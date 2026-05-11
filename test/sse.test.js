import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { ReadableStream } from "node:stream/web"
import { getOpenCodeSseEventMeta, startOpenCodeSseLoop } from "../src/opencode/sse.js"
import { OpenCodeClient, OPENCODE_CORRELATION_HEADER } from "../src/opencode/client.js"
import { classifyBoundaryError } from "../src/boundary-errors.js"
import { getRequestContext } from "../src/runtime/request-context.js"

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
        assert.deepEqual(getOpenCodeSseEventMeta(evt), {
          directory: null,
          eventPath: "/global/event",
          wrapped: false,
          requiresDirectoryRouting: true,
        })
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

test("startOpenCodeSseLoop unwraps opencode global event payloads", async (t) => {
  useFetchStub(t, async () =>
    makeSseResponse([
      'data: {"payload":{"id":"evt_1","type":"message.updated","properties":{"sessionID":"ses_1","info":{"id":"msg_1"}}}}\n',
      "\n",
    ]),
  )

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  const evt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for wrapped SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async ({ evt }) => {
        loop.stop()
        clearTimeout(timeout)
        resolve(evt)
      },
    })
  })

  assert.deepEqual(evt, {
    id: "evt_1",
    type: "message.updated",
    properties: { sessionID: "ses_1", info: { id: "msg_1" } },
  })
  assert.deepEqual(getOpenCodeSseEventMeta(evt), {
    directory: null,
    eventPath: "/global/event",
    wrapped: true,
    requiresDirectoryRouting: true,
  })
})

test("startOpenCodeSseLoop preserves opencode global event directory metadata", async (t) => {
  useFetchStub(t, async () =>
    makeSseResponse([
      'data: {"directory":"C:/repo/demo","payload":{"id":"evt_1","type":"message.updated","properties":{"sessionID":"ses_1","info":{"id":"msg_1"}}}}\n',
      "\n",
    ]),
  )

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  const evt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for wrapped SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async ({ evt }) => {
        loop.stop()
        clearTimeout(timeout)
        resolve(evt)
      },
    })
  })

  assert.equal(evt.type, "message.updated")
  assert.deepEqual(getOpenCodeSseEventMeta(evt), {
    directory: "C:/repo/demo",
    eventPath: "/global/event",
    wrapped: true,
    requiresDirectoryRouting: true,
  })
})

test("startOpenCodeSseLoop treats blank global event directory metadata as missing", async (t) => {
  useFetchStub(t, async () =>
    makeSseResponse([
      'data: {"directory":"   ","payload":{"id":"evt_1","type":"message.updated","properties":{"sessionID":"ses_1"}}}\n',
      "\n",
    ]),
  )

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  const evt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for blank-directory SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async ({ evt }) => {
        loop.stop()
        clearTimeout(timeout)
        resolve(evt)
      },
    })
  })

  assert.deepEqual(getOpenCodeSseEventMeta(evt), {
    directory: null,
    eventPath: "/global/event",
    wrapped: true,
    requiresDirectoryRouting: true,
  })
})

test("startOpenCodeSseLoop sends correlation header and scopes event context", async (t) => {
  const headersSeen = []
  useFetchStub(t, async (_url, init) => {
    headersSeen.push(init.headers)
    return makeSseResponse([
      'data: {"id":"evt_1","type":"message.updated","properties":{"sessionID":"ses_1","info":{"id":"msg_1"}}}\n',
      "\n",
    ])
  })

  const ocClient = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4312" })

  let loop
  const context = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE context")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async () => {
        loop.stop()
        clearTimeout(timeout)
        resolve(getRequestContext())
      },
    })
  })

  assert.match(headersSeen[0][OPENCODE_CORRELATION_HEADER], /^sse-connect-demo-/)
  assert.match(context.correlationId, /^sse-demo-message.updated-/)
  assert.equal(context.source, "opencode")
  assert.equal(context.projectAlias, "demo")
  assert.equal(context.eventType, "message.updated")
  assert.equal(context.sessionId, "ses_1")
  assert.equal(context.messageId, "msg_1")
})

