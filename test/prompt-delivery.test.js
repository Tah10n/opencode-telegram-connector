import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCodeClient } from "../src/opencode/client.js"
import { deliverPromptExactlyOnce, promptDeliveryIdentity } from "../src/connector/prompt-delivery.js"
import { defaultState, StateStore } from "../src/state/store.js"
import { makeBoundaryError } from "../src/boundary-errors.js"

async function makeStore(t) {
  const dir = path.join(os.tmpdir(), `telegram-connector-prompt-delivery-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, JSON.stringify(defaultState()), "utf8")
  const store = new StateStore({ filePath })
  await store.load()
  t.after(async () => fs.rm(dir, { recursive: true, force: true }))
  return store
}

async function startAcceptThenDisconnectServer(t) {
  const messages = new Map()
  const posts = []
  const gets = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)
    if (req.method === "GET" && messageMatch) {
      const messageID = decodeURIComponent(messageMatch[2])
      gets.push(messageID)
      const message = messages.get(messageID)
      if (!message) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(message))
      return
    }
    if (req.method === "POST" && /\/prompt_async$/.test(url.pathname)) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      posts.push(payload)
      messages.set(payload.messageID, { info: { id: payload.messageID, role: "user" }, parts: payload.parts })
      req.socket.destroy()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  return { baseUrl: `http://127.0.0.1:${address.port}`, posts, gets, messages }
}

async function startDelayedAcceptThenDisconnectServer(t) {
  const messages = new Map()
  let posts = 0
  let gets = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)
    if (req.method === "GET" && messageMatch) {
      gets += 1
      const message = messages.get(decodeURIComponent(messageMatch[2]))
      if (!message) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(message))
      return
    }
    if (req.method === "POST" && /\/prompt_async$/.test(url.pathname)) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      posts += 1
      req.socket.destroy()
      setTimeout(() => {
        messages.set(payload.messageID, { info: { id: payload.messageID, role: "user" }, parts: payload.parts })
      }, 50).unref?.()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  return { baseUrl: `http://127.0.0.1:${address.port}`, counts: () => ({ posts, gets }) }
}

function identity(kind, updateId) {
  return promptDeliveryIdentity({
    kind,
    projectAlias: "demo",
    sessionId: "ses_1",
    chatId: 100,
    threadIdOr0: 7,
    messageId: updateId,
    updateId,
  })
}

test("accepted prompt survives a lost response and Telegram redelivery without a second POST", async (t) => {
  const mock = await startAcceptThenDisconnectServer(t)
  const store = await makeStore(t)
  const oc = new OpenCodeClient({ baseUrl: mock.baseUrl })

  for (const [index, kind] of ["text", "attachment-direct", "attachment-confirmed"].entries()) {
    const delivery = identity(kind, 101 + index)
    await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: `prompt ${kind}` }))

    const replay = await deliverPromptExactlyOnce({ store, oc, identity: delivery, text: `prompt ${kind}` })
    assert.equal(replay.accepted, true)
    assert.equal(replay.reconciled, true)
  }

  assert.equal(mock.messages.size, 3)
  assert.equal(mock.posts.length, 3)
  assert.equal(mock.gets.length, 3)
  assert.deepEqual(mock.posts.map((payload) => payload.messageID), mock.gets)
})

test("an initial reconciliation 404 waits for delayed prompt_async persistence instead of reposting", async (t) => {
  const mock = await startDelayedAcceptThenDisconnectServer(t)
  const store = await makeStore(t)
  const oc = new OpenCodeClient({ baseUrl: mock.baseUrl })
  const delivery = identity("text", 150)

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "delayed prompt" }))
  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "delayed prompt" }), (err) => {
    assert.equal(err.kind, "ambiguous_delivery")
    assert.equal(err.outcome, "retryable")
    return true
  })
  assert.equal(mock.counts().posts, 1)

  await delay(80)
  const replay = await deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "delayed prompt" })
  assert.equal(replay.reconciled, true)
  assert.equal(mock.counts().posts, 1)
  assert.equal(mock.counts().gets, 2)
})

test("definitive 400 and 404 prompt failures release durable delivery records", async (t) => {
  for (const status of [400, 404]) {
    const store = await makeStore(t)
    const oc = {
      async promptAsync() {
        throw makeBoundaryError({ source: "opencode", operation: "prompt", status, outcome: "fatal", message: `HTTP ${status}` })
      },
      async getMessage() {
        assert.fail("definitive failures must not leave a record to reconcile")
      },
    }
    const delivery = identity("text", 200 + status)
    await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "bad prompt" }))
    assert.equal(store.getPromptDelivery(delivery.key), null)
  }
})

test("a clearly unsent connect timeout retries POST while ambiguous failures reconcile first", async (t) => {
  const store = await makeStore(t)
  const delivery = identity("text", 301)
  let postCalls = 0
  let getCalls = 0
  const oc = {
    async promptAsync() {
      postCalls += 1
      if (postCalls === 1) {
        const cause = new Error("connect timeout")
        cause.code = "UND_ERR_CONNECT_TIMEOUT"
        throw cause
      }
      return null
    },
    async getMessage() {
      getCalls += 1
      return null
    },
  }

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "retry me" }))
  const replay = await deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "retry me" })

  assert.equal(replay.accepted, true)
  assert.equal(postCalls, 2)
  assert.equal(getCalls, 0)
})

