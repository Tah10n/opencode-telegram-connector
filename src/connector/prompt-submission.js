import { classifyBoundaryError } from "../boundary-errors.js"
import { promptIdentity } from "./idempotency.js"

function promptEntryMatches(entry, promptId, sessionID = "") {
  const id = String(promptId || "").trim()
  if (!id || entry?.id !== id) return false
  const expectedSession = String(sessionID || "").trim()
  const entrySession = String(entry?.sessionID || "").trim()
  if (!expectedSession) return !entrySession
  return promptIdentity(entry.id, entry.sessionID) === promptIdentity(id, expectedSession)
}

async function livePromptStatus({ list, promptId, sessionID, context }) {
  if (typeof list !== "function") return "unknown"
  try {
    const prompts = await list()
    if (!Array.isArray(prompts)) return "unknown"
    return prompts.some((entry) => promptEntryMatches(entry, promptId, sessionID)) ? "active" : "inactive"
  } catch (err) {
    const classification = classifyBoundaryError(err, context)
    if (classification.retryable) return "retryable"
    throw classification.error
  }
}

export function shouldRetrySubmittedPrompt(status) {
  return status === "active" || status === "unknown"
}

export async function livePermissionPromptStatus(oc, permissionId, sessionID = "") {
  return livePromptStatus({
    list: () => oc?.listPermissions?.(),
    promptId: permissionId,
    sessionID,
    context: { source: "opencode", operation: "GET /permission", method: "GET", pathname: "/permission" },
  })
}

export async function liveQuestionPromptStatus(oc, questionId, sessionID = "") {
  return livePromptStatus({
    list: () => oc?.listQuestions?.(),
    promptId: questionId,
    sessionID,
    context: { source: "opencode", operation: "GET /question", method: "GET", pathname: "/question" },
  })
}
