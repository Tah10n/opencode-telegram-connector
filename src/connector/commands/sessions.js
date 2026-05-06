import { makeInlineKeyboard } from "../../telegram/client.js"
import { parseSessionReference, findSessionByShareUrl } from "../../session-ref.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "../../session-list.js"
import { getLaunchSupport } from "../../opencode/launcher.js"
import { isSafeOpenCodeId, normalizeOpenCodeId, requireSafeOpenCodeId } from "../../opencode/ids.js"
import { modelSourceLabel } from "../../model-selection.js"
import { callbackPacker } from "./shared.js"
import { t as translate } from "../../i18n/index.js"

export function createSessionCommandHandlers(deps) {
  const {
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    logger,
    platform,
    tg,
    cb,
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
    markProjectUp,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
  } = deps
  const packCallback = callbackPacker(cb)

  function normalizeSafeSessionId(value) {
    const id = normalizeOpenCodeId(value)
    return id && isSafeOpenCodeId(id) ? id : ""
  }

  function requireSessionIdFromBackend(value, context) {
    return requireSafeOpenCodeId(value, context || "session id")
  }

  function invalidSessionReferenceText() {
    return "Invalid session id. Use a session id without whitespace, colon, pipe, or URL path/query characters. Share links are accepted only when they resolve to a safe session id."
  }

  function unsafeShareLinkSessionText() {
    return "Share link resolved to a session id this connector cannot safely bind. Use a session id without whitespace, colon, pipe, or URL path/query characters."
  }

  function createSessionOptions(projectAlias, extra = {}) {
    const directory = projects?.[projectAlias]?.directory
    return {
      ...extra,
      ...(directory ? { directory } : {}),
    }
  }

  async function resolveValidStartupSession(alias, oc) {
    let startupSid = startupSessionByProject[alias] || (await resolveStartupSession(alias))
    if (startupSid && !normalizeSafeSessionId(startupSid)) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      logger.warn?.(`[${alias}] ignored invalid cached startup session id`)
      startupSid = null
    }
    if (!startupSid) return null

    try {
      await oc.getSession(startupSid)
      return requireSessionIdFromBackend(startupSid, "startup session id")
    } catch (err) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      startupSid = await resolveStartupSession(alias, { forceRefresh: true })
      if (startupSid && !normalizeSafeSessionId(startupSid)) {
        if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
        logger.warn?.(`[${alias}] ignored invalid refreshed startup session id`)
        startupSid = null
      }
      if (!startupSid) throw err
      await oc.getSession(startupSid)
      return requireSessionIdFromBackend(startupSid, "startup session id")
    }
  }

  function sessionsKeyboard(projectAlias, sessions, { currentSessionId, startupSessionId, limit = 10, locale = "en" } = {}) {
    const normalized = normalizeSessionsList(sessions).slice(0, limit).filter((session) => isSafeOpenCodeId(session.id))
    const rows = normalized.map((session) => [
      {
        text: formatSessionButtonLabel(session, { currentSessionId, startupSessionId }),
        callback_data: packCallback("s", projectAlias, session.id),
      },
    ])
    rows.push([
      { text: t(locale, "sessions.refresh"), callback_data: packCallback("s", "refresh") },
      { text: t(locale, "common.newSession"), callback_data: packCallback("s", "new") },
      { text: t(locale, "common.close"), callback_data: packCallback("s", "close") },
    ])
    return makeInlineKeyboard(rows)
  }

  function closeKeyboard(callbackParts = ["s", "close"], locale = "en") {
    return makeInlineKeyboard([[{ text: t(locale, "common.close"), callback_data: packCallback(callbackParts) }]])
  }

  async function renderSessionsList(ctxMeta, { binding, editMessageId } = {}) {
    const oc = ocByAlias[binding.projectAlias]
    const sessions = await oc.listSessions({ directory: projects?.[binding.projectAlias]?.directory, limit: 10 })
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(binding.projectAlias),
      resolveSessionModelInfo(binding.projectAlias, binding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding, { configuredInfo, sessionModelInfo })
    markProjectUp?.(binding.projectAlias)
    const text = formatSessionsListText(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      currentSessionModelLabel: effectiveState?.label,
      currentSessionModelSourceLabel:
        effectiveState?.source && effectiveState.source !== "unknown" ? modelSourceLabel(effectiveState.source) : "",
      startupSessionId: startupSessionByProject[binding.projectAlias],
      locale: ctxMeta.locale,
    })
    const replyMarkup = sessionsKeyboard(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
      locale: ctxMeta.locale,
    })
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function renderProjectSessions(ctxMeta, projectAlias, { editMessageId } = {}) {
    if (!projectAlias || !projects?.[projectAlias]) {
      await safeInformThread(ctxMeta, t(ctxMeta, "sessions.unknownProject"))
      return
    }
    const existing = store.getBinding(ctxMeta.ctxKey)
    if (ctxMeta?.chatType !== "private" && existing?.projectAlias !== projectAlias) {
      await safeInformThread(ctxMeta, t(ctxMeta, "sessions.privateProjectActions"))
      return
    }
    const startupSid = startupSessionByProject[projectAlias] || (await resolveStartupSession(projectAlias)) || ""
    if (existing?.projectAlias !== projectAlias) {
      const oc = ocByAlias[projectAlias]
      const sessions = await oc.listSessions({ directory: projects?.[projectAlias]?.directory, limit: 10 })
      markProjectUp?.(projectAlias)
      const text = `${formatSessionsListText(projectAlias, sessions, { startupSessionId: startupSid, locale: ctxMeta.locale, viewOnly: true })}\n\n${t(ctxMeta, "sessions.viewOnly")}`
      const replyMarkup = closeKeyboard(["srv", "close"], ctxMeta.locale)
      if (editMessageId) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
        return
      }
      await sendToThread(ctxMeta, text, replyMarkup)
      return
    }
    await renderSessionsList(ctxMeta, {
      binding: { projectAlias, sessionId: existing.sessionId || startupSid },
      editMessageId,
    })
  }

  async function handleBindCommand(ctxMeta, argv) {
    const alias = argv[0]
    if (!alias) {
      await sendToThread(ctxMeta, t(ctxMeta, "sessions.usageBind"))
      return
    }
    try {
      await validateProject(alias)
      const oc = ocByAlias[alias]

      const existing = store.getBinding(ctxMeta.ctxKey)
      if (existing && existing.projectAlias === alias && existing.sessionId) {
        await sendToThread(ctxMeta, t(ctxMeta, "sessions.alreadyBound", { project: alias, session: existing.sessionId }))
        return
      }
      const startupSid = await resolveValidStartupSession(alias, oc)
      if (startupSid) {
        const bindResult = await bindCtxToSession(ctxMeta, alias, startupSid)
        await sendToThread(ctxMeta, appendMoveConflict([t(ctxMeta, "sessions.boundStartup", { project: alias, session: startupSid })], bindResult, ctxMeta.locale).join("\n"))
      } else {
        const created = await oc.createSession(createSessionOptions(alias))
        const createdId = requireSessionIdFromBackend(created?.id, "created session id")
        logger.info(`[${alias}] created session for bind:`, createdId)
        startupSessionByProject[alias] = createdId
        const bindResult = await bindCtxToSession(ctxMeta, alias, createdId)
        await sendToThread(ctxMeta, appendMoveConflict([t(ctxMeta, "sessions.boundNew", { project: alias, session: createdId })], bindResult, ctxMeta.locale).join("\n"))
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err, { locale: ctxMeta.locale })).catch(() => {})
    }
  }

  async function handleNewCommand(ctxMeta, title) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.createSessionNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const p = projects[binding.projectAlias]
      const attachOnNewMode = String(p?.openAttachOnNewMode || "same-window")
      const created = await oc.createSession(createSessionOptions(binding.projectAlias, title ? { title } : {}))
      const createdId = requireSessionIdFromBackend(created?.id, "created session id")
      logger.info(`[${binding.projectAlias}] /new created session:`, createdId)

      let tuiSwitchErr = null
      const canRequestTuiSwitch = attachOnNewMode === "same-window" && typeof oc?.selectTuiSession === "function"
      if (canRequestTuiSwitch) {
        await oc
          .selectTuiSession(createdId, { timeoutMs: 2500 })
          .then(() => {
            logger.info(`[${binding.projectAlias}] requested TUI switch to session:`, createdId)
          })
          .catch((err) => {
            tuiSwitchErr = err
            logger.info(
              `[${binding.projectAlias}] failed to request TUI switch (same-window) for session=${createdId}: ${err?.message || String(err)}`,
            )
          })
      }

      let activeSessionSyncUnsupported = false
      if (attachOnNewMode === "same-window" && !tuiSwitchErr && typeof oc?.getActiveTuiSession === "function") {
        await oc.getActiveTuiSession({ timeoutMs: 1500 }).catch((err) => {
          if (err?.isBoundaryError === true && err.status === 404) {
            activeSessionSyncUnsupported = true
            logger.info(`[${binding.projectAlias}] /tui/active-session is unavailable; same-window /new will bind immediately without TUI auto-follow.`)
          }
        })
      }

      const sameWindowSwitchFailed = attachOnNewMode === "same-window" && (!canRequestTuiSwitch || !!tuiSwitchErr)
      if (attachOnNewMode === "same-window") {
        const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, createdId)
        primeTuiActiveSessionFollow?.(binding.projectAlias, ctxMeta, binding.sessionId, { pendingTargetSessionId: createdId })

        const lines = [await buildNewSessionText(binding.projectAlias, createdId, { ctxKey: ctxMeta.ctxKey, locale: ctxMeta.locale })]
        if (sameWindowSwitchFailed) {
          lines.push(
            `Note: Could not switch the existing TUI automatically in same-window mode. Telegram is already using the new session; switch or reattach the TUI manually if needed.`,
          )
        } else {
          lines.push(`Requested same-window TUI switch to session: ${createdId}.`)
        }
        if (activeSessionSyncUnsupported) {
          lines.push(
            `Note: This opencode server does not expose active TUI session tracking; Telegram is already using the new session, but future TUI-only switches will not be followed automatically.`,
          )
        }
        await sendToThread(ctxMeta, appendMoveConflict(lines, bindResult, ctxMeta.locale).join("\n"))
      } else {
        const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, createdId)
        await sendToThread(
          ctxMeta,
          appendMoveConflict([await buildNewSessionText(binding.projectAlias, createdId, { ctxKey: ctxMeta.ctxKey, locale: ctxMeta.locale })], bindResult, ctxMeta.locale).join("\n"),
        )
      }

      if (attachOnNewMode === "new-window") {
        const launchSupport = getLaunchSupport({ project: p, platform })
        const openAttach = openAttachWindowFn || openAttachWindowWindowsFn
        if (launchSupport.canOpenAttachWindow && openAttach) {
          await openAttach({ directory: p.directory, baseUrl: p.baseUrl, sessionId: createdId, platform }).catch((err) => {
            logger.error("Failed to open attach window:", binding.projectAlias, err?.message || String(err))
          })
        } else {
          logger.info(`[${binding.projectAlias}] openAttachOnNewMode=new-window is configured, but no attach-window launcher is available on platform=${platform}.`)
        }
      } else if (attachOnNewMode === "same-window") {
        logger.info(`[${binding.projectAlias}] /new created ${createdId}; openAttachOnNewMode=same-window (no new window spawned).`)
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err, { locale: ctxMeta.locale })).catch(() => {})
    }
  }

  async function handleUseCommand(ctxMeta, sessionId) {
    const sessionRef = parseSessionReference(sessionId)
    if (!sessionRef) {
      await safeInformThread(ctxMeta, t(ctxMeta, "sessions.usageUse"))
      return
    }
    if (sessionRef.type === "invalid-link") {
      await safeInformThread(
        ctxMeta,
        "Unsupported link. Use an OpenCode share link like https://opncd.ai/share/<share-id> (or https://opncd.ai/s/<share-id>) or a raw session id.",
      )
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.switchSessionNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const oc = ocByAlias[binding.projectAlias]

    async function listSessionsForShareLookup(projectAlias) {
      return ocByAlias[projectAlias].listSessions({ directory: projects?.[projectAlias]?.directory })
    }

    try {
      let targetSessionId = sessionRef.sessionId
      if (sessionRef.type === "session-id") {
        targetSessionId = normalizeSafeSessionId(targetSessionId)
        if (!targetSessionId) {
          await safeInformThread(ctxMeta, invalidSessionReferenceText())
          return
        }
      }
      if (sessionRef.type === "share-link") {
        const currentSessions = await listSessionsForShareLookup(binding.projectAlias)
        const currentMatch = findSessionByShareUrl(currentSessions, sessionRef.shareUrl)
        if (currentMatch?.id) {
          targetSessionId = normalizeSafeSessionId(currentMatch.id)
          if (!targetSessionId) {
            await safeInformThread(ctxMeta, unsafeShareLinkSessionText())
            return
          }
        } else {
          let mismatch = null
          const otherLookupErrors = []
          for (const alias of Object.keys(projects)) {
            if (alias === binding.projectAlias) continue
            try {
              const otherSessions = await listSessionsForShareLookup(alias)
              const otherMatch = findSessionByShareUrl(otherSessions, sessionRef.shareUrl)
              if (otherMatch?.id) {
                mismatch = { projectAlias: alias, sessionId: normalizeSafeSessionId(otherMatch.id) || String(otherMatch.id) }
                break
              }
            } catch (err) {
              logger.warn(`Failed to check share link against project '${alias}':`, err?.message || String(err))
              otherLookupErrors.push(alias)
            }
          }

          if (mismatch) {
            await safeInformThread(
              ctxMeta,
              `This share link belongs to project '${mismatch.projectAlias}' (session: ${mismatch.sessionId}), but this thread is bound to '${binding.projectAlias}'. Use /bind ${mismatch.projectAlias} first.`,
            )
            return
          }

          if (otherLookupErrors.length) {
            await safeInformThread(
              ctxMeta,
              `Share link was not found in project '${binding.projectAlias}', but these project lookups failed: ${otherLookupErrors.join(", ")}. The link may belong to one of them; try again when those projects are available.`,
            )
            return
          }

          await safeInformThread(
            ctxMeta,
            `Share link not found in project '${binding.projectAlias}'. It may belong to a different project or may not be shared on this server.`,
          )
          return
        }
      }

      targetSessionId = normalizeSafeSessionId(targetSessionId)
      if (!targetSessionId) {
        await safeInformThread(ctxMeta, invalidSessionReferenceText())
        return
      }
      await oc.getSession(targetSessionId)
      const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, targetSessionId)
      await sendToThread(
        ctxMeta,
        appendMoveConflict([await buildSessionSwitchText(binding.projectAlias, targetSessionId, { ctxKey: ctxMeta.ctxKey, locale: ctxMeta.locale })], bindResult, ctxMeta.locale).join("\n"),
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err, { locale: ctxMeta.locale })).catch(() => {})
    }
  }

  async function handleSessions(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.sessionListNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    try {
      await renderSessionsList(ctxMeta, { binding })
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err, { locale: ctxMeta.locale })).catch(() => {})
    }
  }

  return {
    renderSessionsList,
    renderProjectSessions,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
  }
}
