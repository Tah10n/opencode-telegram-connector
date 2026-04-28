import test from "node:test"
import assert from "node:assert/strict"
import { createLifecycleManager } from "../src/runtime/lifecycle.js"

function createDeferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test("registerPromise tracks a record and removes it on settle", async () => {
  const lifecycle = createLifecycleManager()
  const pending = createDeferred()
  const token = lifecycle.registerPromise("startup", pending.promise, {
    kind: "task",
    metadata: { projectAlias: "demo" },
    stop: async () => {},
  })

  const snapshot = lifecycle.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].name, "startup")
  assert.equal(snapshot[0].kind, "task")
  assert.deepEqual(snapshot[0].metadata, { projectAlias: "demo" })
  assert.equal(snapshot[0].stopCalled, false)
  assert.equal(token.isActive(), true)

  pending.resolve("ok")
  await token.done

  assert.equal(token.isActive(), false)
  assert.equal(lifecycle.snapshot().length, 0)
})

test("registerPromise stop is idempotent and handles stop errors", async () => {
  const lifecycle = createLifecycleManager()
  let stopCalls = 0
  const pending = createDeferred()
  const token = lifecycle.registerPromise("failing-stop", pending.promise, {
    stop: async () => {
      stopCalls += 1
      throw new Error("boom")
    },
  })

  await token.stop()
  await token.stop()
  pending.resolve()
  await token.done

  assert.equal(stopCalls, 1)
  assert.equal(token.isActive(), false)
})

test("registerHandle uses an existing done promise as completion", async () => {
  const lifecycle = createLifecycleManager()
  const doneGate = createDeferred()
  let stopped = false

  const token = lifecycle.registerHandle("with-done", {
    done: doneGate.promise,
    stop: async () => {
      stopped = true
    },
  })

  assert.equal(token.isActive(), true)

  await token.stop()
  assert.equal(stopped, true)

  // Still tracked while external done promise is pending.
  assert.equal(lifecycle.snapshot().length, 1)
  assert.equal(lifecycle.snapshot()[0].stopCalled, true)

  doneGate.resolve("done")
  await token.done

  assert.equal(token.isActive(), false)
  assert.equal(lifecycle.snapshot().length, 0)
})

test("registerHandle without done promise resolves a deferred completion", async () => {
  const lifecycle = createLifecycleManager()
  let stopped = false

  const token = lifecycle.registerHandle("without-done", {
    stop: async () => {
      stopped = true
    },
  })

  await token.stop()
  await token.done

  assert.equal(stopped, true)
  assert.equal(token.isActive(), false)
  assert.equal(lifecycle.snapshot().length, 0)
})

test("registerTimer uses a cleanup clear function and defaults kind to timer", async () => {
  const lifecycle = createLifecycleManager()
  let cleared

  const token = lifecycle.registerTimer("gc", "timer-handle", {
    clear: (value) => {
      cleared = value
    },
  })

  const snapshot = lifecycle.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].kind, "timer")

  await token.stop()
  await token.done

  assert.equal(cleared, "timer-handle")
  assert.equal(lifecycle.snapshot().length, 0)
})

test("registerStopHook defaults kind to cleanup", async () => {
  const lifecycle = createLifecycleManager()
  let stopped = false

  const token = lifecycle.registerStopHook("cleanup", async () => {
    stopped = true
  })

  assert.equal(lifecycle.snapshot().length, 1)
  assert.equal(lifecycle.snapshot()[0].kind, "cleanup")

  await token.stop()
  await token.done

  assert.equal(stopped, true)
  assert.equal(lifecycle.snapshot().length, 0)
})

test("stopAll stops every active handle and waits for completion", async () => {
  const lifecycle = createLifecycleManager()
  const stopGate1 = createDeferred()
  const stopGate2 = createDeferred()
  const stopOrder = []

  lifecycle.registerHandle("first", {
    stop: async () => {
      stopOrder.push("first")
      await stopGate1.promise
    },
  })

  lifecycle.registerHandle("second", {
    stop: async () => {
      stopOrder.push("second")
      await stopGate2.promise
    },
  })

  const stopPromise = lifecycle.stopAll()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stopOrder.length, 2)
  assert.equal(lifecycle.snapshot().length, 2)

  stopGate1.resolve()
  stopGate2.resolve()
  await stopPromise

  assert.equal(lifecycle.snapshot().length, 0)
})
