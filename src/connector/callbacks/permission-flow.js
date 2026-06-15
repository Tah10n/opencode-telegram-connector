import { classifyBoundaryError, isStaleBoundaryError, makeBoundaryError } from "../../boundary-errors.js"
import { promptScopedSubmissionIdempotencyKey, promptSubmissionIdempotencyKey } from "../idempotency.js"
import { livePermissionPromptStatus, shouldRetrySubmittedPrompt } from "../prompt-submission.js"
import { hasHandledPermission, permissionReplyIdempotencyKey } from "./permission-state.js"

function ignoreError() {}

function pendingPermissionSession(store, projectAlias, permissionId, sessionID) {
  const callbackSessionID = String(sessionID || "").trim()
  const candidate = store.getPendingPermission?.(projectAlias, permissionId, callbackSessionID) || null
  const candidateSessionID = String(candidate?.sessionID || "").trim()
  const pendingPermission = !callbackSessionID && candidateSessionID ? null : candidate
  return {
    pendingPermission,
    effectiveSessionID: callbackSessionID || pendingPermission?.sessionID || "",
  }
}

function promptSubmissionScopeMetadata({ projectAlias, ctxKey, sessionID, promptId, promptType, operation, finalKey }) {
  return {
    kind: "prompt-submission-scope",
    projectAlias,
    ctxKey,
    sessionId: sessionID,
    promptId,
    promptType,
    operation,
    finalKey,
  }
}

function makePermissionSubmissionInFlightError() {
  return makeBoundaryError({
    source: "opencode",
    operation: "GET /permission",
    method: "GET",
    pathname: "/permission",
    kind: "network",
    outcome: "retryable",
    message: "Permission prompt submission is already in progress",
  })
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

async function answerStaleIfSessionlessPendingMissing({
  store,
  sessionID,
  pendingPermission,
  ctxMeta,
  msg,
  projectAlias,
  permissionId,
  cleanupPermissionState,
  answerStalePromptCallback,
  callbackQuery,
}) {
  if (sessionID || pendingPermission || typeof store?.getPendingPermission !== "function") return false
  cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, "")
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
  const submittedKey = promptSubmissionIdempotencyKey(replyKey)
  const scopedSubmittedKey = promptScopedSubmissionIdempotencyKey(projectAlias, effectiveSessionID, permissionId, "permission")
  if (hasIdempotencyKey(replyKey) || hasHandledPermission(store, projectAlias, effectiveSessionID, permissionId)) {
    cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Already handled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (await answerStaleIfSessionlessPendingMissing({
    store,
    sessionID,
    pendingPermission,
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    cleanupPermissionState,
    answerStalePromptCallback,
    callbackQuery,
  })) return true
  if (hasIdempotencyKey(submittedKey)) {
    const liveStatus = await livePermissionPromptStatus(oc, permissionId, effectiveSessionID)
    if (liveStatus === "retryable") {
      throw makeBoundaryError({
        source: "opencode",
        operation: "GET /permission",
        method: "GET",
        pathname: "/permission",
        kind: "network",
        outcome: "retryable",
        message: "Permission prompt status temporarily unavailable",
      })
    }
    if (!shouldRetrySubmittedPrompt(liveStatus)) {
      await markIdempotencyKey(replyKey, {
        kind: "permission-reply",
        projectAlias,
        ctxKey: ctxMeta.ctxKey,
        operation: "replyPermission",
        action,
      })
      cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
  } else if (hasIdempotencyKey(scopedSubmittedKey)) {
    const liveStatus = await livePermissionPromptStatus(oc, permissionId, effectiveSessionID)
    if (liveStatus === "retryable" || shouldRetrySubmittedPrompt(liveStatus)) throw makePermissionSubmissionInFlightError()
    cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Already handled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  } else {
    await markIdempotencyKey(scopedSubmittedKey, promptSubmissionScopeMetadata({
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      sessionID: effectiveSessionID,
      promptId: permissionId,
      promptType: "permission",
      operation: "replyPermission",
      finalKey: replyKey,
    }))
    await markIdempotencyKey(submittedKey, {
      kind: "prompt-submission",
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      sessionId: effectiveSessionID,
      operation: "replyPermission",
      action,
    })
    await flushStoreIfAvailable()
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
    const retryableClassification = classifyBoundaryError(err, { source: "opencode", pathname: `/permission/${permissionId}/reply`, method: "POST" })
    if (retryableClassification.retryable) {
      throw retryableClassification.error
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
  if (await answerStaleIfSessionlessPendingMissing({
    store,
    sessionID,
    pendingPermission,
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    cleanupPermissionState,
    answerStalePromptCallback,
    callbackQuery,
  })) return true
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
    await flushStoreIfAvailable()
  } catch (err) {
    setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
    try {
      await flushStoreIfAvailable()
    } catch (rollbackErr) {
      runtime.logger?.error?.("Failed to roll back reject-note flow state:", rollbackErr?.message || String(rollbackErr))
    }
    throw err
  }
  try {
    await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { sessionID: effectiveSessionID })
  } catch (err) {
    setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
    runtime.logger?.error?.("Failed to start reject-note flow:", err?.message || String(err))
    try {
      await flushStoreIfAvailable()
    } catch (rollbackErr) {
      runtime.logger?.error?.("Failed to roll back reject-note flow state:", rollbackErr?.message || String(rollbackErr))
      throw rollbackErr
    }
    const classification = classifyBoundaryError(err, { source: "telegram", operation: "send reject-note prompt" })
    if (classification.retryable) throw classification.error
    await answerCallbackQuery(callbackQuery.id, "Unavailable")
    return true
  }
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
  if (await answerStaleIfSessionlessPendingMissing({
    store,
    sessionID,
    pendingPermission,
    ctxMeta,
    msg,
    projectAlias,
    permissionId,
    cleanupPermissionState,
    answerStalePromptCallback,
    callbackQuery,
  })) return true
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
