export const DEFAULT_ACTIVE_TURN_STALE_MS = 20 * 60 * 1000

const TIMESTAMP_KEYS = new Set([
  "created",
  "createdAt",
  "start",
  "started",
  "startedAt",
  "updated",
  "updatedAt",
  "completed",
  "completedAt",
  "finish",
  "finished",
  "finishedAt",
  "end",
  "ended",
  "endedAt",
])

export function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
  }
  return null
}

function positiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function resolveActiveTurnStaleMs(...values) {
  for (const value of values) {
    const n = positiveNumber(value)
    if (n != null) return Math.floor(n)
  }
  return DEFAULT_ACTIVE_TURN_STALE_MS
}

function assistantInfo(message) {
  return message?.info || message || {}
}

export function messageId(message) {
  const info = assistantInfo(message)
  return String(info?.id || "").trim()
}

function isCompactionAssistant(message, { mirrorCompaction = false } = {}) {
  const info = assistantInfo(message)
  return !mirrorCompaction && (info?.mode === "compaction" || info?.agent === "compaction")
}

export function isTerminalAssistantMessage(message, options = {}) {
  const info = assistantInfo(message)
  if (info?.role !== "assistant") return false
  if (isCompactionAssistant(message, options)) return false
  if (info?.error) return true
  const time = info?.time || message?.time || {}
  return normalizeEpochMs(time.completed) != null
}

export function isRunningAssistantMessage(message, options = {}) {
  const info = assistantInfo(message)
  if (info?.role !== "assistant") return false
  if (isCompactionAssistant(message, options)) return false
  if (info?.error) return false
  const time = info?.time || message?.time || {}
  if (normalizeEpochMs(time.completed) != null) return false
  return collectMessageTimestamps(message).length > 0
}

function collectTimestamps(value, out = [], depth = 0) {
  if (value == null || depth > 6) return out
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, out, depth + 1)
    return out
  }
  if (typeof value !== "object") return out
  for (const [key, child] of Object.entries(value)) {
    if (TIMESTAMP_KEYS.has(key)) {
      const t = normalizeEpochMs(child)
      if (t != null) out.push(t)
    }
    if (child && typeof child === "object") collectTimestamps(child, out, depth + 1)
  }
  return out
}

export function collectMessageTimestamps(message) {
  return collectTimestamps(message, [])
}

export function activeTurnTiming(message) {
  const timestamps = collectMessageTimestamps(message)
  if (!timestamps.length) return { startedAt: null, lastActivityAt: null }
  return {
    startedAt: Math.min(...timestamps),
    lastActivityAt: Math.max(...timestamps),
  }
}

function localAgentMessageIds(localStatus, fieldNames) {
  const ids = new Set()
  for (const fieldName of fieldNames) {
    for (const id of localStatus?.[fieldName] || []) {
      const normalized = String(id || "").trim()
      if (normalized) ids.add(normalized)
    }
  }
  return ids
}

function statusFromLocal(localStatus) {
  return localStatus?.state === "running"
    ? { state: "running", source: "local" }
    : { state: "not-running", source: "local" }
}

function activeTurnFromMessage(message, { now = Date.now(), staleMs = DEFAULT_ACTIVE_TURN_STALE_MS } = {}) {
  const id = messageId(message)
  const timing = activeTurnTiming(message)
  const ageMs = timing.startedAt != null ? Math.max(0, now - timing.startedAt) : null
  const inactiveMs = timing.lastActivityAt != null ? Math.max(0, now - timing.lastActivityAt) : ageMs
  const stale = staleMs > 0 && inactiveMs != null && inactiveMs >= staleMs
  return {
    state: stale ? "stale" : "running",
    source: "remote",
    messageId: id,
    startedAt: timing.startedAt,
    lastActivityAt: timing.lastActivityAt,
    ageMs,
    inactiveMs,
    staleMs,
  }
}

function localStatusUpdatedAt(localStatus) {
  return normalizeEpochMs(localStatus?.updatedAt ?? localStatus?.lastActivityAt ?? localStatus?.lastUpdatedAt)
}

