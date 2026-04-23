import { normalizeFeedMode } from "../state/store.js"
import { normalizeModelReference } from "../model-selection.js"
import { classifyBoundaryError, isRetryableBoundaryError, isStaleBoundaryError } from "../boundary-errors.js"
import {
  permissionNoteIdempotencyPrefix,
  permissionReplyIdempotencyKey,
  permissionReplyIdempotencyPrefix,
  questionRejectIdempotencyKey,
  questionReplyIdempotencyPrefix,
} from "./idempotency.js"

async function defaultBuildSessionSwitchText(_projectAlias, sessionId) {
  return `Switched to session: ${sessionId}`
}

function ignoreError() {}

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
    validateProject,
    renderFeedSettings,
    renderModelSettings,
    renderChangedFilesView,
    renderSessionsList,
    renderProjectSessions,
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
    buildSessionSwitchText = defaultBuildSessionSwitchText,
    setThreadModelPreference,
    formatProjectUnavailable,
    canAutoStartProject,
    startServerKeyboard,
    platform,
    recordCallbackOutcome,
  } = runtime

  async function answerCallbackQuery(callbackQueryId, text) {
    await tg.answerCallbackQuery(callbackQueryId, text).catch(ignoreError)
  }

  async function closeInteractiveMessage(callbackQueryId, ctxMeta, messageId) {
    await answerCallbackQuery(callbackQueryId, "Closed")
    if (typeof tg.deleteMessage === "function") {
      await tg.deleteMessage(ctxMeta.chatId, messageId).catch(ignoreError)
      return
    }
    if (typeof tg.editMessageReplyMarkup === "function") {
      await tg.editMessageReplyMarkup(ctxMeta.chatId, messageId, null).catch(ignoreError)
    }
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function markIdempotencyKey(key, metadata = {}) {
    if (!key) return false
    if (typeof store?.markIdempotencyKey === "function") {
      return store.markIdempotencyKey(key, metadata)
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      return store.markIdempotencyKeyAndFlush(key, metadata)
    }
    return false
  }

  function cleanupPermissionState(ctxKey, projectAlias, permissionId, sessionID = "") {
    store.deletePendingPermission(projectAlias, permissionId, sessionID)
    setRejectNoteAwaitingState(ctxKey, null)
  }

  function cleanupQuestionState(ctxKey, projectAlias, questionId, sessionID = "") {
    runtime.questionWizards.delete(sessionID ? `${projectAlias}:${sessionID}:${questionId}` : `${projectAlias}:${questionId}`)
    runtime.questionWizards.delete(`${projectAlias}:${questionId}`)
    clearPersistedQuestionWizard(projectAlias, questionId, sessionID)
    setAwaitingCustomAnswerState(ctxKey, null)
  }

  function parsePermissionParts(parts) {
    if (parts.length >= 5) return { projectAlias: parts[1], sessionID: parts[2] || "", permissionId: parts[3], action: parts[4] }
    return { projectAlias: parts[1], sessionID: "", permissionId: parts[2], action: parts[3] }
  }

  function parseQuestionParts(parts) {
    const oldShape = parts.length < 4 || parts[3] === "reject" || Number.isInteger(Number(parts[3]))
    if (oldShape) return { projectAlias: parts[1], sessionID: "", questionId: parts[2], rest: parts.slice(3) }
    return { projectAlias: parts[1], sessionID: parts[2] || "", questionId: parts[3], rest: parts.slice(4) }
  }

  function hasHandledPermission(projectAlias, sessionID, permissionId) {
    if (typeof store?.hasIdempotencyKeyPrefix !== "function") return false
    return store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
      store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
      store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, "", permissionId)) ||
      store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, "", permissionId))
  }

  function hasHandledQuestion(projectAlias, sessionID, questionId) {
    return (typeof store?.hasIdempotencyKeyPrefix === "function" &&
        (store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId)) ||
          store.hasIdempotencyKeyPrefix(questionReplyIdempotencyPrefix(projectAlias, "", questionId)))) ||
      store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, sessionID, questionId)) ||
      store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, "", questionId))
  }

  function canUseProjectControl(ctxMeta, projectAlias) {
    if (ctxMeta?.chatType === "private") return true
    return store.getBinding(ctxMeta?.ctxKey)?.projectAlias === projectAlias
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
    const callbackProjectAlias = projects?.[parts[1]] ? parts[1] : store.getBinding(ctxMeta.ctxKey)?.projectAlias || null

    try {
      if (kind === "s") {
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
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
          await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(ignoreError)
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Switched")
        await renderSessionsList({ ...ctxMeta, chatId: msg?.chat?.id || ctxMeta.chatId }, {
          binding: { projectAlias, sessionId: targetSessionId },
          editMessageId: msg?.message_id,
        }).catch(async (err) => {
          runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
          await sendToThread(ctxMeta, await buildSessionSwitchText(projectAlias, targetSessionId, { ctxKey: ctxMeta.ctxKey })).catch(ignoreError)
        })
        return
      }

      if (kind === "srv") {
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        const projectAlias = parts[1]
        const action = parts[2]
        if (!projectAlias || !projects?.[projectAlias]) {
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }
        if (action === "start") {
          if (!canUseProjectControl(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Starting…")
          void ensureProjectStarted(projectAlias, ctxMeta)
          return
        }
        if (action === "health") {
          if (!canUseProjectControl(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Checking…")
          try {
            await validateProject(projectAlias)
            await sendToThread(ctxMeta, `Project '${projectAlias}' health check: online.`).catch(ignoreError)
          } catch (err) {
            const replyMarkup = canAutoStartProject?.(projectAlias, { platform }) ? startServerKeyboard?.(projectAlias) : null
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err), replyMarkup).catch(ignoreError)
          }
          return
        }
        if (action === "sessions") {
          await answerCallbackQuery(callbackQuery.id, "Sessions")
          await renderProjectSessions(ctxMeta, projectAlias, { editMessageId: msg?.message_id }).catch(async (err) => {
            runtime.logger?.error?.("Failed to render project sessions:", err?.message || String(err))
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(ignoreError)
          })
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "feed") {
        const rawMode = parts[1]
        if (rawMode === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const mode = normalizeFeedMode(rawMode)
        store.setFeedMode(ctxMeta.ctxKey, mode)
        await answerCallbackQuery(callbackQuery.id, `Feed: ${feedModeLabel(mode)}`)
        await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id }).catch(ignoreError)
        return
      }

      if (kind === "m") {
        const action = parts[1]
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }

        const binding = store.getBinding(ctxMeta.ctxKey)
        if (!binding) {
          await answerCallbackQuery(callbackQuery.id, "Not bound")
          return
        }

        if (action === "root" || action === "back") {
          await answerCallbackQuery(callbackQuery.id, "Back")
          await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
          return
        }

        if (action === "provider") {
          const providerId = parts[2]
          if (!providerId) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Pick model")
          await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id, selectedProviderId: providerId }).catch(ignoreError)
          return
        }

        if (action === "set") {
          const nextMode = parts[2]
          if (nextMode === "inherit") {
            const result = await setThreadModelPreference(ctxMeta, binding, null)
            await answerCallbackQuery(callbackQuery.id, result?.callbackText || "Model: inherit")
          } else if (nextMode === "project-default") {
            const result = await setThreadModelPreference(ctxMeta, binding, { mode: "project-default" })
            if (!result?.ok) {
              await answerCallbackQuery(callbackQuery.id, result?.callbackText || "Unavailable")
              await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
              return
            }
            await answerCallbackQuery(callbackQuery.id, result.callbackText || "Model: project default")
          } else {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
          return
        }

        if (action === "pick" || action === "model") {
          const modelKey = parts[2]
          if (!modelKey) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          const selectedModel = normalizeModelReference(modelKey)
          if (!selectedModel) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Pick variant")
          await renderModelSettings(ctxMeta, {
            binding,
            editMessageId: msg?.message_id,
            selectedProviderId: selectedModel.providerID,
            selectedModelKey: modelKey,
          }).catch(ignoreError)
          return
        }

        if (action === "apply") {
          const modelKey = parts[2]
          const variantToken = parts[3]
          if (!modelKey || variantToken == null) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          if (!normalizeModelReference(modelKey)) {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          const variant = variantToken === "~" ? "" : variantToken
          const result = await setThreadModelPreference(ctxMeta, binding, { mode: "custom", model: modelKey, variant })
          await answerCallbackQuery(callbackQuery.id, result?.callbackText || (variant ? `Model: ${modelKey} ${variant}` : `Model: ${modelKey}`))
          await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Invalid")
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
        await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, { editMessageId: msg?.message_id }).catch(ignoreError)
        return
      }

      if (kind === "p") {
        const { projectAlias, sessionID, permissionId, action } = parsePermissionParts(parts)
        const oc = ocByAlias[projectAlias]
        if (!oc) {
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }
        if (action === "once" || action === "always" || action === "reject") {
          const replyKey = permissionReplyIdempotencyKey(projectAlias, sessionID, permissionId, action)
          if (hasIdempotencyKey(replyKey) || hasHandledPermission(projectAlias, sessionID, permissionId)) {
            cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            return
          }
          try {
            await oc.replyPermission(permissionId, { reply: action })
          } catch (err) {
            if (isStaleBoundaryError(err, { source: "opencode", pathname: `/permission/${permissionId}/reply`, method: "POST" })) {
              await markIdempotencyKey(replyKey, {
                kind: "permission-reply",
                projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermission",
                action,
              })
              cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
              await store.flush?.()
              recordCallbackOutcome?.(projectAlias, "stale")
              await answerCallbackQuery(callbackQuery.id, "No longer active")
              return
            }
            if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${permissionId}/reply`, method: "POST" })) {
              recordCallbackOutcome?.(projectAlias, "retryable")
              await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
              await sendToThread(ctxMeta, "Action is temporarily unavailable. Please try again.").catch(ignoreError)
              return
            }
            throw err
          }
          await markIdempotencyKey(replyKey, {
            kind: "permission-reply",
            projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermission",
            action,
          })
          cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
          await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, "OK")
          return
        }
        if (action === "reject_note") {
          if (hasHandledPermission(projectAlias, sessionID, permissionId)) {
            cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            return
          }
          setRejectNoteAwaitingState(ctxMeta.ctxKey, { projectAlias, permissionId, ...(sessionID ? { sessionID } : {}) })
          try {
            await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { sessionID })
          } catch (err) {
            setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
            runtime.logger?.error?.("Failed to start reject-note flow:", err?.message || String(err))
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            return
          }
          await store.flush?.()
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
        const { projectAlias, sessionID, questionId, rest } = parseQuestionParts(parts)
        const oc = ocByAlias[projectAlias]
        if (!oc) {
          await answerCallbackQuery(callbackQuery.id, "Unknown project")
          return
        }

        const wizard = getWizard(projectAlias, questionId, sessionID)
        if (rest.length === 1 && rest[0] === "reject") {
          const rejectKey = questionRejectIdempotencyKey(projectAlias, sessionID, questionId)
          if (hasIdempotencyKey(rejectKey) || hasHandledQuestion(projectAlias, sessionID, questionId)) {
            cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            return
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
              cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
              await store.flush?.()
              recordCallbackOutcome?.(projectAlias, "stale")
              await answerCallbackQuery(callbackQuery.id, "No longer active")
              return
            }
            if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/question/${questionId}/reject`, method: "POST" })) {
              recordCallbackOutcome?.(projectAlias, "retryable")
              await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
              await sendToThread(ctxMeta, "Action is temporarily unavailable. Please try again.").catch(ignoreError)
              return
            }
            throw err
          }
          await markIdempotencyKey(rejectKey, {
            kind: "question-reject",
            projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "rejectQuestion",
          })
          cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
          await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, "Rejected")
          return
        }

        if (!wizard) {
          if (hasHandledQuestion(projectAlias, sessionID, questionId)) {
            cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Not found")
          return
        }
        if (rest.length < 2) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }

        const qIndex = Number(rest[0])
        const action = rest[1]
        const arg = rest[2]
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
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, ...(sessionID ? { sessionID } : {}), qIndex })
          try {
            await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question", { sessionID })
          } catch (err) {
            setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
            runtime.logger?.error?.("Failed to start custom-answer flow:", err?.message || String(err))
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            return
          }
          await store.flush?.()
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
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
            const result = await finishQuestionWizard(wizard)
            await answerCallbackQuery(
              callbackQuery.id,
              result?.outcome === "stale" ? "No longer active" : result?.outcome === "retryable" ? "Temporarily unavailable" : "Selected",
            )
            if (result?.outcome === "retryable") {
              await sendToThread(ctxMeta, "Action is temporarily unavailable. Please try again.").catch(ignoreError)
            }
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
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
            const result = await finishQuestionWizard(wizard)
            await answerCallbackQuery(
              callbackQuery.id,
              result?.outcome === "stale" ? "No longer active" : result?.outcome === "retryable" ? "Temporarily unavailable" : "Done",
            )
            if (result?.outcome === "retryable") {
              await sendToThread(ctxMeta, "Action is temporarily unavailable. Please try again.").catch(ignoreError)
            }
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
      const classification = classifyBoundaryError(err)
      if (classification.stale) {
        recordCallbackOutcome?.(callbackProjectAlias, "stale")
        await answerCallbackQuery(callbackQuery.id, "No longer active")
        return
      }
      if (classification.retryable) {
        recordCallbackOutcome?.(callbackProjectAlias, "retryable")
        await answerCallbackQuery(callbackQuery.id, "Temporarily unavailable")
        await sendToThread(ctxMeta, "Action is temporarily unavailable. Please try again.").catch(ignoreError)
        return
      }
      recordCallbackOutcome?.(callbackProjectAlias, "fatal")
      await answerCallbackQuery(callbackQuery.id, "Action failed")
      await sendToThread(ctxMeta, "Action failed. Please try again.").catch(ignoreError)
    }
  }

  return { handleTelegramCallback }
}
