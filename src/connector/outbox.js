import crypto from "node:crypto"
import { classifyBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import { DEFAULT_OUTBOX_MAX_ENTRIES } from "../state/store.js"
import { redactSensitiveText } from "../url-utils.js"

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 5 * 60 * 1000
const DELIVERY_ABORTED = Symbol("delivery-aborted")
const DEFAULT_CAPACITY_WAITER_LIMIT = 1000
const ITEM_SCOPED_TELEGRAM_OPERATIONS = ["sendmessage", "senddocument", "sendhtmlblocks", "editmessagetext", "editmessagereplymarkup"]

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

function isItemScopedTelegramOperation(classification) {
  const operation = [classification.error?.operation, classification.error?.pathname]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return ITEM_SCOPED_TELEGRAM_OPERATIONS.some((candidate) => operation.includes(candidate))
}

function failureDisposition(err) {
  const classification = classifyBoundaryError(err)
  if (classification.source === "state" || classification.kind === "durability" || classification.kind === "invariant") {
    return { classification, disposition: "global-fatal" }
  }
  if (classification.retryable) return { classification, disposition: "retryable" }
  if (classification.source === "telegram") {
    const itemScoped = isItemScopedTelegramOperation(classification)
    const terminalStatus = Number.isInteger(classification.status)
      && classification.status >= 400
      && classification.status < 500
      && ![401, 408, 425, 429].includes(classification.status)
    if (itemScoped && terminalStatus) return { classification, disposition: "terminal" }
    return { classification, disposition: "global-fatal" }
  }
  if (classification.source === "opencode") {
    const terminalStatus = Number.isInteger(classification.status)
      && classification.status >= 400
      && classification.status < 500
      && ![408, 425, 429].includes(classification.status)
    if (classification.stale || classification.kind === "configuration" || terminalStatus) {
      return { classification, disposition: "terminal" }
    }
  }
  return { classification, disposition: "global-fatal" }
}

function safeDiscardReason(classification) {
  return [classification.source, classification.kind, classification.status || classification.code]
    .filter(Boolean)
    .join(":")
    .slice(0, 120) || "terminal-item-error"
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

export function createDurableOutbox({
  store,
  deliver,
  logger,
  observability,
  abortSignal,
  sleep,
  now = () => Date.now(),
  maxEntries,
  maxCapacityWaiters,
} = {}) {
  if (!store?.getOutboxItems || !store?.setOutboxItem || !store?.deleteOutboxItem || !store?.flush) {
    throw new Error("Durable outbox requires a compatible state store")
  }
  const capacityLimit = Number.isInteger(maxEntries) && maxEntries > 0
    ? Math.min(maxEntries, DEFAULT_OUTBOX_MAX_ENTRIES)
    : DEFAULT_OUTBOX_MAX_ENTRIES
  const capacityWaiterLimit = Number.isInteger(maxCapacityWaiters) && maxCapacityWaiters > 0
    ? maxCapacityWaiters
    : DEFAULT_CAPACITY_WAITER_LIMIT
  let deliverItem = deliver
  const inFlight = new Set()
  const interruptedByShutdown = new Set()
  const pendingPersistence = new Map()
  const capacityWaiters = []
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let capacityReservations = 0
  let workerActive = false
  let lastFatalError = ""

  function abortError(message = "Durable outbox capacity wait aborted") {
    return Object.assign(new Error(message), { name: "AbortError" })
  }

  function queueSize() {
    return Object.keys(store.getOutboxItems()).length
  }

  function hasCapacity() {
    return queueSize() + capacityReservations < capacityLimit
  }

  function removeCapacityWaiter(waiter) {
    const index = capacityWaiters.indexOf(waiter)
    if (index >= 0) capacityWaiters.splice(index, 1)
    waiter.signal?.removeEventListener?.("abort", waiter.onAbort)
  }

  function releaseCapacityReservation(reservation) {
    if (!reservation || reservation.released) return
    reservation.released = true
    capacityReservations = Math.max(0, capacityReservations - 1)
    notifyCapacityAvailable()
  }

  function notifyCapacityAvailable() {
    while (capacityWaiters.length && hasCapacity()) {
      const waiter = capacityWaiters.shift()
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(abortError())
        continue
      }
      capacityReservations += 1
      const reservation = { released: false }
      reservation.release = () => releaseCapacityReservation(reservation)
      waiter.resolve(reservation)
    }
  }

  function rejectCapacityWaiters(err) {
    while (capacityWaiters.length) {
      const waiter = capacityWaiters.shift()
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort)
      waiter.reject(err)
    }
  }

  function waitForCapacity(signal, projectAlias) {
    if (signal?.aborted) return Promise.reject(abortError())
    if (capacityWaiters.length >= capacityWaiterLimit) {
      return Promise.reject(makeBoundaryError({
        source: "state",
        operation: "wait for durable Telegram outbox capacity",
        kind: "invariant",
        outcome: "fatal",
        message: "Durable Telegram outbox capacity waiter limit exceeded",
      }))
    }
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, onAbort: null }
      waiter.onAbort = () => {
        removeCapacityWaiter(waiter)
        reject(abortError())
        notifyCapacityAvailable()
      }
      capacityWaiters.push(waiter)
      signal?.addEventListener?.("abort", waiter.onAbort, { once: true })
      notifyCapacityAvailable()
    })
  }

  function snapshot() {
    const items = Object.values(store.getOutboxItems())
    const nextDueAt = items.length
      ? Math.min(...items.map((item) => Number.isFinite(item?.nextAttemptAt) ? item.nextAttemptAt : 0))
      : 0
    return {
      queueSize: items.length,
      maxEntries: capacityLimit,
      inFlight: inFlight.size,
      blockedWaiters: capacityWaiters.length,
      full: items.length + capacityReservations >= capacityLimit,
      nextDueAt,
      workerActive,
      lastFatalError,
    }
  }

  function tryStoreItem(item, { reservation = false } = {}) {
    const effectiveLimit = Math.max(0, capacityLimit - capacityReservations + (reservation ? 1 : 0))
    if (typeof store.trySetOutboxItem === "function") {
      return store.trySetOutboxItem(item, { maxEntries: effectiveLimit, now: now() })
    }
    if (store.setOutboxItem(item, { maxEntries: effectiveLimit, now: now() })) return { ok: true, item: store.getOutboxItem(item.id) }
    return { ok: false, reason: queueSize() >= effectiveLimit ? "full" : "invalid" }
  }

  function malformedItemError(cause) {
    return makeBoundaryError({
      source: "state",
      operation: "enqueue durable Telegram delivery",
      kind: "invariant",
      outcome: "fatal",
      message: "Durable Telegram outbox item is malformed",
      cause,
    })
  }

  function setDeliver(next) {
    if (typeof next !== "function") throw new TypeError("Outbox deliver handler must be a function")
    deliverItem = next
  }

  async function persistCompletion(item, { discarded = false, reason } = {}) {
    const kind = discarded ? "telegram-outbox-discarded" : "telegram-outbox-delivered"
    if (!store.markIdempotencyKey || !store.markIdempotencyKey(completionIdempotencyKey(item), {
      kind,
      action: item.type,
      projectAlias: item.projectAlias,
      ...(reason ? { operation: reason } : {}),
      createdAt: now(),
    })) {
      throw makeBoundaryError({
        source: "state",
        operation: "persist durable Telegram completion tombstone",
        kind: "invariant",
        outcome: "fatal",
        message: `Failed to persist durable outbox completion: ${item.id}`,
      })
    }
    await flushStore(store, "persist durable Telegram completion tombstone")
    if (!store.deleteOutboxItem(item.id)) {
      throw makeBoundaryError({
        source: "state",
        operation: "remove completed durable Telegram item",
        kind: "invariant",
        outcome: "fatal",
        message: `Completed durable outbox item disappeared: ${item.id}`,
      })
    }
    await flushStore(store, "remove completed durable Telegram item")
    notifyCapacityAvailable()
  }

  async function enqueue(
    { type, projectAlias, sessionId, boundSessionId = sessionId, messageId, route, payload, progress, delayMs = 0 } = {},
    { signal = abortSignal, waitForCapacity: shouldWaitForCapacity = false } = {},
  ) {
    const dedupeVariant = type === "agent-error" && payload?.requireMessageError === true ? "verify-message-error" : ""
    const identity = { type, projectAlias, sessionId, messageId }
    const id = outboxItemId({ ...identity, dedupeVariant })
    store.pruneIdempotency?.({ now: now() })
    let reservation = null
    try {
      while (true) {
        if (signal?.aborted) throw abortError()
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
        if (expired) {
          observability?.recordOutboxExpired?.(projectAlias, expired)
          await flushStore(store, "persist expired durable Telegram deliveries")
          notifyCapacityAvailable()
        }
        const createdAt = now()
        let item
        try {
          item = {
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
        } catch (err) {
          throw malformedItemError(err)
        }
        const stored = tryStoreItem(item, { reservation: !!reservation })
        if (!stored.ok && stored.reason === "invalid") throw malformedItemError()
        if (!stored.ok) {
          reservation?.release()
          reservation = null
          observability?.recordOutboxBackpressure?.(projectAlias)
          if (!shouldWaitForCapacity) {
            throw makeBoundaryError({
              source: "state",
              operation: "enqueue durable Telegram delivery",
              kind: "backpressure",
              outcome: "retryable",
              message: "Durable Telegram outbox is full",
            })
          }
          reservation = await waitForCapacity(signal, projectAlias)
          continue
        }
        reservation?.release()
        reservation = null
        const persistence = (async () => {
          try {
            await flushStore(store, "persist durable Telegram delivery")
          } catch (err) {
            store.deleteOutboxItem(id)
            notifyCapacityAvailable()
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
    } finally {
      reservation?.release()
    }
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
      .filter((item) => !pendingPersistence.has(item.id) && !inFlight.has(item.id) && !interruptedByShutdown.has(item.id) && item.nextAttemptAt <= at)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async function processNext({ at = now(), signal = abortSignal } = {}) {
    const expired = store.pruneOutbox?.({ now: at }) || 0
    if (expired) {
      observability?.recordOutboxExpired?.(null, expired)
      await flushStore(store, "persist expired durable Telegram deliveries")
      notifyCapacityAvailable()
    }
    const item = dueItems(at)[0]
    if (!item) return false
    if (typeof deliverItem !== "function") return false
    if (store.hasIdempotencyKey?.(completionIdempotencyKey(item))) {
      store.deleteOutboxItem(item.id)
      await flushStore(store, "complete previously delivered durable Telegram item")
      notifyCapacityAvailable()
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
      if (deliveryResult === DELIVERY_ABORTED || signal?.aborted) {
        if (abortSignal?.aborted) interruptedByShutdown.add(item.id)
        return false
      }
      if (deliveryResult?.completed === false) {
        store.deleteOutboxItem(item.id)
        await flushStore(store, "cancel unconfirmed durable Telegram delivery")
        notifyCapacityAvailable()
        return true
      }
      const discarded = deliveryResult?.delivered === false
      await persistCompletion(item, {
        discarded,
        ...(discarded && deliveryResult?.reason ? { reason: `delivery:${String(deliveryResult.reason).slice(0, 100)}` } : {}),
      })
      if (discarded) observability?.recordOutboxDiscarded?.(item.projectAlias)
      else observability?.recordOutboxDelivered?.(item.projectAlias)
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        if (abortSignal?.aborted) interruptedByShutdown.add(item.id)
        return false
      }
      const current = store.getOutboxItem(item.id) || item
      const { classification, disposition } = failureDisposition(err)
      if (disposition === "terminal") {
        const reason = safeDiscardReason(classification)
        await persistCompletion(current, { discarded: true, reason })
        observability?.recordOutboxDiscarded?.(item.projectAlias)
        logger?.warn?.("Durable Telegram delivery discarded", {
          projectAlias: item.projectAlias,
          sessionId: item.sessionId,
          messageId: item.messageId,
          type: item.type,
          reason,
        })
        return true
      }
      if (disposition !== "retryable") throw err
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
    workerActive = true
    lastFatalError = ""
    try {
      while (!abortSignal?.aborted) {
        const processed = await processNext({ signal: abortSignal })
        if (!processed && !abortSignal?.aborted) await waitForDeliveryOrAbort(pause(250), abortSignal)
      }
    } catch (err) {
      lastFatalError = safeLastError(err)
      rejectCapacityWaiters(err)
      throw err
    } finally {
      workerActive = false
      if (abortSignal?.aborted) rejectCapacityWaiters(abortError())
    }
  }

  async function drain({ signal } = {}) {
    let processed = 0
    while (!signal?.aborted && await processNext({ signal })) processed += 1
    return processed
  }

  return { enqueue, processNext, run, drain, setDeliver, snapshot }
}