test("ambiguous prompt reconciliation requires the exact expected user message", async (t) => {
  const store = await makeStore(t)
  const delivery = identity("text", 401)
  let postCalls = 0
  const oc = {
    async promptAsync() {
      postCalls += 1
      throw makeBoundaryError({ source: "opencode", operation: "prompt", status: 503, message: "response lost" })
    },
    async getMessage() {
      return {
        info: { id: delivery.openCodeMessageId, role: "user", sessionID: "ses_1" },
        parts: [{ type: "text", text: "a different prompt" }],
      }
    },
  }

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "expected prompt" }))
  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "expected prompt" }), (err) => {
    assert.equal(err.outcome, "retryable")
    assert.equal(err.kind, "ambiguous_delivery")
    return true
  })

  assert.equal(postCalls, 1)
  assert.equal(store.getPromptDelivery(delivery.key).state, "outcome_unknown")
})

test("reconciliation uses the persisted prompt fingerprint across formatting drift", async (t) => {
  const store = await makeStore(t)
  const delivery = identity("text", 404)
  let postCalls = 0
  const oc = {
    async promptAsync() {
      postCalls += 1
      throw makeBoundaryError({ source: "opencode", operation: "prompt", status: 503, message: "response lost" })
    },
    async getMessage() {
      return {
        info: { id: delivery.openCodeMessageId, role: "user", sessionID: "ses_1" },
        parts: [{ type: "text", text: "[OLD] original message" }],
      }
    },
  }

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "[OLD] original message" }))
  const replay = await deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "[NEW] original message" })

  assert.equal(replay.reconciled, true)
  assert.equal(postCalls, 1)
})

test("prompt delivery stops before POST when the durable ledger rejects a new marker", async () => {
  let postCalls = 0
  const store = {
    getPromptDelivery: () => null,
    setPromptDelivery: () => false,
    async flush() {},
  }
  const oc = {
    async promptAsync() {
      postCalls += 1
    },
  }

  await assert.rejects(
    () => deliverPromptExactlyOnce({ store, oc, identity: identity("text", 402), text: "must stay unsent" }),
    (err) => {
      assert.equal(err.source, "state")
      assert.equal(err.kind, "backpressure")
      assert.equal(err.outcome, "retryable")
      return true
    },
  )
  assert.equal(postCalls, 0)
})

test("a failed pre-POST attempt flush rolls back to pending and retries without reconciliation", async (t) => {
  const store = await makeStore(t)
  const originalFlush = store.flush.bind(store)
  let flushCalls = 0
  store.flush = async () => {
    flushCalls += 1
    if (flushCalls === 2) throw new Error("disk unavailable")
    return originalFlush()
  }
  let postCalls = 0
  let getCalls = 0
  const oc = {
    async promptAsync() {
      postCalls += 1
    },
    async getMessage() {
      getCalls += 1
      throw new Error("reconciliation must not run for an unsent prompt")
    },
  }
  const delivery = identity("text", 405)

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "send after state recovers" }), (err) => {
    assert.equal(err.source, "state")
    assert.equal(err.kind, "durability")
    return true
  })
  assert.equal(store.getPromptDelivery(delivery.key).state, "pending")
  assert.equal(postCalls, 0)

  const replay = await deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "send after state recovers" })
  assert.equal(replay.accepted, true)
  assert.equal(postCalls, 1)
  assert.equal(getCalls, 0)
})

test("repeated exact-message 404s never release an ambiguous prompt for repost", async (t) => {
  const store = await makeStore(t)
  const delivery = identity("text", 403)
  let postCalls = 0
  let getCalls = 0
  const oc = {
    async promptAsync() {
      postCalls += 1
      if (postCalls === 1) throw makeBoundaryError({ source: "opencode", operation: "prompt", status: 503, message: "response lost" })
    },
    async getMessage() {
      getCalls += 1
      throw makeBoundaryError({ source: "opencode", operation: "getMessage", status: 404, pathname: `/session/ses_1/message/${delivery.openCodeMessageId}`, message: "not found" })
    },
  }

  await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "absent prompt", now: 1_000 }))
  for (const now of [2_000, 60_000, 86_400_000]) {
    await assert.rejects(() => deliverPromptExactlyOnce({ store, oc, identity: delivery, text: "absent prompt", now }), (err) => {
      assert.equal(err.kind, "ambiguous_delivery")
      assert.equal(err.outcome, "retryable")
      return true
    })
  }

  assert.equal(postCalls, 1)
  assert.equal(getCalls, 3)
  assert.equal(store.getPromptDelivery(delivery.key).state, "outcome_unknown")
  assert.equal(store.getPromptDelivery(delivery.key).reconcileNotFoundCount, 3)
})
