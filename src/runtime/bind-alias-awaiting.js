export function createBindAliasAwaitingState({ ttlMs, gcIntervalMs, lifecycle } = {}) {
  const bindAliasAwaiting = new Map()
  const bindAliasAwaitingTtlMs = Number.isFinite(ttlMs) ? Math.max(0, Number(ttlMs)) : 15 * 60 * 1000
  const bindAliasAwaitingGcIntervalMs = Number.isFinite(gcIntervalMs) ? Math.max(1, Number(gcIntervalMs)) : 5 * 60 * 1000

  function getFreshBindAliasAwaiting(ctxKey, now = Date.now()) {
    const awaiting = bindAliasAwaiting.get(ctxKey)
    if (!awaiting) return null
    const startedAt = Number(awaiting.startedAt)
    if (Number.isFinite(startedAt) && now - startedAt > bindAliasAwaitingTtlMs) {
      bindAliasAwaiting.delete(ctxKey)
      return null
    }
    return awaiting
  }

  function pruneBindAliasAwaiting(now = Date.now()) {
    let removed = 0
    for (const [ctxKey, awaiting] of bindAliasAwaiting.entries()) {
      const startedAt = Number(awaiting?.startedAt)
      if (!Number.isFinite(startedAt) || now - startedAt > bindAliasAwaitingTtlMs) {
        bindAliasAwaiting.delete(ctxKey)
        removed += 1
      }
    }
    return removed
  }

  function registerGc() {
    const timer = setInterval(() => {
      pruneBindAliasAwaiting()
    }, bindAliasAwaitingGcIntervalMs)
    timer.unref?.()
    lifecycle?.registerTimer?.("bindAliasAwaiting-gc", timer)
    return timer
  }

  return {
    bindAliasAwaiting,
    bindAliasAwaitingTtlMs,
    getFreshBindAliasAwaiting,
    pruneBindAliasAwaiting,
    registerGc,
  }
}
