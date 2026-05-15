import { classifyBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import { callbackPacker, decodeCallbackData, legacyCallbackPrefix } from "./callback-data.js"
import { t as translate } from "../i18n/index.js"
import { getRequestContext } from "../runtime/request-context.js"
import { CALLBACK_TOAST_KEYS, callbackToast, localizeCallbackToast } from "./callback-toast.js"
import { handleAttachmentCallback } from "./callbacks/attachment.js"
import { handleBindingCallback } from "./callbacks/binding.js"
import { handleChangedFilesCallback } from "./callbacks/changed-files.js"
import { handleFeedCallback } from "./callbacks/feed.js"
import { handleLanguageCallback } from "./callbacks/language.js"
import { handleModelCallback } from "./callbacks/model.js"
import { handlePermissionCallback } from "./callbacks/permission.js"
import { handleProjectCallback } from "./callbacks/project.js"
import { handleQuestionCallback } from "./callbacks/question.js"
import { handleRuntimeCallback } from "./callbacks/runtime.js"
import { handleSessionCallback } from "./callbacks/session.js"

export { CALLBACK_TOAST_KEYS, callbackToast, localizeCallbackToast }

async function defaultBuildSessionSwitchText(_projectAlias, sessionId) {
  return `Switched to session: ${sessionId}`
}

function ignoreError() {}

export function createCallbackHandlers(runtime) {
  const {
    tg,
    cb,
    store,
    projects,
    ocByAlias,
    ctxMetaFromMessage,
    parseCtxKey,
    formatThreadLabel,
    isAllowedUser,
    bindCtxToSession,
    sendToThread,
    ensureProjectStarted,
    validateProject,
    getStartupSession,
    renderFeedSettings,
    renderModelSettings,
    renderChangedFilesView,
    renderSessionsList,
    renderProjectSessions,
    handleBindings,
    handleBindCommand,
    handleNewCommand,
    handleProjects,
    feedModeLabel,
    setRejectNoteAwaitingState,
    sendRejectNotePrompt,
    getWizard,
    clearPersistedQuestionWizard,
    setAwaitingCustomAnswerState,
    sendQuestionCustomAnswerPrompt,
    cloneWizardState,
    applyWizardState,
    persistQuestionWizard,
    finishQuestionWizard,
    buildSessionSwitchText = defaultBuildSessionSwitchText,
    setThreadModelPreference,
    formatProjectUnavailable,
    canAutoStartProject,
    startServerKeyboard,
    platform,
    recordCallbackOutcome,
    recordLegacyCallbackFallback,
    recordPromptAnswered,
    resolveBoundRoute,
    requestRuntimeShutdown,
    scheduleRuntimeShutdown,
    rememberTelegramLocale,
    ctxMetaWithLocale,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
    config,
  } = runtime
  const packCallbackData = callbackPacker(cb)
  const legacyCallbackWarningAt = new Map()
  const legacyCallbackWarningIntervalMs = 5 * 60 * 1000

  async function answerCallbackQuery(callbackQueryId, text) {
    const locale = getRequestContext()?.locale || config?.i18n?.defaultLocale || "en"
    await tg.answerCallbackQuery(callbackQueryId, localizeCallbackToast(text, locale)).catch(ignoreError)
  }

  async function deleteInteractiveMessage(ctxMeta, messageId) {
    if (!messageId) return
    if (typeof tg.deleteMessage === "function") {
      await tg.deleteMessage(ctxMeta.chatId, messageId).catch(ignoreError)
      return
    }
    if (typeof tg.editMessageReplyMarkup === "function") {
      await tg.editMessageReplyMarkup(ctxMeta.chatId, messageId, null).catch(ignoreError)
    }
  }

  async function closeInteractiveMessage(callbackQueryId, ctxMeta, messageId) {
    await answerCallbackQuery(callbackQueryId, "Closed")
    await deleteInteractiveMessage(ctxMeta, messageId)
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function markIdempotencyKey(key, metadata = {}) {
    if (!key) return false
    if (typeof store?.markIdempotencyKey === "function") {
      return store.markIdempotencyKey(key, metadata)
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      try {
        return await store.markIdempotencyKeyAndFlush(key, metadata)
      } catch (err) {
        throw makeStateDurabilityError(err, "persist callback idempotency")
      }
    }
    return false
  }

  function makeStateDurabilityError(err, operation) {
    return makeBoundaryError({
      source: "state",
      operation,
      kind: "durability",
      outcome: "retryable",
      message: `${operation} failed: ${err?.message || String(err)}`,
      cause: err,
    })
  }

  function isStateDurabilityError(err) {
    return err?.isBoundaryError === true && err.source === "state" && err.kind === "durability"
  }

  async function flushStoreIfAvailable() {
    if (typeof store?.flush !== "function") return
    try {
      await store.flush()
    } catch (err) {
      throw makeStateDurabilityError(err, "persist callback state")
    }
  }

  async function persistQuestionWizardDurably(wizard, previousWizard) {
    persistQuestionWizard(wizard)
    try {
      await flushStoreIfAvailable()
    } catch (err) {
      if (previousWizard) {
        try {
          applyWizardState(wizard, previousWizard)
          persistQuestionWizard(wizard)
        } catch (rollbackErr) {
          runtime.logger?.error?.("Failed to roll back question wizard state:", rollbackErr?.message || String(rollbackErr))
        }
      }
      throw err
    }
  }

  function cloneStoreStateSnapshot() {
    if (typeof store?.get !== "function") return null
    const current = store.get()
    if (!current || typeof current !== "object") return null
    return JSON.parse(JSON.stringify(current))
  }

  function restoreStoreStateSnapshot(snapshot) {
    if (!snapshot || typeof store?.get !== "function") return
    const current = store.get()
    if (!current || typeof current !== "object") return
    for (const key of Object.keys(current)) delete current[key]
    Object.assign(current, JSON.parse(JSON.stringify(snapshot)))
  }

  async function commitStateMutation(mutate, { shouldCommit = () => true } = {}) {
    const snapshot = cloneStoreStateSnapshot()
    try {
      const result = await mutate()
      if (shouldCommit(result)) await flushStoreIfAvailable()
      return result
    } catch (err) {
      restoreStoreStateSnapshot(snapshot)
      throw err
    }
  }

  function cleanupPermissionState(ctxKey, projectAlias, permissionId, sessionID = "") {
    store.deletePendingPermission(projectAlias, permissionId, sessionID)
    setRejectNoteAwaitingState(ctxKey, null)
  }

  function cleanupQuestionState(ctxKey, projectAlias, questionId, sessionID = "") {
    if (sessionID) runtime.questionWizards.delete(`${projectAlias}:${sessionID}:${questionId}`)
    runtime.questionWizards.delete(`${projectAlias}:${questionId}`)
    if (sessionID) clearPersistedQuestionWizard(projectAlias, questionId, sessionID)
    clearPersistedQuestionWizard(projectAlias, questionId, "")
    setAwaitingCustomAnswerState(ctxKey, null)
  }

  function routeCtxKey(route) {
    if (route?.chatId == null) return ""
    return `${route.chatId}:${route.threadIdOr0 || 0}`
  }

  async function isPromptBindingCurrent(ctxKey, projectAlias, callbackSessionID = "", { isOldShape = false, stateSessionID = "" } = {}) {
    if (typeof store?.getBinding !== "function") return true
    const binding = store.getBinding(ctxKey)
    if (!binding) return false
    if (binding.projectAlias !== projectAlias) return false
    const expectedSessionID = callbackSessionID || stateSessionID || ""
    if (isOldShape && !expectedSessionID) return false
    if (!expectedSessionID || binding.sessionId === expectedSessionID) return true
    if (typeof resolveBoundRoute !== "function") return false
    const resolved = await resolveBoundRoute(projectAlias, expectedSessionID)
    return binding.sessionId === resolved?.boundSessionId && routeCtxKey(resolved?.route) === ctxKey
  }

  async function answerStalePromptCallback(callbackQuery, ctxMeta, messageId, projectAlias) {
    await flushStoreIfAvailable()
    recordCallbackOutcome?.(projectAlias, "stale")
    await answerCallbackQuery(callbackQuery.id, "No longer active")
    await deleteInteractiveMessage(ctxMeta, messageId)
  }

  function recordLegacyCallback(prefix, projectAlias) {
    if (!prefix) return
    try {
      recordLegacyCallbackFallback?.(projectAlias)
      const now = Date.now()
      const lastWarnedAt = legacyCallbackWarningAt.get(prefix) || 0
      if (now - lastWarnedAt < legacyCallbackWarningIntervalMs) return
      legacyCallbackWarningAt.set(prefix, now)
      runtime.logger?.warn?.("Legacy callback payload format used", {
        callbackPrefix: prefix,
        operation: "callback legacy fallback",
      })
    } catch (err) {
      runtime.logger?.error?.("Legacy callback fallback recorder failed:", err?.message || String(err))
    }
  }

  async function handleTelegramCallback(callbackQuery) {
    if (!isAllowedUser(callbackQuery?.from)) return
    const msg = callbackQuery.message
    let ctxMeta = ctxMetaFromMessage(msg, callbackQuery?.from)
    ctxMeta = rememberTelegramLocale?.(ctxMeta) || ctxMeta
    const data = typeof cb?.unpack === "function" ? cb.unpack(callbackQuery.data) : callbackQuery.data
    if (!data) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    const legacyPrefix = legacyCallbackPrefix(data)
    const parts = decodeCallbackData(data)
    if (!parts?.length || !parts[0]) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }
    const kind = parts[0]
    const callbackProjectAlias = projects?.[parts[1]] ? parts[1] : store.getBinding(ctxMeta.ctxKey)?.projectAlias || null
    recordLegacyCallback(legacyPrefix, callbackProjectAlias)

    try {
      if (kind === "lang") {
        await handleLanguageCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          config,
          tg,
          answerCallbackQuery,
          closeInteractiveMessage,
          flushStoreIfAvailable,
          ctxMetaWithLocale,
          packCallbackData,
          t,
        })
        return
      }

      if (kind === "rt") {
        await handleRuntimeCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          tg,
          store,
          runtime,
          answerCallbackQuery,
          closeInteractiveMessage,
          deleteInteractiveMessage,
          flushStoreIfAvailable,
          requestRuntimeShutdown,
          scheduleRuntimeShutdown,
          packCallbackData,
          t,
        })
        return
      }

      if (kind === "s") {
        await handleSessionCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          ocByAlias,
          answerCallbackQuery,
          closeInteractiveMessage,
          renderSessionsList,
          sendToThread,
          formatProjectUnavailable,
          handleNewCommand,
          commitStateMutation,
          bindCtxToSession,
          buildSessionSwitchText,
          flushStoreIfAvailable,
          t,
          runtime,
        })
        return
      }

      if (kind === "srv") {
        await handleProjectCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          projects,
          runtime,
          answerCallbackQuery,
          closeInteractiveMessage,
          handleProjects,
          ensureProjectStarted,
          handleBindCommand,
          flushStoreIfAvailable,
          sendToThread,
          formatProjectUnavailable,
          validateProject,
          canAutoStartProject,
          platform,
          startServerKeyboard,
          renderProjectSessions,
          t,
        })
        return
      }

      if (kind === "b") {
        await handleBindingCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          projects,
          ocByAlias,
          parseCtxKey,
          formatThreadLabel,
          answerCallbackQuery,
          closeInteractiveMessage,
          deleteInteractiveMessage,
          handleBindings,
          flushStoreIfAvailable,
          sendToThread,
          commitStateMutation,
          getStartupSession,
          bindCtxToSession,
          packCallbackData,
          t,
          formatProjectUnavailable,
          isStateDurabilityError,
        })
        return
      }

      if (kind === "feed") {
        await handleFeedCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          answerCallbackQuery,
          closeInteractiveMessage,
          commitStateMutation,
          renderFeedSettings,
          feedModeLabel,
          t,
        })
        return
      }

      if (kind === "m") {
        await handleModelCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          answerCallbackQuery,
          closeInteractiveMessage,
          commitStateMutation,
          renderModelSettings,
          setThreadModelPreference,
        })
        return
      }

      if (kind === "cf") {
        await handleChangedFilesCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          answerCallbackQuery,
          closeInteractiveMessage,
          renderChangedFilesView,
        })
        return
      }

      if (kind === "att") {
        await handleAttachmentCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          runtime,
          answerCallbackQuery,
          closeInteractiveMessage,
          deleteInteractiveMessage,
        })
        return
      }

      if (kind === "p") {
        await handlePermissionCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          ocByAlias,
          answerCallbackQuery,
          deleteInteractiveMessage,
          flushStoreIfAvailable,
          hasIdempotencyKey,
          markIdempotencyKey,
          cleanupPermissionState,
          isPromptBindingCurrent,
          answerStalePromptCallback,
          setRejectNoteAwaitingState,
          sendRejectNotePrompt,
          sendToThread,
          recordCallbackOutcome,
          recordPromptAnswered,
          t,
          runtime,
        })
        return
      }

      if (kind === "q") {
        await handleQuestionCallback({
          parts,
          callbackQuery,
          ctxMeta,
          msg,
          store,
          ocByAlias,
          answerCallbackQuery,
          deleteInteractiveMessage,
          flushStoreIfAvailable,
          hasIdempotencyKey,
          markIdempotencyKey,
          cleanupQuestionState,
          isPromptBindingCurrent,
          answerStalePromptCallback,
          getWizard,
          setAwaitingCustomAnswerState,
          sendQuestionCustomAnswerPrompt,
          cloneWizardState,
          applyWizardState,
          persistQuestionWizard,
          persistQuestionWizardDurably,
          finishQuestionWizard,
          sendToThread,
          recordCallbackOutcome,
          recordPromptAnswered,
          t,
          runtime,
        })
        return
      }

      await answerCallbackQuery(callbackQuery.id, "Invalid")
    } catch (err) {
      runtime.logger?.error?.("Callback handler error:", err?.message || String(err))
      const classification = classifyBoundaryError(err)
      if (classification.source === "state" && classification.kind === "durability") {
        recordCallbackOutcome?.(callbackProjectAlias, "retryable")
        await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
        throw classification.error
      }
      if (classification.stale) {
        recordCallbackOutcome?.(callbackProjectAlias, "stale")
        await answerCallbackQuery(callbackQuery.id, "No longer active")
        return
      }
      if (classification.retryable) {
        recordCallbackOutcome?.(callbackProjectAlias, "retryable")
        await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
        await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
        return
      }
      recordCallbackOutcome?.(callbackProjectAlias, "fatal")
      await answerCallbackQuery(callbackQuery.id, "Action failed")
      await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionFailedTryAgain")).catch(ignoreError)
    }
  }

  return { handleTelegramCallback }
}
