import {
  questionRejectIdempotencyKey,
  questionReplyIdempotencyPrefix,
} from "../idempotency.js"
import { isRetryableBoundaryError, isStaleBoundaryError } from "../../boundary-errors.js"

function ignoreError() {}

function isIntegerToken(value) {
  return typeof value === "string" && value.length > 0 && Number.isInteger(Number(value))
}

function matchesQuestionCallbackRest(rest) {
  if (rest.length === 1) return rest[0] === "reject"
  if (rest.length === 2) return isIntegerToken(rest[0]) && (rest[1] === "custom" || rest[1] === "cancel_custom" || rest[1] === "done")
  if (rest.length === 3) return isIntegerToken(rest[0]) && (rest[1] === "o" || rest[1] === "t") && isIntegerToken(rest[2])
  return false
}

function parseQuestionParts(parts) {
  const oldShape = { projectAlias: parts[1], sessionID: "", questionId: parts[2], rest: parts.slice(3), isOldShape: true }
  const newShape = { projectAlias: parts[1], sessionID: parts[2] || "", questionId: parts[3], rest: parts.slice(4), isOldShape: false }
  if (matchesQuestionCallbackRest(newShape.rest) && !matchesQuestionCallbackRest(oldShape.rest)) return newShape
  return oldShape
}

function hasHandledQuestion(store, projectAlias, sessionID, questionId) {
  return (typeof store?.hasIdempotencyKeyPrefix === "function" &&
      (store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId)) ||
        store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, "", questionId)))) ||
    store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, sessionID, questionId)) ||
    store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, "", questionId))
}

