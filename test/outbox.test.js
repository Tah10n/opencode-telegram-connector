import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { createDurableOutbox } from "../src/connector/outbox.js"
import { createOutboxDelivery } from "../src/connector/mirroring/outbox-delivery.js"
import { makeBoundaryError } from "../src/boundary-errors.js"
import { DEFAULT_OUTBOX_MAX_AGE_MS, defaultState, StateStore } from "../src/state/store.js"

async function makeStore(t, { filePath } = {}) {
  const dir = filePath ? path.dirname(filePath) : path.join(os.tmpdir(), `telegram-connector-outbox-${crypto.randomUUID()}`)
  const target = filePath || path.join(dir, "state.json")
  if (!filePath) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(target, JSON.stringify(defaultState()), "utf8")
    t.after(async () => fs.rm(dir, { recursive: true, force: true }))
  }
  const store = new StateStore({ filePath: target })
  await store.load()
  return { store, filePath: target }
}

const baseItem = {
  type: "assistant-final",
  projectAlias: "demo",
  sessionId: "ses_1",
  messageId: "msg_1",
  route: { chatId: 100, threadIdOr0: 7 },
}

function makeTrackedAbortSignal() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type === "abort") listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === "abort") listeners.delete(listener)
    },
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

test("durable outbox flushes before delivery, deduplicates repeated events, and deletes only after success", async (t) => {
  const { store } = await makeStore(t)
  const events = []
  const originalFlush = store.flush.bind(store)
  store.flush = async () => {
    events.push("flush")
    return originalFlush()
  }
  const outbox = createDurableOutbox({
    store,
    deliver: async (item) => events.push(`deliver:${item.id}`),
    now: () => 1000,
  })

  const first = await outbox.enqueue(baseItem)
  const second = await outbox.enqueue(baseItem)
  assert.equal(first.deduped, false)
  assert.equal(second.deduped, true)
  assert.equal(Object.keys(store.getOutboxItems()).length, 1)
  assert.equal(events[0], "flush")

  await outbox.processNext({ at: 1000 })
  assert.match(events[1], /^deliver:out_/)
  assert.equal(events[2], "flush")
  assert.deepEqual(store.getOutboxItems(), {})
})

test("durable outbox hides an enqueue until persistence succeeds and makes duplicates await it", async (t) => {
  const { store } = await makeStore(t)
  const originalFlush = store.flush.bind(store)
  let releaseFlush
  let markFlushStarted
  const flushStarted = new Promise((resolve) => { markFlushStarted = resolve })
  const flushGate = new Promise((resolve) => { releaseFlush = resolve })
  let gateFirstFlush = true
  store.flush = async () => {
    if (gateFirstFlush) {
      gateFirstFlush = false
      markFlushStarted()
      await flushGate
    }
    return originalFlush()
  }
  let deliveries = 0
  const outbox = createDurableOutbox({ store, deliver: async () => { deliveries += 1 } })

  const firstPromise = outbox.enqueue(baseItem)
  await flushStarted
  const duplicatePromise = outbox.enqueue(baseItem)
  assert.equal(await outbox.processNext(), false)
  assert.equal(deliveries, 0)

  releaseFlush()
  const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise])
  assert.equal(first.deduped, false)
  assert.equal(duplicate.deduped, true)
  await outbox.processNext()
  assert.equal(deliveries, 1)
})

test("durable outbox rolls back a failed enqueue flush for all concurrent callers", async (t) => {
  const { store } = await makeStore(t)
  const originalFlush = store.flush.bind(store)
  let rejectFlush
  let markFlushStarted
  const flushStarted = new Promise((resolve) => { markFlushStarted = resolve })
  const flushGate = new Promise((_resolve, reject) => { rejectFlush = reject })
  let failFirstFlush = true
  store.flush = () => {
    if (failFirstFlush) {
      markFlushStarted()
      return flushGate
    }
    return originalFlush()
  }
  let deliveries = 0
  const outbox = createDurableOutbox({ store, deliver: async () => { deliveries += 1 } })

  const firstPromise = outbox.enqueue(baseItem)
  await flushStarted
  const duplicatePromise = outbox.enqueue(baseItem)
  assert.equal(await outbox.processNext(), false)
  failFirstFlush = false
  rejectFlush(new Error("disk unavailable"))
  const outcomes = await Promise.allSettled([firstPromise, duplicatePromise])

  assert.deepEqual(outcomes.map((entry) => entry.status), ["rejected", "rejected"])
  assert.deepEqual(store.getOutboxItems(), {})
  assert.equal(await outbox.processNext(), false)
  assert.equal(deliveries, 0)
})