function withLocalActivity(turn, localStatus, { now = Date.now(), staleMs = DEFAULT_ACTIVE_TURN_STALE_MS } = {}) {
  if (!turn || localStatus?.state !== "running") return turn
  const localUpdatedAt = localStatusUpdatedAt(localStatus)
  if (localUpdatedAt == null) return turn
  if (turn.lastActivityAt != null && localUpdatedAt <= turn.lastActivityAt) return turn
  const inactiveMs = Math.max(0, now - localUpdatedAt)
  return {
    ...turn,
    source: "remote+local",
    lastActivityAt: localUpdatedAt,
    inactiveMs,
    state: staleMs > 0 && inactiveMs >= staleMs ? "stale" : "running",
  }
}

function chooseActiveTurn(messages, options) {
  const candidates = messages.map((message) => activeTurnFromMessage(message, options))
  candidates.sort((a, b) => {
    const aActivity = a.lastActivityAt ?? a.startedAt ?? -1
    const bActivity = b.lastActivityAt ?? b.startedAt ?? -1
    if (aActivity !== bActivity) return bActivity - aActivity
    const aStart = a.startedAt ?? -1
    const bStart = b.startedAt ?? -1
    return bStart - aStart
  })
  return candidates[0] || null
}

export async function resolveActiveTurnStatus({
  oc,
  projectAlias,
  sessionId,
  getAgentActivityStatus,
  mirrorCompaction = false,
  staleMs = DEFAULT_ACTIVE_TURN_STALE_MS,
  now = Date.now(),
  listLimit = 20,
} = {}) {
  const localStatus = typeof getAgentActivityStatus === "function" ? getAgentActivityStatus(projectAlias, sessionId) : null
  const localIsRunning = localStatus?.state === "running"
  if (!oc?.listMessages || !sessionId) return localIsRunning ? statusFromLocal(localStatus) : { state: "unknown", reason: "message-list-unavailable" }

  const messages = await oc.listMessages(sessionId, { limit: listLimit })
  if (!Array.isArray(messages)) return localIsRunning ? statusFromLocal(localStatus) : { state: "unknown", reason: "message-list-unavailable" }

  const locallyEndedIds = localAgentMessageIds(localStatus, ["endedMessageIds"])
  const runningMessages = messages.filter((message) => {
    const id = messageId(message)
    return isRunningAssistantMessage(message, { mirrorCompaction }) && (!id || !locallyEndedIds.has(id))
  })

  if (runningMessages.length > 0) {
    return withLocalActivity(chooseActiveTurn(runningMessages, { now, staleMs }), localStatus, { now, staleMs })
  }

  if (localIsRunning) {
    const localIds = localAgentMessageIds(localStatus, ["activeMessageIds", "activeToolMessageIds"])
    if (localIds.size > 0) {
      const remoteById = new Map(messages.map((message) => [messageId(message), message]).filter(([id]) => Boolean(id)))
      if ([...localIds].every((id) => remoteById.has(id) && isTerminalAssistantMessage(remoteById.get(id), { mirrorCompaction }))) {
        return { state: "not-running", source: "remote" }
      }
    }
    return statusFromLocal(localStatus)
  }

  return { state: "not-running", source: "remote" }
}

export function formatDurationMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return "unknown"
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatActiveTurnStatus(status) {
  if (status?.state === "stale") {
    const duration = formatDurationMs(status.inactiveMs ?? status.ageMs)
    const id = status.messageId ? `; message ${status.messageId}` : ""
    return `stale (${duration} without progress${id}; use /abort or /new)`
  }
  if (status?.state === "running") return "running"
  if (status?.state === "not-running") return "not running"
  if (status?.reason === "message-list-unavailable") return "unknown (message list unavailable)"
  if (status?.reason === "message-list-failed") return "unknown (message list failed)"
  return "unknown"
}

export function formatStaleActiveTurnNotice(status, binding = {}) {
  const duration = formatDurationMs(status?.inactiveMs ?? status?.ageMs)
  const messageLine = status?.messageId ? `Message: ${status.messageId}` : ""
  return [
    "⚠️ Agent appears stuck.",
    `Project: ${binding.projectAlias || "unknown"}`,
    `Session: ${binding.sessionId || "unknown"}`,
    `No assistant/tool progress for ${duration}.`,
    messageLine,
    "",
    "I did not send this prompt to OpenCode, so it will not be queued behind the hung turn.",
    "Use /abort and resend the prompt, or use /new for a clean session.",
  ].filter(Boolean).join("\n")
}
