import test from "node:test"
import assert from "node:assert/strict"
import { ReadableStream } from "node:stream/web"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { startOpenCodeSseLoop } from "../src/opencode/sse.js"
import { makeBoundaryError } from "../src/boundary-errors.js"

const require = createRequire(import.meta.url)
const timersPromises = require("node:timers/promises")
const originalGlobalSetTimeout = globalThis.setTimeout

function useFetchStub(t, impl) {
  const previous = global.fetch
  global.fetch = impl
  t.after(() => {
    global.fetch = previous
  })
}

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function usePatchedDelay(t, impl) {
  const previous = timersPromises.setTimeout
  timersPromises.setTimeout = impl
  syncBuiltinESMExports()
  t.after(() => {
    timersPromises.setTimeout = previous
    syncBuiltinESMExports()
  })
}

function captureIdleTimers(t) {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  const timers = []
  globalThis.setTimeout = (fn, ms) => {
    const handle = {
      fn,
      ms,
      cleared: false,
      unref() {
        handle.unrefCalled = true
      },
    }
    timers.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (handle) handle.cleared = true
  }
  t.after(() => {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
  })
  return timers
}

function makeLogger() {
  const logs = { info: [], error: [] }
  return {
    logs,
    info(...args) {
      logs.info.push(args)
    },
    error(...args) {
      logs.error.push(args)
    },
  }
}

function makeSseResponse(chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function makeAbortableSseResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"))
      })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function makeClient() {
  return {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }
}

test("startOpenCodeSseLoop reports non-OK SSE responses via onError", async (t) => {
  usePatchedDelay(t, async () => {})
  useFetchStub(t, async () => ({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    text: async () => "busy secret-token",
  }))

  let loop
  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for non-OK SSE error")), 1000)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient: makeClient(),
      logger: makeLogger(),
      onError: async ({ projectAlias, err }) => {
        assert.equal(projectAlias, "demo")
        assert.equal(err.isBoundaryError, true)
        assert.match(err.message, /SSE 503: Service Unavailable/)
        assert.doesNotMatch(err.message, /secret-token|busy/)
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })
})

test("startOpenCodeSseLoop skips invalid JSON events and logs handler failures", async (t) => {
  useFetchStub(t, async () =>
    makeSseResponse(['data: {not-json}\n', '\n', 'data: {"id":"evt_2","type":"message"}\n', '\n']),
  )

  const logger = makeLogger()
  const seen = []
  let loop
  loop = startOpenCodeSseLoop({
    projectAlias: "demo",
    ocClient: makeClient(),
    logger,
    onEvent: async ({ evt }) => {
      seen.push(evt)
      loop.stop()
      throw new Error("handler failed")
    },
  })

  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for handler error log")), 1000)
    const poll = () => {
      if (logger.logs.error.length) {
        clearTimeout(timeout)
        resolve()
        return
      }
      originalGlobalSetTimeout(poll, 10)
    }
    poll()
  })

  assert.deepEqual(seen, [{ id: "evt_2", type: "message" }])
  assert.equal(logger.logs.error.length, 1)
  assert.equal(logger.logs.error[0][0], "SSE event handler error")
  assert.equal(logger.logs.error[0][1].projectAlias, "demo")
  assert.equal(logger.logs.error[0][1].error, "handler failed")
})

test("startOpenCodeSseLoop reports handler failures via onError", async (t) => {
  usePatchedDelay(t, async () => {})
  useFetchStub(t, async () => makeSseResponse(['data: {"id":"evt_state","type":"permission.asked"}\n', "\n"]))

  let loop
  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for handler onError")), 1000)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient: makeClient(),
      logger: makeLogger(),
      onEvent: async () => {
        throw makeBoundaryError({
          source: "state",
          operation: "persist prompt recovery state",
          kind: "durability",
          outcome: "retryable",
          message: "persist prompt recovery state failed",
        })
      },
      onError: async ({ projectAlias, err }) => {
        assert.equal(projectAlias, "demo")
        assert.equal(err.isBoundaryError, true)
        assert.equal(err.source, "state")
        assert.equal(err.outcome, "retryable")
        assert.match(err.message, /persist prompt recovery state failed/)
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })
})