test("durable outbox resumes multipart delivery from the last flushed checkpoint after restart", async (t) => {
  const clock = { now: 2000 }
  const first = await makeStore(t)
  const sent = []
  const outbox1 = createDurableOutbox({
    store: first.store,
    now: () => clock.now,
    deliver: async (item, { checkpoint }) => {
      const index = item.progress.blockIndex || 0
      if (index === 0) {
        sent.push("block-0")
        await checkpoint({ blockIndex: 1 })
      }
      throw makeBoundaryError({ source: "telegram", operation: "sendMessage", kind: "network", outcome: "retryable", message: "Telegram disconnected" })
    },
  })
  await outbox1.enqueue(baseItem)
  await outbox1.processNext({ at: clock.now })
  assert.equal(Object.values(first.store.getOutboxItems())[0].progress.blockIndex, 1)
  await first.store.flush()

  clock.now += 1000
  const second = await makeStore(t, { filePath: first.filePath })
  const outbox2 = createDurableOutbox({
    store: second.store,
    now: () => clock.now,
    deliver: async (item, { checkpoint }) => {
      for (let index = item.progress.blockIndex || 0; index < 2; index += 1) {
        sent.push(`block-${index}`)
        await checkpoint({ blockIndex: index + 1 })
      }
    },
  })
  await outbox2.processNext({ at: clock.now })

  assert.deepEqual(sent, ["block-0", "block-1"])
  assert.deepEqual(second.store.getOutboxItems(), {})
})

test("durable outbox retains failed items for bounded backoff and reports cap backpressure", async (t) => {
  const { store } = await makeStore(t)
  const now = Date.now()
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    now: () => now,
    deliver: async () => {
      throw makeBoundaryError({ source: "telegram", operation: "sendMessage", kind: "network", outcome: "retryable", message: "offline" })
    },
  })

  await outbox.enqueue(baseItem)
  await assert.rejects(() => outbox.enqueue({ ...baseItem, messageId: "msg_2" }, { waitForCapacity: false }), (err) => {
    assert.equal(err.kind, "backpressure")
    assert.equal(err.outcome, "retryable")
    return true
  })
  await outbox.processNext({ at: now })
  const retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 1)
  assert.equal(retained.nextAttemptAt, now + 1000)
  assert.equal(retained.lastError, "network")
})

test("durable outbox holds a capacity waiter until the first item is durably removed", async (t) => {
  const { store } = await makeStore(t)
  const delivered = []
  const tracked = makeTrackedAbortSignal()
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    deliver: async (item) => delivered.push(item.messageId),
  })

  await outbox.enqueue(baseItem)
  let secondSettled = false
  const secondPromise = outbox
    .enqueue({ ...baseItem, messageId: "msg_2" }, { signal: tracked.signal, waitForCapacity: true })
    .then((result) => {
      secondSettled = true
      return result
    })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(secondSettled, false)
  const blockedSnapshot = outbox.snapshot()
  assert.deepEqual(
    { ...blockedSnapshot, nextDueAt: 0 },
    {
      queueSize: 1,
      maxEntries: 1,
      inFlight: 0,
      blockedWaiters: 1,
      full: true,
      nextDueAt: 0,
      workerActive: false,
      lastFatalError: "",
    },
  )
  assert.equal(Number.isFinite(blockedSnapshot.nextDueAt), true)

  assert.equal(await outbox.processNext(), true)
  const second = await secondPromise
  assert.equal(second.deduped, false)
  assert.equal(tracked.listenerCount(), 0)
  assert.equal(Object.values(store.getOutboxItems())[0].messageId, "msg_2")
  assert.equal(await outbox.processNext(), true)
  assert.deepEqual(delivered, ["msg_1", "msg_2"])
  assert.deepEqual(store.getOutboxItems(), {})
})

