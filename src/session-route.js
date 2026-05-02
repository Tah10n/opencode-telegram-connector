import { sessionKey } from "./state/store.js"
import { isRetryableBoundaryError } from "./boundary-errors.js"

export async function resolveSessionRoute({ projectAlias, sessionId, sessionIndex, getSession, parentBySessionKey, maxDepth = 8, debug } = {}) {
  if (!projectAlias || !sessionId) return null

  let currentSessionId = sessionId
  const seen = new Set()

  while (currentSessionId && !seen.has(currentSessionId) && seen.size < maxDepth) {
    seen.add(currentSessionId)

    const currentKey = sessionKey(projectAlias, currentSessionId)
    const directRoute = sessionIndex?.[currentKey]
    if (directRoute) {
      debug?.(`route hit session=${currentSessionId}`)
      return { route: directRoute, boundSessionId: currentSessionId }
    }

    let parentSessionId = parentBySessionKey.get(currentKey)
    if (parentSessionId === undefined) {
      let session = null
      try {
        session = await getSession(currentSessionId)
      } catch (err) {
        if (isRetryableBoundaryError(err, { source: "opencode", operation: "getSession" })) {
          debug?.(`route lookup retryable session=${currentSessionId} error=${err?.message || String(err)}`)
          throw err
        }
        debug?.(`route miss session=${currentSessionId} reason=session_lookup_failed`)
        return null
      }
      if (!session) {
        debug?.(`route miss session=${currentSessionId} reason=session_lookup_failed`)
        return null
      }
      parentSessionId = typeof session.parentID === "string" && session.parentID.trim() ? session.parentID.trim() : ""
      if (parentSessionId) parentBySessionKey.set(currentKey, parentSessionId)
      debug?.(`parent fetched session=${currentSessionId} parent=${parentSessionId || "(none)"}`)
    } else {
      debug?.(`parent cached session=${currentSessionId} parent=${parentSessionId || "(none)"}`)
    }

    if (!parentSessionId) {
      debug?.(`route miss session=${currentSessionId} reason=no_parent`)
      return null
    }
    currentSessionId = parentSessionId
  }

  debug?.(`route miss session=${sessionId} reason=cycle_or_depth`)
  return null
}
