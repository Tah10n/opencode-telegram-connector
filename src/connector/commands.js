import { makeInlineKeyboard } from "../telegram/client.js"
import { sessionKey } from "../state/store.js"
import { permissionNoteIdempotencyKey, telegramMessageIdempotencyKey } from "./idempotency.js"
import { classifyBoundaryError, isRetryableBoundaryError, isStaleBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import { userAttachmentLimitsFromConfig } from "../limits.js"
import { createAttachmentHandlers } from "./commands/attachments.js"
import { createModelCommandHandlers } from "./commands/model.js"
import { createOperatorCommandHandlers } from "./commands/operator.js"
import { createSessionCommandHandlers } from "./commands/sessions.js"
import { formatModelUiChoices, resolveModelProviderCatalog } from "./model-ui.js"
import { unsupportedMediaKind, unsupportedMediaText } from "./incoming-attachments.js"

function helpText({ scopeLabel = "this thread", defaultProject = "", isBound = false } = {}) {
  const next = isBound
    ? "Next: use the buttons below for Sessions, New, Feed, Model, or Unbind."
    : `Next: tap Projects, or send ${defaultProject ? `/bind ${defaultProject}` : "/bind <projectAlias>"}.`
  return [
    "Telegram connector help:",
    `Scope: ${scopeLabel}`,
    next,
    defaultProject && !isBound ? `Default project hint: ${defaultProject}` : "",
    "",
    "Thread commands:",
    "/bind <projectAlias> — bind this chat/thread",
    "/new [title] — create a session for this thread",
    "/use <sessionId|shareLink> — switch this thread",
    "/sessions — recent sessions for this thread's project",
    "/model — model override for this thread",
    "/feed — Telegram feed mode for this thread",
    "/status — current binding for this thread",
    "/unbind — remove this thread's binding after confirmation",
    "",
    "Operator commands:",
    "/projects — project overview",
    "/runtime or /health — private chat only",
    "/bindings — private chat only",
    "/abort, /sendlast, /cancel",
  ].filter((line) => line !== "").join("\n")
}

export function createCommandHandlers(runtime) {
  const {
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    config,
    logger,
    platform,
    tg,
    getStartupSession,
    openAttachWindowFn,
    openAttachWindowWindowsFn,
    validateProject,
    bindCtxToSession,
    primeTuiActiveSessionFollow,
    recordProjectHealthFailure,
    sendToThread,
    parseCtxKey,
    formatThreadLabel,
    getProjectSseStatus,
    renderFeedSettings,
    feedModeLabel,
    getFeedMode,
    deliverAssistantText,
    extractAssistantDisplayText,
    lastAssistantBySession,
    canAutoStartProject,
    isRetryableProjectError,
    startServerKeyboard,
    ensureRecentPromptSet,
    hashTextForEcho,
    formatProjectUnavailable,
    buildProjectsOverviewText,
    buildProjectsOverviewKeyboard,
    isCommand,
    parseCommand,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    bindAliasAwaiting,
    getWizard,
    cloneWizardState,
    applyWizardState,
    persistQuestionWizard,
    finishQuestionWizard,
    sendCurrentQuestionStep,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    recordPromptAnswered,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
  } = runtime

  const userAttachmentLimits = userAttachmentLimitsFromConfig(config?.limits)

  const {
    resolveSessionModelInfo,
    resolveConfiguredModelInfo,
    resolveEffectiveModelState,
    resolvePromptOverride,
    appendEffectiveModelLines,
    buildSessionSwitchText,
    buildNewSessionText,
    setThreadModelPreference,
    renderModelSettings,
    handleModelCommand,
  } = createModelCommandHandlers({
    store,
    projects,
    ocByAlias,
    config,
    sendToThread,
    tg,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    formatModelUiChoices,
    resolveModelProviderCatalog,
    getFeedMode,
    feedModeLabel,
    cb: runtime.cb,
  })

  function recordRetryableOpenCodeFailure(projectAlias, err, context) {
    if (!projectAlias || !isRetryableProjectError(err)) return
    recordProjectHealthFailure?.(projectAlias, err, context)
  }

  const { handleAttachmentDocumentMessage, handleAttachmentConfirmation } = createAttachmentHandlers({
    store,
    tg,
    cb: runtime.cb,
    ocByAlias,
    sendToThread,
    config,
    recordRetryableOpenCodeFailure,
    resolvePromptOverride,
    userAttachmentLimits,
    isRetryableProjectError,
    canAutoStartProject,
    platform,
    formatProjectUnavailable,
    startServerKeyboard,
    ensureRecentPromptSet,
    hashTextForEcho,
  })

  async function resolveStartupSession(alias, { forceRefresh = false } = {}) {
    return getStartupSession(alias, { waitForStart: false, forceRefresh }).catch(() => null)
  }

  async function safeInformThread(ctxMeta, text, replyMarkup, options) {
    await sendToThread(ctxMeta, text, replyMarkup, options).catch(() => {})
  }

  async function safeEditMessage(ctxMeta, messageId, text, replyMarkup, options) {
    if (!messageId || !tg?.editMessageText) return
    await tg.editMessageText(ctxMeta.chatId, messageId, text, replyMarkup, options).catch(() => {})
  }

  function threadScopeLabel(ctxMeta) {
    if (!ctxMeta?.chatId) return "this thread"
    return `chat ${ctxMeta.chatId} / ${formatThreadLabel(ctxMeta.threadIdOr0)}`
  }

  function configuredDefaultProject() {
    const alias = String(config?.defaultProject || "").trim()
    return alias && projects?.[alias] ? alias : ""
  }

  function unboundGuidanceText(ctxMeta, reason = "This thread is not bound yet.") {
    const def = configuredDefaultProject()
    return [
      reason,
      `Scope: ${threadScopeLabel(ctxMeta)}`,
      `Next: tap Projects${def ? `, tap Bind ${def}, or send /bind ${def}` : ", then bind a project with /bind <projectAlias>"}.`,
      def ? `Default project hint: ${def}` : "Use /projects to see available aliases.",
    ].join("\n")
  }

  function unboundGuidanceKeyboard() {
    const rows = []
    const def = configuredDefaultProject()
    if (def) rows.push([{ text: `Bind ${def}`, callback_data: runtime.cb.pack(`srv|${def}|bind`) }])
    rows.push([{ text: "Projects", callback_data: runtime.cb.pack("srv|projects") }])
    rows.push([{ text: "Close", callback_data: runtime.cb.pack("srv|close") }])
    return makeInlineKeyboard(rows)
  }

  function boundThreadActionsKeyboard(ctxMeta) {
    return makeInlineKeyboard([
      [
        { text: "Sessions", callback_data: runtime.cb.pack("s|refresh") },
        { text: "New", callback_data: runtime.cb.pack("s|new") },
      ],
      [
        { text: "Feed", callback_data: runtime.cb.pack("feed|settings") },
        { text: "Model", callback_data: runtime.cb.pack("m|settings") },
      ],
      [
        { text: "Unbind", callback_data: runtime.cb.pack(`b|confirm-unbind|${ctxMeta.ctxKey}`) },
        { text: "Close", callback_data: runtime.cb.pack("s|close") },
      ],
    ])
  }

  function closeOnlyKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: runtime.cb.pack("s|close") }]])
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function flushDurableState(operation) {
    if (typeof store?.flush !== "function") return
    try {
      await store.flush()
    } catch (err) {
      throw makeBoundaryError({
        source: "state",
        operation,
        kind: "durability",
        outcome: "retryable",
        message: `${operation} failed: ${err?.message || String(err)}`,
        cause: err,
      })
    }
  }

  async function markIdempotencyEntries(entries, { flush = true, rollbackOnFlushFailure = false } = {}) {
    const normalized = entries.filter((entry) => !!entry?.key)
    if (!normalized.length) return false
    if (typeof store?.markIdempotencyKey === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = store.markIdempotencyKey(entry.key, entry.metadata || {}) || marked
      }
      if (marked && flush) {
        try {
          await flushDurableState("persist idempotency entries")
        } catch (err) {
          if (rollbackOnFlushFailure) {
            await Promise.all(normalized.map((entry) => deleteIdempotencyEntry(entry.key, { flush: false }).catch(() => false)))
          }
          throw err
        }
      }
      return marked
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      let marked = false
      for (const entry of normalized) {
        try {
          marked = (await store.markIdempotencyKeyAndFlush(entry.key, entry.metadata || {})) || marked
        } catch (err) {
          if (rollbackOnFlushFailure) await deleteIdempotencyEntry(entry.key, { flush: false }).catch(() => {})
          throw makeBoundaryError({
            source: "state",
            operation: "persist idempotency entries",
            kind: "durability",
            outcome: "retryable",
            message: `persist idempotency entries failed: ${err?.message || String(err)}`,
            cause: err,
          })
        }
      }
      return marked
    }
    return false
  }

  async function deleteIdempotencyEntry(key, { flush = true } = {}) {
    if (!key || typeof store?.deleteIdempotencyKey !== "function") return false
    const deleted = store.deleteIdempotencyKey(key)
    if (deleted && flush) await flushDurableState("delete idempotency entry")
    return deleted
  }

  function moveConflictNote(result) {
    if (!result?.movedFromRoute) return ""
    return `Note: this session was already bound to chat ${result.movedFromRoute.chatId} / ${formatThreadLabel(result.movedFromRoute.threadIdOr0)} and was moved to this thread.`
  }

  function appendMoveConflict(lines, result) {
    const note = moveConflictNote(result)
    if (note) lines.push(note)
    return lines
  }

  const {
    renderSessionsList,
    renderProjectSessions,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
  } = createSessionCommandHandlers({
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    logger,
    platform,
    tg,
    cb: runtime.cb,
    sendToThread,
    validateProject,
    bindCtxToSession,
    primeTuiActiveSessionFollow,
    formatProjectUnavailable,
    resolveStartupSession,
    safeInformThread,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    appendMoveConflict,
    buildSessionSwitchText,
    buildNewSessionText,
    resolveConfiguredModelInfo,
    resolveSessionModelInfo,
    resolveEffectiveModelState,
    openAttachWindowFn,
    openAttachWindowWindowsFn,
    markProjectUp: runtime.markProjectUp,
  })

  const {
    handleAbort,
    handleWhere,
    handleRuntime,
    handleBindings,
    handleSendLast,
    handleProjects,
    handleUnbind,
  } = createOperatorCommandHandlers({
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    platform,
    cb: runtime.cb,
    sendToThread,
    safeInformThread,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    boundThreadActionsKeyboard,
    formatThreadLabel,
    getProjectSseStatus,
    getFeedMode,
    feedModeLabel,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
    resolveStartupSession,
    validateProject,
    isRetryableProjectError,
    formatProjectUnavailable,
    buildProjectsOverviewText,
    buildProjectsOverviewKeyboard,
    deliverAssistantText,
    extractAssistantDisplayText,
    lastAssistantBySession,
    mirrorCompaction: runtime.mirrorCompaction,
    appendEffectiveModelLines,
    resolveEffectiveModelState,
    compareNumbers: runtime.compareNumbers,
    parseCtxKey,
    markProjectUp: runtime.markProjectUp,
    threadScopeLabel,
  })

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleTelegramMessage(msg, options = {}) {
    if (!runtime.isAllowedUser(msg?.from)) return
    const ctxMeta = runtime.ctxMetaFromMessage(msg)
    if (!ctxMeta.chatId) return

    const text = typeof msg?.text === "string" ? msg.text : ""
    const hasText = !!text.trim()
    const hasDocument = !!msg?.document
    const mediaKind = unsupportedMediaKind(msg)
    if (!hasText && !hasDocument && !mediaKind) return

    const messageKey = telegramMessageIdempotencyKey(ctxMeta, msg)
    if (hasIdempotencyKey(messageKey)) {
      await flushDurableState("persist replayed telegram message idempotency")
      return
    }

    function messageIdempotencyEntry(operation, metadata = {}) {
      return {
        key: messageKey,
        metadata: {
          kind: "telegram-message",
          ctxKey: ctxMeta.ctxKey,
          operation,
          updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
          messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
          ...metadata,
        },
      }
    }

    async function markMessageHandled(operation, metadata = {}, options = {}) {
      return markIdempotencyEntries([messageIdempotencyEntry(operation, metadata)], options)
    }

    async function persistCustomAnswerProgressDurably(wizard, previousWizard, previousAwaiting) {
      persistQuestionWizard(wizard)
      setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      try {
        await flushDurableState("persist question wizard state")
      } catch (err) {
        try {
          applyWizardState(wizard, previousWizard)
          persistQuestionWizard(wizard)
          setAwaitingCustomAnswerState(ctxMeta.ctxKey, previousAwaiting)
        } catch (rollbackErr) {
          logger?.error?.("Failed to roll back custom-answer wizard state:", rollbackErr?.message || String(rollbackErr))
        }
        throw err
      }
    }

    const awaitingQ = awaitingCustomAnswer.get(ctxMeta.ctxKey)
    if (awaitingQ) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This question expects a text answer. Send text or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("questionNonText", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId, awaitingQ.sessionID)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, "Question is no longer active.")
        await markMessageHandled("customAnswerStale", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const nextWizard = cloneWizardState(wizard)
      nextWizard.answers[awaitingQ.qIndex] = [text]
      const nextIndex = awaitingQ.qIndex + 1
      if (nextIndex >= wizard.request.questions.length) {
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        const result = await finishQuestionWizard(wizard, {
          idempotencyEntries: [messageIdempotencyEntry("replyQuestion", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })],
        })
        if (result?.outcome === "retryable") {
          await sendToThread(ctxMeta, "Question answer is temporarily unavailable. Send the answer again or /cancel.").catch(() => {})
          return
        }
      } else {
        const previousWizard = cloneWizardState(wizard)
        const previousAwaiting = { ...awaitingQ }
        nextWizard.index = nextIndex
        await sendCurrentQuestionStep(nextWizard)
        applyWizardState(wizard, nextWizard)
        await persistCustomAnswerProgressDurably(wizard, previousWizard, previousAwaiting)
        await markMessageHandled("questionNextStep", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This permission flow expects a text rejection note. Send text or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("permissionNoteNonText", { projectAlias: awaiting.projectAlias })
        return
      }
      const oc = ocByAlias[awaiting.projectAlias]
      const noteKey = permissionNoteIdempotencyKey(awaiting.projectAlias, awaiting.sessionID, awaiting.permissionId, text)
      if (hasIdempotencyKey(noteKey)) {
        store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await markMessageHandled("replyPermissionNote", { projectAlias: awaiting.projectAlias })
        await sendToThread(ctxMeta, "Rejection note already sent.").catch(() => {})
        return
      }
      try {
        await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      } catch (err) {
        if (isStaleBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await markIdempotencyEntries([
            {
              key: noteKey,
              metadata: {
                kind: "permission-note",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermission",
                action: "reject_note",
              },
            },
            {
              key: messageKey,
              metadata: {
                kind: "telegram-message",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermissionNote",
                updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
                messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
              },
            },
          ], { flush: false })
          store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await flushDurableState("persist stale permission note state")
          await sendToThread(ctxMeta, "Permission request is no longer active.").catch(() => {})
          return
        }
        if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await sendToThread(ctxMeta, "Permission reply is temporarily unavailable. Send the note again or /cancel.").catch(() => {})
          return
        }
        throw err
      }
      await markIdempotencyEntries([
        {
          key: noteKey,
          metadata: {
            kind: "permission-note",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermission",
            action: "reject_note",
          },
        },
        {
          key: messageKey,
          metadata: {
            kind: "telegram-message",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermissionNote",
            updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
            messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
          },
        },
      ], { flush: false })
      recordPromptAnswered?.(awaiting.projectAlias, "permission", "ok")
      store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      await flushDurableState("persist permission note state")
      await sendToThread(ctxMeta, "Rejection note sent.").catch(() => {})
      return
    }

    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This bind flow expects a project alias as text. Send an alias or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("bindAliasNonText")
        return
      }
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (!cmd) return
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, "Cancelled.")
          await markMessageHandled("bindAliasCancel")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
      } else {
        const alias = String(text).trim().split(/\s+/)[0]
        if (!alias) {
          await sendToThread(ctxMeta, "Send project alias (e.g. 'myproj') or /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, [alias])
        await markMessageHandled("bindAlias", { projectAlias: alias })
        return
      }
    }

    if (hasText && isCommand(text)) {
      const { cmd, args, argv } = parseCommand(text)
      if (!cmd) return
      if (cmd === "/cancel") {
        const hadBind = bindAliasAwaiting.delete(ctxMeta.ctxKey)
        const hadRejectNote = rejectNoteAwaiting.has(ctxMeta.ctxKey)
        const hadCustomAnswer = awaitingCustomAnswer.has(ctxMeta.ctxKey)
        if (hadRejectNote) setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        if (hadCustomAnswer) setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        const cancelled = hadBind || hadRejectNote || hadCustomAnswer
        await sendToThread(ctxMeta, cancelled ? "Cancelled." : "Nothing to cancel.")
        await markMessageHandled("cancel")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        const binding = store.getBinding(ctxMeta.ctxKey)
        await sendToThread(
          ctxMeta,
          helpText({ scopeLabel: threadScopeLabel(ctxMeta), defaultProject: configuredDefaultProject(), isBound: !!binding }),
          binding ? boundThreadActionsKeyboard(ctxMeta) : unboundGuidanceKeyboard(),
        )
        await markMessageHandled(cmd)
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, `${unboundGuidanceText(ctxMeta, "Send a project alias for this thread, or tap a button below.")}\nYou can /cancel.`, unboundGuidanceKeyboard())
          await markMessageHandled("bindPrompt")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, argv)
        await markMessageHandled("bind", { projectAlias: argv[0] })
        return
      }
      if (cmd === "/new") {
        await handleNewCommand(ctxMeta, args)
        await markMessageHandled("new")
        return
      }
      if (cmd === "/use") {
        await handleUseCommand(ctxMeta, argv[0])
        await markMessageHandled("use")
        return
      }
      if (cmd === "/sessions") {
        await handleSessions(ctxMeta)
        await markMessageHandled("sessions")
        return
      }
      if (cmd === "/model") {
        await handleModelCommand(ctxMeta, argv)
        await markMessageHandled("model")
        return
      }
      if (cmd === "/feed") {
        await handleFeed(ctxMeta)
        await markMessageHandled("feed")
        return
      }
      if (cmd === "/status") {
        await handleWhere(ctxMeta)
        await markMessageHandled("status")
        return
      }
      if (cmd === "/runtime" || cmd === "/health") {
        await handleRuntime(ctxMeta)
        await markMessageHandled("runtime")
        return
      }
      if (cmd === "/bindings") {
        await handleBindings(ctxMeta)
        await markMessageHandled("bindings")
        return
      }
      if (cmd === "/abort") {
        await handleAbort(ctxMeta)
        await markMessageHandled("abort")
        return
      }
      if (cmd === "/sendlast") {
        await handleSendLast(ctxMeta)
        await markMessageHandled("sendlast")
        return
      }
      if (cmd === "/projects") {
        await handleProjects(ctxMeta)
        await markMessageHandled("projects")
        return
      }
      if (cmd === "/unbind") {
        await handleUnbind(ctxMeta)
        await markMessageHandled("unbind")
        return
      }
      await sendToThread(ctxMeta, "Unknown command. Use /help.")
      await markMessageHandled("unknownCommand")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta), unboundGuidanceKeyboard())
      await markMessageHandled("unbound")
      return
    }

    if (hasDocument) {
      await handleAttachmentDocumentMessage(ctxMeta, msg, binding, messageKey, markMessageHandled, options)
      return
    }

    if (mediaKind) {
      await sendToThread(ctxMeta, unsupportedMediaText(mediaKind, { limits: userAttachmentLimits }), closeOnlyKeyboard())
      await markMessageHandled("unsupportedMedia", { projectAlias: binding.projectAlias, sessionId: binding.sessionId, action: mediaKind })
      return
    }

    if (!hasText) return

    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    const promptText = `${prefix}${text}`
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
    const promptOverride = await resolvePromptOverride(ctxMeta.ctxKey, binding)
    // Persist message idempotency before the external side effect. If opencode
    // accepts the prompt and the process crashes immediately after, replayed
    // Telegram updates will skip instead of sending a duplicate prompt.
    await markIdempotencyEntries([messageIdempotencyEntry("promptAsync", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })], {
      rollbackOnFlushFailure: true,
    })
    try {
      await oc.promptAsync(binding.sessionId, promptText, promptOverride || undefined)
    } catch (err) {
      let cleanupErr = null
      try {
        await deleteIdempotencyEntry(messageKey)
      } catch (deleteErr) {
        cleanupErr = deleteErr
      }
      const alias = binding.projectAlias
      const withButton = isRetryableProjectError(err) && canAutoStartProject(alias, { platform })
      recordRetryableOpenCodeFailure(alias, err, {
        operation: "POST /session/:id/prompt_async",
        method: "POST",
        pathname: `/session/${binding.sessionId}/prompt_async`,
      })
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : null).catch(() => {})
      if (cleanupErr) throw cleanupErr
      if (isRetryableProjectError(err)) throw err
      return
    }
  }

  return {
    renderSessionsList,
    renderModelSettings,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
    handleModelCommand,
    handleAbort,
    handleWhere,
    handleRuntime,
    handleFeed,
    handleBindings,
    handleSendLast,
    handleProjects,
    renderProjectSessions,
    handleUnbind,
    handleAttachmentConfirmation,
    handleTelegramMessage,
    buildSessionSwitchText,
    setThreadModelPreference,
  }
}