test("durable outbox removes an aborted capacity waiter and its listener", async (t) => {
  const { store } = await makeStore(t)
  const tracked = makeTrackedAbortSignal()
  const outbox = createDurableOutbox({ store, maxEntries: 1, deliver: async () => {} })
  await outbox.enqueue(baseItem)

  const pending = outbox.enqueue(
    { ...baseItem, messageId: "msg_abort_waiter" },
    { signal: tracked.signal, waitForCapacity: true },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outbox.snapshot().blockedWaiters, 1)
  assert.equal(tracked.listenerCount(), 1)

  tracked.abort()
  await assert.rejects(pending, (err) => err?.name === "AbortError")
  assert.equal(outbox.snapshot().blockedWaiters, 0)
  assert.equal(tracked.listenerCount(), 0)
  assert.equal(Object.keys(store.getOutboxItems()).length, 1)
})

test("durable outbox serves multiple capacity waiters in FIFO order", async (t) => {
  const { store } = await makeStore(t)
  const delivered = []
  const settled = []
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    deliver: async (item) => delivered.push(item.messageId),
  })
  await outbox.enqueue(baseItem)

  const second = outbox.enqueue(
    { ...baseItem, messageId: "msg_2" },
    { waitForCapacity: true },
  ).then((result) => {
    settled.push("msg_2")
    return result
  })
  const third = outbox.enqueue(
    { ...baseItem, messageId: "msg_3" },
    { waitForCapacity: true },
  ).then((result) => {
    settled.push("msg_3")
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(outbox.snapshot().blockedWaiters, 2)

  await outbox.processNext()
  await second
  assert.deepEqual(settled, ["msg_2"])
  assert.equal(outbox.snapshot().blockedWaiters, 1)

  await outbox.processNext()
  await third
  assert.deepEqual(settled, ["msg_2", "msg_3"])
  await outbox.processNext()
  assert.deepEqual(delivered, ["msg_1", "msg_2", "msg_3"])
})

test("durable outbox rejects malformed items as fatal invariants even while full", async (t) => {
  const { store } = await makeStore(t)
  const outbox = createDurableOutbox({ store, maxEntries: 1, deliver: async () => {} })
  await outbox.enqueue(baseItem)

  await assert.rejects(
    () => outbox.enqueue({ ...baseItem, type: "unknown", messageId: "msg_invalid" }, { waitForCapacity: true }),
    (err) => {
      assert.equal(err.source, "state")
      assert.equal(err.kind, "invariant")
      assert.equal(err.outcome, "fatal")
      return true
    },
  )
  assert.equal(outbox.snapshot().blockedWaiters, 0)
})

test("durable outbox bounds its capacity waiter queue", async (t) => {
  const { store } = await makeStore(t)
  const tracked = makeTrackedAbortSignal()
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    maxCapacityWaiters: 1,
    deliver: async () => {},
  })
  await outbox.enqueue(baseItem)
  const waiting = outbox.enqueue(
    { ...baseItem, messageId: "msg_waiting" },
    { signal: tracked.signal, waitForCapacity: true },
  )
  await new Promise((resolve) => setImmediate(resolve))

  await assert.rejects(
    () => outbox.enqueue({ ...baseItem, messageId: "msg_overflow" }, { waitForCapacity: true }),
    (err) => {
      assert.equal(err.kind, "invariant")
      assert.equal(err.outcome, "fatal")
      return true
    },
  )
  assert.equal(outbox.snapshot().blockedWaiters, 1)
  tracked.abort()
  await assert.rejects(waiting, (err) => err?.name === "AbortError")
  assert.equal(outbox.snapshot().blockedWaiters, 0)
})

test("durable outbox releases capacity after a terminal discard", async (t) => {
  const { store } = await makeStore(t)
  const delivered = []
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    deliver: async (item) => {
      if (item.messageId === "msg_1") {
        throw makeBoundaryError({
          source: "telegram",
          operation: "sendMessage",
          status: 400,
          outcome: "fatal",
          message: "chat not found",
        })
      }
      delivered.push(item.messageId)
    },
  })
  await outbox.enqueue(baseItem)
  const waiting = outbox.enqueue(
    { ...baseItem, messageId: "msg_after_discard" },
    { waitForCapacity: true },
  )
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(await outbox.processNext(), true)
  await waiting
  assert.equal(await outbox.processNext(), true)
  assert.deepEqual(delivered, ["msg_after_discard"])
})

