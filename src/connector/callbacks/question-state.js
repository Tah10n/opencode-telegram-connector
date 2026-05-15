import {
  questionRejectIdempotencyKey,
  questionReplyIdempotencyPrefix,
} from "../idempotency.js"

function isIntegerToken(value) {
  return typeof value === "string" && value.length > 0 && Number.isInteger(Number(value))
}

function matchesQuestionCallbackRest(rest) {
  if (rest.length === 1) return rest[0] === "reject"
  if (rest.length === 2) return isIntegerToken(rest[0]) && (rest[1] === "custom" || rest[1] === "cancel_custom" || rest[1] === "done")
  if (rest.length === 3) return isIntegerToken(rest[0]) && (rest[1] === "o" || rest[1] === "t") && isIntegerToken(rest[2])
  return false
}

export function parseQuestionParts(parts) {
  const oldShape = { projectAlias: parts[1], sessionID: "", questionId: parts[2], rest: parts.slice(3), isOldShape: true }
  const newShape = { projectAlias: parts[1], sessionID: parts[2] || "", questionId: parts[3], rest: parts.slice(4), isOldShape: false }
  if (matchesQuestionCallbackRest(newShape.rest) && !matchesQuestionCallbackRest(oldShape.rest)) return newShape
  return oldShape
}

export function hasHandledQuestion(store, projectAlias, sessionID, questionId) {
  return (typeof store?.hasIdempotencyKeyPrefix === "function" &&
      (store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId)) ||
        store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, "", questionId)))) ||
    store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, sessionID, questionId)) ||
    store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, "", questionId))
}

export { questionRejectIdempotencyKey }
