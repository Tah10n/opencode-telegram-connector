import test from "node:test"
import assert from "node:assert/strict"
import { resolveSessionRoute } from "../src/session-route.js"

test("resolveSessionRoute returns direct binding when session is bound", async () => {
  const sessionIndex = {
    "demo:ses_main": { chatId: 1, threadIdOr0: 2 },
  }

  const result = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_main",
    sessionIndex,
    getSession: async () => {
      throw new Error("should not load session")
    },
    parentBySessionKey: new Map(),
  })

  assert.deepEqual(result, {
    route: { chatId: 1, threadIdOr0: 2 },
    boundSessionId: "ses_main",
  })
})

test("resolveSessionRoute inherits route from parent session", async () => {
  const sessionIndex = {
    "demo:ses_parent": { chatId: 10, threadIdOr0: 20 },
  }
  let getSessionCalls = 0

  const result = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex,
    getSession: async (sessionId) => {
      getSessionCalls += 1
      return sessionId === "ses_child" ? { parentID: "ses_parent" } : null
    },
    parentBySessionKey: new Map(),
  })

  assert.equal(getSessionCalls, 1)
  assert.deepEqual(result, {
    route: { chatId: 10, threadIdOr0: 20 },
    boundSessionId: "ses_parent",
  })
})

test("resolveSessionRoute caches parent lookups", async () => {
  const sessionIndex = {
    "demo:ses_parent": { chatId: 10, threadIdOr0: 20 },
  }
  let getSessionCalls = 0
  const parentBySessionKey = new Map()

  const getSession = async (sessionId) => {
    getSessionCalls += 1
    return sessionId === "ses_child" ? { parentID: "ses_parent" } : null
  }

  const first = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex,
    getSession,
    parentBySessionKey,
  })
  const second = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex,
    getSession,
    parentBySessionKey,
  })

  assert.equal(getSessionCalls, 1)
  assert.equal(first.boundSessionId, "ses_parent")
  assert.equal(second.boundSessionId, "ses_parent")
})

test("resolveSessionRoute does not cache transient lookup failures", async () => {
  const sessionIndex = {
    "demo:ses_parent": { chatId: 10, threadIdOr0: 20 },
  }
  let callCount = 0
  const parentBySessionKey = new Map()

  const first = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex,
    getSession: async () => {
      callCount += 1
      throw new Error("temporary failure")
    },
    parentBySessionKey,
  })
  const second = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex,
    getSession: async () => {
      callCount += 1
      return { parentID: "ses_parent" }
    },
    parentBySessionKey,
  })

  assert.equal(first, null)
  assert.equal(callCount, 2)
  assert.equal(second?.boundSessionId, "ses_parent")
})

test("resolveSessionRoute returns null when no ancestor is bound", async () => {
  const result = await resolveSessionRoute({
    projectAlias: "demo",
    sessionId: "ses_child",
    sessionIndex: {},
    getSession: async () => ({ parentID: null }),
    parentBySessionKey: new Map(),
  })

  assert.equal(result, null)
})
