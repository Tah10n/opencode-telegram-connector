import { normalizeFeedMode } from "../state/store.js"

export function createCallbackHandlers(runtime) {
  const {
    tg,
    cb,
    store,
    projects,
    ocByAlias,
    ctxMetaFromMessage,
    isAllowedUser,
    bindCtxToSession,
    sendToThread,
    ensureProjectStarted,
    renderFeedSettings,
    renderChangedFilesView,
    renderSessionsList,
    feedModeLabel,
    setRejectNoteAwaitingState,
    sendRejectNotePrompt,
    getWizard,
    clearPersistedQuestionWizard,
    setAwaitingCustomAnswerState,
    sendQuestionCustomAnswerPrompt,
    cloneWizardState,
    applyWizardState,
    persistQuestionWizard,
    finishQuestionWizard,
    formatProjectUnavailable,
  } = runtime

  async function handleTelegramCallback(callbackQuery) {
    if (!isAllowedUser(callbackQuery?.from)) return
    const msg = callbackQuery.message
    const ctxMeta = ctxMetaFromMessage(msg)
    const data = cb.unpack(callbackQuery.data)
    if (!data) {
      await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    const parts = String(data).split("|")
    const kind = parts[0]

    if (kind === "s") {
      const projectAlias = parts[1]
      const targetSessionId = parts[2]
      const oc = ocByAlias[projectAlias]
      const binding = store.getBinding(ctxMeta.ctxKey)
      if (!oc || !projectAlias || !targetSessionId) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      if (!binding) {
        await tg.answerCallbackQuery(callbackQuery.id, "Not bound")
        return
      }
      if (binding.projectAlias !== projectAlias) {
        await tg.answerCallbackQuery(callbackQuery.id, "Binding changed")
        return
      }
      if (binding.sessionId === targetSessionId) {
        await tg.answerCallbackQuery(callbackQuery.id, "Already current")
        return
      }
      try {
        await oc.getSession(targetSessionId)
        await bindCtxToSession(ctxMeta, projectAlias, targetSessionId)
      } catch (err) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unavailable")
        await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(() => {})
        return
      }

      await tg.answerCallbackQuery(callbackQuery.id, "Switched")
      await renderSessionsList({ ...ctxMeta, chatId: msg?.chat?.id || ctxMeta.chatId }, {
        binding: { projectAlias, sessionId: targetSessionId },
        editMessageId: msg?.message_id,
      }).catch(async (err) => {
        runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
        await sendToThread(ctxMeta, `Switched to session: ${targetSessionId}`).catch(() => {})
      })
      return
    }

    if (kind === "srv") {
      const projectAlias = parts[1]
      const action = parts[2]
      if (!projectAlias || !projects?.[projectAlias]) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }
      if (action !== "start") {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id, "Starting…")
      void ensureProjectStarted(projectAlias, ctxMeta)
      return
    }

    if (kind === "feed") {
      const rawMode = parts[1]
      if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      const mode = normalizeFeedMode(rawMode)
      store.setFeedMode(ctxMeta.ctxKey, mode)
      await tg.answerCallbackQuery(callbackQuery.id, `Feed: ${feedModeLabel(mode)}`).catch(() => {})
      await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id }).catch(() => {})
      return
    }

    if (kind === "cf") {
      const projectAlias = parts[1]
      const sessionId = parts[2]
      const opencodeMessageId = parts[3]
      const action = parts[4]
      if (!projectAlias || !sessionId || !opencodeMessageId || (action !== "show" && action !== "back")) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id).catch(() => {})
      await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, { editMessageId: msg?.message_id }).catch(
        () => {},
      )
      return
    }

    if (kind === "p") {
      const projectAlias = parts[1]
      const permissionId = parts[2]
      const action = parts[3]
      const oc = ocByAlias[projectAlias]
      if (!oc) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }
      if (action === "once" || action === "always" || action === "reject") {
        await oc.replyPermission(permissionId, { reply: action })
        store.deletePendingPermission(projectAlias, permissionId)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "OK").catch(() => {})
        return
      }
      if (action === "reject_note") {
        setRejectNoteAwaitingState(ctxMeta.ctxKey, { projectAlias, permissionId })
        await tg.answerCallbackQuery(callbackQuery.id, "Send note")
        await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId)
        return
      }
      if (action === "cancel_note") {
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Cancelled")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    if (kind === "q") {
      const projectAlias = parts[1]
      const questionId = parts[2]
      const oc = ocByAlias[projectAlias]
      if (!oc) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }

      const wizard = getWizard(projectAlias, questionId)
      if (parts.length === 4 && parts[3] === "reject") {
        await oc.rejectQuestion(questionId)
        if (wizard) {
          runtime.questionWizards.delete(`${projectAlias}:${questionId}`)
          clearPersistedQuestionWizard(projectAlias, questionId)
        }
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Rejected").catch(() => {})
        return
      }

      if (!wizard) {
        await tg.answerCallbackQuery(callbackQuery.id, "Not found")
        return
      }
      if (parts.length < 5) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      const qIndex = Number(parts[3])
      const action = parts[4]
      const arg = parts[5]
      if (!Number.isInteger(qIndex) || qIndex !== wizard.index) {
        await tg.answerCallbackQuery(callbackQuery.id, "Out of date")
        return
      }

      const req = wizard.request
      const q = req.questions[qIndex]
      const multiple = q.multiple === true
      const allowCustom = q.custom !== false
      const messageId = callbackQuery.message?.message_id

      if (action === "custom") {
        if (!allowCustom) {
          await tg.answerCallbackQuery(callbackQuery.id, "Custom disabled")
          return
        }
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, qIndex })
        await tg.answerCallbackQuery(callbackQuery.id, "Send answer")
        await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question")
        return
      }
      if (action === "cancel_custom") {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Cancelled")
        return
      }
      if (action === "o") {
        const optIndex = Number(arg)
        if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const label = String(q.options[optIndex].label)
        const nextWizard = cloneWizardState(wizard)
        nextWizard.answers[qIndex] = [label]
        const nextIndex = qIndex + 1
        if (nextIndex >= req.questions.length) {
          persistQuestionWizard(nextWizard)
          await finishQuestionWizard(nextWizard)
        } else {
          nextWizard.index = nextIndex
          await runtime.sendCurrentQuestionStep(nextWizard)
          applyWizardState(wizard, nextWizard)
          persistQuestionWizard(wizard)
        }
        await tg.answerCallbackQuery(callbackQuery.id, "Selected").catch(() => {})
        return
      }
      if (action === "t") {
        if (!multiple) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const optIndex = Number(arg)
        if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const label = String(q.options[optIndex].label)
        const current = new Set(wizard.selectedByIndex?.[qIndex] || [])
        if (current.has(label)) current.delete(label)
        else current.add(label)
        const nextWizard = cloneWizardState(wizard)
        nextWizard.selectedByIndex[qIndex] = Array.from(current)
        if (messageId) await runtime.sendCurrentQuestionStep(nextWizard, { editMessageId: messageId })
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        await tg.answerCallbackQuery(callbackQuery.id).catch(() => {})
        return
      }
      if (action === "done") {
        if (!multiple) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const selected = wizard.selectedByIndex?.[qIndex] || []
        const nextWizard = cloneWizardState(wizard)
        nextWizard.answers[qIndex] = selected
        const nextIndex = qIndex + 1
        if (nextIndex >= req.questions.length) {
          persistQuestionWizard(nextWizard)
          await finishQuestionWizard(nextWizard)
        } else {
          nextWizard.index = nextIndex
          await runtime.sendCurrentQuestionStep(nextWizard)
          applyWizardState(wizard, nextWizard)
          persistQuestionWizard(wizard)
        }
        await tg.answerCallbackQuery(callbackQuery.id, "Done").catch(() => {})
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id, "Unsupported")
      return
    }

    await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
  }

  return { handleTelegramCallback }
}