test("durable outbox releases capacity after durable expiry cleanup", async (t) => {
  const { store } = await makeStore(t)
  const clock = { now: Date.now() - DEFAULT_OUTBOX_MAX_AGE_MS - 1000 }
  const delivered = []
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    now: () => clock.now,
    deliver: async (item) => delivered.push(item.messageId),
  })
  await outbox.enqueue(baseItem)
  const waiting = outbox.enqueue(
    { ...baseItem, messageId: "msg_after_expiry" },
    { waitForCapacity: true },
  )
  await new Promise((resolve) => setImmediate(resolve))

  clock.now = Date.now()
  assert.equal(await outbox.processNext({ at: clock.now }), false)
  await waiting
  const [pending] = Object.values(store.getOutboxItems())
  assert.equal(pending.messageId, "msg_after_expiry")
  assert.ok(pending.nextAttemptAt <= clock.now)
  assert.equal(await outbox.processNext({ at: clock.now }), true)
  assert.deepEqual(delivered, ["msg_after_expiry"])
})

test("durable outbox recovers a Telegram 503 without dropping the item", async (t) => {
  const { store } = await makeStore(t)
  const clock = { now: Date.now() }
  let attempts = 0
  const outbox = createDurableOutbox({
    store,
    now: () => clock.now,
    deliver: async () => {
      attempts += 1
      if (attempts === 1) {
        throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 503, outcome: "retryable", message: "temporarily unavailable" })
      }
    },
  })

  await outbox.enqueue(baseItem)
  await outbox.processNext({ at: clock.now })
  let retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 1)
  assert.equal(retained.nextAttemptAt, clock.now + 1000)

  clock.now = retained.nextAttemptAt
  await outbox.processNext({ at: clock.now })
  assert.equal(attempts, 2)
  assert.deepEqual(store.getOutboxItems(), {})
})

test("durable outbox honors Telegram retry_after for 429 responses", async (t) => {
  const { store } = await makeStore(t)
  const now = Date.now()
  const outbox = createDurableOutbox({
    store,
    now: () => now,
    deliver: async () => {
      throw makeBoundaryError({
        source: "telegram",
        operation: "sendMessage",
        status: 429,
        outcome: "retryable",
        retryAfterMs: 12_000,
        message: "rate limited",
      })
    },
  })

  await outbox.enqueue(baseItem)
  await outbox.processNext({ at: now })

  const retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 1)
  assert.equal(retained.nextAttemptAt, now + 12_000)
})

test("durable outbox preserves fatal delivery items and propagates the failure", async (t) => {
  const { store } = await makeStore(t)
  let discarded = 0
  const outbox = createDurableOutbox({
    store,
    observability: { recordOutboxDiscarded: () => { discarded += 1 } },
    deliver: async () => {
      throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 401, outcome: "fatal", message: "unauthorized" })
    },
  })
  await outbox.enqueue(baseItem)

  await assert.rejects(() => outbox.processNext(), (err) => {
    assert.equal(err.status, 401)
    return true
  })
  const retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 0)
  assert.equal(retained.lastError, undefined)
  assert.equal(discarded, 0)
})

test("durable outbox terminally discards item-scoped Telegram 400 and 403 failures", async (t) => {
  for (const status of [400, 403]) {
    const { store } = await makeStore(t)
    let discarded = 0
    const outbox = createDurableOutbox({
      store,
      observability: { recordOutboxDiscarded: () => { discarded += 1 } },
      deliver: async () => {
        throw makeBoundaryError({
          source: "telegram",
          operation: "POST sendMessage",
          method: "POST",
          pathname: "/sendMessage",
          status,
          outcome: "fatal",
          message: status === 403 ? "bot was blocked by the user" : "chat not found",
        })
      },
    })

    await outbox.enqueue({ ...baseItem, messageId: `msg_terminal_${status}` })
    assert.equal(await outbox.processNext(), true)
    assert.equal(discarded, 1)
    assert.deepEqual(store.getOutboxItems(), {})
    assert.ok(
      Object.values(store.get().idempotency.keys).some((entry) =>
        entry.kind === "telegram-outbox-discarded" && entry.operation === `telegram:http:${status}`),
    )
  }
})

