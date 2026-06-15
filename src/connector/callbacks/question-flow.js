import { classifyBoundaryError, isStaleBoundaryError, makeBoundaryError } from "../../boundary-errors.js"
import { promptScopedSubmissionIdempotencyKey, promptSubmissionIdempotencyKey } from "../idempotency.js"
import { liveQuestionPromptStatus, shouldRetrySubmittedPrompt } from "../prompt-submission.js"
import { hasHandledQuestion, questionRejectIdempotencyKey } from "./question-state.js"

function ignoreError() {}

function promptSubmissionScopeMetadata({ projectAlias, ctxKey, sessionID, promptId, promptType, operation, finalKey }) {
  return {
    kind: "prompt-submission-scope",
    projectAlias,
    ctxKey,
    sessionId: sessionID,
    promptId,
    promptType,
    operation,
    finalKey,
  }
}

function makeQuestionSubmissionInFlightError() {
  return makeBoundaryError({
    source: "opencode",
    operation: "GET /question",
    method: "GET",
    pathname: "/question",
    kind: "network",
    outcome: "retryable",
    message: "Question prompt submission is already in progress",
  })
}

async function answerFinishedQuestion({
  callbackQuery,
  ctxMeta,
  msg,
  projectAlias,
  result,
  successText,
  answerCallbackQuery,
  deleteInteractiveMessage,
  sendToThread,
  t,
}) {
  await answerCallbackQuery(
    callbackQuery.id,
    result?.outcome === "stale" ? "No longer active" : result?.outcome === "retryable" ? "Temporarily unavailable" : successText,
  )
  if (result?.outcome === "retryable") {
    await sendToThread(ctxMeta, t(ctxMeta, "callbacks.actionTemporarilyUnavailable")).catch(ignoreError)
  } else {
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  }
}

