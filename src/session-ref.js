function normalizePathname(pathname) {
  const trimmed = String(pathname || "").replace(/\/+$/, "")
  return trimmed || "/"
}

export function normalizeShareUrl(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""

  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""

    const pathname = normalizePathname(url.pathname)
    if (!/^\/s\/[^/]+$/i.test(pathname)) return ""

    url.pathname = pathname
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}

export function parseSessionReference(input) {
  const raw = String(input || "").trim()
  if (!raw) return null

  if (/^https?:\/\//i.test(raw)) {
    const shareUrl = normalizeShareUrl(raw)
    if (!shareUrl) return { type: "invalid-link", raw }
    return { type: "share-link", raw, shareUrl }
  }

  return { type: "session-id", raw, sessionId: raw }
}

export function findSessionByShareUrl(sessions, shareUrl) {
  const normalizedShareUrl = normalizeShareUrl(shareUrl)
  if (!normalizedShareUrl || !Array.isArray(sessions)) return null

  for (const session of sessions) {
    const id = typeof session?.id === "string" ? session.id.trim() : ""
    const candidate = normalizeShareUrl(session?.share?.url)
    if (id && candidate && candidate === normalizedShareUrl) return session
  }

  return null
}