test("terminal discard is durable across restart and does not block the next outbox item", async (t) => {
  const first = await makeStore(t)
  const delivered = []
  let discarded = 0
  const badItem = { ...baseItem, projectAlias: "bad", messageId: "msg_bad" }
  const goodItem = { ...baseItem, messageId: "msg_good" }
  const outbox1 = createDurableOutbox({
    store: first.store,
    observability: { recordOutboxDiscarded: () => { discarded += 1 } },
    deliver: async (item) => {
      if (item.projectAlias === "bad") {
        throw makeBoundaryError({
          source: "telegram",
          operation: "POST sendMessage",
          pathname: "/sendMessage",
          status: 400,
          outcome: "fatal",
          message: "chat not found",
        })
      }
      delivered.push(item.messageId)
    },
  })

  await outbox1.enqueue(badItem)
  await outbox1.enqueue(goodItem)
  assert.equal(await outbox1.processNext(), true)
  assert.equal(discarded, 1)

  const second = await makeStore(t, { filePath: first.filePath })
  const outbox2 = createDurableOutbox({
    store: second.store,
    deliver: async (item) => delivered.push(item.messageId),
  })
  const replay = await outbox2.enqueue(badItem)
  assert.equal(replay.completed, true)
  assert.equal(await outbox2.processNext(), true)
  assert.deepEqual(delivered, ["msg_good"])
  assert.deepEqual(second.store.getOutboxItems(), {})
})

test("missing outbox project alias is terminally discarded without an OpenCode call", async (t) => {
  const { store } = await makeStore(t)
  store.get().bindings["100:7"] = { projectAlias: "removed", sessionId: "ses_1" }
  store.get().sessionIndex["removed:ses_1"] = { chatId: 100, threadIdOr0: 7 }
  let discarded = 0
  const deliver = createOutboxDelivery({
    store,
    ocByAlias: {},
    logSseDebug() {},
  })
  const outbox = createDurableOutbox({
    store,
    deliver,
    observability: { recordOutboxDiscarded: () => { discarded += 1 } },
  })

  await outbox.enqueue({ ...baseItem, projectAlias: "removed" })
  assert.equal(await outbox.processNext(), true)
  assert.equal(discarded, 1)
  assert.deepEqual(store.getOutboxItems(), {})
})

test("durable outbox run stops promptly during a non-settling in-flight delivery", async (t) => {
  const { store } = await makeStore(t)
  const abortController = new AbortController()
  let markDeliveryStarted
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve })
  const outbox = createDurableOutbox({
    store,
    abortSignal: abortController.signal,
    deliver: async () => {
      markDeliveryStarted()
      await new Promise(() => {})
    },
  })
  await outbox.enqueue(baseItem)

  const runPromise = outbox.run()
  await deliveryStarted
  assert.equal(outbox.snapshot().workerActive, true)
  assert.equal(outbox.snapshot().inFlight, 1)
  abortController.abort()
  await Promise.race([
    runPromise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("outbox did not stop")), 250)),
  ])

  const retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 0)
  assert.equal(outbox.snapshot().workerActive, false)
  assert.equal(outbox.snapshot().lastFatalError, "")
})

test("durable outbox exposes a fatal worker failure and releases blocked waiters", async (t) => {
  const { store } = await makeStore(t)
  const tracked = makeTrackedAbortSignal()
  const unauthorized = makeBoundaryError({
    source: "telegram",
    operation: "sendMessage",
    status: 401,
    outcome: "fatal",
    message: "unauthorized",
  })
  const outbox = createDurableOutbox({
    store,
    maxEntries: 1,
    deliver: async () => {
      throw unauthorized
    },
  })
  await outbox.enqueue(baseItem)
  const waiting = outbox.enqueue(
    { ...baseItem, messageId: "msg_waiting_after_fatal" },
    { signal: tracked.signal, waitForCapacity: true },
  )
  await new Promise((resolve) => setImmediate(resolve))

  await assert.rejects(outbox.run(), (err) => err === unauthorized)
  await assert.rejects(waiting, (err) => err === unauthorized)

  const runtime = outbox.snapshot()
  assert.equal(runtime.workerActive, false)
  assert.equal(runtime.lastFatalError, "http:401")
  assert.equal(runtime.blockedWaiters, 0)
  assert.equal(tracked.listenerCount(), 0)
})

test("durable outbox replays an item persisted before delivery after restart", async (t) => {
  const first = await makeStore(t)
  const clock = { now: Date.now() }
  const outbox1 = createDurableOutbox({ store: first.store, now: () => clock.now, deliver: async () => {} })
  await outbox1.enqueue(baseItem)

  const second = await makeStore(t, { filePath: first.filePath })
  const delivered = []
  const outbox2 = createDurableOutbox({
    store: second.store,
    now: () => clock.now,
    deliver: async (item) => delivered.push(item.id),
  })
  await outbox2.processNext({ at: clock.now })

  assert.equal(delivered.length, 1)
  assert.deepEqual(second.store.getOutboxItems(), {})
})