export async function handleQuestionRejectAction({
  callbackQuery,
  ctxMeta,
  msg,
  store,
  oc,
  projectAlias,
  questionId,
  effectiveSessionID,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  hasIdempotencyKey,
  markIdempotencyKey,
  cleanupQuestionState,
  sendToThread,
  recordCallbackOutcome,
  recordPromptAnswered,
  t,
}) {
  const rejectKey = questionRejectIdempotencyKey(projectAlias, effectiveSessionID, questionId)
  const submittedKey = promptSubmissionIdempotencyKey(rejectKey)
  const scopedSubmittedKey = promptScopedSubmissionIdempotencyKey(projectAlias, effectiveSessionID, questionId, "question")
  if (hasIdempotencyKey(rejectKey) || hasHandledQuestion(store, projectAlias, effectiveSessionID, questionId)) {
    cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Already handled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (hasIdempotencyKey(submittedKey)) {
    const liveStatus = await liveQuestionPromptStatus(oc, questionId, effectiveSessionID)
    if (liveStatus === "retryable") {
      throw makeBoundaryError({
        source: "opencode",
        operation: "GET /question",
        method: "GET",
        pathname: "/question",
        kind: "network",
        outcome: "retryable",
        message: "Question prompt status temporarily unavailable",
      })
    }
    if (!shouldRetrySubmittedPrompt(liveStatus)) {
      await markIdempotencyKey(rejectKey, {
        kind: "question-reject",
        projectAlias,
        ctxKey: ctxMeta.ctxKey,
        operation: "rejectQuestion",
      })
      cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
      await flushStoreIfAvailable()
      await answerCallbackQuery(callbackQuery.id, "Already handled")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
  } else if (hasIdempotencyKey(scopedSubmittedKey)) {
    const liveStatus = await liveQuestionPromptStatus(oc, questionId, effectiveSessionID)
    if (liveStatus === "retryable" || shouldRetrySubmittedPrompt(liveStatus)) throw makeQuestionSubmissionInFlightError()
    cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, effectiveSessionID)
    await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, "Already handled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  } else {
    await markIdempotencyKey(scopedSubmittedKey, promptSubmissionScopeMetadata({
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      sessionID: effectiveSessionID,
      promptId: questionId,
      promptType: "question",
      operation: "rejectQuestion",
      finalKey: rejectKey,
    }))
    await markIdempotencyKey(submittedKey, {
      kind: "prompt-submission",
      projectAlias,
      ctxKey: ctxMeta.ctxKey,
      sessionId: effectiveSessionID,
      operation: "rejectQuestion",
    })
    await flushStoreIfAvailable()
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
    const retryableClassification = classifyBoundaryError(err, { source: "opencode", pathname: `/question/${questionId}/reject`, method: "POST" })
    if (retryableClassification.retryable) {
      throw retryableClassification.error
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

export async function startQuestionCustomAnswer({
  callbackQuery,
  ctxMeta,
  msg,
  projectAlias,
  questionId,
  effectiveSessionID,
  qIndex,
  q,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  setAwaitingCustomAnswerState,
  sendQuestionCustomAnswerPrompt,
  runtime,
}) {
  setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, ...(effectiveSessionID ? { sessionID: effectiveSessionID } : {}), qIndex })
  try {
    await flushStoreIfAvailable()
  } catch (err) {
    setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
    try {
      await flushStoreIfAvailable()
    } catch (rollbackErr) {
      runtime.logger?.error?.("Failed to roll back custom-answer flow state:", rollbackErr?.message || String(rollbackErr))
    }
    throw err
  }
  try {
    await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question", { sessionID: effectiveSessionID })
  } catch (err) {
    setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
    runtime.logger?.error?.("Failed to start custom-answer flow:", err?.message || String(err))
    try {
      await flushStoreIfAvailable()
    } catch (rollbackErr) {
      runtime.logger?.error?.("Failed to roll back custom-answer flow state:", rollbackErr?.message || String(rollbackErr))
      throw rollbackErr
    }
    const classification = classifyBoundaryError(err, { source: "telegram", operation: "send custom-answer prompt" })
    if (classification.retryable) throw classification.error
    await answerCallbackQuery(callbackQuery.id, "Unavailable")
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Send answer")
  await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  return true
}

export async function cancelQuestionCustomAnswer({
  callbackQuery,
  ctxMeta,
  msg,
  answerCallbackQuery,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  setAwaitingCustomAnswerState,
}) {
  setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
  await flushStoreIfAvailable()
  await answerCallbackQuery(callbackQuery.id, "Cancelled")
  await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  return true
}

export async function selectSingleChoiceQuestion({
  callbackQuery,
  ctxMeta,
  msg,
  projectAlias,
  wizard,
  req,
  qIndex,
  label,
  answerCallbackQuery,
  deleteInteractiveMessage,
  sendToThread,
  cloneWizardState,
  applyWizardState,
  persistQuestionWizard,
  persistQuestionWizardDurably,
  finishQuestionWizard,
  runtime,
  t,
}) {
  const previousWizard = cloneWizardState(wizard)
  const nextWizard = cloneWizardState(wizard)
  nextWizard.answers[qIndex] = [label]
  const nextIndex = qIndex + 1
  if (nextIndex >= req.questions.length) {
    applyWizardState(wizard, nextWizard)
    persistQuestionWizard(wizard)
    const result = await finishQuestionWizard(wizard)
    await answerFinishedQuestion({
      callbackQuery,
      ctxMeta,
      msg,
      projectAlias,
      result,
      successText: "Selected",
      answerCallbackQuery,
      deleteInteractiveMessage,
      sendToThread,
      t,
    })
    return true
  }
  nextWizard.index = nextIndex
  applyWizardState(wizard, nextWizard)
  await persistQuestionWizardDurably(wizard, previousWizard)
  try {
    await runtime.sendCurrentQuestionStep(wizard)
  } catch (err) {
    applyWizardState(wizard, previousWizard)
    await persistQuestionWizardDurably(wizard)
    throw err
  }
  await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  await answerCallbackQuery(callbackQuery.id, "Selected")
  return true
}

export async function toggleMultipleChoiceQuestion({
  callbackQuery,
  messageId,
  wizard,
  qIndex,
  label,
  answerCallbackQuery,
  cloneWizardState,
  applyWizardState,
  persistQuestionWizardDurably,
  runtime,
}) {
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

export async function finishMultipleChoiceQuestion({
  callbackQuery,
  ctxMeta,
  msg,
  projectAlias,
  wizard,
  req,
  qIndex,
  selected,
  answerCallbackQuery,
  deleteInteractiveMessage,
  sendToThread,
  cloneWizardState,
  applyWizardState,
  persistQuestionWizard,
  persistQuestionWizardDurably,
  finishQuestionWizard,
  runtime,
  t,
}) {
  const previousWizard = cloneWizardState(wizard)
  const nextWizard = cloneWizardState(wizard)
  nextWizard.answers[qIndex] = selected
  const nextIndex = qIndex + 1
  if (nextIndex >= req.questions.length) {
    applyWizardState(wizard, nextWizard)
    persistQuestionWizard(wizard)
    const result = await finishQuestionWizard(wizard)
    await answerFinishedQuestion({
      callbackQuery,
      ctxMeta,
      msg,
      projectAlias,
      result,
      successText: "Done",
      answerCallbackQuery,
      deleteInteractiveMessage,
      sendToThread,
      t,
    })
    return true
  }
  nextWizard.index = nextIndex
  applyWizardState(wizard, nextWizard)
  await persistQuestionWizardDurably(wizard, previousWizard)
  try {
    await runtime.sendCurrentQuestionStep(wizard)
  } catch (err) {
    applyWizardState(wizard, previousWizard)
    await persistQuestionWizardDurably(wizard)
    throw err
  }
  await deleteInteractiveMessage(ctxMeta, msg?.message_id)
  await answerCallbackQuery(callbackQuery.id, "Done")
  return true
}
