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
  if (!waitForStart && startInProgress.has(alias)) {
    return startupSessionByProject[alias] || null
  }

  if (waitForStart && startInProgress.has(alias)) {
    await startInProgress.get(alias).catch(() => {})
  }
  if (!forceRefresh && startupSessionByProject[alias]) return startupSessionByProject[alias]
  if (startupSessionInProgress.has(alias)) {
    const inFlight = startupSessionInProgress.get(alias)
    if (!waitForStart || !startInProgress.has(alias)) return inFlight
    await inFlight.catch(() => {})
    if (!forceRefresh && startupSessionByProject[alias]) return startupSessionByProject[alias]
  }

  const promise = (async () => {
    const oc = ocByAlias[alias]
    if (!oc) return null

    const list = await oc.listSessions({ limit: 1, signal: abortSignal })
    const latest = Array.isArray(list) && list[0] ? list[0] : null
    if (latest?.id) {
      startupSessionByProject[alias] = latest.id
    } else {
      const created = await oc.createSession({ signal: abortSignal })
      if (created?.id) {
        logger?.info?.(`[${alias}] created startup session:`, created.id)
        startupSessionByProject[alias] = created.id
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
