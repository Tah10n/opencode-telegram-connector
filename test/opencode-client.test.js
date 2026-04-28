import test from "node:test"
import assert from "node:assert/strict"
import { OpenCodeClient } from "../src/opencode/client.js"
import { classifyBoundaryError } from "../src/boundary-errors.js"

test("OpenCodeClient request sends query params, auth headers, and JSON bodies", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }
  }

  try {
    const external = new AbortController()
    const client = new OpenCodeClient({ baseUrl: "https://example.com/api", username: "user", password: "secret" })
    const result = await client.request("/session", {
      method: "POST",
      query: { directory: "C:/repo", limit: 10, ignored: null },
      json: { title: "demo" },
      signal: external.signal,
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://example.com/api/session?directory=C%3A%2Frepo&limit=10")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers.accept, "application/json")
    assert.equal(calls[0].init.headers["content-type"], "application/json")
    assert.match(calls[0].init.headers.authorization, /^Basic /)
    assert.equal(calls[0].init.body, JSON.stringify({ title: "demo" }))
    assert.equal(calls[0].init.signal instanceof AbortSignal, true)
    assert.equal(calls[0].init.signal.aborted, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenCodeClient rejects baseUrl query strings and fragments", () => {
  assert.throws(() => new OpenCodeClient({ baseUrl: "https://example.com/api?token=abc" }), /must not include query strings or fragments/)
  assert.throws(() => new OpenCodeClient({ baseUrl: "https://example.com/api#frag" }), /must not include query strings or fragments/)
})

test("OpenCodeClient request handles 204, text responses, and backend errors", async () => {
  const originalFetch = globalThis.fetch
  const queue = [
    { status: 204, ok: true, text: async () => "" },
    { status: 200, ok: true, text: async () => "plain text" },
    { status: 500, ok: false, statusText: "Server Error", text: async () => "boom" },
  ]
  globalThis.fetch = async () => queue.shift()

  try {
    const client = new OpenCodeClient({ baseUrl: "https://example.com" })
    assert.equal(await client.request("/noop"), null)
    assert.equal(await client.request("/text"), "plain text")
    await assert.rejects(async () => client.request("/broken"), (err) => {
      assert.match(err.message, /GET \/broken failed: 500 boom/)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "opencode")
      assert.equal(err.status, 500)
      assert.equal(classifyBoundaryError(err).retryable, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenCodeClient request wraps resource 404s as stale boundary errors", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: async () => "not found",
  })

  try {
    const client = new OpenCodeClient({ baseUrl: "https://example.com" })
    await assert.rejects(async () => client.getSession("ses_missing"), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.pathname, "/session/ses_missing")
      assert.equal(classification.stale, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenCodeClient keeps prefixed resource 404s stale", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: async () => "not found",
  })

  try {
    const client = new OpenCodeClient({ baseUrl: "https://example.com/api" })
    await assert.rejects(async () => client.getSession("ses_missing"), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.pathname, "/api/session/ses_missing")
      assert.equal(classification.stale, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenCodeClient convenience methods call the expected endpoints", async () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com" })
  const calls = []
  client.request = async (pathname, options) => {
    calls.push({ pathname, options })
    return { ok: true }
  }

  await client.health()
  await client.getConfig({ directory: "C:/repo" })
  await client.getConfigProviders()
  await client.listSessions({ directory: "C:/repo", limit: 5 })
  await client.getSession("ses_1")
  await client.createSession({ title: "demo" })
  await client.selectTuiSession("ses_1")
  await client.getActiveTuiSession()
  await client.abortSession("ses_1")
  await client.promptAsync("ses_1", "hello", { model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" })
  await client.getMessage("ses_1", "msg_1")
  await client.listMessages("ses_1", { limit: 20 })
  await client.replyPermission("perm_1", { reply: "reject", message: "no" })
  await client.replyQuestion("q_1", [["lint"]])
  await client.rejectQuestion("q_1")
  await client.listPermissions()
  await client.listQuestions()

  assert.deepEqual(calls, [
    { pathname: "/global/health", options: undefined },
    { pathname: "/config", options: { query: { directory: "C:/repo" } } },
    { pathname: "/config/providers", options: undefined },
    { pathname: "/session", options: { query: { directory: "C:/repo", limit: 5 } } },
    { pathname: "/session/ses_1", options: undefined },
    { pathname: "/session", options: { method: "POST", json: { title: "demo" } } },
    { pathname: "/tui/select-session", options: { method: "POST", json: { sessionID: "ses_1" }, timeoutMs: 5000 } },
    { pathname: "/tui/active-session", options: { timeoutMs: 5000 } },
    { pathname: "/session/ses_1/abort", options: { method: "POST" } },
    {
      pathname: "/session/ses_1/prompt_async",
      options: {
        method: "POST",
        json: {
          parts: [{ type: "text", text: "hello" }],
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "xhigh",
        },
      },
    },
    { pathname: "/session/ses_1/message/msg_1", options: undefined },
    { pathname: "/session/ses_1/message", options: { query: { limit: 20 } } },
    { pathname: "/permission/perm_1/reply", options: { method: "POST", json: { reply: "reject", message: "no" } } },
    { pathname: "/question/q_1/reply", options: { method: "POST", json: { answers: [["lint"]] } } },
    { pathname: "/question/q_1/reject", options: { method: "POST" } },
    { pathname: "/permission", options: { timeoutMs: 15_000 } },
    { pathname: "/question", options: { timeoutMs: 15_000 } },
  ])
})

test("OpenCodeClient encodes dynamic path segments", async () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com" })
  const calls = []
  client.request = async (pathname, options) => {
    calls.push({ pathname, options })
    return { ok: true }
  }

  await client.getSession("ses/a b?#")
  await client.abortSession("ses/a b?#")
  await client.promptAsync("ses/a b?#", "hello")
  await client.getMessage("ses/a b?#", "msg/a b?#")
  await client.listMessages("ses/a b?#", { limit: 2 })
  await client.replyPermission("perm/a b?#", { reply: "once" })
  await client.replyQuestion("q/a b?#", [["ok"]])
  await client.rejectQuestion("q/a b?#")

  assert.deepEqual(calls.map((call) => call.pathname), [
    "/session/ses%2Fa%20b%3F%23",
    "/session/ses%2Fa%20b%3F%23/abort",
    "/session/ses%2Fa%20b%3F%23/prompt_async",
    "/session/ses%2Fa%20b%3F%23/message/msg%2Fa%20b%3F%23",
    "/session/ses%2Fa%20b%3F%23/message",
    "/permission/perm%2Fa%20b%3F%23/reply",
    "/question/q%2Fa%20b%3F%23/reply",
    "/question/q%2Fa%20b%3F%23/reject",
  ])
})

test("OpenCodeClient rejects empty dynamic path segments", async () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com" })

  assert.throws(() => client.getSession("   "), /Invalid session id/)
  assert.throws(() => client.getMessage("ses_1", "\u0000"), /Invalid message id/)
})

test("OpenCodeClient selectTuiSession falls back to /tui/publish on 404", async () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com" })
  const calls = []
  client.request = async (pathname, options) => {
    calls.push({ pathname, options })
    if (pathname === "/tui/select-session") {
      const err = new Error("missing")
      err.isBoundaryError = true
      err.status = 404
      throw err
    }
    return true
  }

  await client.selectTuiSession("ses_1")

  assert.deepEqual(calls, [
    { pathname: "/tui/select-session", options: { method: "POST", json: { sessionID: "ses_1" }, timeoutMs: 5000 } },
    {
      pathname: "/tui/publish",
      options: {
        method: "POST",
        json: { type: "tui.session.select", properties: { sessionID: "ses_1" } },
        timeoutMs: 5000,
      },
    },
  ])
})

test("OpenCodeClient headers keep accept header and default auth username", () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com", password: "secret" })
  const headers = client.headers({ "x-test": "1" })

  assert.equal(headers.accept, "application/json")
  assert.equal(headers["x-test"], "1")
  assert.match(headers.authorization, /^Basic /)
})

test("OpenCodeClient request keeps timeout behavior when an external abort signal is provided", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    await new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      )
    })
  }

  try {
    const client = new OpenCodeClient({ baseUrl: "https://example.com" })
    const external = new AbortController()
    await assert.rejects(client.request("/slow", { timeoutMs: 5, signal: external.signal }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(classification.retryable, true)
      assert.equal(err.kind, "timeout")
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
