import {
  cancelQuestionCustomAnswer,
  finishMultipleChoiceQuestion,
  handleQuestionRejectAction,
  selectSingleChoiceQuestion,
  startQuestionCustomAnswer,
  toggleMultipleChoiceQuestion,
} from "./question-flow.js"
import { hasHandledQuestion, parseQuestionParts } from "./question-state.js"

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
    return handleQuestionRejectAction({
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
    })
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
    return startQuestionCustomAnswer({
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
    })
  }
  if (action === "cancel_custom") {
    return cancelQuestionCustomAnswer({
      callbackQuery,
      ctxMeta,
      msg,
      answerCallbackQuery,
      deleteInteractiveMessage,
      flushStoreIfAvailable,
      setAwaitingCustomAnswerState,
    })
  }
  if (action === "o") {
    const optIndex = Number(arg)
    if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    return selectSingleChoiceQuestion({
      callbackQuery,
      ctxMeta,
      msg,
      projectAlias,
      wizard,
      req,
      qIndex,
      label: String(q.options[optIndex].label),
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
    })
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
    return toggleMultipleChoiceQuestion({
      callbackQuery,
      messageId,
      wizard,
      qIndex,
      label: String(q.options[optIndex].label),
      answerCallbackQuery,
      cloneWizardState,
      applyWizardState,
      persistQuestionWizardDurably,
      runtime,
    })
  }
  if (action === "done") {
    if (!multiple) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    return finishMultipleChoiceQuestion({
      callbackQuery,
      ctxMeta,
      msg,
      projectAlias,
      wizard,
      req,
      qIndex,
      selected: wizard.selectedByIndex?.[qIndex] || [],
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
    })
  }
  await answerCallbackQuery(callbackQuery.id, "Unsupported")
  return true
}
