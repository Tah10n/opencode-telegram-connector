export async function sendChangedFilesExport({
  claimChangedFilesExport,
  markChangedFilesExportSent,
  releaseChangedFilesExport,
  tg,
  ctxMeta,
  projectAlias,
  sessionId,
  messageId,
  action,
  actionArg = "",
  content,
  filename,
  caption,
  markAction = action,
  onSent,
} = {}) {
  const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, action, actionArg)
  if (!claim.claimed) return false
  try {
    await tg.sendDocument(
      ctxMeta.chatId,
      content,
      filename,
      caption,
      { message_thread_id: ctxMeta.threadIdOr0 || undefined },
    )
    await onSent?.()
    await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action: markAction })
  } finally {
    releaseChangedFilesExport(claim.key)
  }
  return true
}
