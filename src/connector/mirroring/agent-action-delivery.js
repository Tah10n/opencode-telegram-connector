import { sessionKey } from "../../state/store.js"
import { ctxKeyFrom } from "../../telegram/routing.js"
import { NOISY_SKIP_REASONS } from "../noisy-skip-reasons.js"
import { formatAgentStopErrorNotice } from "./assistant-format.js"
import {
  agentActionForwardKey,
  fallbackAgentActionPartId,
  formatAgentActionText,
  normalizeAgentActionStatus,
  partEventTimeInfo,
} from "./agent-action-format.js"

export function createAgentActionDelivery({
  abortSignal,
  isStopping,
  logSseDebug,
  resolveBoundRouteWithRetry,
  eventStartedAfterLaunch,
  ensureForwardedSets,
  markAgentToolStatus,
  scheduleAgentStopErrorFallback,
  shouldMirrorToFeed,
  getFeedMode,
  recordNoisySkip,
  sendToThread,
} = {}) {
  async function handleMessagePartUpdated({ projectAlias, props }) {
    if (isStopping()) return
    const part = props?.part
    if (part?.type !== "tool") return

    const sessionId = props?.sessionID || part.sessionID || part.sessionId
    const messageId = String(part.messageID || part.messageId || props?.messageID || props?.messageId || "")
    const partId = String(part.id || part.callID || part.callId || fallbackAgentActionPartId(part, props))
    const status = normalizeAgentActionStatus(part?.state?.status)
    if (!sessionId || !partId || !status) return

    logSseDebug(projectAlias, sessionId, `event type=message.part.updated part=tool status=${status} msg=${messageId || "unknown"} part=${partId}`)

    const text = formatAgentActionText(part)
    if (!text) return

    const sk = sessionKey(projectAlias, sessionId)
    const resolved = await resolveBoundRouteWithRetry(projectAlias, sessionId, { signal: abortSignal })
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=agent_action_no_route")
      return
    }
    if (!eventStartedAfterLaunch(partEventTimeInfo(part, props), { allowCompletedAfterStart: true })) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_before_start part=${partId}`)
      return
    }
    const isChildAction = resolved.boundSessionId !== sessionId
    const route = resolved.route
    const routeCtx = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
    const sets = ensureForwardedSets(sk)
    const forwardKey = agentActionForwardKey(messageId, partId, status)
    const eventInfo = partEventTimeInfo(part, props)
    markAgentToolStatus(projectAlias, sessionId, `${messageId}:${partId}`, status, text, { messageId, eventInfo })
    if (status === "error") {
      scheduleAgentStopErrorFallback({
        projectAlias,
        sessionId,
        messageId,
        partId,
        text: formatAgentStopErrorNotice({ reason: "Agent action failed; no successful completion was seen yet.", details: text }),
        allowParentRoute: isChildAction,
        verifyMessageError: true,
      })
    }
    if (isChildAction) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_child bound=${resolved.boundSessionId}`)
      return
    }
    if (sets.actions.has(forwardKey)) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_already_forwarded part=${partId} status=${status}`)
      return
    }

    if (!shouldMirrorToFeed(routeCtx.ctxKey, "agent-action")) {
      sets.actions.add(forwardKey)
      logSseDebug(projectAlias, sessionId, `drop=agent_action_feed part=${partId} mode=${getFeedMode(routeCtx.ctxKey)}`)
      recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.AGENT_ACTION_FEED_FILTERED)
      return
    }

    await sendToThread(routeCtx, text, null, { disable_web_page_preview: true })
    sets.actions.add(forwardKey)
    logSseDebug(projectAlias, sessionId, `send=agent_action part=${partId} status=${status} thread=${route.threadIdOr0 || 0}`)
  }

  return { handleMessagePartUpdated }
}

export { formatAgentActionText }
