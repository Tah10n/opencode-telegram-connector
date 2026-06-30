import { isSafeOpenCodeId, normalizeOpenCodeId } from "./ids.js"
import { directoriesMatch } from "../directory-paths.js"
import { sessionItemsFromResponse } from "../session-response.js"

/**
 * @typedef {{ id?: unknown, directory?: unknown }} StartupSessionItem
 * @typedef {{ listSessions(options?: { directory?: string, limit?: number, signal?: AbortSignal }): Promise<unknown>, createSession(options?: { directory?: string, signal?: AbortSignal }): Promise<unknown> }} StartupOpenCodeClient
 * @typedef {{ warn?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void, error?: (...args: unknown[]) => void }} StartupLogger
 * @typedef {{ ok: true, id: string } | { ok: false, reason: "invalid-id" | "directory-mismatch" | "missing-directory" }} StartupSessionReuseDecision
 */

/**
 * @param {StartupSessionItem | null | undefined} session
 * @param {{ directory?: string, allowUnscopedSessionListFallback?: boolean }} [options]
 * @returns {StartupSessionReuseDecision}
 */
function startupSessionReuseDecision(session, { directory, allowUnscopedSessionListFallback } = {}) {
  const sessionId = normalizeOpenCodeId(session?.id)
  if (!sessionId || !isSafeOpenCodeId(sessionId)) return { ok: false, reason: "invalid-id" }
  if (!directory) return { ok: true, id: sessionId }

  const sessionDirectory = String(session?.directory ?? "").trim()
  if (sessionDirectory && directoriesMatch(sessionDirectory, directory)) return { ok: true, id: sessionId }
  if (!sessionDirectory && allowUnscopedSessionListFallback === true) return { ok: true, id: sessionId }
  return { ok: false, reason: sessionDirectory ? "directory-mismatch" : "missing-directory" }
}

/**
 * @param {{
 *   alias: string,
 *   startInProgress: Map<string, Promise<unknown>>,
 *   startupSessionByProject: Record<string, string | undefined>,
 *   startupSessionInProgress: Map<string, Promise<string | null>>,
 *   ocByAlias: Record<string, StartupOpenCodeClient | undefined>,
 *   logger?: StartupLogger,
 *   directory?: string,
 *   allowUnscopedSessionListFallback?: boolean,
 *   waitForStart?: boolean,
 *   ignoreStartInProgress?: boolean,
 *   forceRefresh?: boolean,
 *   abortSignal?: AbortSignal,
 * }} options
 * @returns {Promise<string | null>}
 */
export async function ensureStartupSession({
  alias,
  startInProgress,
  startupSessionByProject,
  startupSessionInProgress,
  ocByAlias,
  logger,
  directory,
  allowUnscopedSessionListFallback = false,
  waitForStart = true,
  ignoreStartInProgress = false,
  forceRefresh = false,
  abortSignal,
}) {
  function cachedStartupSession() {
    if (!startupSessionByProject[alias]) return null
    const cachedId = normalizeOpenCodeId(startupSessionByProject[alias])
    if (cachedId && isSafeOpenCodeId(cachedId)) return cachedId
    delete startupSessionByProject[alias]
    logger?.warn?.(`[${alias}] ignored invalid cached startup session id`)
    return null
  }

  if (!ignoreStartInProgress && !waitForStart && startInProgress.has(alias)) {
    return cachedStartupSession()
  }

  if (!ignoreStartInProgress && waitForStart && startInProgress.has(alias)) {
    await startInProgress.get(alias)?.catch(() => {})
  }
  if (!forceRefresh && startupSessionByProject[alias]) return cachedStartupSession()
  if (startupSessionInProgress.has(alias)) {
    const inFlight = startupSessionInProgress.get(alias) || null
    if (!inFlight) return null
    if (!forceRefresh && (ignoreStartInProgress || !waitForStart || !startInProgress.has(alias))) return inFlight
    await inFlight.catch(() => {})
    if (!forceRefresh && startupSessionByProject[alias]) return cachedStartupSession()
  }

  const promise = (async () => {
    const oc = ocByAlias[alias]
    if (!oc) return null

    const list = await oc.listSessions({ directory, limit: 1, signal: abortSignal })
    const latest = /** @type {StartupSessionItem | null} */ (sessionItemsFromResponse(list)[0] || null)
    const latestDecision = startupSessionReuseDecision(latest, { directory, allowUnscopedSessionListFallback })
    if (latestDecision.ok) {
      startupSessionByProject[alias] = latestDecision.id
    } else {
      if (latestDecision.reason === "invalid-id" && latest?.id) logger?.warn?.(`[${alias}] ignored invalid latest session id`)
      if (latestDecision.reason === "directory-mismatch") logger?.warn?.(`[${alias}] ignored latest startup session from another directory`)
      if (latestDecision.reason === "missing-directory") logger?.warn?.(`[${alias}] ignored latest startup session without directory evidence`)
      const created = /** @type {StartupSessionItem | null} */ (await oc.createSession({ directory, signal: abortSignal }) || null)
      const createdDecision = startupSessionReuseDecision(created, { directory, allowUnscopedSessionListFallback: false })
      if (createdDecision.ok) {
        logger?.info?.(`[${alias}] created startup session:`, createdDecision.id)
        startupSessionByProject[alias] = createdDecision.id
      } else {
        if (createdDecision.reason === "invalid-id") logger?.error?.(`[${alias}] opencode returned an invalid startup session id`)
        if (createdDecision.reason === "directory-mismatch") logger?.warn?.(`[${alias}] ignored created startup session from another directory`)
        if (createdDecision.reason === "missing-directory") logger?.warn?.(`[${alias}] ignored created startup session without directory evidence`)
      }
    }

    if (startupSessionByProject[alias]) {
      logger?.info?.(`[${alias}] startup session:`, startupSessionByProject[alias])
    }
    return startupSessionByProject[alias] || null
  })().finally(() => startupSessionInProgress.delete(alias))

  startupSessionInProgress.set(alias, promise)
  return promise
}
