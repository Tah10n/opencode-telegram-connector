import crypto from "node:crypto"
import { classifyBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import { redactSensitiveText } from "../url-utils.js"

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 5 * 60 * 1000
const DELIVERY_ABORTED = Symbol("delivery-aborted")

export function outboxItemId({ type, projectAlias, sessionId, messageId, dedupeVariant }) {
  const identity = [type, projectAlias, sessionId, messageId]
  if (dedupeVariant) identity.push(dedupeVariant)
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")
  return `out_${hash}`
}

function completionIdempotencyKey(item) {
  return `telegram-outbox-completed:${outboxItemId(item)}`
}

function routeRecord(route) {
  const chatId = Number(route?.chatId)
  const threadIdOr0 = Number(route?.threadIdOr0 || 0)
  if (!Number.isInteger(chatId) || !Number.isInteger(threadIdOr0) || threadIdOr0 < 0) throw new Error("Outbox route requires integer chatId and threadIdOr0")
  return { chatId, threadIdOr0, ctxKey: `${chatId}:${threadIdOr0}` }
}

async function flushStore(store, operation) {
  try {
    await store.flush()
  } catch (err) {
    throw makeBoundaryError({
      source: "state",
      operation,
      kind: "durability",
      outcome: "retryable",
      message: `${operation} failed: ${err?.message || String(err)}`,
      cause: err,
    })
  }
}

function safeLastError(err) {
  const classification = classifyBoundaryError(err)
  const marker = [classification.kind, classification.status || classification.code].filter(Boolean).join(":")
  return redactSensitiveText(marker || classification.error.message || "delivery_failed").slice(0, 200)
}

function retryDelay(item, classification) {
  if (classification.retryAfterMs) return classification.retryAfterMs
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(8, item.attemptCount || 0)))
}

function waitForDeliveryOrAbort(promise, signal) {
  const observed = Promise.resolve(promise)
  if (!signal) return observed
  if (signal.aborted) {
    observed.catch(() => {})
    return Promise.resolve(DELIVERY_ABORTED)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener?.("abort", onAbort)
      callback(value)
    }
    const onAbort = () => finish(resolve, DELIVERY_ABORTED)
    signal.addEventListener?.("abort", onAbort, { once: true })
    observed.then((value) => finish(resolve, value), (err) => finish(reject, err))
  })
}

