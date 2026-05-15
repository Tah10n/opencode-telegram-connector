import { isRetryableBoundaryError, isStaleBoundaryError } from "../../boundary-errors.js"
import { hasHandledPermission, permissionReplyIdempotencyKey } from "./permission-state.js"

function ignoreError() {}

function pendingPermissionSession(store, projectAlias, permissionId, sessionID) {
  const pendingPermission = store.getPendingPermission?.(projectAlias, permissionId, sessionID) || null
  return {
    pendingPermission,
    effectiveSessionID: sessionID || pendingPermission?.sessionID || "",
  }
}

async function answerStaleIfBindingChanged({
  ctxMeta,
  msg,
  projectAlias,
  permissionId,
  sessionID,
  isOldShape,
  pendingPermission,
  effectiveSessionID,
  cleanupPermissionState,
  isPromptBindingCurrent,
  answerStalePromptCallback,
  callbackQuery,
}) {
  if (await isPromptBindingCurrent(ctxMeta.ctxKey, projectAlias, sessionID, { isOldShape, stateSessionID: pendingPermission?.sessionID || "" })) {
    return false
  }
  cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
  await answerStalePromptCallback(callbackQuery, ctxMeta, msg?.message_id, projectAlias)
  return true
}

export async function handlePermissionReplyAction({
  action,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  oc,
  projectAlias,
  sessionID,
  permissionId,
  isOldShape,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  hasIdempotencyKey,
  markIdempotencyKey,
  cleanupPermissionState,
  isPromptBindingCurrent,
  answerStalePromptCallback,
  sendToThread,
  recordCallbackOutcome,
  recordPromptAnswered,
  t,
}) {
  const { pendingPermission, effectiveSessionID } = pendingPermissionSession(store, projectAlias, permissionId, sessionID)
  if (await answerStaleIfBindingChanged({
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    sessionID,
    isOldShape,
    pendingPermission,
    effectiveSessionID,
    cleanupPermissionState,
    isPromptBindingCurrent,
    answerStalePromptCallback,
    callbackQuery,
  })) return true

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

export async function handlePermissionRejectNoteAction({
  callbackQuery,
  ctxMeta,
  msg,
  store,
  projectAlias,
  sessionID,
  permissionId,
  isOldShape,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  cleanupPermissionState,
  isPromptBindingCurrent,
  answerStalePromptCallback,
  setRejectNoteAwaitingState,
  sendRejectNotePrompt,
  runtime,
}) {
  const { pendingPermission, effectiveSessionID } = pendingPermissionSession(store, projectAlias, permissionId, sessionID)
  if (await answerStaleIfBindingChanged({
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    sessionID,
    isOldShape,
    pendingPermission,
    effectiveSessionID,
    cleanupPermissionState,
    isPromptBindingCurrent,
    answerStalePromptCallback,
    callbackQuery,
  })) return true

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

export async function handlePermissionCancelNoteAction({
  callbackQuery,
  ctxMeta,
  msg,
  store,
  projectAlias,
  sessionID,
  permissionId,
  isOldShape,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  cleanupPermissionState,
  isPromptBindingCurrent,
  answerStalePromptCallback,
  setRejectNoteAwaitingState,
}) {
  const { pendingPermission, effectiveSessionID } = pendingPermissionSession(store, projectAlias, permissionId, sessionID)
  if (await answerStaleIfBindingChanged({
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    sessionID,
    isOldShape,
    pendingPermission,
    effectiveSessionID,
    cleanupPermissionState,
    isPromptBindingCurrent,
    answerStalePromptCallback,
    callbackQuery,
  })) return true

  setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
  await flushStoreIfAvailable()
  await answerCallbackQuery(callbackQuery.id, "Cancelled")
  await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  return true
}
