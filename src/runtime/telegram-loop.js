import { classifyBoundaryError, isClearlyUnsentRequestError, makeBoundaryError } from "../boundary-errors.js"
import { telegramUpdateIdempotencyKey } from "../connector/idempotency.js"

function malformedGetUpdatesResponse(operation) {
  return makeBoundaryError({
    source: "telegram",
    operation,
    method: "POST",
    pathname: "/getUpdates",
    status: 200,
    kind: "protocol",
    outcome: "fatal",
    message: "Telegram getUpdates returned a successful response with a non-array result",
  })
}

export function createTelegramUpdateLoop({
  store,
  tg,
  logger,
  abortController,
  logLoopIssue,
  recordLoopAbort,
  sleepWithAbort,
  flushCriticalState,
  runTelegramUpdateContext,
  handleTelegramMessage,
  handleTelegramCallback,
  runtimeObservability,
  drainTelegramBacklogOnFirstRun = true,
} = {}) {
  async function drainTelegramBacklogIfNeeded() {
    const persistedOffset = store.get().updateOffset
    if (persistedOffset != null && persistedOffset !== -1) return
    if (persistedOffset === -1) {
      logger.warn("Recovering an interrupted Telegram backlog cutoff without discarding queued updates.")
      store.setUpdateOffset(0)
      await flushCriticalState("recover interrupted Telegram backlog cutoff")
      return
    }
    if (drainTelegramBacklogOnFirstRun === false) {
      logger.info("Telegram backlog drain disabled on first run. Processing queued updates from offset 0.")
      store.setUpdateOffset(0)
      await flushCriticalState("persist Telegram first-run offset")
      return
    }
    logger.info("Capturing Telegram backlog cutoff (first run)…")
    store.setUpdateOffset(-1)
    await flushCriticalState("persist Telegram backlog cutoff intent")
    let backoff = 1000
    while (true) {
      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      let updates
      try {
        updates = await tg.getUpdates({ offset: -1, timeout: 0, limit: 1, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
      } catch (err) {
        if (abortController.signal.aborted) return
        const clearlyUnsent = isClearlyUnsentRequestError(err)
        const classification = classifyBoundaryError(err, {
          source: "telegram",
          operation: "getUpdates",
          method: "POST",
          pathname: "/getUpdates",
        })
        logLoopIssue("backlogDrain", classification.error, {
          retryable: classification.retryable,
          source: "telegram",
          operation: "getUpdates",
          method: "POST",
          pathname: "/getUpdates",
        })
        if (!classification.retryable) throw classification.error
        if (!clearlyUnsent) {
          store.setUpdateOffset(0)
          await flushCriticalState("persist Telegram backlog cutoff fallback")
          runtimeObservability.recordLoopFallbackHit("backlogDrain")
          logger.warn("Telegram backlog cutoff response was ambiguous. Continuing safely from offset 0.", {
            outcome: classification.outcome,
            kind: classification.kind,
            status: classification.status,
            code: classification.code,
            offset: 0,
          })
          return
        }
        await sleepWithAbort(classification.retryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      if (!Array.isArray(updates)) {
        throw malformedGetUpdatesResponse("getUpdates backlog cutoff")
      }

      backoff = 1000
      const updateIds = updates.map((update) => update?.update_id)
      if (updateIds.some((updateId) => !Number.isSafeInteger(updateId) || updateId < 0)) {
        throw makeBoundaryError({
          source: "telegram",
          operation: "getUpdates backlog cutoff",
          method: "POST",
          pathname: "/getUpdates",
          kind: "protocol",
          outcome: "fatal",
          message: "Telegram backlog cutoff response contained an invalid update_id",
        })
      }
      const cutoffUpdateId = updateIds.length > 0 ? Math.max(...updateIds) : null
      const offset = cutoffUpdateId == null ? 0 : cutoffUpdateId + 1
      store.setUpdateOffset(offset)
      await flushCriticalState("persist Telegram backlog cutoff")
      runtimeObservability.recordLoopSuccess("backlogDrain")
      logger.info("Telegram backlog cutoff captured.", { cutoffUpdateId, offset })
      return
    }
  }

  async function telegramLoop() {
    await drainTelegramBacklogIfNeeded()
    let backoff = 1000
    while (!abortController.signal.aborted) {
      const offset = store.get().updateOffset ?? 0
      let updates
      try {
        updates = await tg.getUpdates({ offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
      } catch (err) {
        if (abortController.signal.aborted) break
        const classification = classifyBoundaryError(err, {
          source: "telegram",
          operation: "getUpdates",
          method: "POST",
          pathname: "/getUpdates",
        })
        logLoopIssue("telegramPoll", classification.error, {
          retryable: classification.retryable,
          source: "telegram",
          operation: "getUpdates",
          method: "POST",
          pathname: "/getUpdates",
        })
        if (!classification.retryable) throw classification.error
        await sleepWithAbort(classification.retryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }
      if (abortController.signal.aborted) {
        recordLoopAbort("telegramPoll", { reason: "connector stop" })
        break
      }
      if (!Array.isArray(updates)) {
        throw malformedGetUpdatesResponse("getUpdates")
      }
      runtimeObservability.recordLoopSuccess("telegramPoll")
      if (updates.length === 0) {
        backoff = 1000
        continue
      }
      backoff = 1000
      for (const u of updates) {
        let shouldAdvanceOffset = false
        let retryDelayMs = 1000
        const updateKey = telegramUpdateIdempotencyKey(u?.update_id)
        if (updateKey && store.hasIdempotencyKey?.(updateKey)) {
          store.setUpdateOffset(u.update_id + 1)
          await flushCriticalState("persist replayed Telegram update offset")
          continue
        }
        await runTelegramUpdateContext(u, async () => {
          try {
            if (u.message) await handleTelegramMessage(u.message, { updateId: u.update_id })
            if (u.callback_query) await handleTelegramCallback(u.callback_query, { updateId: u.update_id })
            shouldAdvanceOffset = true
          } catch (err) {
            const classification = classifyBoundaryError(err)
            if (classification.retryable) {
              retryDelayMs = classification.retryAfterMs || retryDelayMs
              runtimeObservability.recordUpdateRetry()
              logger.warn("Retryable update handler error", {
                source: "telegram",
                operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
                updateId: u.update_id,
                outcome: classification.outcome,
                kind: classification.kind,
                status: classification.status,
                code: classification.code,
                retryable: true,
                error: classification.error.message,
              })
            } else {
              runtimeObservability.recordUpdateSkip()
              logger.error("Skipping non-retryable update", {
                source: "telegram",
                operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
                updateId: u.update_id,
                outcome: classification.outcome,
                kind: classification.kind,
                status: classification.status,
                code: classification.code,
                retryable: false,
                error: classification.error.message,
              })
              shouldAdvanceOffset = true
            }
          }
        })

        if (shouldAdvanceOffset) {
          store.markIdempotencyKey?.(updateKey, {
            kind: "telegram-update",
            updateId: u.update_id,
            operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
          })
          store.setUpdateOffset(u.update_id + 1)
          await flushCriticalState("persist Telegram update checkpoint")
        } else {
          await sleepWithAbort(retryDelayMs)
          break
        }
      }
    }
  }

  return { drainTelegramBacklogIfNeeded, telegramLoop }
}