export function createDurableOutbox({ store, deliver, logger, observability, abortSignal, sleep, now = () => Date.now(), maxEntries } = {}) {
  if (!store?.getOutboxItems || !store?.setOutboxItem || !store?.deleteOutboxItem || !store?.flush) {
    throw new Error("Durable outbox requires a compatible state store")
  }
  let deliverItem = deliver
  const inFlight = new Set()
  const pendingPersistence = new Map()
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function setDeliver(next) {
    if (typeof next !== "function") throw new TypeError("Outbox deliver handler must be a function")
    deliverItem = next
  }

  async function enqueue({ type, projectAlias, sessionId, boundSessionId = sessionId, messageId, route, payload, progress, delayMs = 0 } = {}) {
    const dedupeVariant = type === "agent-error" && payload?.requireMessageError === true ? "verify-message-error" : ""
    const identity = { type, projectAlias, sessionId, messageId }
    const id = outboxItemId({ ...identity, dedupeVariant })
    store.pruneIdempotency?.({ now: now() })
    if (store.hasIdempotencyKey?.(completionIdempotencyKey(identity))) {
      return { item: null, deduped: true, completed: true }
    }
    const existingPersistence = pendingPersistence.get(id)
    if (existingPersistence) {
      await existingPersistence
      return { item: store.getOutboxItem(id), deduped: true }
    }
    const existing = store.getOutboxItem(id)
    if (existing) return { item: existing, deduped: true }

    const expired = store.pruneOutbox?.({ now: now() }) || 0
    if (expired) observability?.recordOutboxExpired?.(projectAlias, expired)
    const createdAt = now()
    const item = {
      id,
      type,
      projectAlias,
      sessionId,
      boundSessionId,
      messageId,
      route: routeRecord(route),
      progress: progress && typeof progress === "object" && !Array.isArray(progress) ? { ...progress } : {},
      attemptCount: 0,
      nextAttemptAt: createdAt + Math.max(0, Number.isFinite(Number(delayMs)) ? Math.trunc(Number(delayMs)) : 0),
      createdAt,
      updatedAt: createdAt,
      ...((typeof payload?.text === "string" && payload.text) || payload?.requireMessageError === true
        ? { payload: {
            ...(typeof payload?.text === "string" && payload.text ? { text: payload.text.slice(0, 8000) } : {}),
            ...(payload?.requireMessageError === true ? { requireMessageError: true } : {}),
          } }
        : {}),
    }
    if (!store.setOutboxItem(item, maxEntries == null ? undefined : { maxEntries })) {
      observability?.recordOutboxBackpressure?.(projectAlias)
      throw makeBoundaryError({
        source: "state",
        operation: "enqueue durable Telegram delivery",
        kind: "backpressure",
        outcome: "retryable",
        message: "Durable Telegram outbox is full or the item is invalid",
      })
    }
    const persistence = (async () => {
      try {
        await flushStore(store, "persist durable Telegram delivery")
      } catch (err) {
        store.deleteOutboxItem(id)
        throw err
      }
    })()
    pendingPersistence.set(id, persistence)
    try {
      await persistence
    } finally {
      if (pendingPersistence.get(id) === persistence) pendingPersistence.delete(id)
    }
    observability?.recordOutboxQueued?.(projectAlias)
    return { item: store.getOutboxItem(id), deduped: false }
  }

  async function checkpoint(id, progressPatch) {
    const current = store.getOutboxItem(id)
    if (!current) throw new Error(`Outbox item disappeared during delivery: ${id}`)
    const next = {
      ...current,
      progress: { ...current.progress, ...(progressPatch || {}) },
      updatedAt: now(),
    }
    if (!store.setOutboxItem(next)) throw new Error(`Failed to update outbox progress: ${id}`)
    await flushStore(store, "persist durable Telegram delivery progress")
    return store.getOutboxItem(id)
  }

  function dueItems(at = now()) {
    return Object.values(store.getOutboxItems())
      .filter((item) => !pendingPersistence.has(item.id) && !inFlight.has(item.id) && item.nextAttemptAt <= at)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async function processNext({ at = now(), signal = abortSignal } = {}) {
    const expired = store.pruneOutbox?.({ now: at }) || 0
    if (expired) {
      observability?.recordOutboxExpired?.(null, expired)
      await flushStore(store, "persist expired durable Telegram deliveries")
    }
    const item = dueItems(at)[0]
    if (!item) return false
    if (typeof deliverItem !== "function") return false
    if (store.hasIdempotencyKey?.(completionIdempotencyKey(item))) {
      store.deleteOutboxItem(item.id)
      await flushStore(store, "complete previously delivered durable Telegram item")
      return true
    }
    inFlight.add(item.id)
    try {
      if (signal?.aborted) return false
      const deliveryResult = await waitForDeliveryOrAbort(
        Promise.resolve().then(() => {
          if (signal?.aborted) return DELIVERY_ABORTED
          return deliverItem(item, {
            checkpoint: (progressPatch) => {
              if (signal?.aborted) throw Object.assign(new Error("Durable outbox delivery aborted"), { name: "AbortError" })
              return checkpoint(item.id, progressPatch)
            },
            current: () => store.getOutboxItem(item.id),
            signal,
          })
        }),
        signal,
      )
      if (deliveryResult === DELIVERY_ABORTED || signal?.aborted) return false
      if (deliveryResult?.completed === false) {
        store.deleteOutboxItem(item.id)
        await flushStore(store, "cancel unconfirmed durable Telegram delivery")
        return true
      }
      if (store.markIdempotencyKey && !store.markIdempotencyKey(completionIdempotencyKey(item), {
        kind: deliveryResult?.delivered === false ? "telegram-outbox-discarded" : "telegram-outbox-delivered",
        action: item.type,
        projectAlias: item.projectAlias,
        createdAt: now(),
      })) {
        throw new Error(`Failed to persist durable outbox completion: ${item.id}`)
      }
      store.deleteOutboxItem(item.id)
      await flushStore(store, "complete durable Telegram delivery")
      if (deliveryResult?.delivered === false) observability?.recordOutboxDiscarded?.(item.projectAlias)
      else observability?.recordOutboxDelivered?.(item.projectAlias)
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") return false
      const current = store.getOutboxItem(item.id) || item
      const classification = classifyBoundaryError(err)
      if (!classification.retryable) throw err
      const failed = {
        ...current,
        attemptCount: (current.attemptCount || 0) + 1,
        nextAttemptAt: at + retryDelay(current, classification),
        updatedAt: now(),
        lastError: safeLastError(err),
      }
      if (!store.setOutboxItem(failed)) throw err
      await flushStore(store, "persist durable Telegram delivery retry")
      observability?.recordOutboxRetry?.(item.projectAlias)
      logger?.warn?.("Durable Telegram delivery deferred", {
        projectAlias: item.projectAlias,
        sessionId: item.sessionId,
        messageId: item.messageId,
        type: item.type,
        attempt: failed.attemptCount,
        nextAttemptAt: failed.nextAttemptAt,
        error: failed.lastError,
      })
    } finally {
      inFlight.delete(item.id)
    }
    return true
  }

  async function run() {
    while (!abortSignal?.aborted) {
      const processed = await processNext({ signal: abortSignal })
      if (!processed && !abortSignal?.aborted) await waitForDeliveryOrAbort(pause(250), abortSignal)
    }
  }

  async function drain({ signal } = {}) {
    let processed = 0
    while (!signal?.aborted && await processNext({ signal })) processed += 1
    return processed
  }

  return { enqueue, processNext, run, drain, setDeliver }
}