test("startOpenCodeSseLoop aborts oversized SSE events and reports a protocol error", async (t) => {
  usePatchedDelay(t, async () => {})
  swapEnv(t, { OPENCODE_SSE_MAX_EVENT_BYTES: "10" })
  useFetchStub(t, async () => makeSseResponse([`data: ${"x".repeat(50)}\n`, "\n"]))

  let loop
  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for oversized event error")), 1000)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient: makeClient(),
      logger: makeLogger(),
      onError: async ({ err }) => {
        assert.match(err.message, /SSE event exceeded limit/)
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })
})

test("startOpenCodeSseLoop stops instead of reconnecting after fatal protocol errors", async (t) => {
  usePatchedDelay(t, async () => {})
  swapEnv(t, { OPENCODE_SSE_MAX_EVENT_BYTES: "10" })
  let fetchCalls = 0
  useFetchStub(t, async () => {
    fetchCalls += 1
    return makeSseResponse([`data: ${"x".repeat(50)}\n`, "\n"])
  })

  const errors = []
  const loop = startOpenCodeSseLoop({
    projectAlias: "demo",
    ocClient: makeClient(),
    logger: makeLogger(),
    onError: async ({ err }) => {
      errors.push(err)
    },
  })

  await Promise.race([
    loop.done,
    new Promise((_, reject) => originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for fatal SSE stop")), 1000)),
  ])

  assert.equal(fetchCalls, 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].outcome, "fatal")
})

test("startOpenCodeSseLoop aborts when an SSE line exceeds the buffer limit", async (t) => {
  usePatchedDelay(t, async () => {})
  swapEnv(t, { OPENCODE_SSE_MAX_LINE_BYTES: "10" })
  useFetchStub(t, async () => makeSseResponse([`data: ${"y".repeat(50)}`]))

  let loop
  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for line-buffer error")), 1000)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient: makeClient(),
      logger: makeLogger(),
      onError: async ({ err }) => {
        assert.match(err.message, /SSE line buffer exceeded limit/)
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })
})

test("startOpenCodeSseLoop aborts an idle connection and logs it as a normal stop", async (t) => {
  usePatchedDelay(t, async () => {})
  const timers = captureIdleTimers(t)
  useFetchStub(t, async (_url, init) => makeAbortableSseResponse(init.signal))

  const logger = makeLogger()
  let loop
  await new Promise((resolve, reject) => {
    const timeout = originalGlobalSetTimeout(() => reject(new Error("Timed out waiting for idle abort")), 1000)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient: makeClient(),
      logger,
    })

    const poll = () => {
      const idleTimer = timers.find((timer) => !timer.cleared && timer.ms > 60_000)
      if (idleTimer) {
        idleTimer.fn()
        return
      }
      originalGlobalSetTimeout(poll, 10)
    }
    poll()

    const waitForAbortLog = () => {
      if (logger.logs.info.some((entry) => entry[0] === "SSE aborted")) {
        loop.stop()
        clearTimeout(timeout)
        resolve()
        return
      }
      originalGlobalSetTimeout(waitForAbortLog, 10)
    }
    waitForAbortLog()
  })

  assert.equal(logger.logs.info.some((entry) => entry[0] === "SSE aborted" && entry[1]?.projectAlias === "demo"), true)
})

test("startOpenCodeSseLoop exposes done for explicit stop without reporting an error", async (t) => {
  useFetchStub(t, async (_url, init) => makeAbortableSseResponse(init.signal))

  let errorCalls = 0
  const loop = startOpenCodeSseLoop({
    projectAlias: "demo",
    ocClient: makeClient(),
    logger: makeLogger(),
    onError: async () => {
      errorCalls += 1
    },
  })

  await new Promise((resolve) => originalGlobalSetTimeout(resolve, 20))
  loop.stop()
  await loop.done

  assert.equal(errorCalls, 0)
})
