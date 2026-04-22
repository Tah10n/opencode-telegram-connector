import { makeInlineKeyboard } from "../telegram/client.js"
import { parseSessionReference, findSessionByShareUrl } from "../session-ref.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "../session-list.js"
import { sanitizeBaseUrlForDisplay } from "../url-utils.js"
import { sessionKey } from "../state/store.js"

function helpText() {
  return [
    "Commands:",
    "/bind <projectAlias>",
    "/new [title]",
    "/use <sessionId|shareLink>",
    "/sessions",
    "/feed",
    "/status",
    "/bindings (private chat only)",
    "/abort",
    "/sendlast",
    "/projects",
    "/unbind",
    "/cancel",
  ].join("\n")
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
    getStartupSession,
    openAttachWindowWindowsFn,
    validateProject,
    bindCtxToSession,
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
    isLikelyConnectError,
    startServerKeyboard,
    ensureRecentPromptSet,
    hashTextForEcho,
    formatProjectUnavailable,
    buildProjectsOverviewText,
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
  } = runtime

  async function resolveStartupSession(alias, { forceRefresh = false } = {}) {
    return getStartupSession(alias, { waitForStart: false, forceRefresh }).catch(() => null)
  }

  async function resolveValidStartupSession(alias, oc) {
    let startupSid = startupSessionByProject[alias] || (await resolveStartupSession(alias))
    if (!startupSid) return null

    try {
      await oc.getSession(startupSid)
      return startupSid
    } catch (err) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      startupSid = await resolveStartupSession(alias, { forceRefresh: true })
      if (!startupSid) throw err
      await oc.getSession(startupSid)
      return startupSid
    }
  }

  function sessionsKeyboard(projectAlias, sessions, { currentSessionId, startupSessionId, limit = 10 } = {}) {
    const normalized = normalizeSessionsList(sessions).slice(0, limit)
    if (!normalized.length) return null
    return makeInlineKeyboard(
      normalized.map((session) => [
        {
          text: formatSessionButtonLabel(session, { currentSessionId, startupSessionId }),
          callback_data: runtime.cb.pack(`s|${projectAlias}|${session.id}`),
        },
      ]),
    )
  }

  async function renderSessionsList(ctxMeta, { binding, editMessageId } = {}) {
    const oc = ocByAlias[binding.projectAlias]
    const sessions = await oc.listSessions({ directory: projects?.[binding.projectAlias]?.directory, limit: 10 })
    runtime.markProjectUp(binding.projectAlias)
    const text = formatSessionsListText(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    const replyMarkup = sessionsKeyboard(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    if (editMessageId) {
      await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function handleBindCommand(ctxMeta, argv) {
    const alias = argv[0]
    if (!alias) {
      await sendToThread(ctxMeta, "Usage: /bind <projectAlias>")
      return
    }
    try {
      await validateProject(alias)
      const oc = ocByAlias[alias]

      const existing = store.getBinding(ctxMeta.ctxKey)
      if (existing && existing.projectAlias === alias && existing.sessionId) {
        await sendToThread(ctxMeta, `Already bound: ${alias} / ${existing.sessionId}`)
        return
      }
      const startupSid = await resolveValidStartupSession(alias, oc)
      if (startupSid) {
        await bindCtxToSession(ctxMeta, alias, startupSid)
        await sendToThread(ctxMeta, `Bound to project '${alias}' (startup session): ${startupSid}`)
      } else {
        const created = await oc.createSession({})
        if (created?.id) logger.info(`[${alias}] created session for bind:`, created.id)
        startupSessionByProject[alias] = created.id
        await bindCtxToSession(ctxMeta, alias, created.id)
        await sendToThread(ctxMeta, `Bound to project '${alias}' with new session: ${created.id}`)
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err)).catch(() => {})
    }
  }

  async function handleNewCommand(ctxMeta, title) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const created = await oc.createSession({ title: title || undefined })
      if (created?.id) logger.info(`[${binding.projectAlias}] /new created session:`, created.id)
      await bindCtxToSession(ctxMeta, binding.projectAlias, created.id)
      await sendToThread(ctxMeta, `Created and switched to session: ${created.id}`)

      const p = projects[binding.projectAlias]
      if (p?.openAttachOnNew === true) {
        if (platform === "win32") {
          await openAttachWindowWindowsFn({ directory: p.directory, baseUrl: p.baseUrl, sessionId: created.id }).catch((err) => {
            logger.error("Failed to open attach window:", binding.projectAlias, err?.message || String(err))
          })
        } else {
          logger.info(`[${binding.projectAlias}] openAttachOnNew is enabled, but attach auto-open is only implemented on Windows.`)
        }
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleUseCommand(ctxMeta, sessionId) {
    const sessionRef = parseSessionReference(sessionId)
    if (!sessionRef) {
      await sendToThread(ctxMeta, "Usage: /use <sessionId|shareLink>")
      return
    }
    if (sessionRef.type === "invalid-link") {
      await sendToThread(ctxMeta, "Unsupported link. Use an OpenCode share link like https://opncd.ai/s/<share-id> or a raw session id.")
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]

    async function listSessionsForShareLookup(projectAlias) {
      return ocByAlias[projectAlias].listSessions({ directory: projects?.[projectAlias]?.directory })
    }

    try {
      let targetSessionId = sessionRef.sessionId
      if (sessionRef.type === "share-link") {
        const currentSessions = await listSessionsForShareLookup(binding.projectAlias)
        const currentMatch = findSessionByShareUrl(currentSessions, sessionRef.shareUrl)
        if (currentMatch?.id) {
          targetSessionId = currentMatch.id
        } else {
          let mismatch = null
          const otherLookupErrors = []
          for (const alias of Object.keys(projects)) {
            if (alias === binding.projectAlias) continue
            try {
              const otherSessions = await listSessionsForShareLookup(alias)
              const otherMatch = findSessionByShareUrl(otherSessions, sessionRef.shareUrl)
              if (otherMatch?.id) {
                mismatch = { projectAlias: alias, sessionId: otherMatch.id }
                break
              }
            } catch (err) {
              logger.warn(`Failed to check share link against project '${alias}':`, err?.message || String(err))
              otherLookupErrors.push(alias)
            }
          }

          if (mismatch) {
            await sendToThread(
              ctxMeta,
              `This share link belongs to project '${mismatch.projectAlias}' (session: ${mismatch.sessionId}), but this thread is bound to '${binding.projectAlias}'. Use /bind ${mismatch.projectAlias} first.`,
            )
            return
          }

          if (otherLookupErrors.length) {
            await sendToThread(
              ctxMeta,
              `Share link was not found in project '${binding.projectAlias}', but these project lookups failed: ${otherLookupErrors.join(", ")}. The link may belong to one of them; try again when those projects are available.`,
            )
            return
          }

          await sendToThread(
            ctxMeta,
            `Share link not found in project '${binding.projectAlias}'. It may belong to a different project or may not be shared on this server.`,
          )
          return
        }
      }

      await oc.getSession(targetSessionId)
      await bindCtxToSession(ctxMeta, binding.projectAlias, targetSessionId)
      await sendToThread(ctxMeta, `Switched to session: ${targetSessionId}`)
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleSessions(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    try {
      await renderSessionsList(ctxMeta, { binding })
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleAbort(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const aborted = await oc.abortSession(binding.sessionId)
      runtime.markProjectUp(binding.projectAlias)
      await sendToThread(
        ctxMeta,
        aborted === false ? `No active run to abort for session: ${binding.sessionId}` : `Abort requested for session: ${binding.sessionId}`,
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleWhere(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }
    const startupSessionId = startupSessionByProject[binding.projectAlias] || "unknown"
    const sseStatus = getProjectSseStatus(binding.projectAlias)
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[binding.projectAlias]?.baseUrl) || "unknown"
    const feedMode = feedModeLabel(getFeedMode(ctxMeta.ctxKey))
    await sendToThread(
      ctxMeta,
      [
        `Project: ${binding.projectAlias}`,
        `Session: ${binding.sessionId}`,
        `Startup session: ${startupSessionId}`,
        `Feed: ${feedMode}`,
        `SSE: ${sseStatus}`,
        `Base URL: ${baseUrl}`,
      ].join("\n"),
    )
  }

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleBindings(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await sendToThread(ctxMeta, "Use /bindings only in a private chat with the bot. Bindings contain sensitive session IDs.")
      return
    }
    const entries = Object.entries(store.get().bindings || {})
      .map(([ctxKey, binding]) => ({ ctxKey, binding, ctx: parseCtxKey(ctxKey) }))
      .sort((a, b) => {
        const byChat = runtime.compareNumbers(a.ctx?.chatId ?? 0, b.ctx?.chatId ?? 0)
        if (byChat !== 0) return byChat
        const byThread = runtime.compareNumbers(a.ctx?.threadIdOr0 ?? 0, b.ctx?.threadIdOr0 ?? 0)
        if (byThread !== 0) return byThread
        return a.ctxKey.localeCompare(b.ctxKey)
      })

    if (!entries.length) {
      await sendToThread(ctxMeta, "No bindings.")
      return
    }

    const lines = ["Bindings:"]
    for (const entry of entries) {
      const scope = entry.ctx ? `chat ${entry.ctx.chatId} / ${formatThreadLabel(entry.ctx.threadIdOr0)}` : entry.ctxKey
      const current = entry.ctxKey === ctxMeta.ctxKey ? " (current)" : ""
      lines.push(`- ${scope}${current} -> ${entry.binding.projectAlias} / ${entry.binding.sessionId}`)
    }
    await sendToThread(ctxMeta, lines.join("\n"))
  }

  async function handleSendLast(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    if (!oc) {
      await sendToThread(ctxMeta, `Unknown project: ${binding.projectAlias}`)
      return
    }
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const last = lastAssistantBySession.get(sk)
    const messageId = last?.messageId
    const messageSessionId = last?.sessionId || binding.sessionId
    let text = typeof last?.text === "string" ? last.text : ""

    if (messageId) {
      const msg = await oc.getMessage(messageSessionId, messageId).catch(() => null)
      if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        // ignore
      } else {
        const fetched = extractAssistantDisplayText(binding.projectAlias, msg)
        if (fetched && fetched.trim()) text = fetched
      }
    }

    if (!text || !text.trim()) {
      await sendToThread(ctxMeta, "No assistant message yet.")
      return
    }
    await deliverAssistantText(ctxMeta, binding.projectAlias, messageSessionId, messageId || "sendlast", text)
  }

  async function handleProjects(ctxMeta) {
    const aliases = Object.keys(projects)
    await Promise.allSettled(aliases.map((a) => resolveStartupSession(a, { forceRefresh: true })))
    const text = buildProjectsOverviewText({
      startupSessionByProject,
      formatThreadLabel,
      previewLimit: 3,
      showBindingScopes: ctxMeta?.chatType === "private",
    })
    await sendToThread(ctxMeta, text)
  }

  async function handleUnbind(ctxMeta) {
    const ok = store.unbind(ctxMeta.ctxKey)
    await sendToThread(ctxMeta, ok ? "Unbound." : "Not bound.")
  }

  async function handleTelegramMessage(msg) {
    if (!runtime.isAllowedUser(msg?.from)) return
    const ctxMeta = runtime.ctxMetaFromMessage(msg)
    if (!ctxMeta.chatId) return

    const text = msg?.text
    if (typeof text !== "string" || !text.trim()) return

    const awaitingQ = awaitingCustomAnswer.get(ctxMeta.ctxKey)
    if (awaitingQ) {
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, "Question is no longer active.")
        return
      }
      const nextWizard = cloneWizardState(wizard)
      nextWizard.answers[awaitingQ.qIndex] = [text]
      const nextIndex = awaitingQ.qIndex + 1
      if (nextIndex >= wizard.request.questions.length) {
        persistQuestionWizard(nextWizard)
        await finishQuestionWizard(nextWizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      } else {
        nextWizard.index = nextIndex
        await sendCurrentQuestionStep(nextWizard)
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      const oc = ocByAlias[awaiting.projectAlias]
      await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId)
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      await sendToThread(ctxMeta, "Rejection note sent.").catch(() => {})
      return
    }

    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, "Cancelled.")
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
        return handleBindCommand(ctxMeta, [alias])
      }
    }

    if (isCommand(text)) {
      const { cmd, args, argv } = parseCommand(text)
      if (cmd === "/cancel") {
        const hadBind = bindAliasAwaiting.delete(ctxMeta.ctxKey)
        const hadRejectNote = rejectNoteAwaiting.has(ctxMeta.ctxKey)
        const hadCustomAnswer = awaitingCustomAnswer.has(ctxMeta.ctxKey)
        if (hadRejectNote) setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        if (hadCustomAnswer) setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        const cancelled = hadBind || hadRejectNote || hadCustomAnswer
        await sendToThread(ctxMeta, cancelled ? "Cancelled." : "Nothing to cancel.")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        await sendToThread(ctxMeta, helpText())
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, "Send project alias (or /projects to list). You can /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        return handleBindCommand(ctxMeta, argv)
      }
      if (cmd === "/new") return handleNewCommand(ctxMeta, args)
      if (cmd === "/use") return handleUseCommand(ctxMeta, argv[0])
      if (cmd === "/sessions") return handleSessions(ctxMeta)
      if (cmd === "/feed") return handleFeed(ctxMeta)
      if (cmd === "/status") return handleWhere(ctxMeta)
      if (cmd === "/bindings") return handleBindings(ctxMeta)
      if (cmd === "/abort") return handleAbort(ctxMeta)
      if (cmd === "/sendlast") return handleSendLast(ctxMeta)
      if (cmd === "/projects") return handleProjects(ctxMeta)
      if (cmd === "/unbind") return handleUnbind(ctxMeta)
      await sendToThread(ctxMeta, "Unknown command. Use /help.")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      const def = config.defaultProject
      if (def) await sendToThread(ctxMeta, `Not bound. Use /bind <projectAlias> (default: ${def}).`)
      else await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }

    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    try {
      const promptText = `${prefix}${text}`
      const sk = sessionKey(binding.projectAlias, binding.sessionId)
      ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
      await oc.promptAsync(binding.sessionId, promptText)
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isLikelyConnectError(err) && canAutoStartProject(alias, { platform })
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : null).catch(() => {})
    }
  }

  return {
    renderSessionsList,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
    handleAbort,
    handleWhere,
    handleFeed,
    handleBindings,
    handleSendLast,
    handleProjects,
    handleUnbind,
    handleTelegramMessage,
  }
}
