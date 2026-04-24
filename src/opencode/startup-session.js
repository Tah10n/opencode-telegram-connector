import { isSafeOpenCodeId, normalizeOpenCodeId } from "./ids.js"

export async function ensureStartupSession({
  alias,
  startInProgress,
  startupSessionByProject,
  startupSessionInProgress,
  ocByAlias,
  logger,
  waitForStart = true,
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

  if (!waitForStart && startInProgress.has(alias)) {
    return cachedStartupSession()
  }

  if (waitForStart && startInProgress.has(alias)) {
    await startInProgress.get(alias).catch(() => {})
  }
  if (!forceRefresh && startupSessionByProject[alias]) return cachedStartupSession()
  if (startupSessionInProgress.has(alias)) {
    const inFlight = startupSessionInProgress.get(alias)
    if (!waitForStart || !startInProgress.has(alias)) return inFlight
    await inFlight.catch(() => {})
    if (!forceRefresh && startupSessionByProject[alias]) return cachedStartupSession()
  }

  const promise = (async () => {
    const oc = ocByAlias[alias]
    if (!oc) return null

    const list = await oc.listSessions({ limit: 1, signal: abortSignal })
    const latest = Array.isArray(list) && list[0] ? list[0] : null
    const latestId = normalizeOpenCodeId(latest?.id)
    if (latestId && isSafeOpenCodeId(latestId)) {
      startupSessionByProject[alias] = latestId
    } else {
      if (latest?.id) logger?.warn?.(`[${alias}] ignored invalid latest session id`)
      const created = await oc.createSession({ signal: abortSignal })
      const createdId = normalizeOpenCodeId(created?.id)
      if (createdId && isSafeOpenCodeId(createdId)) {
        logger?.info?.(`[${alias}] created startup session:`, createdId)
        startupSessionByProject[alias] = createdId
      } else {
        logger?.error?.(`[${alias}] opencode returned an invalid startup session id`)
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
