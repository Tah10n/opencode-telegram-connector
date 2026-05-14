import {
  permissionNoteIdempotencyPrefix,
  permissionReplyIdempotencyKey,
  permissionReplyIdempotencyPrefix,
} from "../idempotency.js"
import { isRetryableBoundaryError, isStaleBoundaryError } from "../../boundary-errors.js"

function ignoreError() {}

function parsePermissionParts(parts) {
  if (parts.length >= 5) return { projectAlias: parts[1], sessionID: parts[2] || "", permissionId: parts[3], action: parts[4], isOldShape: false }
  return { projectAlias: parts[1], sessionID: "", permissionId: parts[2], action: parts[3], isOldShape: true }
}

function hasHandledPermission(store, projectAlias, sessionID, permissionId) {
  if (typeof store?.hasIdempotencyKeyPrefix !== "function") return false
  return store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, "", permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, "", permissionId))
}

export async function handlePermissionCallback({
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
}) {
  const { projectAlias, sessionID, permissionId, action, isOldShape } = parsePermissionParts(parts)
  const oc = ocByAlias[projectAlias]
  if (!oc) {
    await answerCallbackQuery(callbackQuery.id, "Unknown project")
    return true
  }
  if (action === "once" || action === "always" || action === "reject") {
    const pendingPermission = store.getPendingPermission?.(projectAlias, permissionId, sessionID) || null
    const effectiveSessionID = sessionID || pendingPermission?.sessionID || ""
    if (!(await isPromptBindingCurrent(ctxMeta.ctxKey, projectAlias, sessionID, { isOldShape, stateSessionID: pendingPermission?.sessionID || "" }))) {
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await answerStalePromptCallback(callbackQuery, ctxMeta, msg?.message_id, projectAlias)
      return true
    }
    const replyKey = permissionReplyIdempotencyKey(projectAlias, effectiveSessionID, permissionId, action)
    if (hasIdempotencyKey(replyKey) || hasHandledPermission(store, projectAlias, effectiveSessionID, permissionId)) {
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
    try {
      await oc.replyPermission(permissionId, { reply: action })
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/permission/${permissionId}/reply`, method: "POST" })) {
        await markIdempotencyKey(replyKey, {
          kind: "permission-reply",
          projectAlias,
          ctxKey: ctxMeta.ctxKey,
          operation: "replyPermission",
          action,
        })
        cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
        await flushStoreIfAvailable()
        recordCallbackOutcome?.(projectAlias, "stale")
        await answerCallbackQuery(callbackQuery.id, "No longer active")
        await deleteInteractiveMessage(ctxMeta, msg?.message_id)
        return true
      }
      if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${permissionId}/reply`, method: "POST" })) {
        recordCallbackOutcome?.(projectAlias, "retryable")
        await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
        await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
        return true
      }
      throw err
    }
    await markIdempotencyKey(replyKey, {
      kind: "permission-reply",
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      operation: "replyPermission",
      action,
    })
    recordPromptAnswered?.(projectAlias, "permission", "ok")
    cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "OK")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (action === "reject_note") {
    const pendingPermission = store.getPendingPermission?.(projectAlias, permissionId, sessionID) || null
    const effectiveSessionID = sessionID || pendingPermission?.sessionID || ""
    if (!(await isPromptBindingCurrent(ctxMeta.ctxKey, projectAlias, sessionID, { isOldShape, stateSessionID: pendingPermission?.sessionID || "" }))) {
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await answerStalePromptCallback(callbackQuery, ctxMeta, msg?.message_id, projectAlias)
      return true
    }
    if (hasHandledPermission(store, projectAlias, effectiveSessionID, permissionId)) {
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
    setRejectNoteAwaitingState(ctxMeta.ctxKey, { projectAlias, permissionId, ...(effectiveSessionID ? { sessionID: effectiveSessionID } : {}) })
    try {
      await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { sessionID: effectiveSessionID })
    } catch (err) {
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      runtime.logger?.error?.("Failed to start reject-note flow:", err?.message || String(err))
      await answerCallbackQuery(callbackQuery.id, "Unavailable")
      return true
    }
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Send note")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (action === "cancel_note") {
    const pendingPermission = store.getPendingPermission?.(projectAlias, permissionId, sessionID) || null
    const effectiveSessionID = sessionID || pendingPermission?.sessionID || ""
    if (!(await isPromptBindingCurrent(ctxMeta.ctxKey, projectAlias, sessionID, { isOldShape, stateSessionID: pendingPermission?.sessionID || "" }))) {
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await answerStalePromptCallback(callbackQuery, ctxMeta, msg?.message_id, projectAlias)
      return true
    }
    setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Cancelled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
