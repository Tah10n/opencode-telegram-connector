import {
  handlePermissionCancelNoteAction,
  handlePermissionRejectNoteAction,
  handlePermissionReplyAction,
} from "./permission-flow.js"
import { parsePermissionParts } from "./permission-state.js"

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
    return handlePermissionReplyAction({
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
    })
  }
  if (action === "reject_note") {
    return handlePermissionRejectNoteAction({
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
    })
  }
  if (action === "cancel_note") {
    return handlePermissionCancelNoteAction({
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
    })
  }
  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
