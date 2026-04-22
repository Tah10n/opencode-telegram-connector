import test from "node:test"
import assert from "node:assert/strict"
import { OpenCodeClient } from "../src/opencode/client.js"

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
    const client = new OpenCodeClient({ baseUrl: "https://example.com/api", username: "user", password: "secret" })
    const result = await client.request("/session", {
      method: "POST",
      query: { directory: "C:/repo", limit: 10, ignored: null },
      json: { title: "demo" },
      signal: "external-signal",
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://example.com/api/session?directory=C%3A%2Frepo&limit=10")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers.accept, "application/json")
    assert.equal(calls[0].init.headers["content-type"], "application/json")
    assert.match(calls[0].init.headers.authorization, /^Basic /)
    assert.equal(calls[0].init.body, JSON.stringify({ title: "demo" }))
    assert.equal(calls[0].init.signal, "external-signal")
  } finally {
    globalThis.fetch = originalFetch
  }
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
    await assert.rejects(() => client.request("/broken"), /GET \/broken failed: 500 boom/)
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

test("OpenCodeClient headers keep accept header and default auth username", () => {
  const client = new OpenCodeClient({ baseUrl: "https://example.com", password: "secret" })
  const headers = client.headers({ "x-test": "1" })

  assert.equal(headers.accept, "application/json")
  assert.equal(headers["x-test"], "1")
  assert.match(headers.authorization, /^Basic /)
})
