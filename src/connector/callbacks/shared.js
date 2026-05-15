import { makeBoundaryError } from "../../boundary-errors.js"
import { getRequestContext } from "../../runtime/request-context.js"
import { localizeCallbackToast } from "../callback-toast.js"

export async function defaultBuildSessionSwitchText(_projectAlias, sessionId) {
  return `Switched to session: ${sessionId}`
}

export function ignoreCallbackError() {}

export function createLegacyCallbackRecorder({ recordLegacyCallbackFallback, logger, intervalMs = 5 * 60 * 1000 } = {}) {
  const legacyCallbackWarningAt = new Map()
  return function recordLegacyCallback(prefix, projectAlias) {
    if (!prefix) return
    try {
      recordLegacyCallbackFallback?.(projectAlias)
      const now = Date.now()
      const lastWarnedAt = legacyCallbackWarningAt.get(prefix) || 0
      if (now - lastWarnedAt < intervalMs) return
      legacyCallbackWarningAt.set(prefix, now)
      logger?.warn?.("Legacy callback payload format used", {
        callbackPrefix: prefix,
        operation: "callback legacy fallback",
      })
    } catch (err) {
      logger?.error?.("Legacy callback fallback recorder failed:", err?.message || String(err))
    }
  }
}

export function createCallbackSharedContext({
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
} = {}) {
  async function answerCallbackQuery(callbackQueryId, text) {
    const locale = getRequestContext()?.locale || config?.i18n?.defaultLocale || "en"
    await tg.answerCallbackQuery(callbackQueryId, localizeCallbackToast(text, locale)).catch(ignoreCallbackError)
  }

  async function deleteInteractiveMessage(ctxMeta, messageId) {
    if (!messageId) return
    if (typeof tg.deleteMessage === "function") {
      await tg.deleteMessage(ctxMeta.chatId, messageId).catch(ignoreCallbackError)
      return
    }
    if (typeof tg.editMessageReplyMarkup === "function") {
      await tg.editMessageReplyMarkup(ctxMeta.chatId, messageId, null).catch(ignoreCallbackError)
    }
  }

  async function closeInteractiveMessage(callbackQueryId, ctxMeta, messageId) {
    await answerCallbackQuery(callbackQueryId, "Closed")
    await deleteInteractiveMessage(ctxMeta, messageId)
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
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

  return {
    answerCallbackQuery,
    deleteInteractiveMessage,
    closeInteractiveMessage,
    hasIdempotencyKey,
    markIdempotencyKey,
    makeStateDurabilityError,
    isStateDurabilityError,
    flushStoreIfAvailable,
    persistQuestionWizardDurably,
    commitStateMutation,
    cleanupPermissionState,
    cleanupQuestionState,
    isPromptBindingCurrent,
    answerStalePromptCallback,
  }
}
