import { sessionKey } from "./state/store.js"

export async function resolveSessionRoute({ projectAlias, sessionId, sessionIndex, getSession, parentBySessionKey, maxDepth = 8 }) {
  if (!projectAlias || !sessionId) return null

  let currentSessionId = sessionId
  const seen = new Set()

  while (currentSessionId && !seen.has(currentSessionId) && seen.size < maxDepth) {
    seen.add(currentSessionId)

    const currentKey = sessionKey(projectAlias, currentSessionId)
    const directRoute = sessionIndex?.[currentKey]
    if (directRoute) {
      return { route: directRoute, boundSessionId: currentSessionId }
    }

    let parentSessionId = parentBySessionKey.get(currentKey)
    if (parentSessionId === undefined) {
      const session = await getSession(currentSessionId).catch(() => null)
      parentSessionId = typeof session?.parentID === "string" && session.parentID.trim() ? session.parentID.trim() : null
      parentBySessionKey.set(currentKey, parentSessionId)
    }

    if (!parentSessionId) return null
    currentSessionId = parentSessionId
  }

  return null
}
