import { classifyBoundaryError } from "../boundary-errors.js"
import { telegramUpdateIdempotencyKey } from "../connector/idempotency.js"

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
} = {}) {
  async function drainTelegramBacklogIfNeeded() {
    if (store.get().updateOffset != null) return
    logger.info("Draining Telegram backlog (first run)…")
    let offset = 0
    let backoff = 1000
    while (true) {
      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      let pollRetryAfterMs = null
      const updates = await tg
        .getUpdates({ offset, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
        .catch((err) => {
          if (abortController.signal.aborted) return null
          const classification = classifyBoundaryError(err, {
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          pollRetryAfterMs = classification.retryAfterMs
          logLoopIssue("backlogDrain", classification.error, {
            retryable: classification.retryable,
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          return null
        })

      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      if (!Array.isArray(updates)) {
        await sleepWithAbort(pollRetryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

      runtimeObservability.recordLoopSuccess("backlogDrain")
      backoff = 1000
      if (updates.length === 0) break
      offset = updates[updates.length - 1].update_id + 1
      await sleepWithAbort(200)
    }
    store.setUpdateOffset(offset)
    await flushCriticalState("persist Telegram backlog offset")
    logger.info("Telegram backlog drained. Starting from offset:", offset)
  }

  async function telegramLoop() {
    await drainTelegramBacklogIfNeeded()
    let backoff = 1000
    while (!abortController.signal.aborted) {
      let pollRetryAfterMs = null
      const offset = store.get().updateOffset ?? 0
      const updates = await tg
        .getUpdates({ offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
        .catch((err) => {
          if (abortController.signal.aborted) return null
          const classification = classifyBoundaryError(err, {
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          pollRetryAfterMs = classification.retryAfterMs
          logLoopIssue("telegramPoll", classification.error, {
            retryable: classification.retryable,
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          return null
        })
      if (abortController.signal.aborted) {
        recordLoopAbort("telegramPoll", { reason: "connector stop" })
        break
      }
      if (!Array.isArray(updates)) {
        // Avoid a tight loop on network/API errors.
        await sleepWithAbort(pollRetryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
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
