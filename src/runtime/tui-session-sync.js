import { classifyBoundaryError } from "../boundary-errors.js"
import { sessionKey } from "../state/store.js"
import { ctxKeyFrom } from "../telegram/routing.js"

export function createTuiSessionSyncTools({
  store,
  ocByAlias,
  abortSignal,
  logger,
  ctxMetaWithLocale,
  bindCtxToSession,
  flushCriticalState,
  sendToThread,
} = {}) {
  const tuiActiveSessionStateByProject = new Map() // alias -> { currentSessionId, followCtxKey }
  const tuiActiveSessionUnsupportedProjects = new Set() // alias values where /tui/active-session is unavailable

  function getBoundCtxForSession(projectAlias, sessionId) {
    if (!projectAlias || !sessionId) return null
    const route = store.get().sessionIndex?.[sessionKey(projectAlias, sessionId)]
    if (!route) return null
    const ctxKey = ctxKeyFrom(route.chatId, route.threadIdOr0)
    const binding = store.getBinding(ctxKey)
    if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
    return ctxMetaWithLocale({ chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey })
  }

  function parseBoundCtxKey(ctxKey) {
    const match = String(ctxKey || "").match(/^(-?\d+):(\d+)$/)
    if (!match) return null
    return ctxMetaWithLocale({ chatId: Number(match[1]), threadIdOr0: Number(match[2]), ctxKey: String(ctxKey) })
  }

  function primeTuiActiveSessionFollow(projectAlias, ctxMeta, sessionId, options = {}) {
    if (!projectAlias || !ctxMeta?.ctxKey || !sessionId) return
    const pendingTargetSessionId =
      typeof options?.pendingTargetSessionId === "string" && options.pendingTargetSessionId.trim() ? options.pendingTargetSessionId.trim() : null
    tuiActiveSessionStateByProject.set(projectAlias, {
      currentSessionId: sessionId,
      followCtxKey: ctxMeta.ctxKey,
      ...(pendingTargetSessionId ? { pendingTargetSessionId } : {}),
    })
  }

  async function syncProjectTuiActiveSession(projectAlias) {
    if (tuiActiveSessionUnsupportedProjects.has(projectAlias)) return
    const oc = ocByAlias[projectAlias]
    if (!oc?.getActiveTuiSession) return

    let activeSession = null
    try {
      activeSession = await oc.getActiveTuiSession({ timeoutMs: 2500, signal: abortSignal })
    } catch (err) {
      const classification = classifyBoundaryError(err, {
        source: "opencode",
        operation: "GET /tui/active-session",
        method: "GET",
        pathname: "/tui/active-session",
      })
      if (classification.status === 404) {
        tuiActiveSessionUnsupportedProjects.add(projectAlias)
        logger.info(`[${projectAlias}] /tui/active-session is unavailable; disabling TUI session sync.`)
      }
      return
    }

    const activeSessionId = typeof activeSession?.id === "string" && activeSession.id.trim() ? activeSession.id.trim() : null
    let previous = tuiActiveSessionStateByProject.get(projectAlias)
    if (!previous) {
      const activeCtx = activeSessionId ? getBoundCtxForSession(projectAlias, activeSessionId) : null
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: activeCtx?.ctxKey || null,
      })
      return
    }

    const pendingTargetSessionId =
      typeof previous.pendingTargetSessionId === "string" && previous.pendingTargetSessionId.trim() ? previous.pendingTargetSessionId.trim() : null
    if (pendingTargetSessionId) {
      const followCtxKey = previous.followCtxKey || getBoundCtxForSession(projectAlias, pendingTargetSessionId)?.ctxKey || null
      const followBinding = followCtxKey ? store.getBinding(followCtxKey) : null
      if (followBinding?.projectAlias === projectAlias && followBinding.sessionId === pendingTargetSessionId) {
        if (activeSessionId === pendingTargetSessionId) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: activeSessionId,
            followCtxKey,
          })
          logger.info(`[${projectAlias}] confirmed pending TUI switch to session: ${activeSessionId}`)
          return
        }
        if (!activeSessionId || activeSessionId === previous.currentSessionId) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: previous.currentSessionId,
            followCtxKey,
            pendingTargetSessionId,
          })
          return
        }
      } else {
        tuiActiveSessionStateByProject.set(projectAlias, {
          currentSessionId: previous.currentSessionId,
          followCtxKey: previous.followCtxKey || null,
        })
        previous = tuiActiveSessionStateByProject.get(projectAlias)
      }
    }

    if (previous.currentSessionId === activeSessionId) {
      if (!previous.followCtxKey && activeSessionId) {
        const activeCtx = getBoundCtxForSession(projectAlias, activeSessionId)
        if (activeCtx?.ctxKey) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: activeSessionId,
            followCtxKey: activeCtx.ctxKey,
          })
        }
      }
      return
    }

    const followCtxKey = previous.followCtxKey || getBoundCtxForSession(projectAlias, previous.currentSessionId)?.ctxKey || null
    if (!activeSessionId) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: null,
        followCtxKey,
      })
      return
    }

    const targetCtx = getBoundCtxForSession(projectAlias, activeSessionId)
    if (!followCtxKey) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    const followBinding = store.getBinding(followCtxKey)
    if (followBinding?.projectAlias !== projectAlias) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    if (followBinding.sessionId === activeSessionId) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey,
      })
      return
    }

    const sourceCtx = parseBoundCtxKey(followCtxKey)
    if (!sourceCtx) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    if (targetCtx && targetCtx.ctxKey !== followCtxKey) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey,
      })
      logger.info(
        `[${projectAlias}] active TUI session ${activeSessionId} is already bound to another Telegram context; skipping auto-switch from ${followBinding.sessionId}.`,
      )
      return
    }

    try {
      await bindCtxToSession(sourceCtx, projectAlias, activeSessionId)
      await flushCriticalState("persist TUI active session binding")
    } catch (err) {
      try {
        store.setBinding(followCtxKey, followBinding, sourceCtx)
      } catch {}
      throw err
    }
    tuiActiveSessionStateByProject.set(projectAlias, {
      currentSessionId: activeSessionId,
      followCtxKey,
    })
    await sendToThread(sourceCtx, `TUI switched to session: ${activeSessionId}\nPrevious: ${followBinding.sessionId}`).catch(() => {})
    logger.info(`[${projectAlias}] synced Telegram binding to active TUI session: ${followBinding.sessionId} -> ${activeSessionId}`)
  }

  return {
    primeTuiActiveSessionFollow,
    syncProjectTuiActiveSession,
  }
}