test("startOpenCodeSseLoop accepts one large chunk with many short SSE lines", async (t) => {
  swapEnv(t, { OPENCODE_SSE_MAX_LINE_BYTES: "32" })
  const chunk = `${Array.from({ length: 20 }, (_value, idx) => `: keepalive ${idx}\n`).join("")}data: {"id":"evt_1"}\n\n`
  assert.ok(Buffer.byteLength(chunk, "utf8") > 32)

  useFetchStub(t, async () => makeSseResponse([chunk]))

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  const evt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async ({ evt }) => {
        loop.stop()
        clearTimeout(timeout)
        resolve(evt)
      },
      onError: async ({ err }) => {
        loop?.stop()
        clearTimeout(timeout)
        reject(err)
      },
    })
  })

  assert.deepEqual(evt, { id: "evt_1" })
})

test("startOpenCodeSseLoop rejects one SSE line over the configured limit", async (t) => {
  swapEnv(t, { OPENCODE_SSE_MAX_LINE_BYTES: "32" })
  const longLine = `data: ${"x".repeat(40)}\n\n`

  useFetchStub(t, async () => makeSseResponse([longLine]))

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  const err = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE line limit error")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async () => {
        loop?.stop()
        clearTimeout(timeout)
        reject(new Error("Unexpected SSE event"))
      },
      onError: async ({ err }) => {
        loop?.stop()
        clearTimeout(timeout)
        resolve(err)
      },
    })
  })

  assert.match(err.message, /SSE line buffer exceeded limit/)
  assert.equal(classifyBoundaryError(err).retryable, false)
})

test("startOpenCodeSseLoop appends event path after a base path", async (t) => {
  const fetchUrls = []
  useFetchStub(t, async (url) => {
    fetchUrls.push(String(url))
    return makeSseResponse(['data: {"id":"evt_1","type":"message"}\n', "\n"])
  })

  const ocClient = {
    baseUrl: "https://example.com/api",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async () => {
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })

  assert.deepEqual(fetchUrls, ["https://example.com/api/global/event"])
})

test("startOpenCodeSseLoop allows overriding the SSE event path", async (t) => {
  swapEnv(t, { OPENCODE_SSE_EVENT_PATH: "/event" })
  const fetchUrls = []
  let receivedEvent
  useFetchStub(t, async (url) => {
    fetchUrls.push(String(url))
    return makeSseResponse(['data: {"payload":{"id":"evt_1","type":"message"}}\n', "\n"])
  })

  const ocClient = {
    baseUrl: "https://example.com/api",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onEvent: async ({ evt }) => {
        receivedEvent = evt
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })

  assert.deepEqual(fetchUrls, ["https://example.com/api/event"])
  assert.deepEqual(receivedEvent, { id: "evt_1", type: "message" })
  assert.deepEqual(getOpenCodeSseEventMeta(receivedEvent), {
    directory: null,
    eventPath: "/event",
    wrapped: true,
    requiresDirectoryRouting: false,
  })
})

test("startOpenCodeSseLoop reports disconnects only after a failed health check", async (t) => {
  let fetchCalls = 0
  useFetchStub(t, async () => {
    fetchCalls += 1
    return makeSseResponse([])
  })

  const healthCalls = []
  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async (input = {}) => {
      healthCalls.push(input)
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
  assert.equal(healthCalls.length, 1)
  assert.equal(healthCalls[0].signal, abortController.signal)
})

test("startOpenCodeSseLoop times out a hung initial SSE fetch", async (t) => {
  swapEnv(t, { OPENCODE_SSE_CONNECT_TIMEOUT_MS: "1" })
  let fetchCalls = 0
  useFetchStub(t, async (_url, options = {}) => {
    fetchCalls += 1
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener?.(
        "abort",
        () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        { once: true },
      )
    })
  })

  const ocClient = {
    baseUrl: "http://127.0.0.1:4312",
    headers: () => ({}),
    health: async () => ({ ok: true }),
  }

  let loop
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE timeout")), 1500)
    loop = startOpenCodeSseLoop({
      projectAlias: "demo",
      ocClient,
      logger: makeLogger(),
      onError: async ({ err }) => {
        const classification = classifyBoundaryError(err)
        assert.equal(classification.retryable, true)
        assert.equal(classification.kind, "timeout")
        loop.stop()
        clearTimeout(timeout)
        resolve()
      },
    })
  })

  assert.equal(fetchCalls, 1)
})
