import crypto from "node:crypto"

function hashValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return crypto.createHash("sha256").update(text || "").digest("hex").slice(0, 24)
}

function cleanPart(value) {
  return encodeURIComponent(String(value ?? "").trim()).replace(/%/g, "~")
}

function key(kind, ...parts) {
  return [kind, ...parts.map(cleanPart)].join(":")
}

export function hashIdempotencyValue(value) {
  return hashValue(value)
}

export function telegramUpdateIdempotencyKey(updateId) {
  if (!Number.isInteger(updateId)) return null
  return key("tg-update", updateId)
}

export function telegramMessageIdempotencyKey(ctxMeta, msg) {
  const messageId = msg?.message_id
  if (!ctxMeta?.chatId || !Number.isInteger(messageId)) return null
  return key("tg-message", ctxMeta.chatId, ctxMeta.threadIdOr0 || 0, messageId)
}

export function promptIdentity(promptId, sessionID = "") {
  const id = String(promptId || "").trim()
  if (!id) return ""
  const session = String(sessionID || "").trim()
  return session ? `${session}:${id}` : id
}

function unpackSessionScopedArgs(a, b, c) {
  if (c !== undefined) return { sessionID: a, id: b, tail: c }
  return { sessionID: "", id: a, tail: b }
}

export function permissionReplyIdempotencyKey(projectAlias, sessionOrPermissionId, permissionOrAction, maybeAction) {
  const { sessionID, id: permissionId, tail: action } = unpackSessionScopedArgs(sessionOrPermissionId, permissionOrAction, maybeAction)
  if (!projectAlias || !permissionId || !action) return null
  return key("permission-reply", projectAlias, promptIdentity(permissionId, sessionID), action)
}

export function permissionReplyIdempotencyPrefix(projectAlias, sessionID, permissionId) {
  if (!projectAlias || !permissionId) return null
  return key("permission-reply", projectAlias, promptIdentity(permissionId, sessionID)) + ":"
}

export function permissionNoteIdempotencyKey(projectAlias, sessionOrPermissionId, permissionOrNote, maybeNote) {
  const { sessionID, id: permissionId, tail: note } = unpackSessionScopedArgs(sessionOrPermissionId, permissionOrNote, maybeNote)
  if (!projectAlias || !permissionId) return null
  return key("permission-note", projectAlias, promptIdentity(permissionId, sessionID), hashValue(note || ""))
}

export function permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId) {
  if (!projectAlias || !permissionId) return null
  return key("permission-note", projectAlias, promptIdentity(permissionId, sessionID)) + ":"
}

export function questionReplyIdempotencyKey(projectAlias, sessionOrQuestionId, questionOrAnswers, maybeAnswers) {
  const { sessionID, id: questionId, tail: answers } = unpackSessionScopedArgs(sessionOrQuestionId, questionOrAnswers, maybeAnswers)
  if (!projectAlias || !questionId) return null
  return key("question-reply", projectAlias, promptIdentity(questionId, sessionID), hashValue(answers || []))
}

export function questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId) {
  if (!projectAlias || !questionId) return null
  return key("question-reply", projectAlias, promptIdentity(questionId, sessionID)) + ":"
}

export function questionRejectIdempotencyKey(projectAlias, sessionOrQuestionId, maybeQuestionId) {
  const sessionID = maybeQuestionId === undefined ? "" : sessionOrQuestionId
  const questionId = maybeQuestionId === undefined ? sessionOrQuestionId : maybeQuestionId
  if (!projectAlias || !questionId) return null
  return key("question-reject", projectAlias, promptIdentity(questionId, sessionID))
}