test("durable outbox completion tombstones suppress repeated SSE delivery after restart", async (t) => {
  const first = await makeStore(t)
  let deliveries = 0
  const outbox1 = createDurableOutbox({
    store: first.store,
    deliver: async () => { deliveries += 1 },
  })
  await outbox1.enqueue(baseItem)
  await outbox1.processNext()
  assert.equal(deliveries, 1)

  const second = await makeStore(t, { filePath: first.filePath })
  const outbox2 = createDurableOutbox({
    store: second.store,
    deliver: async () => { deliveries += 1 },
  })
  const replay = await outbox2.enqueue(baseItem)
  assert.equal(replay.deduped, true)
  assert.equal(replay.completed, true)
  assert.equal(await outbox2.processNext(), false)
  assert.equal(deliveries, 1)
  assert.deepEqual(second.store.getOutboxItems(), {})
})

test("durable outbox removes expired items without attempting delivery", async (t) => {
  const { store } = await makeStore(t)
  const clock = { now: Date.now() - DEFAULT_OUTBOX_MAX_AGE_MS - 1000 }
  let deliveries = 0
  let expired = 0
  const outbox = createDurableOutbox({
    store,
    now: () => clock.now,
    deliver: async () => { deliveries += 1 },
    observability: { recordOutboxExpired: (_projectAlias, count) => { expired += count } },
  })
  await outbox.enqueue(baseItem)

  clock.now = Date.now()
  assert.equal(await outbox.processNext({ at: clock.now }), false)
  assert.equal(deliveries, 0)
  assert.equal(expired, 1)
  assert.deepEqual(store.getOutboxItems(), {})
})

test("durable outbox discards and tombstones an item whose Telegram route was rebound", async (t) => {
  const { store } = await makeStore(t)
  let messageReads = 0
  let delivered = 0
  let discarded = 0
  const logs = []
  store.get().bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_1" }
  store.get().sessionIndex["demo:ses_1"] = { chatId: 100, threadIdOr0: 7 }
  const deliver = createOutboxDelivery({
    store,
    ocByAlias: { demo: { async getMessage() { messageReads += 1 } } },
    logSseDebug: (...args) => logs.push(args),
  })
  const outbox = createDurableOutbox({
    store,
    deliver,
    observability: {
      recordOutboxDelivered: () => { delivered += 1 },
      recordOutboxDiscarded: () => { discarded += 1 },
    },
  })
  await outbox.enqueue(baseItem)

  store.get().bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_2" }
  delete store.get().sessionIndex["demo:ses_1"]
  store.get().sessionIndex["demo:ses_2"] = { chatId: 100, threadIdOr0: 7 }
  await outbox.processNext()

  assert.equal(messageReads, 0)
  assert.equal(delivered, 0)
  assert.equal(discarded, 1)
  assert.deepEqual(store.getOutboxItems(), {})
  assert.ok(logs.some((entry) => entry[2]?.includes("drop=outbox_stale_route")))
  const replay = await outbox.enqueue(baseItem)
  assert.equal(replay.completed, true)
})

test("a missing durable TUI user message is retried instead of stopping the outbox worker", async (t) => {
  const { store } = await makeStore(t)
  store.get().bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_1" }
  store.get().sessionIndex["demo:ses_1"] = { chatId: 100, threadIdOr0: 7 }
  const clock = { now: 10_000 }
  let sends = 0
  const deliver = createOutboxDelivery({
    store,
    runtime: {},
    ocByAlias: {
      demo: {
        async getMessage() {
          throw makeBoundaryError({
            source: "opencode",
            operation: "GET message",
            pathname: "/session/ses_1/message/msg_user",
            status: 404,
            outcome: "stale",
            message: "not found",
          })
        },
      },
    },
    ensureForwardedSets: () => ({ user: new Set() }),
    tg: { async sendHtmlBlocks() { sends += 1 } },
    logSseDebug() {},
  })
  const outbox = createDurableOutbox({ store, deliver, now: () => clock.now })
  await outbox.enqueue({
    type: "user-mirror",
    projectAlias: "demo",
    sessionId: "ses_1",
    messageId: "msg_user",
    route: { chatId: 100, threadIdOr0: 7 },
  })

  await outbox.processNext({ at: clock.now })

  const [pending] = Object.values(store.getOutboxItems())
  assert.equal(pending.attemptCount, 1)
  assert.ok(pending.nextAttemptAt > clock.now)
  assert.equal(sends, 0)
})

