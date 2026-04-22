function clampString(value, max) {
  const str = String(value ?? "").trim()
  if (!str) return ""
  if (str.length <= max) return str
  return `${str.slice(0, Math.max(0, max - 1))}…`
}

function sessionIdOf(session) {
  const id = session?.id
  return typeof id === "string" && id.trim() ? id.trim() : ""
}

function sessionTitleOf(session) {
  const title = session?.title
  return typeof title === "string" && title.trim() ? clampString(title, 80) : ""
}

function sessionMarkers(sessionId, { currentSessionId, startupSessionId } = {}) {
  const markers = []
  if (sessionId && sessionId === currentSessionId) markers.push("current")
  if (sessionId && sessionId === startupSessionId) markers.push("startup")
  return markers
}

export function normalizeSessionsList(sessions) {
  return Array.isArray(sessions)
    ? sessions
        .map((session) => {
          const id = sessionIdOf(session)
          if (!id) return null
          return {
            id,
            title: sessionTitleOf(session),
          }
        })
        .filter(Boolean)
    : []
}

export function formatSessionButtonLabel(session, { currentSessionId, startupSessionId } = {}) {
  const sessionId = typeof session === "string" ? session : session?.id
  const title = typeof session === "string" ? "" : session?.title
  const markers = sessionMarkers(sessionId, { currentSessionId, startupSessionId })
  let prefix = ""
  if (markers.includes("current")) prefix += "✅ "
  if (markers.includes("startup")) prefix += "🏁 "
  const label = title ? clampString(title, 48) : clampString(sessionId, 48)
  return `${prefix}${label}`
}

export function formatSessionsListText(
  projectAlias,
  sessions,
  { currentSessionId, currentSessionModelLabel, currentSessionModelSourceLabel, startupSessionId, limit = 10 } = {},
) {
  const safeProjectAlias = String(projectAlias || "").trim() || "(unknown)"
  const normalized = normalizeSessionsList(sessions)

  const lines = [`Sessions for '${safeProjectAlias}':`]
  if (currentSessionId) lines.push(`Current: ${currentSessionId}`)
  if (currentSessionModelLabel) {
    lines.push(
      currentSessionModelSourceLabel ? `Current model: ${currentSessionModelLabel} (${currentSessionModelSourceLabel})` : `Current model: ${currentSessionModelLabel}`,
    )
  }
  if (startupSessionId && startupSessionId !== currentSessionId) lines.push(`Startup: ${startupSessionId}`)
  lines.push("")

  if (normalized.length === 0) {
    lines.push("No sessions found.")
    lines.push("Use /new to create one or /use <sessionId> to switch.")
    return lines.join("\n")
  }

  lines.push("Tap a button below to switch:")
  lines.push("")
  lines.push("Recent sessions:")
  for (const session of normalized.slice(0, limit)) {
    const markers = sessionMarkers(session.id, { currentSessionId, startupSessionId })
    const suffix = []
    if (markers.length) suffix.push(`[${markers.join(", ")}]`)
    if (session.title) suffix.push(`— ${session.title}`)
    lines.push(`- ${session.id}${suffix.length ? ` ${suffix.join(" ")}` : ""}`)
  }

  if (normalized.length > limit) {
    lines.push(`…and ${normalized.length - limit} more.`)
  }
  lines.push("")
  lines.push("Use /use <sessionId> to switch.")
  return lines.join("\n")
}
