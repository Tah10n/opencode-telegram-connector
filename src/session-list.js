import { isSafeOpenCodeId } from "./opencode/ids.js"
import { t as translate } from "./i18n/index.js"

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
  { currentSessionId, currentSessionModelLabel, currentSessionModelSourceLabel, startupSessionId, limit = 10, locale = "en" } = {},
) {
  const safeProjectAlias = String(projectAlias || "").trim() || "(unknown)"
  const normalized = normalizeSessionsList(sessions)

  const lines = [translate(locale, "sessions.title", { project: safeProjectAlias })]
  if (currentSessionId) lines.push(translate(locale, "sessions.current", { session: currentSessionId }))
  if (currentSessionModelLabel) {
    lines.push(
      currentSessionModelSourceLabel
        ? translate(locale, "sessions.currentModelWithSource", { model: currentSessionModelLabel, source: currentSessionModelSourceLabel })
        : translate(locale, "sessions.currentModel", { model: currentSessionModelLabel }),
    )
  }
  if (startupSessionId && startupSessionId !== currentSessionId) lines.push(translate(locale, "sessions.startup", { session: startupSessionId }))
  lines.push("")

  if (normalized.length === 0) {
    lines.push(translate(locale, "sessions.noneFound"))
    lines.push(translate(locale, "sessions.createOrUse"))
    return lines.join("\n")
  }

  const visibleSessions = normalized.slice(0, limit)
  const hasSwitchableSessions = visibleSessions.some((session) => isSafeOpenCodeId(session.id))
  const hasUnsupportedSessions = visibleSessions.some((session) => !isSafeOpenCodeId(session.id))
  lines.push(hasSwitchableSessions ? translate(locale, "sessions.tapToSwitch") : translate(locale, "sessions.recentUnsupported"))
  lines.push("")
  lines.push(translate(locale, "sessions.recent"))
  for (const session of visibleSessions) {
    const markers = sessionMarkers(session.id, { currentSessionId, startupSessionId })
    const suffix = []
    if (markers.length) suffix.push(`[${markers.join(", ")}]`)
    if (!isSafeOpenCodeId(session.id)) suffix.push("[unsupported id]")
    if (session.title) suffix.push(`— ${session.title}`)
    lines.push(`- ${session.id}${suffix.length ? ` ${suffix.join(" ")}` : ""}`)
  }

  if (normalized.length > limit) {
    lines.push(translate(locale, "sessions.more", { count: normalized.length - limit }))
  }
  lines.push("")
  if (hasUnsupportedSessions) lines.push(translate(locale, "sessions.unsupportedHelp"))
  lines.push(translate(locale, "sessions.useToSwitch"))
  return lines.join("\n")
}
