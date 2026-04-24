import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { ensureStartupSession } from "../src/opencode/startup-session.js"

function makeLogger() {
  return { info() {}, error() {}, warn() {}, debug() {} }
}

test("ensureStartupSession reuses latest session", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let createCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        return [{ id: "sess-latest" }]
      },
      async createSession() {
        createCalls += 1
        return { id: "sess-created" }
      },
    },
  }

  const sid = await ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias,
    logger: makeLogger(),
  })

  assert.equal(sid, "sess-latest")
  assert.equal(startupSessionByProject.demo, "sess-latest")
  assert.equal(createCalls, 0)
})

test("ensureStartupSession creates a session when none exist", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let createCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        return []
      },
      async createSession() {
        createCalls += 1
        return { id: "sess-created" }
      },
    },
  }

  const sid = await ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias,
    logger: makeLogger(),
  })

  assert.equal(sid, "sess-created")
  assert.equal(startupSessionByProject.demo, "sess-created")
  assert.equal(createCalls, 1)
})

test("ensureStartupSession does not cache invalid session ids", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let createCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        return [{ id: "bad/id" }]
      },
      async createSession() {
        createCalls += 1
        return { id: "also bad" }
      },
    },
  }

  const sid = await ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias,
    logger: makeLogger(),
  })

  assert.equal(sid, null)
  assert.equal(startupSessionByProject.demo, undefined)
  assert.equal(createCalls, 1)
})

test("ensureStartupSession deduplicates concurrent calls", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let listCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        listCalls += 1
        await delay(20)
        return [{ id: "sess-latest" }]
      },
      async createSession() {
        throw new Error("should not create")
      },
    },
  }

  const [a, b] = await Promise.all([
    ensureStartupSession({
      alias: "demo",
      startInProgress,
      startupSessionByProject,
      startupSessionInProgress,
      ocByAlias,
      logger: makeLogger(),
      waitForStart: false,
    }),
    ensureStartupSession({
      alias: "demo",
      startInProgress,
      startupSessionByProject,
      startupSessionInProgress,
      ocByAlias,
      logger: makeLogger(),
      waitForStart: false,
    }),
  ])

  assert.equal(a, "sess-latest")
  assert.equal(b, "sess-latest")
  assert.equal(listCalls, 1)
})

test("ensureStartupSession waits for start before retrying after early null result", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let ready = false
  let listCalls = 0
  let createCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        listCalls += 1
        return ready ? [{ id: "sess-ready" }] : null
      },
      async createSession() {
        createCalls += 1
        return null
      },
    },
  }

  const startPromise = (async () => {
    await delay(30)
    ready = true
  })()
  startInProgress.set("demo", startPromise)

  const early = await ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias,
    logger: makeLogger(),
    waitForStart: false,
  })
  assert.equal(early, null)

  const later = await ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias,
    logger: makeLogger(),
    waitForStart: true,
  })

  assert.equal(later, "sess-ready")
  assert.equal(startupSessionByProject.demo, "sess-ready")
  assert.equal(listCalls, 1)
  assert.equal(createCalls, 0)
})

test("ensureStartupSession does not wait for auto-start when waitForStart is false", async () => {
  const startInProgress = new Map([["demo", new Promise(() => {})]])
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let listCalls = 0
  let createCalls = 0
  const ocByAlias = {
    demo: {
      async listSessions() {
        listCalls += 1
        return [{ id: "sess-latest" }]
      },
      async createSession() {
        createCalls += 1
        return { id: "sess-created" }
      },
    },
  }

  const result = await Promise.race([
    ensureStartupSession({
      alias: "demo",
      startInProgress,
      startupSessionByProject,
      startupSessionInProgress,
      ocByAlias,
      logger: makeLogger(),
      waitForStart: false,
    }),
    delay(50).then(() => "timeout"),
  ])

  assert.equal(result, null)
  assert.equal(listCalls, 0)
  assert.equal(createCalls, 0)
})

test("ensureStartupSession aborts promptly when abortSignal cancels startup requests", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  const abortController = new AbortController()
  let createCalls = 0

  const promise = ensureStartupSession({
    alias: "demo",
    startInProgress,
    startupSessionByProject,
    startupSessionInProgress,
    ocByAlias: {
      demo: {
        async listSessions({ signal } = {}) {
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
              return
            }
            signal?.addEventListener?.(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            )
          })
        },
        async createSession({ signal } = {}) {
          createCalls += 1
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
              return
            }
            signal?.addEventListener?.(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            )
          })
        },
      },
    },
    logger: makeLogger(),
    abortSignal: abortController.signal,
  })

  abortController.abort()

  await assert.rejects(promise, (err) => {
    assert.equal(err?.name, "AbortError")
    return true
  })
  assert.equal(createCalls, 0)
})

test("ensureStartupSession does not create a replacement session when listing sessions fails", async () => {
  const startInProgress = new Map()
  const startupSessionByProject = {}
  const startupSessionInProgress = new Map()
  let createCalls = 0

  await assert.rejects(
    ensureStartupSession({
      alias: "demo",
      startInProgress,
      startupSessionByProject,
      startupSessionInProgress,
      ocByAlias: {
        demo: {
          async listSessions() {
            throw new Error("temporary failure")
          },
          async createSession() {
            createCalls += 1
            return { id: "sess-created" }
          },
        },
      },
      logger: makeLogger(),
    }),
    /temporary failure/,
  )

  assert.equal(createCalls, 0)
  assert.equal(startupSessionByProject.demo, undefined)
})
