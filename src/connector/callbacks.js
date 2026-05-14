import { classifyBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import { requireSafeOpenCodeId } from "../opencode/ids.js"
import { makeInlineKeyboard } from "../telegram/client.js"
import { callbackPacker, decodeCallbackData, legacyCallbackPrefix } from "./callback-data.js"
import { localeDisplayName, matchSupportedLocale, t as translate } from "../i18n/index.js"
import { languageSettingsView, supportedLocaleSummary } from "./language-ui.js"
import { getRequestContext } from "../runtime/request-context.js"
import { CALLBACK_TOAST_KEYS, callbackToast, localizeCallbackToast } from "./callback-toast.js"
import { handleFeedCallback } from "./callbacks/feed.js"
import { handleModelCallback } from "./callbacks/model.js"
import { handlePermissionCallback } from "./callbacks/permission.js"
import { handleQuestionCallback } from "./callbacks/question.js"
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

  function canUseProjectControl(ctxMeta, projectAlias) {
    if (ctxMeta?.chatType === "private") return true
    return store.getBinding(ctxMeta?.ctxKey)?.projectAlias === projectAlias
  }

  function canUseBindingAction(ctxMeta, targetCtxKey) {
    return ctxMeta?.chatType === "private" || ctxMeta?.ctxKey === targetCtxKey
  }

  function canUseProjectBind(ctxMeta, projectAlias) {
    if (ctxMeta?.chatType === "private") return true
    const binding = store.getBinding(ctxMeta?.ctxKey)
    return !binding || binding.projectAlias === projectAlias
  }

  function describeTargetCtx(ctxKey) {
    const parsed = parseCtxKey?.(ctxKey)
    if (!parsed) return ctxKey
    return `chat ${parsed.chatId} / ${formatThreadLabel?.(parsed.threadIdOr0) || `thread ${parsed.threadIdOr0}`}`
  }

  function unbindConfirmationKeyboard(ctxKey, binding, locale = "en") {
    return makeInlineKeyboard([
      [{ text: t(locale, "operator.removeBinding"), callback_data: packCallbackData("b", "unbind", ctxKey, binding.projectAlias, binding.sessionId) }],
      [{ text: t(locale, "common.close"), callback_data: packCallbackData("b", "close") }],
    ])
  }

  function runtimeCloseKeyboard(locale = "en") {
    return makeInlineKeyboard([[{ text: t(locale, "common.close"), callback_data: packCallbackData("rt", "close") }]])
  }

  function runtimeConfirmationKeyboard(action, locale = "en") {
    const label = action === "restart" ? t(locale, "callbacks.confirmRestart") : t(locale, "callbacks.confirmStop")
    return makeInlineKeyboard([
      [{ text: label, callback_data: packCallbackData("rt", action) }],
      [{ text: t(locale, "common.cancel"), callback_data: packCallbackData("rt", "cancel") }],
    ])
  }

  function runtimeConfirmationText(action, ctxMeta) {
    if (action === "restart") {
      return t(ctxMeta, "callbacks.runtimeConfirmRestart")
    }
    return t(ctxMeta, "callbacks.runtimeConfirmStop")
  }

  function canRequestRuntimeShutdown() {
    return typeof requestRuntimeShutdown === "function"
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

  function requestRuntimeShutdownSoon(action) {
    const run = () =>
      Promise.resolve(requestRuntimeShutdown({ action })).catch((err) => {
        runtime.logger?.error?.("Runtime shutdown request failed:", err?.message || String(err))
      })
    try {
      if (typeof scheduleRuntimeShutdown === "function") {
        scheduleRuntimeShutdown(run)
        return
      }
      const timer = setTimeout(run, 50)
      timer.unref?.()
    } catch (err) {
      runtime.logger?.error?.("Failed to schedule runtime shutdown request:", err?.message || String(err))
    }
  }

  async function persistRuntimeRestartNotice(ctxMeta) {
    if (typeof store?.setPendingRuntimeOnlineNotice !== "function") return
    try {
      store.setPendingRuntimeOnlineNotice({ kind: "restart", chatId: ctxMeta.chatId, createdAt: Date.now() })
      await flushStoreIfAvailable()
    } catch (err) {
      runtime.logger?.error?.("Failed to persist runtime restart notice:", err?.message || String(err))
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
        const action = parts[1]
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "reset") {
          store.clearLocale?.(ctxMeta.ctxKey)
          await flushStoreIfAvailable()
          ctxMeta = ctxMetaWithLocale?.({ ...ctxMeta, locale: "" }) || { ...ctxMeta, locale: "" }
          const view = languageSettingsView(ctxMeta, { store, config, packCallback: packCallbackData, t })
          await answerCallbackQuery(callbackQuery.id, t(ctxMeta, "language.reset"))
          if (msg?.message_id && typeof tg.editMessageText === "function") {
            await tg.editMessageText(ctxMeta.chatId, msg.message_id, view.text, view.replyMarkup).catch(ignoreError)
          }
          return
        }
        if (action === "set") {
          const locale = matchSupportedLocale(parts[2], config?.i18n?.supportedLocales)
          if (!locale) {
            await answerCallbackQuery(
              callbackQuery.id,
              t(ctxMeta, "language.unsupported", { locale: parts[2] || "", supported: supportedLocaleSummary({ config, displayLocale: ctxMeta.locale }) }),
            )
            return
          }
          store.setLocale?.(ctxMeta.ctxKey, locale, { source: "manual" })
          await flushStoreIfAvailable()
          ctxMeta = ctxMetaWithLocale?.(ctxMeta) || { ...ctxMeta, locale }
          const view = languageSettingsView(ctxMeta, { store, config, packCallback: packCallbackData, t })
          await answerCallbackQuery(callbackQuery.id, t(ctxMeta, "language.changed", { language: localeDisplayName(locale, locale) }))
          if (msg?.message_id && typeof tg.editMessageText === "function") {
            await tg.editMessageText(ctxMeta.chatId, msg.message_id, view.text, view.replyMarkup).catch(ignoreError)
          }
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "rt") {
        const action = parts[1]
        if (ctxMeta?.chatType !== "private") {
          await answerCallbackQuery(callbackQuery.id, "Private chat only")
          return
        }
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "cancel") {
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }
        if (action === "confirm-stop" || action === "confirm-restart") {
          const targetAction = action === "confirm-restart" ? "restart" : "stop"
          await answerCallbackQuery(callbackQuery.id, targetAction === "restart" ? "Confirm restart" : "Confirm stop")
          if (msg?.message_id && typeof tg.editMessageText === "function") {
            await tg
              .editMessageText(ctxMeta.chatId, msg.message_id, runtimeConfirmationText(targetAction, ctxMeta), runtimeConfirmationKeyboard(targetAction, ctxMeta.locale))
              .catch(ignoreError)
          }
          return
        }
        if (action === "stop" || action === "restart") {
          if (!canRequestRuntimeShutdown()) {
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            if (msg?.message_id && typeof tg.editMessageText === "function") {
              await tg.editMessageText(ctxMeta.chatId, msg.message_id, t(ctxMeta, "callbacks.runtimeShutdownUnavailable"), runtimeCloseKeyboard(ctxMeta.locale)).catch(ignoreError)
            }
            return
          }
          await answerCallbackQuery(callbackQuery.id, action === "restart" ? "Restarting…" : "Stopping…")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          if (action === "restart") await persistRuntimeRestartNotice(ctxMeta)
          requestRuntimeShutdownSoon(action)
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
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
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (parts[1] === "projects") {
          if (typeof handleProjects !== "function") {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Projects")
          await handleProjects(ctxMeta).catch(ignoreError)
          return
        }
        const projectAlias = parts[1]
        const action = parts[2]
        if (!projectAlias || !projects?.[projectAlias]) {
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }
        if (action === "start") {
          if (!canUseProjectControl(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Starting…")
          void ensureProjectStarted(projectAlias, ctxMeta)
          return
        }
        if (action === "bind") {
          if (!canUseProjectBind(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          if (typeof handleBindCommand !== "function") {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Binding…")
          await handleBindCommand(ctxMeta, [projectAlias]).then(() => flushStoreIfAvailable()).catch(async (err) => {
            runtime.logger?.error?.("Failed to bind project from callback:", err?.message || String(err))
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
          })
          return
        }
        if (action === "health") {
          if (!canUseProjectControl(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Checking…")
          try {
            await validateProject(projectAlias)
            await sendToThread(ctxMeta, t(ctxMeta, "callbacks.healthOnline", { project: projectAlias })).catch(ignoreError)
          } catch (err) {
            const replyMarkup = canAutoStartProject?.(projectAlias, { platform }) ? startServerKeyboard?.(projectAlias) : null
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale }), replyMarkup).catch(ignoreError)
          }
          return
        }
        if (action === "sessions") {
          await answerCallbackQuery(callbackQuery.id, "Sessions")
          await renderProjectSessions(ctxMeta, projectAlias, { editMessageId: msg?.message_id }).catch(async (err) => {
            runtime.logger?.error?.("Failed to render project sessions:", err?.message || String(err))
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
          })
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "b") {
        const action = parts[1]
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "repair") {
          if (ctxMeta?.chatType !== "private") {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          const summary = store.repairBindingIndex?.() || { changed: false }
          if (summary.changed) await flushStoreIfAvailable()
          await answerCallbackQuery(callbackQuery.id, summary.changed ? "Repaired" : "Already clean")
          if (typeof handleBindings === "function") await handleBindings(ctxMeta).catch(ignoreError)
          return
        }

        const targetCtxKey = parts[2]
        const targetCtx = parseCtxKey?.(targetCtxKey)
        if (!targetCtxKey || !targetCtx) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (!canUseBindingAction(ctxMeta, targetCtxKey)) {
          await answerCallbackQuery(callbackQuery.id, "Private chat only")
          return
        }
        const binding = store.getBinding(targetCtxKey)
        if (!binding) {
          await answerCallbackQuery(callbackQuery.id, "Not bound")
          return
        }

        if (action === "keep") {
          await answerCallbackQuery(callbackQuery.id, "Kept")
          await sendToThread(ctxMeta, t(ctxMeta, "callbacks.bindingKept", { scope: describeTargetCtx(targetCtxKey) })).catch(ignoreError)
          return
        }
        if (action === "confirm-unbind") {
          await answerCallbackQuery(callbackQuery.id, "Confirm")
          await sendToThread(
            ctxMeta,
            [
              t(ctxMeta, "operator.confirmUnbind"),
              t(ctxMeta, "operator.scope", { scope: describeTargetCtx(targetCtxKey) }),
              t(ctxMeta, "operator.project", { project: binding.projectAlias }),
              t(ctxMeta, "operator.session", { session: binding.sessionId }),
              t(ctxMeta, "operator.unbindNote"),
            ].join("\n"),
            unbindConfirmationKeyboard(targetCtxKey, binding, ctxMeta.locale),
          ).catch(ignoreError)
          return
        }
        if (action === "unbind") {
          const expectedProjectAlias = parts[3] || ""
          const expectedSessionId = parts[4] || ""
          if (!expectedProjectAlias || !expectedSessionId) {
            await answerCallbackQuery(callbackQuery.id, "Confirm")
            await sendToThread(
              ctxMeta,
              [
                t(ctxMeta, "operator.confirmUnbind"),
                t(ctxMeta, "operator.scope", { scope: describeTargetCtx(targetCtxKey) }),
                t(ctxMeta, "operator.project", { project: binding.projectAlias }),
                t(ctxMeta, "operator.session", { session: binding.sessionId }),
                t(ctxMeta, "operator.unbindNote"),
              ].join("\n"),
              unbindConfirmationKeyboard(targetCtxKey, binding, ctxMeta.locale),
            ).catch(ignoreError)
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            return
          }
          if (binding.projectAlias !== expectedProjectAlias || binding.sessionId !== expectedSessionId) {
            await answerCallbackQuery(callbackQuery.id, "Binding changed")
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            await sendToThread(ctxMeta, t(ctxMeta, "callbacks.bindingChangedForScope", { scope: describeTargetCtx(targetCtxKey) })).catch(ignoreError)
            return
          }
          const ok = await commitStateMutation(() => store.unbind(targetCtxKey), { shouldCommit: (result) => !!result })
          await answerCallbackQuery(callbackQuery.id, ok ? "Unbound" : "Not bound")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          await sendToThread(ctxMeta, ok ? t(ctxMeta, "callbacks.bindingRemoved", { scope: describeTargetCtx(targetCtxKey) }) : t(ctxMeta, "callbacks.bindingAbsent")).catch(ignoreError)
          return
        }
        if (action === "rebind" || action === "new") {
          const projectAlias = binding.projectAlias
          const oc = ocByAlias[projectAlias]
          if (!projectAlias || !projects?.[projectAlias] || !oc) {
            await answerCallbackQuery(callbackQuery.id, "Unknown project")
            return
          }
          try {
            const nextSessionId = action === "rebind"
              ? await getStartupSession(projectAlias, { waitForStart: false, forceRefresh: true })
              : (await oc.createSession(projects?.[projectAlias]?.directory ? { directory: projects[projectAlias].directory } : {}))?.id
            if (!nextSessionId) {
              await answerCallbackQuery(callbackQuery.id, "Unavailable")
              return
            }
            const safeNextSessionId = requireSafeOpenCodeId(nextSessionId, "session id")
            const targetMeta = { ...targetCtx, ctxKey: targetCtxKey, chatType: ctxMeta.chatType }
            await commitStateMutation(() => bindCtxToSession(targetMeta, projectAlias, safeNextSessionId))
            await answerCallbackQuery(callbackQuery.id, action === "rebind" ? "Rebound" : "Created")
            await sendToThread(
              ctxMeta,
              t(ctxMeta, "callbacks.bindingChangedToSession", {
                action: action === "rebind" ? t(ctxMeta, "callbacks.rebound") : t(ctxMeta, "callbacks.createdAndBound"),
                scope: describeTargetCtx(targetCtxKey),
                project: projectAlias,
                session: safeNextSessionId,
              }),
            ).catch(ignoreError)
          } catch (err) {
            if (isStateDurabilityError(err)) {
              if (action === "new") {
                await answerCallbackQuery(callbackQuery.id, "Action failed")
                await sendToThread(ctxMeta, t(ctxMeta, "callbacks.newSessionPersistFailed")).catch(ignoreError)
                return
              }
              throw err
            }
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
          }
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Invalid")
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
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        const projectAlias = parts[1]
        const sessionId = parts[2]
        const opencodeMessageId = parts[3]
        const action = parts[4]
        const validChangedFilesActions = new Set(["show", "back", "summary", "patch", "files", "file", "filepatch"])
        if (!projectAlias || !sessionId || !opencodeMessageId || !validChangedFilesActions.has(action)) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        await answerCallbackQuery(callbackQuery.id)
        const viewOptions = { editMessageId: msg?.message_id }
        if (parts[5] != null) viewOptions.actionArg = parts[5]
        await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, viewOptions)
        return
      }

      if (kind === "att") {
        const action = parts[1]
        const token = parts[2]
        if (!token || (action !== "send" && action !== "cancel" && action !== "close")) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (action === "close") {
          await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "send") await answerCallbackQuery(callbackQuery.id, "Sending…")
        const result = await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
        if (action !== "send") await answerCallbackQuery(callbackQuery.id, result?.callbackText || (action === "cancel" ? "Cancelled" : "Closed"))
        if (result?.callbackText === "Sent" || result?.callbackText === "Cancelled" || result?.callbackText === "Already sent") {
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
        }
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
