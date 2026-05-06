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
import { formatStaleActiveTurnNotice, resolveActiveTurnStaleMs, resolveActiveTurnStatus } from "./active-turns.js"
import { callbackPacker } from "./commands/shared.js"
import { localeDisplayName, matchSupportedLocale, t as translate } from "../i18n/index.js"
import { languageSettingsView, supportedLocaleSummary } from "./language-ui.js"

function helpText({ scopeLabel = "this thread", defaultProject = "", isBound = false, locale = "en", t = translate } = {}) {
  const bindCommand = defaultProject ? `/bind ${defaultProject}` : "/bind <projectAlias>"
  const next = isBound
    ? t(locale, "commands.help.nextBound")
    : t(locale, "commands.help.nextUnbound", { bindCommand })
  return [
    t(locale, "commands.help.title"),
    t(locale, "commands.help.scope", { scope: scopeLabel }),
    next,
    defaultProject && !isBound ? t(locale, "commands.help.defaultProjectHint", { project: defaultProject }) : "",
    "",
    t(locale, "commands.help.threadCommands"),
    t(locale, "commands.help.bind"),
    t(locale, "commands.help.new"),
    t(locale, "commands.help.use"),
    t(locale, "commands.help.sessions"),
    t(locale, "commands.help.model"),
    t(locale, "commands.help.feed"),
    t(locale, "commands.help.language"),
    t(locale, "commands.help.status"),
    t(locale, "commands.help.unbind"),
    "",
    t(locale, "commands.help.operatorCommands"),
    t(locale, "commands.help.projects"),
    t(locale, "commands.help.runtime"),
    t(locale, "commands.help.bindings"),
    t(locale, "commands.help.controls"),
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
    resolveBoundRoute,
    recordPromptAnswered,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
    clearAgentActivity,
    getAgentActivityStatus,
    rememberTelegramLocale,
    ctxMetaWithLocale,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
  } = runtime

  const userAttachmentLimits = userAttachmentLimitsFromConfig(config?.limits)
  const activeTurnStaleMs = resolveActiveTurnStaleMs(config?.activeTurnStaleMs)
  const packCallback = callbackPacker(runtime.cb)

  function routeCtxKey(route) {
    if (route?.chatId == null) return ""
    return `${route.chatId}:${route.threadIdOr0 || 0}`
  }

  async function promptContinuationBindingStatus(ctxKey, projectAlias, sessionID = "") {
    try {
      const binding = typeof store?.getBinding === "function" ? store.getBinding(ctxKey) : null
      if (!binding) return typeof resolveBoundRoute === "function" ? "stale" : "current"
      if (binding.projectAlias !== projectAlias) return "stale"
      if (!sessionID || binding.sessionId === sessionID) return "current"
      if (typeof resolveBoundRoute !== "function") return "stale"
      const resolved = await resolveBoundRoute(projectAlias, sessionID)
      return binding.sessionId === resolved?.boundSessionId && routeCtxKey(resolved?.route) === ctxKey ? "current" : "stale"
    } catch (err) {
      const classification = classifyBoundaryError(err)
      if (classification.retryable) return "retryable"
      throw err
    }
  }

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
    staleActiveTurnGuard: maybeBlockStaleActiveTurn,
    t,
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

  function unboundGuidanceText(ctxMeta, reason = t(ctxMeta, "commands.unbound.defaultReason")) {
    const def = configuredDefaultProject()
    return [
      reason,
      t(ctxMeta, "commands.unbound.scope", { scope: threadScopeLabel(ctxMeta) }),
      def ? t(ctxMeta, "commands.unbound.nextWithDefault", { project: def }) : t(ctxMeta, "commands.unbound.nextWithoutDefault"),
      def ? t(ctxMeta, "commands.unbound.defaultProjectHint", { project: def }) : t(ctxMeta, "commands.unbound.useProjects"),
    ].join("\n")
  }

  function unboundGuidanceKeyboard(ctxMeta = null) {
    const rows = []
    const def = configuredDefaultProject()
    const locale = ctxMeta?.locale || config.i18n?.defaultLocale || "en"
    if (def) rows.push([{ text: `${translate(locale, "common.bind")} ${def}`, callback_data: packCallback("srv", def, "bind") }])
    rows.push([{ text: translate(locale, "common.projects"), callback_data: packCallback("srv", "projects") }])
    rows.push([{ text: translate(locale, "common.close"), callback_data: packCallback("srv", "close") }])
    return makeInlineKeyboard(rows)
  }

  function boundThreadActionsKeyboard(ctxMeta) {
    return makeInlineKeyboard([
      [
        { text: t(ctxMeta, "common.sessions"), callback_data: packCallback("s", "refresh") },
        { text: t(ctxMeta, "common.newSession"), callback_data: packCallback("s", "new") },
      ],
      [
        { text: t(ctxMeta, "common.feed"), callback_data: packCallback("feed", "settings") },
        { text: t(ctxMeta, "common.model"), callback_data: packCallback("m", "settings") },
      ],
      [
        { text: t(ctxMeta, "common.unbind"), callback_data: packCallback("b", "confirm-unbind", ctxMeta.ctxKey) },
        { text: t(ctxMeta, "common.close"), callback_data: packCallback("s", "close") },
      ],
    ])
  }

  function localeForCtx(ctxMeta = null) {
    return ctxMeta?.locale || config.i18n?.defaultLocale || "en"
  }

  function closeOnlyKeyboard(ctxMeta = null) {
    return makeInlineKeyboard([[{ text: translate(localeForCtx(ctxMeta), "common.close"), callback_data: packCallback("s", "close") }]])
  }

  async function maybeBlockStaleActiveTurn(ctxMeta, binding) {
    const oc = ocByAlias[binding?.projectAlias]
    if (!oc?.listMessages || !binding?.sessionId) return false
    let status
    try {
      status = await resolveActiveTurnStatus({
        oc,
        projectAlias: binding.projectAlias,
        sessionId: binding.sessionId,
        getAgentActivityStatus: runtime.getAgentActivityStatus,
        mirrorCompaction: runtime.mirrorCompaction,
        staleMs: activeTurnStaleMs,
      })
    } catch (err) {
      logger?.warn?.("Stale active-turn check failed:", binding.projectAlias, binding.sessionId, err?.message || String(err))
      return false
    }
    if (status?.state !== "stale") return false
    await sendToThread(ctxMeta, formatStaleActiveTurnNotice(status, binding), closeOnlyKeyboard(ctxMeta))
    return true
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
    t,
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
    clearAgentActivity,
    getAgentActivityStatus,
    activeTurnStaleMs,
    mirrorCompaction: runtime.mirrorCompaction,
    appendEffectiveModelLines,
    resolveEffectiveModelState,
    compareNumbers: runtime.compareNumbers,
    parseCtxKey,
    markProjectUp: runtime.markProjectUp,
    threadScopeLabel,
    t,
  })

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleLanguage(ctxMeta, argv = []) {
    const arg = String(argv?.[0] || "").trim()
    if (arg) {
      if (arg.toLowerCase() === "reset") {
        store.clearLocale?.(ctxMeta.ctxKey)
        ctxMeta = ctxMetaWithLocale?.({ ...ctxMeta, locale: "" }) || { ...ctxMeta, locale: "" }
        const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
        await sendToThread(ctxMeta, `${t(ctxMeta, "language.reset")}\n\n${view.text}`, view.replyMarkup)
        return
      }

      const locale = matchSupportedLocale(arg, config.i18n?.supportedLocales)
      if (!locale) {
        await sendToThread(
          ctxMeta,
          t(ctxMeta, "language.unsupported", { locale: arg, supported: supportedLocaleSummary({ config, displayLocale: ctxMeta.locale }) }),
          closeOnlyKeyboard(ctxMeta),
        )
        return
      }

      store.setLocale?.(ctxMeta.ctxKey, locale, { source: "manual" })
      ctxMeta = ctxMetaWithLocale?.(ctxMeta) || { ...ctxMeta, locale }
      const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
      await sendToThread(ctxMeta, `${t(ctxMeta, "language.changed", { language: localeDisplayName(locale, locale) })}\n\n${view.text}`, view.replyMarkup)
      return
    }

    const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
    await sendToThread(ctxMeta, view.text, view.replyMarkup)
  }

  async function handleTelegramMessage(msg, options = {}) {
    if (!runtime.isAllowedUser(msg?.from)) return
    let ctxMeta = runtime.ctxMetaFromMessage(msg, msg?.from)
    ctxMeta = rememberTelegramLocale?.(ctxMeta) || ctxMeta
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
      const bindingStatus = await promptContinuationBindingStatus(ctxMeta.ctxKey, awaitingQ.projectAlias, awaitingQ.sessionID)
      if (bindingStatus === "retryable") {
        await sendToThread(ctxMeta, t(ctxMeta, "commands.questionRetry")).catch(() => {})
        return
      }
      if (bindingStatus !== "current") {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, t(ctxMeta, "prompts.questionInactive")).catch(() => {})
        await markMessageHandled("customAnswerStale", { projectAlias: awaitingQ.projectAlias })
        return
      }
      if (!hasText) {
        await sendToThread(ctxMeta, t(ctxMeta, "commands.questionTextExpected"), closeOnlyKeyboard(ctxMeta))
        await markMessageHandled("questionNonText", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId, awaitingQ.sessionID)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, t(ctxMeta, "prompts.questionInactive"))
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
          await sendToThread(ctxMeta, t(ctxMeta, "commands.questionRetry")).catch(() => {})
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
      const bindingStatus = await promptContinuationBindingStatus(ctxMeta.ctxKey, awaiting.projectAlias, awaiting.sessionID)
      if (bindingStatus === "retryable") {
        await sendToThread(ctxMeta, t(ctxMeta, "commands.permissionRetry")).catch(() => {})
        return
      }
      if (bindingStatus !== "current") {
        store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, t(ctxMeta, "commands.permissionInactive")).catch(() => {})
        await markMessageHandled("permissionNoteStale", { projectAlias: awaiting.projectAlias })
        return
      }
      if (!hasText) {
        await sendToThread(ctxMeta, t(ctxMeta, "commands.permissionTextExpected"), closeOnlyKeyboard(ctxMeta))
        await markMessageHandled("permissionNoteNonText", { projectAlias: awaiting.projectAlias })
        return
      }
      const oc = ocByAlias[awaiting.projectAlias]
      const noteKey = permissionNoteIdempotencyKey(awaiting.projectAlias, awaiting.sessionID, awaiting.permissionId, text)
      if (hasIdempotencyKey(noteKey)) {
        store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await markMessageHandled("replyPermissionNote", { projectAlias: awaiting.projectAlias })
        await sendToThread(ctxMeta, t(ctxMeta, "commands.rejectionNoteAlreadySent")).catch(() => {})
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
          await sendToThread(ctxMeta, t(ctxMeta, "commands.permissionInactive")).catch(() => {})
          return
        }
        if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await sendToThread(ctxMeta, t(ctxMeta, "commands.permissionRetry")).catch(() => {})
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
      await sendToThread(ctxMeta, t(ctxMeta, "commands.rejectionNoteSent")).catch(() => {})
      return
    }

    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (!hasText) {
        await sendToThread(ctxMeta, t(ctxMeta, "commands.bindTextExpected"), closeOnlyKeyboard(ctxMeta))
        await markMessageHandled("bindAliasNonText")
        return
      }
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (!cmd) return
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, t(ctxMeta, "commands.cancelled"))
          await markMessageHandled("bindAliasCancel")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
      } else {
        const alias = String(text).trim().split(/\s+/)[0]
        if (!alias) {
          await sendToThread(ctxMeta, t(ctxMeta, "commands.bindAliasPrompt"))
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
        await sendToThread(ctxMeta, cancelled ? t(ctxMeta, "commands.cancelled") : t(ctxMeta, "commands.nothingToCancel"))
        await markMessageHandled("cancel")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        const binding = store.getBinding(ctxMeta.ctxKey)
        await sendToThread(
          ctxMeta,
          helpText({ scopeLabel: threadScopeLabel(ctxMeta), defaultProject: configuredDefaultProject(), isBound: !!binding, locale: ctxMeta.locale, t }),
          binding ? boundThreadActionsKeyboard(ctxMeta) : unboundGuidanceKeyboard(ctxMeta),
        )
        await markMessageHandled(cmd)
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, `${unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.bindPromptReason"))}\n${t(ctxMeta, "commands.unbound.bindPromptCancel")}`, unboundGuidanceKeyboard(ctxMeta))
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
      if (cmd === "/language") {
        await handleLanguage(ctxMeta, argv)
        await markMessageHandled("language")
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
      await sendToThread(ctxMeta, t(ctxMeta, "commands.unknown"))
      await markMessageHandled("unknownCommand")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta), unboundGuidanceKeyboard(ctxMeta))
      await markMessageHandled("unbound")
      return
    }

    if (hasDocument) {
      await handleAttachmentDocumentMessage(ctxMeta, msg, binding, messageKey, markMessageHandled, options)
      return
    }

    if (mediaKind) {
      await sendToThread(ctxMeta, unsupportedMediaText(mediaKind, { limits: userAttachmentLimits, locale: ctxMeta.locale }), closeOnlyKeyboard(ctxMeta))
      await markMessageHandled("unsupportedMedia", { projectAlias: binding.projectAlias, sessionId: binding.sessionId, action: mediaKind })
      return
    }

    if (!hasText) return

    const oc = ocByAlias[binding.projectAlias]
    if (await maybeBlockStaleActiveTurn(ctxMeta, binding)) {
      await markMessageHandled("staleActiveTurn", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
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
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err, { locale: ctxMeta.locale }), withButton ? startServerKeyboard(alias, { locale: ctxMeta.locale }) : null).catch(() => {})
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
