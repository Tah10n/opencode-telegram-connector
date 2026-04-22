import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { ReadableStream } from "node:stream/web"
import { startOpenCodeSseLoop } from "../src/opencode/sse.js"
import { classifyBoundaryError } from "../src/boundary-errors.js"

function makeLogger() {
  return { info() {}, error() {}, warn() {}, debug() {} }
}

function useFetchStub(t, impl) {
  const previous = global.fetch
  global.fetch = impl
  t.after(() => {
    global.fetch = previous
  })
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

test("startOpenCodeSseLoop forwards parsed SSE events and connects once", async (t) => {
  let fetchCalls = 0
  useFetchStub(t, async () => {
    fetchCalls += 1
    return makeSseResponse(['data: {"id":"evt_1","type":"message"}\n', "\n"])
  })

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let connectCalls = 0
  let errorCalls = 0
  let loop
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onConnect: async () => {
        connectCalls += 1
      },
      onEvent: async ({ projectAlias, evt }) => {
        assert.equal(projectAlias, "demo")
        assert.deepEqual(evt, { id: "evt_1", type: "message" })
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
      onError: async () => {
        errorCalls += 1
      },
    })
  })

  await delay(20)
  assert.equal(fetchCalls, 1)
  assert.equal(connectCalls, 1)
  assert.equal(errorCalls, 0)
})

test("startOpenCodeSseLoop reports disconnects only after a failed health check", async (t) => {
  let fetchCalls = 0
  useFetchStub(t, async () => {
    fetchCalls += 1
    return makeSseResponse([])
  })

  let healthCalls = 0
  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => {
      healthCalls += 1
      throw new Error("server down")
    },
  }

  const abortController = new AbortController()
  let loop
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE error")), 1500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      abortSignal: abortController.signal,
      onError: async ({ projectAlias, err }) => {
        assert.equal(projectAlias, "demo")
        assert.match(err.message, /SSE disconnected/)
        assert.equal(err.isBoundaryError, true)
        assert.equal(classifyBoundaryError(err).retryable, true)
        loop.stop()
        abortController.abort()
        clearTimeout(timeout)
        resolve()
      },
    })
  })

  assert.equal(fetchCalls, 1)
  assert.equal(healthCalls, 1)
})
