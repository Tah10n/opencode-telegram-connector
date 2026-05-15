const VALID_CHANGED_FILES_ACTIONS = new Set(["show", "back", "summary", "patch", "files", "file", "filepatch"])

export async function handleChangedFilesCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  answerCallbackQuery,
  closeInteractiveMessage,
  renderChangedFilesView,
}) {
  if (parts[1] === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  const projectAlias = parts[1]
  const sessionId = parts[2]
  const opencodeMessageId = parts[3]
  const action = parts[4]
  if (!projectAlias || !sessionId || !opencodeMessageId || !VALID_CHANGED_FILES_ACTIONS.has(action)) {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  await answerCallbackQuery(callbackQuery.id)
  const viewOptions = { editMessageId: msg?.message_id }
  if (parts[5] != null) viewOptions.actionArg = parts[5]
  await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, viewOptions)
  return true
}