test("a provisional agent-error 404 cannot suppress a later definitive error notice", async (t) => {
  const { store } = await makeStore(t)
  store.get().bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_1" }
  store.get().sessionIndex["demo:ses_1"] = { chatId: 100, threadIdOr0: 7 }
  let messageMissing = true
  let currentMessage = { info: { id: "msg_agent_error", role: "assistant" }, parts: [] }
  const sent = []
  const forwarded = { agentStopErrors: new Set() }
  const deliver = createOutboxDelivery({
    store,
    runtime: {},
    ocByAlias: {
      demo: {
        async getMessage() {
          if (messageMissing) {
            throw makeBoundaryError({
              source: "opencode",
              operation: "GET message",
              pathname: "/session/ses_1/message/msg_agent_error",
              status: 404,
              outcome: "stale",
              message: "not found",
            })
          }
          return currentMessage
        },
      },
    },
    ensureForwardedSets: () => forwarded,
    sendToThread: async (_route, text) => sent.push(text),
    logSseDebug() {},
  })
  const outbox = createDurableOutbox({ store, deliver })
  const item = {
    type: "agent-error",
    projectAlias: "demo",
    sessionId: "ses_1",
    messageId: "msg_agent_error",
    route: { chatId: 100, threadIdOr0: 7 },
  }

  await outbox.enqueue({ ...item, payload: { text: "provisional", requireMessageError: true } })
  await outbox.processNext()
  assert.deepEqual(sent, [])
  assert.deepEqual(store.getOutboxItems(), {})

  messageMissing = false
  await outbox.enqueue({ ...item, payload: { text: "provisional", requireMessageError: true } })
  await outbox.processNext()
  assert.deepEqual(sent, [])
  assert.deepEqual(store.getOutboxItems(), {})

  currentMessage = { info: { id: "msg_agent_error", role: "assistant", error: { name: "AgentError", message: "tool failed" } }, parts: [] }
  const definitive = await outbox.enqueue({ ...item, payload: { text: "definitive" } })
  assert.equal(definitive.completed, undefined)
  await outbox.processNext()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /tool failed/)

  const replay = await outbox.enqueue({ ...item, payload: { text: "definitive" } })
  assert.equal(replay.completed, true)
  assert.equal(sent.length, 1)
})

test("durable preview finalization retries a Telegram 503 instead of losing the item", async (t) => {
  const { store } = await makeStore(t)
  store.get().bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_1" }
  store.get().sessionIndex["demo:ses_1"] = { chatId: 100, threadIdOr0: 7 }
  const clock = { now: Date.now() }
  let editAttempts = 0
  const previewBySession = new Map([["demo:ses_1", { messageId: "msg_1", telegramMessageId: 900 }]])
  const forwarded = { assistant: new Set(), changes: new Set(), agentStopErrors: new Set() }
  const deliver = createOutboxDelivery({
    tg: {
      async editMessageText() {
        editAttempts += 1
        if (editAttempts === 1) {
          throw makeBoundaryError({ source: "telegram", operation: "editMessageText", status: 503, outcome: "retryable", message: "temporarily unavailable" })
        }
        return { message_id: 900 }
      },
    },
    store,
    runtime: { mirrorCompaction: false },
    ocByAlias: { demo: {} },
    assistantPreviewBySession: previewBySession,
    lastAssistantBySession: new Map(),
    ensureForwardedSets: () => forwarded,
    extractAssistantDisplayText: () => "",
    extractChangedFilesSummary: () => "",
    getAssistantMessageWithRetry: async () => ({ info: { id: "msg_1", role: "assistant" }, parts: [] }),
    previewMatchesRoute: () => true,
    sendToThread: async () => assert.fail("retryable edit failures must not fall back to a new send"),
    logSseDebug() {},
    recordNoisySkip() {},
  })
  const outbox = createDurableOutbox({ store, deliver, now: () => clock.now })
  await outbox.enqueue(baseItem)

  await outbox.processNext({ at: clock.now })
  const retained = Object.values(store.getOutboxItems())[0]
  assert.equal(retained.attemptCount, 1)
  assert.equal(editAttempts, 1)

  clock.now = retained.nextAttemptAt
  await outbox.processNext({ at: clock.now })
  assert.equal(editAttempts, 2)
  assert.deepEqual(store.getOutboxItems(), {})
})
