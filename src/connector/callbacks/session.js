import { requireSafeOpenCodeId } from "../../opencode/ids.js"
import { sessionItemsFromResponse } from "../../session-response.js"
import { sessionProjectScopeDecision, sessionProjectScopeDecisionWithFallback, sessionProjectScopeErrorText } from "../../session-project-scope.js"

function ignoreError() {}

async function matchingSessionListEvidence(oc, project, sessionId) {
  const directory = String(project?.directory ?? "").trim()
  if (!directory || typeof oc?.listSessions !== "function") return null
  const sessions = sessionItemsFromResponse(await oc.listSessions({ directory }))
  return sessions.find((session) => String(session?.id ?? "").trim() === sessionId && sessionProjectScopeDecision(session, project).ok) || null
}

export async function handleSessionCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  projects,
  ocByAlias,
  answerCallbackQuery,
  closeInteractiveMessage,
  renderSessionsList,
  sendToThread,
  formatProjectUnavailable,
  handleNewCommand,
  commitStateMutation,
  bindCtxToSession,
  buildSessionSwitchText,
  flushStoreIfAvailable,
  t,
  runtime,
}) {
  if (parts[1] === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (parts[1] === "refresh") {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await answerCallbackQuery(callbackQuery.id, "Not bound")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Sessions")
    await renderSessionsList(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(async (err) => {
      runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
    })
    return true
  }
  if (parts[1] === "new") {
    if (typeof handleNewCommand !== "function") {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    if (!store.getBinding(ctxMeta.ctxKey)) {
      await answerCallbackQuery(callbackQuery.id, "Not bound")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Creating…")
    await handleNewCommand(ctxMeta, "").then(() => flushStoreIfAvailable()).catch(async (err) => {
      runtime.logger?.error?.("Failed to create session from callback:", err?.message || String(err))
      await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionFailedTryNew")).catch(ignoreError)
    })
    return true
  }

  const projectAlias = parts[1]
  const targetSessionId = parts[2]
  const oc = ocByAlias[projectAlias]
  const binding = store.getBinding(ctxMeta.ctxKey)
  if (!oc || !projectAlias || !targetSessionId) {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  if (!binding) {
    await answerCallbackQuery(callbackQuery.id, "Not bound")
    return true
  }
  if (binding.projectAlias !== projectAlias) {
    await answerCallbackQuery(callbackQuery.id, "Binding changed")
    return true
  }
  let safeTargetSessionId
  try {
    safeTargetSessionId = requireSafeOpenCodeId(targetSessionId, "session id")
  } catch {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  if (binding.sessionId === safeTargetSessionId) {
    await answerCallbackQuery(callbackQuery.id, "Already current")
    return true
  }
  try {
    const targetSession = await oc.getSession(safeTargetSessionId)
    const project = projects?.[projectAlias]
    const initialScopeDecision = sessionProjectScopeDecision(targetSession, project)
    const fallbackEvidence = initialScopeDecision.reason === "missing-directory"
      ? await matchingSessionListEvidence(oc, project, safeTargetSessionId)
      : null
    const scopeDecision = sessionProjectScopeDecisionWithFallback(targetSession, project, fallbackEvidence)
    if (!scopeDecision.ok) {
      await answerCallbackQuery(callbackQuery.id, "Wrong project")
      await sendToThread(ctxMeta, sessionProjectScopeErrorText(projectAlias, safeTargetSessionId, scopeDecision)).catch(ignoreError)
      return true
    }
  } catch (err) {
    await answerCallbackQuery(callbackQuery.id, "Unavailable")
    await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
    return true
  }

  await commitStateMutation(() => bindCtxToSession(ctxMeta, projectAlias, safeTargetSessionId))

  await answerCallbackQuery(callbackQuery.id, "Switched")
  await renderSessionsList({ ...ctxMeta, chatId: msg?.chat?.id || ctxMeta.chatId }, {
    binding: { projectAlias, sessionId: safeTargetSessionId },
    editMessageId: msg?.message_id,
  }).catch(async (err) => {
    runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
    await sendToThread(ctxMeta, await buildSessionSwitchText(projectAlias, safeTargetSessionId, { ctxKey: ctxMeta.ctxKey, locale: ctxMeta.locale })).catch(ignoreError)
  })
  return true
}
