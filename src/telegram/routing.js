export function threadIdOr0FromMessage(message) {
  const v = message?.message_thread_id
  return typeof v === "number" && Number.isInteger(v) ? v : 0
}

export function ctxKeyFrom(chatId, threadIdOr0) {
  return `${chatId}:${threadIdOr0 || 0}`
}
