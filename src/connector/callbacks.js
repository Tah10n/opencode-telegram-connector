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
    isMissingPromptError = () => false,
    formatProjectUnavailable,
  } = runtime

  async function answerCallbackQuery(callbackQueryId, text) {
    await tg.answerCallbackQuery(callbackQueryId, text).catch(() => {})
  }

  async function handleTelegramCallback(callbackQuery) {
    if (!isAllowedUser(callbackQuery?.from)) return
    const msg = callbackQuery.message
    const ctxMeta = ctxMetaFromMessage(msg)
    const data = cb.unpack(callbackQuery.data)
    if (!data) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    const parts = String(data).split("|")
    const kind = parts[0]

    try {
      if (kind === "s") {
        const projectAlias = parts[1]
        const targetSessionId = parts[2]
        const oc = ocByAlias[projectAlias]
        const binding = store.getBinding(ctxMeta.ctxKey)
        if (!oc || !projectAlias || !targetSessionId) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (!binding) {
          await answerCallbackQuery(callbackQuery.id, "Not bound")
          return
        }
        if (binding.projectAlias !== projectAlias) {
          await answerCallbackQuery(callbackQuery.id, "Binding changed")
          return
        }
        if (binding.sessionId === targetSessionId) {
          await answerCallbackQuery(callbackQuery.id, "Already current")
          return
        }
        try {
          await oc.getSession(targetSessionId)
          await bindCtxToSession(ctxMeta, projectAlias, targetSessionId)
        } catch (err) {
          await answerCallbackQuery(callbackQuery.id, "Unavailable")
          await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(() => {})
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Switched")
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
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }
        if (action !== "start") {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Starting…")
        void ensureProjectStarted(projectAlias, ctxMeta)
        return
      }

      if (kind === "feed") {
        const rawMode = parts[1]
        if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const mode = normalizeFeedMode(rawMode)
        store.setFeedMode(ctxMeta.ctxKey, mode)
        await answerCallbackQuery(callbackQuery.id, `Feed: ${feedModeLabel(mode)}`)
        await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id }).catch(() => {})
        return
      }

      if (kind === "cf") {
        const projectAlias = parts[1]
        const sessionId = parts[2]
        const opencodeMessageId = parts[3]
        const action = parts[4]
        if (!projectAlias || !sessionId || !opencodeMessageId || (action !== "show" && action !== "back")) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        await answerCallbackQuery(callbackQuery.id)
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
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }
        if (action === "once" || action === "always" || action === "reject") {
          try {
            await oc.replyPermission(permissionId, { reply: action })
          } catch (err) {
            if (!isMissingPromptError(err)) throw err
            store.deletePendingPermission(projectAlias, permissionId)
            setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
            await answerCallbackQuery(callbackQuery.id, "No longer active")
            return
          }
          store.deletePendingPermission(projectAlias, permissionId)
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "OK")
          return
        }
        if (action === "reject_note") {
          try {
            await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId)
          } catch (err) {
            runtime.logger?.error?.("Failed to start reject-note flow:", err?.message || String(err))
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            return
          }
          setRejectNoteAwaitingState(ctxMeta.ctxKey, { projectAlias, permissionId })
          await answerCallbackQuery(callbackQuery.id, "Send note")
          return
        }
        if (action === "cancel_note") {
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "q") {
        const projectAlias = parts[1]
        const questionId = parts[2]
        const oc = ocByAlias[projectAlias]
        if (!oc) {
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }

        const wizard = getWizard(projectAlias, questionId)
        if (parts.length === 4 && parts[3] === "reject") {
          try {
            await oc.rejectQuestion(questionId)
          } catch (err) {
            if (!isMissingPromptError(err)) throw err
            if (wizard) {
              runtime.questionWizards.delete(`${projectAlias}:${questionId}`)
              clearPersistedQuestionWizard(projectAlias, questionId)
            }
            setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
            await answerCallbackQuery(callbackQuery.id, "No longer active")
            return
          }
          if (wizard) {
            runtime.questionWizards.delete(`${projectAlias}:${questionId}`)
            clearPersistedQuestionWizard(projectAlias, questionId)
          }
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "Rejected")
          return
        }

        if (!wizard) {
          await answerCallbackQuery(callbackQuery.id, "Not found")
          return
        }
        if (parts.length < 5) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }

        const qIndex = Number(parts[3])
        const action = parts[4]
        const arg = parts[5]
        if (!Number.isInteger(qIndex) || qIndex !== wizard.index) {
          await answerCallbackQuery(callbackQuery.id, "Out of date")
          return
        }

        const req = wizard.request
        const q = req.questions[qIndex]
        const multiple = q.multiple === true
        const allowCustom = q.custom !== false
        const messageId = callbackQuery.message?.message_id

        if (action === "custom") {
          if (!allowCustom) {
            await answerCallbackQuery(callbackQuery.id, "Custom disabled")
            return
          }
          try {
            await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question")
          } catch (err) {
            runtime.logger?.error?.("Failed to start custom-answer flow:", err?.message || String(err))
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            return
          }
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, qIndex })
          await answerCallbackQuery(callbackQuery.id, "Send answer")
          return
        }
        if (action === "cancel_custom") {
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          return
        }
        if (action === "o") {
          const optIndex = Number(arg)
          if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          const label = String(q.options[optIndex].label)
          const nextWizard = cloneWizardState(wizard)
          nextWizard.answers[qIndex] = [label]
          const nextIndex = qIndex + 1
          if (nextIndex >= req.questions.length) {
            persistQuestionWizard(nextWizard)
            const result = await finishQuestionWizard(nextWizard)
            await answerCallbackQuery(callbackQuery.id, result?.stale ? "No longer active" : "Selected")
            return
          } else {
            nextWizard.index = nextIndex
            await runtime.sendCurrentQuestionStep(nextWizard)
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
          }
          await answerCallbackQuery(callbackQuery.id, "Selected")
          return
        }
        if (action === "t") {
          if (!multiple) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          const optIndex = Number(arg)
          if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
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
          await answerCallbackQuery(callbackQuery.id)
          return
        }
        if (action === "done") {
          if (!multiple) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          const selected = wizard.selectedByIndex?.[qIndex] || []
          const nextWizard = cloneWizardState(wizard)
          nextWizard.answers[qIndex] = selected
          const nextIndex = qIndex + 1
          if (nextIndex >= req.questions.length) {
            persistQuestionWizard(nextWizard)
            const result = await finishQuestionWizard(nextWizard)
            await answerCallbackQuery(callbackQuery.id, result?.stale ? "No longer active" : "Done")
            return
          } else {
            nextWizard.index = nextIndex
            await runtime.sendCurrentQuestionStep(nextWizard)
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
          }
          await answerCallbackQuery(callbackQuery.id, "Done")
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Unsupported")
        return
      }

      await answerCallbackQuery(callbackQuery.id, "Invalid")
    } catch (err) {
      runtime.logger?.error?.("Callback handler error:", err?.message || String(err))
      await answerCallbackQuery(callbackQuery.id, "Action failed")
      await sendToThread(ctxMeta, "Action failed. Please try again.").catch(() => {})
    }
  }

  return { handleTelegramCallback }
}