export async function handleQuestionCallback({
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
  cleanupQuestionState,
  isPromptBindingCurrent,
  answerStalePromptCallback,
  getWizard,
  setAwaitingCustomAnswerState,
  sendQuestionCustomAnswerPrompt,
  cloneWizardState,
  applyWizardState,
  persistQuestionWizard,
  persistQuestionWizardDurably,
  finishQuestionWizard,
  sendToThread,
  recordCallbackOutcome,
  recordPromptAnswered,
  t,
  runtime,
}) {
  const { projectAlias, sessionID, questionId, rest, isOldShape } = parseQuestionParts(parts)
  const oc = ocByAlias[projectAlias]
  if (!oc) {
    await answerCallbackQuery(callbackQuery.id, "Unknown project")
    return true
  }

  const wizard = getWizard(projectAlias, questionId, sessionID)
  const effectiveSessionID = sessionID || wizard?.sessionID || ""
  if (!(await isPromptBindingCurrent(ctxMeta.ctxKey, projectAlias, sessionID, { isOldShape, stateSessionID: wizard?.sessionID || "" }))) {
    cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
    await answerStalePromptCallback(callbackQuery, ctxMeta, msg?.message_id, projectAlias)
    return true
  }
  if (rest.length === 1 && rest[0] === "reject") {
    const rejectKey = questionRejectIdempotencyKey(projectAlias, effectiveSessionID, questionId)
    if (hasIdempotencyKey(rejectKey) || hasHandledQuestion(store, projectAlias, effectiveSessionID, questionId)) {
      cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
    try {
      await oc.rejectQuestion(questionId)
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/question/${questionId}/reject`, method: "POST" })) {
        await markIdempotencyKey(rejectKey, {
          kind: "question-reject",
          projectAlias,
          ctxKey: ctxMeta.ctxKey,
          operation: "rejectQuestion",
        })
        cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
        await flushStoreIfAvailable()
        recordCallbackOutcome?.(projectAlias, "stale")
        await answerCallbackQuery(callbackQuery.id, "No longer active")
        await deleteInteractiveMessage(ctxMeta, msg?.message_id)
        return true
      }
      if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/question/${questionId}/reject`, method: "POST" })) {
        recordCallbackOutcome?.(projectAlias, "retryable")
        await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
        await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
        return true
      }
      throw err
    }
    await markIdempotencyKey(rejectKey, {
      kind: "question-reject",
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      operation: "rejectQuestion",
    })
    recordPromptAnswered?.(projectAlias, "question", "rejected")
    cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Rejected")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }

  if (!wizard) {
    if (hasHandledQuestion(store, projectAlias, effectiveSessionID, questionId)) {
      cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Not found")
    return true
  }
  if (rest.length < 2) {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }

  const qIndex = Number(rest[0])
  const action = rest[1]
  const arg = rest[2]
  if (!Number.isInteger(qIndex) || qIndex !== wizard.index) {
    await answerCallbackQuery(callbackQuery.id, "Out of date")
    return true
  }

  const req = wizard.request
  const q = req.questions[qIndex]
  const multiple = q.multiple === true
  const allowCustom = q.custom !== false
  const messageId = callbackQuery.message?.message_id

  if (action === "custom") {
    if (!allowCustom) {
      await answerCallbackQuery(callbackQuery.id, "Custom disabled")
      return true
    }
    setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, ...(effectiveSessionID ? { sessionID: effectiveSessionID } : {}), qIndex })
    try {
      await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question", { sessionID: effectiveSessionID })
    } catch (err) {
      setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      runtime.logger?.error?.("Failed to start custom-answer flow:", err?.message || String(err))
      await answerCallbackQuery(callbackQuery.id, "Unavailable")
      return true
    }
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Send answer")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (action === "cancel_custom") {
    setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Cancelled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (action === "o") {
    const optIndex = Number(arg)
    if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const label = String(q.options[optIndex].label)
    const previousWizard = cloneWizardState(wizard)
    const nextWizard = cloneWizardState(wizard)
    nextWizard.answers[qIndex] = [label]
    const nextIndex = qIndex + 1
    if (nextIndex >= req.questions.length) {
      applyWizardState(wizard, nextWizard)
      persistQuestionWizard(wizard)
      const result = await finishQuestionWizard(wizard)
      await answerCallbackQuery(
        callbackQuery.id,
        result?.outcome === "stale" ? "No longer active" : result?.outcome === "retryable" ? "Temporarily unavailable" : "Selected",
      )
      if (result?.outcome === "retryable") {
        await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
      } else {
        await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      }
      return true
    } else {
      nextWizard.index = nextIndex
      await runtime.sendCurrentQuestionStep(nextWizard)
      applyWizardState(wizard, nextWizard)
      await persistQuestionWizardDurably(wizard, previousWizard)
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    }
    await answerCallbackQuery(callbackQuery.id, "Selected")
    return true
  }
  if (action === "t") {
    if (!multiple) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const optIndex = Number(arg)
    if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const label = String(q.options[optIndex].label)
    const current = new Set(wizard.selectedByIndex?.[qIndex] || [])
    if (current.has(label)) current.delete(label)
    else current.add(label)
    const previousWizard = cloneWizardState(wizard)
    const nextWizard = cloneWizardState(wizard)
    nextWizard.selectedByIndex[qIndex] = Array.from(current)
    if (messageId) await runtime.sendCurrentQuestionStep(nextWizard, { editMessageId: messageId })
    applyWizardState(wizard, nextWizard)
    await persistQuestionWizardDurably(wizard, previousWizard)
    await answerCallbackQuery(callbackQuery.id)
    return true
  }
  if (action === "done") {
    if (!multiple) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const selected = wizard.selectedByIndex?.[qIndex] || []
    const previousWizard = cloneWizardState(wizard)
    const nextWizard = cloneWizardState(wizard)
    nextWizard.answers[qIndex] = selected
    const nextIndex = qIndex + 1
    if (nextIndex >= req.questions.length) {
      applyWizardState(wizard, nextWizard)
      persistQuestionWizard(wizard)
      const result = await finishQuestionWizard(wizard)
      await answerCallbackQuery(
        callbackQuery.id,
        result?.outcome === "stale" ? "No longer active" : result?.outcome === "retryable" ? "Temporarily unavailable" : "Done",
      )
      if (result?.outcome === "retryable") {
        await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
      } else {
        await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      }
      return true
    } else {
      nextWizard.index = nextIndex
      await runtime.sendCurrentQuestionStep(nextWizard)
      applyWizardState(wizard, nextWizard)
      await persistQuestionWizardDurably(wizard, previousWizard)
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    }
    await answerCallbackQuery(callbackQuery.id, "Done")
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Unsupported")
  return true
}
