import { normalizeFeedMode } from "../state/store.js"
import { normalizeModelReference } from "../model-selection.js"
import { requireSafeOpenCodeId } from "../opencode/ids.js"
import { classifyBoundaryError, isRetryableBoundaryError, isStaleBoundaryError } from "../boundary-errors.js"
import { makeInlineKeyboard } from "../telegram/client.js"
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
    parseCtxKey,
    formatThreadLabel,
    isAllowedUser,
    bindCtxToSession,
    sendToThread,
    ensureProjectStarted,
    validateProject,
    getStartupSession,
    renderFeedSettings,
    renderModelSettings,
    renderChangedFilesView,
    renderSessionsList,
    renderProjectSessions,
    handleBindings,
    handleBindCommand,
    handleNewCommand,
    handleProjects,
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
    recordPromptAnswered,
    requestRuntimeShutdown,
    scheduleRuntimeShutdown,
  } = runtime

  async function answerCallbackQuery(callbackQueryId, text) {
    await tg.answerCallbackQuery(callbackQueryId, text).catch(ignoreError)
  }

  async function deleteInteractiveMessage(ctxMeta, messageId) {
    if (!messageId) return
    if (typeof tg.deleteMessage === "function") {
      await tg.deleteMessage(ctxMeta.chatId, messageId).catch(ignoreError)
      return
    }
    if (typeof tg.editMessageReplyMarkup === "function") {
      await tg.editMessageReplyMarkup(ctxMeta.chatId, messageId, null).catch(ignoreError)
    }
  }

  async function closeInteractiveMessage(callbackQueryId, ctxMeta, messageId) {
    await answerCallbackQuery(callbackQueryId, "Closed")
    await deleteInteractiveMessage(ctxMeta, messageId)
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

  function canUseBindingAction(ctxMeta, targetCtxKey) {
    return ctxMeta?.chatType === "private" || ctxMeta?.ctxKey === targetCtxKey
  }

  function canUseProjectBind(ctxMeta, projectAlias) {
    if (ctxMeta?.chatType === "private") return true
    const binding = store.getBinding(ctxMeta?.ctxKey)
    return !binding || binding.projectAlias === projectAlias
  }

  function describeTargetCtx(ctxKey) {
    const parsed = parseCtxKey?.(ctxKey)
    if (!parsed) return ctxKey
    return `chat ${parsed.chatId} / ${formatThreadLabel?.(parsed.threadIdOr0) || `thread ${parsed.threadIdOr0}`}`
  }

  function packCallbackData(data) {
    return typeof cb?.pack === "function" ? cb.pack(data) : data
  }

  function unbindConfirmationKeyboard(ctxKey, binding) {
    return makeInlineKeyboard([
      [{ text: "Remove this thread binding", callback_data: packCallbackData(`b|unbind|${ctxKey}|${binding.projectAlias}|${binding.sessionId}`) }],
      [{ text: "Close", callback_data: packCallbackData("b|close") }],
    ])
  }

  function runtimeCloseKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: packCallbackData("rt|close") }]])
  }

  function runtimeConfirmationKeyboard(action) {
    const label = action === "restart" ? "Confirm restart" : "Confirm stop"
    return makeInlineKeyboard([
      [{ text: label, callback_data: packCallbackData(`rt|${action}`) }],
      [{ text: "Cancel", callback_data: packCallbackData("rt|cancel") }],
    ])
  }

  function runtimeConfirmationText(action) {
    if (action === "restart") {
      return "Restart connector?\n\nThis will stop the current process and exit with code 1 so your supervisor can start it again."
    }
    return "Stop connector?\n\nThis will stop Telegram polling, OpenCode streams, flush state, and exit."
  }

  function canRequestRuntimeShutdown() {
    return typeof requestRuntimeShutdown === "function"
  }

  function requestRuntimeShutdownSoon(action) {
    const run = () =>
      Promise.resolve(requestRuntimeShutdown({ action })).catch((err) => {
        runtime.logger?.error?.("Runtime shutdown request failed:", err?.message || String(err))
      })
    try {
      if (typeof scheduleRuntimeShutdown === "function") {
        scheduleRuntimeShutdown(run)
        return
      }
      const timer = setTimeout(run, 50)
      timer.unref?.()
    } catch (err) {
      runtime.logger?.error?.("Failed to schedule runtime shutdown request:", err?.message || String(err))
    }
  }

  async function persistRuntimeRestartNotice(ctxMeta) {
    if (typeof store?.setPendingRuntimeOnlineNotice !== "function") return
    try {
      store.setPendingRuntimeOnlineNotice({ kind: "restart", chatId: ctxMeta.chatId, createdAt: Date.now() })
      await store.flush?.()
    } catch (err) {
      runtime.logger?.error?.("Failed to persist runtime restart notice:", err?.message || String(err))
    }
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
      if (kind === "rt") {
        const action = parts[1]
        if (ctxMeta?.chatType !== "private") {
          await answerCallbackQuery(callbackQuery.id, "Private chat only")
          return
        }
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "cancel") {
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }
        if (action === "confirm-stop" || action === "confirm-restart") {
          const targetAction = action === "confirm-restart" ? "restart" : "stop"
          await answerCallbackQuery(callbackQuery.id, targetAction === "restart" ? "Confirm restart" : "Confirm stop")
          if (msg?.message_id && typeof tg.editMessageText === "function") {
            await tg
              .editMessageText(ctxMeta.chatId, msg.message_id, runtimeConfirmationText(targetAction), runtimeConfirmationKeyboard(targetAction))
              .catch(ignoreError)
          }
          return
        }
        if (action === "stop" || action === "restart") {
          if (!canRequestRuntimeShutdown()) {
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            if (msg?.message_id && typeof tg.editMessageText === "function") {
              await tg.editMessageText(ctxMeta.chatId, msg.message_id, "Runtime shutdown control is unavailable for this launcher.", runtimeCloseKeyboard()).catch(ignoreError)
            }
            return
          }
          await answerCallbackQuery(callbackQuery.id, action === "restart" ? "Restarting…" : "Stopping…")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          if (action === "restart") await persistRuntimeRestartNotice(ctxMeta)
          requestRuntimeShutdownSoon(action)
          return
        }
        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "s") {
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (parts[1] === "refresh") {
          const binding = store.getBinding(ctxMeta.ctxKey)
          if (!binding) {
            await answerCallbackQuery(callbackQuery.id, "Not bound")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Sessions")
          await renderSessionsList(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(async (err) => {
            runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
            await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(ignoreError)
          })
          return
        }
        if (parts[1] === "new") {
          if (typeof handleNewCommand !== "function") {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          if (!store.getBinding(ctxMeta.ctxKey)) {
            await answerCallbackQuery(callbackQuery.id, "Not bound")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Creating…")
          await handleNewCommand(ctxMeta, "").catch(async (err) => {
            runtime.logger?.error?.("Failed to create session from callback:", err?.message || String(err))
            await sendToThread(ctxMeta, "Action failed. Please try /new.").catch(ignoreError)
          })
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
        let safeTargetSessionId
        try {
          safeTargetSessionId = requireSafeOpenCodeId(targetSessionId, "session id")
        } catch {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (binding.sessionId === safeTargetSessionId) {
          await answerCallbackQuery(callbackQuery.id, "Already current")
          return
        }
        try {
          await oc.getSession(safeTargetSessionId)
          await bindCtxToSession(ctxMeta, projectAlias, safeTargetSessionId)
        } catch (err) {
          await answerCallbackQuery(callbackQuery.id, "Unavailable")
          await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(ignoreError)
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Switched")
        await renderSessionsList({ ...ctxMeta, chatId: msg?.chat?.id || ctxMeta.chatId }, {
          binding: { projectAlias, sessionId: safeTargetSessionId },
          editMessageId: msg?.message_id,
        }).catch(async (err) => {
          runtime.logger?.error?.("Failed to refresh sessions list:", err?.message || String(err))
          await sendToThread(ctxMeta, await buildSessionSwitchText(projectAlias, safeTargetSessionId, { ctxKey: ctxMeta.ctxKey })).catch(ignoreError)
        })
        return
      }

      if (kind === "srv") {
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (parts[1] === "projects") {
          if (typeof handleProjects !== "function") {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Projects")
          await handleProjects(ctxMeta).catch(ignoreError)
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
        if (action === "bind") {
          if (!canUseProjectBind(ctxMeta, projectAlias)) {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          if (typeof handleBindCommand !== "function") {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await answerCallbackQuery(callbackQuery.id, "Binding…")
          await handleBindCommand(ctxMeta, [projectAlias]).catch(async (err) => {
            runtime.logger?.error?.("Failed to bind project from callback:", err?.message || String(err))
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(ignoreError)
          })
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

      if (kind === "b") {
        const action = parts[1]
        if (action === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "repair") {
          if (ctxMeta?.chatType !== "private") {
            await answerCallbackQuery(callbackQuery.id, "Private chat only")
            return
          }
          const summary = store.repairBindingIndex?.() || { changed: false }
          if (summary.changed) await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, summary.changed ? "Repaired" : "Already clean")
          if (typeof handleBindings === "function") await handleBindings(ctxMeta).catch(ignoreError)
          return
        }

        const targetCtxKey = parts[2]
        const targetCtx = parseCtxKey?.(targetCtxKey)
        if (!targetCtxKey || !targetCtx) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (!canUseBindingAction(ctxMeta, targetCtxKey)) {
          await answerCallbackQuery(callbackQuery.id, "Private chat only")
          return
        }
        const binding = store.getBinding(targetCtxKey)
        if (!binding) {
          await answerCallbackQuery(callbackQuery.id, "Not bound")
          return
        }

        if (action === "keep") {
          await answerCallbackQuery(callbackQuery.id, "Kept")
          await sendToThread(ctxMeta, `Kept binding for ${describeTargetCtx(targetCtxKey)} unchanged.`).catch(ignoreError)
          return
        }
        if (action === "confirm-unbind") {
          await answerCallbackQuery(callbackQuery.id, "Confirm")
          await sendToThread(
            ctxMeta,
            [
              "Confirm unbind for this thread:",
              `Scope: ${describeTargetCtx(targetCtxKey)}`,
              `Project: ${binding.projectAlias}`,
              `Session: ${binding.sessionId}`,
              "This only removes the Telegram binding; it does not delete the opencode session.",
            ].join("\n"),
            unbindConfirmationKeyboard(targetCtxKey, binding),
          ).catch(ignoreError)
          return
        }
        if (action === "unbind") {
          const expectedProjectAlias = parts[3] || ""
          const expectedSessionId = parts[4] || ""
          if (!expectedProjectAlias || !expectedSessionId) {
            await answerCallbackQuery(callbackQuery.id, "Confirm")
            await sendToThread(
              ctxMeta,
              [
                "Confirm unbind for this thread:",
                `Scope: ${describeTargetCtx(targetCtxKey)}`,
                `Project: ${binding.projectAlias}`,
                `Session: ${binding.sessionId}`,
                "This only removes the Telegram binding; it does not delete the opencode session.",
              ].join("\n"),
              unbindConfirmationKeyboard(targetCtxKey, binding),
            ).catch(ignoreError)
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            return
          }
          if (binding.projectAlias !== expectedProjectAlias || binding.sessionId !== expectedSessionId) {
            await answerCallbackQuery(callbackQuery.id, "Binding changed")
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            await sendToThread(ctxMeta, `Binding changed for ${describeTargetCtx(targetCtxKey)}. Open /status or /bindings and confirm again.`).catch(ignoreError)
            return
          }
          const ok = store.unbind(targetCtxKey)
          if (ok) await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, ok ? "Unbound" : "Not bound")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          await sendToThread(ctxMeta, ok ? `Changed: binding removed.\nRemoved binding for ${describeTargetCtx(targetCtxKey)}.` : "Binding was already absent.").catch(ignoreError)
          return
        }
        if (action === "rebind" || action === "new") {
          const projectAlias = binding.projectAlias
          const oc = ocByAlias[projectAlias]
          if (!projectAlias || !projects?.[projectAlias] || !oc) {
            await answerCallbackQuery(callbackQuery.id, "Unknown project")
            return
          }
          try {
            const nextSessionId = action === "rebind"
              ? await getStartupSession(projectAlias, { waitForStart: false, forceRefresh: true })
              : (await oc.createSession({}))?.id
            if (!nextSessionId) {
              await answerCallbackQuery(callbackQuery.id, "Unavailable")
              return
            }
            const safeNextSessionId = requireSafeOpenCodeId(nextSessionId, "session id")
            const targetMeta = { ...targetCtx, ctxKey: targetCtxKey, chatType: ctxMeta.chatType }
            await bindCtxToSession(targetMeta, projectAlias, safeNextSessionId)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, action === "rebind" ? "Rebound" : "Created")
            await sendToThread(ctxMeta, `${action === "rebind" ? "Rebound" : "Created and bound"} ${describeTargetCtx(targetCtxKey)} to ${projectAlias} / ${safeNextSessionId}.`).catch(ignoreError)
          } catch (err) {
            await answerCallbackQuery(callbackQuery.id, "Unavailable")
            await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(ignoreError)
          }
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
        if (rawMode === "settings") {
          await answerCallbackQuery(callbackQuery.id, "Feed")
          await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id }).catch(ignoreError)
          return
        }
        if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const mode = normalizeFeedMode(rawMode)
        store.setFeedMode(ctxMeta.ctxKey, mode)
        await answerCallbackQuery(callbackQuery.id, `Feed: ${feedModeLabel(mode)}`)
        await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id, noticeText: `Changed: this thread feed is now ${feedModeLabel(mode)}.` }).catch(ignoreError)
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

        if (action === "settings") {
          await answerCallbackQuery(callbackQuery.id, "Model")
          await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
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
          let setResult = null
          if (nextMode === "inherit") {
            setResult = await setThreadModelPreference(ctxMeta, binding, null)
            await answerCallbackQuery(callbackQuery.id, setResult?.callbackText || "Model: inherit")
          } else if (nextMode === "project-default") {
            setResult = await setThreadModelPreference(ctxMeta, binding, { mode: "project-default" })
            if (!setResult?.ok) {
              await answerCallbackQuery(callbackQuery.id, setResult?.callbackText || "Unavailable")
              await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
              return
            }
            await answerCallbackQuery(callbackQuery.id, setResult.callbackText || "Model: project default")
          } else {
            await answerCallbackQuery(callbackQuery.id, "Invalid")
            return
          }
          await renderModelSettings(ctxMeta, {
            binding,
            editMessageId: msg?.message_id,
            ...(setResult?.noticeText ? { noticeText: setResult.noticeText } : {}),
          }).catch(ignoreError)
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
          await renderModelSettings(ctxMeta, {
            binding,
            editMessageId: msg?.message_id,
            ...(result?.noticeText ? { noticeText: result.noticeText } : {}),
          }).catch(ignoreError)
          return
        }

        await answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      if (kind === "cf") {
        if (parts[1] === "close") {
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        const projectAlias = parts[1]
        const sessionId = parts[2]
        const opencodeMessageId = parts[3]
        const action = parts[4]
        const validChangedFilesActions = new Set(["show", "back", "summary", "patch", "files", "file", "filepatch"])
        if (!projectAlias || !sessionId || !opencodeMessageId || !validChangedFilesActions.has(action)) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        await answerCallbackQuery(callbackQuery.id)
        const viewOptions = { editMessageId: msg?.message_id }
        if (parts[5] != null) viewOptions.actionArg = parts[5]
        await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, viewOptions)
        return
      }

      if (kind === "att") {
        const action = parts[1]
        const token = parts[2]
        if (!token || (action !== "send" && action !== "cancel" && action !== "close")) {
          await answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        if (action === "close") {
          await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
          await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
          return
        }
        if (action === "send") await answerCallbackQuery(callbackQuery.id, "Sending…")
        const result = await runtime.handleAttachmentConfirmation?.(ctxMeta, action, token, { editMessageId: msg?.message_id })
        if (action !== "send") await answerCallbackQuery(callbackQuery.id, result?.callbackText || (action === "cancel" ? "Cancelled" : "Closed"))
        if (result?.callbackText === "Sent" || result?.callbackText === "Cancelled" || result?.callbackText === "Already sent") {
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
        }
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
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
              await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
          recordPromptAnswered?.(projectAlias, "permission", "ok")
          cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
          await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, "OK")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }
        if (action === "reject_note") {
          if (hasHandledPermission(projectAlias, sessionID, permissionId)) {
            cleanupPermissionState(ctxMeta.ctxKey, projectAlias, permissionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }
        if (action === "cancel_note") {
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
              await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
          recordPromptAnswered?.(projectAlias, "question", "rejected")
          cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
          await store.flush?.()
          await answerCallbackQuery(callbackQuery.id, "Rejected")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }

        if (!wizard) {
          if (hasHandledQuestion(projectAlias, sessionID, questionId)) {
            cleanupQuestionState(ctxMeta.ctxKey, projectAlias, questionId, sessionID)
            await store.flush?.()
            await answerCallbackQuery(callbackQuery.id, "Already handled")
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
          return
        }
        if (action === "cancel_custom") {
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
          await answerCallbackQuery(callbackQuery.id, "Cancelled")
          await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
            } else {
              await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            }
            return
          } else {
            nextWizard.index = nextIndex
            await runtime.sendCurrentQuestionStep(nextWizard)
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
            } else {
              await deleteInteractiveMessage(ctxMeta, msg?.message_id)
            }
            return
          } else {
            nextWizard.index = nextIndex
            await runtime.sendCurrentQuestionStep(nextWizard)
            applyWizardState(wizard, nextWizard)
            persistQuestionWizard(wizard)
            await deleteInteractiveMessage(ctxMeta, msg?.message_id)
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
