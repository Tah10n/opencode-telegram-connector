import { classifyBoundaryError } from "../boundary-errors.js"
import { callbackPacker, decodeCallbackData, legacyCallbackPrefix } from "./callback-data.js"
import { t as translate } from "../i18n/index.js"
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
import {
  createCallbackSharedContext,
  createLegacyCallbackRecorder,
  defaultBuildSessionSwitchText,
  ignoreCallbackError as ignoreError,
} from "./callbacks/shared.js"
import { handleSessionCallback } from "./callbacks/session.js"

export { CALLBACK_TOAST_KEYS, callbackToast, localizeCallbackToast }

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
  const {
    answerCallbackQuery,
    deleteInteractiveMessage,
    closeInteractiveMessage,
    hasIdempotencyKey,
    markIdempotencyKey,
    isStateDurabilityError,
    flushStoreIfAvailable,
    persistQuestionWizardDurably,
    commitStateMutation,
    cleanupPermissionState,
    cleanupQuestionState,
    isPromptBindingCurrent,
    answerStalePromptCallback,
  } = createCallbackSharedContext({
    tg,
    store,
    config,
    ctxMetaWithLocale,
    t,
    runtime,
    recordCallbackOutcome,
    resolveBoundRoute,
    applyWizardState,
    persistQuestionWizard,
    clearPersistedQuestionWizard,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
  })
  const recordLegacyCallback = createLegacyCallbackRecorder({
    recordLegacyCallbackFallback,
    logger: runtime.logger,
  })

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
