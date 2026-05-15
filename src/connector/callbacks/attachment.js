export async function handleAttachmentCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  runtime,
  answerCallbackQuery,
  closeInteractiveMessage,
  deleteInteractiveMessage,
}) {
  const action = parts[1]
  const token = parts[2]
  if (!token || (action !== "send" && action !== "cancel" && action !== "close")) {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  if (action === "close") {
    await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (action === "send") await answerCallbackQuery(callbackQuery.id, "Sending…")
  const result = await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
  if (action !== "send") await answerCallbackQuery(callbackQuery.id, result?.callbackText || (action === "cancel" ? "Cancelled" : "Closed"))
  if (result?.callbackText === "Sent" || result?.callbackText === "Cancelled" || result?.callbackText === "Already sent") {
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  }
  return true
}
