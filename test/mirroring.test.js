import test from "node:test"
import assert from "node:assert/strict"
import { createMirroringHandlers } from "../src/connector/mirroring.js"
import { NOISY_SKIP_REASONS } from "../src/connector/noisy-skip-reasons.js"
import { sessionKey } from "../src/state/store.js"
import { makeBoundaryError } from "../src/boundary-errors.js"

class FakeLruSet {
  constructor() {
    this.map = new Map()
  }
  has(key) {
    return this.map.has(key)
  }
  add(key) {
    this.map.set(key, true)
  }
  delete(key) {
    return this.map.delete(key)
  }
}

function useImmediateTimeouts(t) {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  const cancelled = new Set()
  let nextId = 1

  globalThis.setTimeout = (fn) => {
    const id = nextId++
    queueMicrotask(() => {
      if (!cancelled.has(id)) fn()
    })
    return id
  }
  globalThis.clearTimeout = (id) => {
    cancelled.add(id)
  }

  t.after(() => {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
  })
}

function useManualTimeouts(t) {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  const timers = new Map()
  let nextId = 1

  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++
    timers.set(id, { fn, ms })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }

  t.after(() => {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
  })

  return {
    runNext() {
      const next = timers.entries().next().value
      if (!next) return false
      const [id, timer] = next
      timers.delete(id)
      timer.fn()
      return true
    },
    pendingDelays() {
      return [...timers.values()].map((timer) => timer.ms)
    },
  }
}

function useFakeNow(t, initialNow = 1_000) {
  const previousNow = Date.now
  let now = initialNow
  Date.now = () => now
  t.after(() => {
    Date.now = previousNow
  })
  return {
    set(value) {
      now = value
    },
  }
}

async function flushAsyncWork(iterations = 8) {
  for (let i = 0; i < iterations; i += 1) await Promise.resolve()
}

function createHarness(overrides = {}) {
  const calls = {
    editMessageText: [],
    sendDocument: [],
    sendMessage: [],
    sendHtmlBlocks: [],
    sendToThread: [],
    sendBlocksToThread: [],
    logSseDebug: [],
  }

  const tg = {
    async editMessageText(...args) {
      calls.editMessageText.push(args)
      return true
    },
    async sendDocument(...args) {
      calls.sendDocument.push(args)
      return { message_id: 901 }
    },
    async sendMessage(...args) {
      calls.sendMessage.push(args)
      return { message_id: 902 }
    },
    async sendHtmlBlocks(...args) {
      calls.sendHtmlBlocks.push(args)
      return [{ message_id: 903 }]
    },
  }

  const runtime = {
    tg,
    store: { getFeedMode: () => "main+changes" },
    config: {},
    projects: { demo: { directory: "/repo" } },
    ocByAlias: {
      demo: {
        async getMessage() {
          return null
        },
      },
    },
    cb: { pack: (value) => value },
    LruSet: FakeLruSet,
    CHANGED_FILES_LIMIT: 10,
    INLINE_DIFF_TEXT_MAX_CHARS: 120,
    STREAM_PREVIEW_MAX_CHARS: 200,
    TEXT_ATTACHMENT_THRESHOLD: 20,
    forwardedBySession: new Map(),
    assistantDebounce: new Map(),
    assistantPreviewBySession: new Map(),
    recentTgPromptsBySession: new Map(),
    lastAssistantBySession: new Map(),
    async sendToThread(...args) {
      calls.sendToThread.push(args)
      return { message_id: 904 }
    },
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      return [{ message_id: 905 }]
    },
    async resolveBoundRoute(_projectAlias, sessionId) {
      return { route: { chatId: 11, threadIdOr0: 22 }, boundSessionId: sessionId }
    },
    logSseDebug(...args) {
      calls.logSseDebug.push(args)
    },
    eventStartedAfterLaunch: () => true,
    sleep: async () => {},
    abortSignal: undefined,
    clampString: (text, max) => String(text).slice(0, max),
    normalizeEpochMs: (value) => (value == null ? null : Number(value)),
    mirrorCompaction: false,
  }

  const merged = {
    ...runtime,
    ...overrides,
    tg: { ...runtime.tg, ...(overrides.tg || {}) },
    store: { ...runtime.store, ...(overrides.store || {}) },
    config: { ...runtime.config, ...(overrides.config || {}) },
    projects: { ...runtime.projects, ...(overrides.projects || {}) },
    ocByAlias: { ...runtime.ocByAlias, ...(overrides.ocByAlias || {}) },
    cb: { ...runtime.cb, ...(overrides.cb || {}) },
  }

  return { calls, runtime: merged, handlers: createMirroringHandlers(merged) }
}

test("renderChangedFilesView reports an unknown project", async () => {
  const { calls, handlers } = createHarness({ ocByAlias: {} })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "missing",
    "ses_1",
    "msg_1",
    "show",
    { editMessageId: 77 },
  )

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][0], 11)
  assert.equal(calls.editMessageText[0][1], 77)
  assert.equal(calls.editMessageText[0][2], "Unknown project: missing")
})

test("handleMessageUpdated suppresses TUI user messages unless runtime mirroring is enabled", async () => {
  const { calls, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
    ocByAlias: {
      demo: {
        async getMessage() {
          return { parts: [{ type: "text", text: "typed in tui" }] }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "user_1", role: "user", time: { completed: Date.now() } } },
  })

  assert.equal(calls.sendHtmlBlocks.length, 0)
  assert.ok(calls.logSseDebug.some((entry) => /drop=user_mirror_disabled/.test(entry[2])))
})

test("handleMessageUpdated mirrors TUI user messages independently of feed mode", async () => {
  const { calls, handlers } = createHarness({
    config: { mirrorTuiUserMessages: true },
    store: { getFeedMode: () => "main" },
    ocByAlias: {
      demo: {
        async getMessage() {
          return { parts: [{ type: "text", text: "typed in tui" }] }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "user_1", role: "user", time: { completed: Date.now() } } },
  })

  assert.equal(calls.sendHtmlBlocks.length, 1)
  assert.equal(calls.sendHtmlBlocks[0][0], 11)
  assert.equal(calls.sendHtmlBlocks[0][1].length, 1)
  assert.equal(calls.sendHtmlBlocks[0][1][0].html, "<i>User:</i>\ntyped in tui")
  assert.equal(calls.sendHtmlBlocks[0][3].message_thread_id, 22)
})

test("handleMessageUpdated still suppresses Telegram-origin user echoes when TUI mirroring is enabled", async () => {
  const { calls, handlers } = createHarness({
    config: { mirrorTuiUserMessages: true, echoFilterMode: "prefix", tgPrefix: "[TG] " },
    ocByAlias: {
      demo: {
        async getMessage() {
          return { parts: [{ type: "text", text: "[TG] from telegram" }] }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "user_echo", role: "user", time: { completed: Date.now() } } },
  })

  assert.equal(calls.sendHtmlBlocks.length, 0)
  assert.ok(calls.logSseDebug.some((entry) => /drop=user_echo/.test(entry[2])))
})

test("renderChangedFilesView reports when the changed-files update is no longer available", async () => {
  const { calls, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          throw new Error("gone")
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "show",
    { editMessageId: 88 },
  )

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][2], "Changed files update is no longer available.")
})

test("renderChangedFilesView refuses stale buttons after thread rebind", async () => {
  const { calls, handlers } = createHarness({
    store: { getBinding: () => ({ projectAlias: "demo", sessionId: "ses_other" }) },
    ocByAlias: {
      demo: {
        async getMessage() {
          throw new Error("should not fetch")
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "patch",
    { editMessageId: 88 },
  )

  assert.equal(calls.editMessageText.length, 1)
  assert.match(calls.editMessageText[0][2], /no longer valid/)
  assert.equal(calls.sendDocument.length, 0)
})

test("renderChangedFilesView refuses stale buttons after thread unbind", async () => {
  const { calls, handlers } = createHarness({
    store: { getBinding: () => null },
    ocByAlias: {
      demo: {
        async getMessage() {
          throw new Error("should not fetch")
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "patch",
    { editMessageId: 88 },
  )

  assert.equal(calls.editMessageText.length, 1)
  assert.match(calls.editMessageText[0][2], /no longer bound/)
  assert.equal(calls.sendDocument.length, 0)
})

test("deliverChangedFilesSummary falls back to sending a new message when edit fails", async () => {
  const { calls, handlers } = createHarness({
    tg: {
      async editMessageText(...args) {
        calls.editMessageText.push(args)
        throw new Error("cannot edit")
      },
    },
  })

  const result = await handlers.deliverChangedFilesSummary(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    {
      parts: [{ type: "patch", files: ["/repo/src/app.js"] }],
    },
    { replaceMessageId: 55 },
  )

  assert.deepEqual(result, { mode: "sent" })
  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.sendToThread.length, 1)
  assert.match(calls.sendToThread[0][1], /Changed files:/)
})

test("deliverAssistantText falls back to a notice message before attaching long output", async () => {
  const fallbacks = []
  const { calls, handlers } = createHarness({
    tg: {
      async editMessageText(...args) {
        calls.editMessageText.push(args)
        throw new Error("cannot edit")
      },
    },
    recordAttachmentFallback: (...args) => fallbacks.push(args),
  })

  const result = await handlers.deliverAssistantText(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "This assistant reply is definitely longer than twenty characters.",
    { replaceMessageId: 66 },
  )

  assert.deepEqual(result, { mode: "attachment" })
  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.sendToThread.length, 1)
  assert.match(calls.sendToThread[0][1], /attached as a \.txt file/)
  assert.equal(calls.sendDocument.length, 1)
  assert.equal(calls.sendDocument[0][2], "demo-ses_1-msg_1-assistant.txt")
  assert.deepEqual(fallbacks, [["demo", "assistant-long-output"]])
})

test("renderChangedFilesView sends full patch export as a .patch document", async () => {
  const { calls, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            parts: [{ type: "patch", files: ["/repo/src/app.js"], diff: "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new" }],
          }
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "patch",
    { editMessageId: 77 },
  )

  assert.equal(calls.sendDocument.length, 1)
  assert.equal(calls.sendDocument[0][2], "demo-ses_1-msg_1-changed-files.patch")
  assert.match(calls.sendDocument[0][1], /diff --git/)
  assert.match(calls.sendDocument[0][3], /Changed files diff/)
})

test("renderChangedFilesView loads current opencode diffs from parent user summary", async () => {
  const fetched = []
  const { calls, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage(_sessionId, messageId) {
          fetched.push(messageId)
          if (messageId === "msg_1") {
            return {
              info: { id: "msg_1", role: "assistant", parentID: "user_1" },
              parts: [{ type: "patch", hash: "abc", files: ["/repo/src/app.js"] }],
            }
          }
          if (messageId === "user_1") {
            return {
              info: {
                id: "user_1",
                role: "user",
                summary: {
                  diffs: [
                    {
                      file: "src/app.js",
                      patch: "Index: src/app.js\n--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-old\n+new",
                    },
                  ],
                },
              },
              parts: [],
            }
          }
          return null
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "show",
    { editMessageId: 77 },
  )

  assert.deepEqual(fetched, ["msg_1", "user_1"])
  assert.equal(calls.editMessageText.length, 1)
  assert.match(calls.editMessageText[0][2], /Changed files diff/)
  assert.match(calls.editMessageText[0][2], /🔴 -old/)
  assert.match(calls.editMessageText[0][2], /🟢 \+new/)
  assert.deepEqual(calls.editMessageText[0][4], {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  })
})

test("renderChangedFilesView suppresses duplicate changed-files exports", async () => {
  const sentKeys = new Set()
  const { calls, handlers } = createHarness({
    store: {
      hasIdempotencyKey: (key) => sentKeys.has(key),
      markIdempotencyKey: (key) => {
        sentKeys.add(key)
        return true
      },
      flush: async () => {},
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return { parts: [{ type: "patch", files: ["/repo/src/app.js"], diff: "diff --git a/src/app.js b/src/app.js\n+new" }] }
        },
      },
    },
  })

  const ctxMeta = { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" }
  await handlers.renderChangedFilesView(ctxMeta, "demo", "ses_1", "msg_1", "patch", { editMessageId: 77 })
  await handlers.renderChangedFilesView(ctxMeta, "demo", "ses_1", "msg_1", "patch", { editMessageId: 77 })

  assert.equal(calls.sendDocument.length, 1)
})

test("renderChangedFilesView shows and exports selected file diffs", async () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.js b/src/b.js",
    "--- a/src/b.js",
    "+++ b/src/b.js",
    "@@ -2 +2 @@",
    "-left",
    "+right",
  ].join("\n")
  const { calls, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          return { parts: [{ type: "patch", diff }] }
        },
      },
    },
  })

  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "files",
    { editMessageId: 77 },
  )
  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "file",
    { editMessageId: 77, actionArg: "1" },
  )
  await handlers.renderChangedFilesView(
    { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
    "demo",
    "ses_1",
    "msg_1",
    "filepatch",
    { editMessageId: 77, actionArg: "1" },
  )

  assert.match(calls.editMessageText[0][2], /Changed file diffs:/)
  assert.match(calls.editMessageText[1][2], /src\/b\.js/)
  assert.match(calls.editMessageText[1][2], /🔴 -left/)
  assert.match(calls.editMessageText[1][2], /🟢 \+right/)
  assert.deepEqual(calls.editMessageText[1][4], {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  })
  assert.equal(calls.sendDocument.length, 1)
  assert.match(calls.sendDocument[0][2], /file-diff-b\.js\.patch$/)
})

test("handleMessageUpdated drops assistant events when there is no bound route", async () => {
  const { calls, handlers } = createHarness({
    resolveBoundRoute: async () => null,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant" } },
  })

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendMessage.length, 0)
  assert.equal(calls.logSseDebug.at(-1)?.[2], "drop=no_route")
})

test("handleMessagePartUpdated mirrors tool actions only in verbose feed", async () => {
  const noisy = []
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
    recordNoisyEventSkipped: (...args) => noisy.push(args),
  })
  const runningPart = {
    id: "part_1",
    callID: "call_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: "read_file",
    state: { status: "running", title: "Read project file", time: { start: Date.now() } },
  }

  await handlers.handleMessagePartUpdated({ projectAlias: "demo", props: { part: runningPart } })
  await handlers.handleMessagePartUpdated({ projectAlias: "demo", props: { part: runningPart } })

  assert.equal(calls.sendToThread.length, 1)
  assert.equal(calls.sendToThread[0][0].chatId, 11)
  assert.equal(calls.sendToThread[0][0].threadIdOr0, 22)
  assert.match(calls.sendToThread[0][1], /^🛠 Agent action\nRunning: Read project file\nTool: read_file$/)
  assert.deepEqual(calls.sendToThread[0][3], { disable_web_page_preview: true })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: {
        ...runningPart,
        state: { status: "completed", title: "Read project file", time: { start: Date.now(), end: Date.now() } },
      },
    },
  })

  assert.equal(calls.sendToThread.length, 2)
  assert.match(calls.sendToThread[1][1], /^✅ Agent action\nDone: Read project file\nTool: read_file$/)
  assert.deepEqual(noisy, [])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.actions.map.size, 2)
})

test("handleMessagePartUpdated suppresses tool actions outside verbose feed", async () => {
  const noisy = []
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
    recordNoisyEventSkipped: (...args) => noisy.push(args),
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: {
        id: "part_1",
        messageID: "msg_1",
        type: "tool",
        tool: "bash",
        state: { status: "running", title: "Run tests" },
      },
    },
  })

  assert.equal(calls.sendToThread.length, 0)
  assert.deepEqual(noisy, [["demo", NOISY_SKIP_REASONS.AGENT_ACTION_FEED_FILTERED]])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.actions.map.size, 1)
})

test("handleMessagePartUpdated sends agent stop notice for tool errors outside verbose feed", async (t) => {
  const timers = useManualTimeouts(t)
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
    ocByAlias: {
      demo: {
        async getMessage() {
          return { info: { id: "msg_1", role: "assistant", error: "boom token=123456789:replace_me; DB_PASSWORD=hunter2; OPENAI_API_KEY=sk-test; Authorization: Bearer supersecret" } }
        },
      },
    },
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: {
        id: "part_1",
        messageID: "msg_1",
        type: "tool",
        tool: "bash",
        state: {
          status: "error",
          title: "Run tests token=abc123",
          error: "Authorization: Bearer replace_me",
        },
      },
    },
  })

  assert.equal(calls.sendToThread.length, 0)
  assert.deepEqual(timers.pendingDelays(), [5000])

  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendToThread.length, 1)
  assert.deepEqual(calls.sendToThread[0][0], { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" })
  assert.match(calls.sendToThread[0][1], /Agent stopped due to error/)
  assert.match(calls.sendToThread[0][1], /Assistant reply failed/)
  assert.match(calls.sendToThread[0][1], /boom/)
  assert.doesNotMatch(calls.sendToThread[0][1], /123456789|replace_me|hunter2|sk-test|supersecret/)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.agentStopErrors.has("msg_1"), true)
})

test("handleMessagePartUpdated does not flush unconfirmed tool errors as stop notices", async (t) => {
  const timers = useManualTimeouts(t)
  const { calls, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "part_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "error", title: "Run tests" } },
    },
  })
  assert.deepEqual(timers.pendingDelays(), [5000])

  await handlers.flushPendingAssistantDeliveries()

  assert.equal(calls.sendToThread.length, 0)
  assert.equal(timers.runNext(), false)
  assert.ok(calls.logSseDebug.some((entry) => entry[2] === "drop=agent_stop_error_unconfirmed key=msg_1"))
})

test("handleMessageUpdated cancels pending tool-error stop notice on successful completion", async (t) => {
  const timers = useManualTimeouts(t)
  const { calls, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Recovered" }],
          }
        },
      },
    },
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "part_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "error", title: "Run tests" } },
    },
  })
  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })

  assert.deepEqual(timers.pendingDelays(), [250])
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendToThread.length, 0)
  assert.equal(calls.sendBlocksToThread.length, 1)
  assert.doesNotMatch(calls.sendBlocksToThread[0][1]?.[0]?.html || "", /Agent stopped due to error/)
})

test("handleMessageUpdated replaces pending tool-error stop notice with assistant error", async (t) => {
  const timers = useManualTimeouts(t)
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "part_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "error", title: "Run tests" } },
    },
  })
  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  assert.equal(calls.sendToThread.length, 1)
  assert.match(calls.sendToThread[0][1], /Assistant reply failed/)
  assert.equal(runtime.forwardedBySession.get(sessionKey("demo", "ses_1")).agentStopErrors.has("msg_1"), true)
  assert.equal(timers.runNext(), false)
})

test("handleMessagePartUpdated routes child-session tool stop notices through the parent binding", async (t) => {
  const timers = useManualTimeouts(t)
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "main+changes" },
    async resolveBoundRoute(_projectAlias, sessionId) {
      if (sessionId === "ses_child") return { route: { chatId: 11, threadIdOr0: 22 }, boundSessionId: "ses_parent" }
      return null
    },
    ocByAlias: {
      demo: {
        async getMessage(sessionId) {
          assert.equal(sessionId, "ses_child")
          return { info: { id: "msg_1", role: "assistant", error: "child boom" } }
        },
      },
    },
  })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_child",
      part: { id: "part_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "error", title: "Run tests" } },
    },
  })
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendToThread.length, 1)
  assert.deepEqual(calls.sendToThread[0][0], { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" })
  assert.match(calls.sendToThread[0][1], /child boom/)
  assert.equal(runtime.forwardedBySession.get(sessionKey("demo", "ses_child")).agentStopErrors.has("msg_1"), true)
  assert.ok(calls.logSseDebug.some((entry) => entry[2] === "drop=agent_action_child bound=ses_parent"))
})

test("handleMessageUpdated routes child-session assistant errors through the parent binding", async () => {
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(_projectAlias, sessionId) {
      if (sessionId === "ses_child") return { route: { chatId: 11, threadIdOr0: 22 }, boundSessionId: "ses_parent" }
      return null
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_child", info: { id: "msg_1", role: "assistant", error: "child boom" } },
  })

  assert.equal(calls.sendToThread.length, 1)
  assert.deepEqual(calls.sendToThread[0][0], { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" })
  assert.match(calls.sendToThread[0][1], /child boom/)
  assert.equal(runtime.forwardedBySession.get(sessionKey("demo", "ses_child")).agentStopErrors.has("msg_1"), true)
})

test("handleMessagePartUpdated deduplicates using properties message ids when tool part ids are missing", async () => {
  const { calls, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
  })
  const part = {
    type: "tool",
    tool: "bash",
    state: { status: "running", title: "Run checks" },
  }

  await handlers.handleMessagePartUpdated({ projectAlias: "demo", props: { sessionID: "ses_1", messageID: "msg_1", time: 100, part } })
  await handlers.handleMessagePartUpdated({ projectAlias: "demo", props: { sessionID: "ses_1", messageID: "msg_1", time: 200, part } })
  await handlers.handleMessagePartUpdated({ projectAlias: "demo", props: { sessionID: "ses_1", messageID: "msg_2", time: 300, part } })

  assert.equal(calls.sendToThread.length, 2)
  assert.match(calls.sendToThread[0][1], /Running: Run checks/)
  assert.match(calls.sendToThread[1][1], /Running: Run checks/)
})

test("agent activity tracking keeps overlapping running messages isolated", async (t) => {
  useImmediateTimeouts(t)
  const { handlers } = createHarness({ store: { getFeedMode: () => "verbose" } })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "First tool" } },
    },
  })
  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_2", messageID: "msg_2", type: "tool", tool: "bash", state: { status: "running", title: "Second tool" } },
    },
  })

  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "running")

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork()

  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "running")
})

test("agent activity tracking ignores late running updates after completion", async (t) => {
  useImmediateTimeouts(t)
  const { handlers } = createHarness({ store: { getFeedMode: () => "verbose" } })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "Run checks" } },
    },
  })
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "running")

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork()
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "not-running")
  assert.deepEqual(handlers.getAgentActivityStatus("demo", "ses_1").endedMessageIds, ["msg_1"])

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_late", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "Late tool" } },
    },
  })
  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { updated: 2 } } },
  })

  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "not-running")
})

test("agent activity tracking ignores late running updates after abort but allows newer runs without timestamps", async (t) => {
  const clock = useFakeNow(t, 1_000)
  const { handlers } = createHarness({ store: { getFeedMode: () => "verbose" } })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      time: 900,
      part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "Run checks" } },
    },
  })
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "running")

  handlers.clearAgentActivity("demo", "ses_1")
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "not-running")

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      time: 900,
      part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "Late tool" } },
    },
  })
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "not-running")

  clock.set(2_000)
  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_2", messageID: "msg_2", type: "tool", tool: "bash", state: { status: "running", title: "New run" } },
    },
  })
  assert.equal(handlers.getAgentActivityStatus("demo", "ses_1").state, "running")
})

test("agent activity tombstones expire during later status checks", async (t) => {
  const clock = useFakeNow(t, 1_000)
  const { handlers } = createHarness({ store: { getFeedMode: () => "verbose" } })

  await handlers.handleMessagePartUpdated({
    projectAlias: "demo",
    props: {
      sessionID: "ses_1",
      part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "running", title: "Run checks" } },
    },
  })
  handlers.clearAgentActivity("demo", "ses_1")
  assert.deepEqual(handlers.getAgentActivityStatus("demo", "ses_1").endedMessageIds, ["msg_1"])
  assert.deepEqual(handlers.getAgentActivityStatus("demo", "ses_1").endedToolMessageIds, ["msg_1"])

  clock.set(1_000 + 31 * 60 * 1_000)
  const status = handlers.getAgentActivityStatus("demo", "ses_1")
  assert.equal(status.state, "not-running")
  assert.deepEqual(status.endedMessageIds || [], [])
  assert.deepEqual(status.endedToolMessageIds || [], [])
})

test("formatAgentActionText redacts sensitive tool details", () => {
  const { handlers } = createHarness()

  const text = handlers.formatAgentActionText({
    id: "part_1",
    messageID: "msg_1",
    type: "tool",
    tool: "fetch",
    state: {
      status: "error",
      title: "GET https://user:pass@example.test/path?token=abc#frag",
      error: "Authorization: Bearer supersecret token=123456789:replace_me",
    },
  })

  assert.match(text, /^⚠️ Agent action\nFailed:/)
  assert.match(text, /https:\/\/\*\*\*:\*\*\*@example\.test\/path\?token=\*\*\*/)
  assert.doesNotMatch(text, /user:pass|token=abc|Bearer supersecret|replace_me/)
})

test("handleMessageUpdated clears an existing assistant preview when the reply fails", async () => {
  const { calls, runtime, handlers } = createHarness()
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 77,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][1], 77)
  assert.match(calls.editMessageText[0][2], /Assistant reply failed\./)
  assert.match(calls.editMessageText[0][2], /boom/)
  assert.equal(calls.sendToThread.length, 0)
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
})

test("handleMessageUpdated sends assistant error notification when no preview exists", async () => {
  const { calls, handlers } = createHarness()

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendToThread.length, 1)
  assert.deepEqual(calls.sendToThread[0][0], { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" })
  assert.match(calls.sendToThread[0][1], /Assistant reply failed\./)
  assert.match(calls.sendToThread[0][1], /boom/)
})

test("handleMessageUpdated deduplicates repeated assistant error notifications", async () => {
  const { calls, handlers } = createHarness()
  const update = {
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  }

  await handlers.handleMessageUpdated(update)
  await handlers.handleMessageUpdated(update)

  assert.equal(calls.sendToThread.length, 1)
  assert.ok(calls.logSseDebug.some((entry) => entry[2] === "drop=agent_stop_error_already_forwarded key=msg_1"))
})

test("handleMessageUpdated falls back to a new assistant error notification when preview edit fails", async () => {
  const { calls, runtime, handlers } = createHarness({
    tg: {
      async editMessageText(...args) {
        calls.editMessageText.push(args)
        throw new Error("message not found")
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 77,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.sendToThread.length, 1)
  assert.match(calls.sendToThread[0][1], /Assistant reply failed\./)
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
})

test("handleMessageUpdated sends a new assistant error notification when preview route changed", async () => {
  const { calls, runtime, handlers } = createHarness()
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 77,
    routeCtx: { chatId: 99, threadIdOr0: 0, ctxKey: "99:0" },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendToThread.length, 1)
  assert.deepEqual(calls.sendToThread[0][0], { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" })
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
})

test("handleMessageUpdated retries assistant error notification after transient send failure", async (t) => {
  const timers = useManualTimeouts(t)
  let sendAttempts = 0
  const { calls, runtime, handlers } = createHarness({
    async sendToThread(...args) {
      calls.sendToThread.push(args)
      sendAttempts += 1
      if (sendAttempts === 1) {
        throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 429, message: "rate limited" })
      }
      return { message_id: 904 }
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", error: "boom" } },
  })

  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(calls.sendToThread.length, 1)
  assert.equal(sets.assistantErrors.has("msg_1"), false)
  assert.deepEqual(timers.pendingDelays(), [500])

  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendToThread.length, 2)
  assert.equal(sets.assistantErrors.has("msg_1"), true)
  assert.ok(calls.logSseDebug.some((entry) => /retry=agent_stop_error_delivery key=msg_1/.test(entry[2])))
})

test("handleMessageUpdated edits an existing assistant preview in verbose mode", async () => {
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant" },
            parts: [{ type: "text", text: "Hello <world>" }],
          }
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 77,
    lastPreviewHtml: "old",
    lastPreviewAt: 0,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant" } },
  })

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][0], 11)
  assert.equal(calls.editMessageText[0][1], 77)
  assert.match(calls.editMessageText[0][2], /Hello &lt;world&gt;/)
  assert.doesNotMatch(calls.editMessageText[0][2], /Streaming reply/)
  assert.deepEqual(calls.editMessageText[0][4], {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  })
  const preview = runtime.assistantPreviewBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(preview.telegramMessageId, 77)
  assert.match(preview.lastPreviewHtml, /Hello &lt;world&gt;/)
  assert.equal(typeof preview.lastPreviewAt, "number")
})

test("handleMessageUpdated suppresses empty assistant previews in verbose mode", async () => {
  const noisy = []
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
    recordNoisyEventSkipped: (...args) => noisy.push(args),
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant" },
            parts: [{ type: "text", text: "   " }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant" } },
  })

  assert.equal(calls.sendMessage.length, 0)
  assert.equal(calls.editMessageText.length, 0)
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
  assert.equal(calls.logSseDebug.at(-1)?.[2], "drop=assistant_preview_empty msg=msg_1")
  assert.deepEqual(noisy, [["demo", NOISY_SKIP_REASONS.ASSISTANT_PREVIEW_EMPTY]])
})

test("handleMessageUpdated keeps the preview message when final assistant content cannot be fetched", async (t) => {
  useImmediateTimeouts(t)
  let fetchCalls = 0
  const { calls, runtime, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          fetchCalls += 1
          return null
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 81,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(16)

  assert.equal(fetchCalls, 3)
  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][1], 81)
  assert.match(calls.editMessageText[0][2], /Use \/sendlast to retry\./)
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), true)
})

test("handleMessageUpdated reports when the completed assistant reply has no visible Telegram content", async (t) => {
  useImmediateTimeouts(t)
  const { calls, runtime, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          return { info: { id: "msg_1", role: "assistant" }, parts: [] }
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 82,
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork()

  assert.equal(calls.editMessageText.length, 1)
  assert.equal(calls.editMessageText[0][1], 82)
  assert.match(calls.editMessageText[0][2], /no Telegram-visible content/)
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated records mirrored final assistant replies", async (t) => {
  useImmediateTimeouts(t)
  const mirrored = []
  const { calls, runtime, handlers } = createHarness({
    recordAssistantMirrored: (...args) => mirrored.push(args),
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final answer" }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork()

  assert.equal(calls.sendBlocksToThread.length, 1)
  assert.deepEqual(mirrored, [["demo"]])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated drops final assistant delivery when unbound before debounce fires", async (t) => {
  const timers = useManualTimeouts(t)
  let binding = { projectAlias: "demo", sessionId: "ses_1", route: { chatId: 11, threadIdOr0: 22 } }
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(projectAlias, sessionId) {
      if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
      return { route: binding.route, boundSessionId: sessionId }
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final answer" }],
          }
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 81,
    routeCtx: { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  binding = null
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendBlocksToThread.length, 0)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), false)
  assert.ok(calls.logSseDebug.some((entry) => entry[2] === "drop=assistant_no_route msg=msg_1"))
})

test("handleMessageUpdated drops final assistant delivery when rebound to a different session before debounce fires", async (t) => {
  const timers = useManualTimeouts(t)
  let binding = { projectAlias: "demo", sessionId: "ses_1", route: { chatId: 11, threadIdOr0: 22 } }
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(projectAlias, sessionId) {
      if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
      return { route: binding.route, boundSessionId: sessionId }
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final answer" }],
          }
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 82,
    routeCtx: { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  binding = { projectAlias: "demo", sessionId: "ses_2", route: { chatId: 33, threadIdOr0: 44 } }
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendBlocksToThread.length, 0)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), false)
  assert.ok(calls.logSseDebug.some((entry) => entry[2] === "drop=assistant_no_route msg=msg_1"))
})

test("handleMessageUpdated sends final assistant delivery to current route without editing stale preview", async (t) => {
  const timers = useManualTimeouts(t)
  let binding = { projectAlias: "demo", sessionId: "ses_1", route: { chatId: 11, threadIdOr0: 22 } }
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(projectAlias, sessionId) {
      if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
      return { route: binding.route, boundSessionId: sessionId }
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final answer" }],
          }
        },
      },
    },
  })
  runtime.assistantPreviewBySession.set(sessionKey("demo", "ses_1"), {
    messageId: "msg_1",
    telegramMessageId: 83,
    routeCtx: { chatId: 11, threadIdOr0: 22, ctxKey: "11:22" },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  binding = { projectAlias: "demo", sessionId: "ses_1", route: { chatId: 33, threadIdOr0: 44 } }
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.editMessageText.length, 0)
  assert.equal(calls.sendBlocksToThread.length, 1)
  assert.equal(calls.sendBlocksToThread[0][0].chatId, 33)
  assert.equal(calls.sendBlocksToThread[0][0].threadIdOr0, 44)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated sends changed-files card in main+changes when patch files are inferred from diff", async (t) => {
  useImmediateTimeouts(t)
  const { calls, runtime, handlers } = createHarness({
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [
              { type: "text", text: "Final answer" },
              {
                type: "patch",
                diff: [
                  "diff --git a/src/app.js b/src/app.js",
                  "--- a/src/app.js",
                  "+++ b/src/app.js",
                  "@@ -1 +1 @@",
                  "-old",
                  "+new",
                ].join("\n"),
              },
            ],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(16)

  assert.equal(calls.sendBlocksToThread.length, 1)
  assert.equal(calls.sendToThread.length, 1)
  assert.match(calls.sendToThread[0][1], /Changed files:/)
  assert.match(calls.sendToThread[0][1], /src\/app\.js/)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.changes.has("msg_1"), true)
})

test("handleMessageUpdated retries retryable route lookups before final delivery", async (t) => {
  useImmediateTimeouts(t)
  let routeCalls = 0
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(_projectAlias, sessionId) {
      routeCalls += 1
      if (routeCalls === 1) {
        throw makeBoundaryError({ source: "opencode", operation: "GET /session/ses_1", status: 503, message: "session lookup unavailable" })
      }
      return { route: { chatId: 11, threadIdOr0: 22 }, boundSessionId: sessionId }
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final" }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork()

  assert.equal(routeCalls, 3)
  assert.equal(calls.sendBlocksToThread.length, 1)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated retries retryable final assistant delivery failures", async (t) => {
  useImmediateTimeouts(t)
  const mirrored = []
  const loggerErrors = []
  let sendAttempts = 0
  const { calls, runtime, handlers } = createHarness({
    recordAssistantMirrored: (...args) => mirrored.push(args),
    logger: {
      error(...args) {
        loggerErrors.push(args)
      },
    },
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      sendAttempts += 1
      if (sendAttempts === 1) {
        throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 429, message: "rate limited" })
      }
      return [{ message_id: 905 }]
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final" }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(20)

  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.deepEqual(mirrored, [["demo"]])
  assert.deepEqual(loggerErrors, [])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated honors retry_after for final assistant delivery retries", async (t) => {
  const timers = useManualTimeouts(t)
  let sendAttempts = 0
  const { calls, runtime, handlers } = createHarness({
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      sendAttempts += 1
      if (sendAttempts === 1) {
        throw makeBoundaryError({
          source: "telegram",
          operation: "sendMessage",
          status: 429,
          message: "rate limited",
          retryAfterMs: 42_000,
        })
      }
      return [{ message_id: 905 }]
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final" }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  assert.deepEqual(timers.pendingDelays(), [250])

  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendBlocksToThread.length, 1)
  assert.deepEqual(timers.pendingDelays(), [42_000])

  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.deepEqual(timers.pendingDelays(), [])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated resends assistant text when retry route changes", async (t) => {
  useImmediateTimeouts(t)
  let currentRoute = { chatId: 11, threadIdOr0: 22 }
  let changedFilesAttempts = 0
  const { calls, runtime, handlers } = createHarness({
    async resolveBoundRoute(_projectAlias, sessionId) {
      return { route: currentRoute, boundSessionId: sessionId }
    },
    async sendToThread(...args) {
      calls.sendToThread.push(args)
      changedFilesAttempts += 1
      if (changedFilesAttempts === 1) {
        currentRoute = { chatId: 33, threadIdOr0: 44 }
        throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 429, message: "rate limited" })
      }
      return { message_id: 904 }
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [
              { type: "text", text: "Final answer" },
              {
                type: "patch",
                diff: [
                  "diff --git a/src/app.js b/src/app.js",
                  "--- a/src/app.js",
                  "+++ b/src/app.js",
                  "@@ -1 +1 @@",
                  "-old",
                  "+new",
                ].join("\n"),
              },
            ],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(24)

  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.equal(calls.sendBlocksToThread[0][0].chatId, 11)
  assert.equal(calls.sendBlocksToThread[1][0].chatId, 33)
  assert.equal(calls.sendToThread.length, 2)
  assert.equal(calls.sendToThread[1][0].chatId, 33)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated resumes multi-block assistant delivery without resending completed blocks", async (t) => {
  useImmediateTimeouts(t)
  let sendAttempts = 0
  const finalText = Array.from({ length: 700 }, (_, index) => `line-${index}`).join("\n")
  const { calls, runtime, handlers } = createHarness({
    TEXT_ATTACHMENT_THRESHOLD: 10_000,
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        sendAttempts += 1
        if (sendAttempts === 2) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 429, message: "rate limited" })
        }
        return { message_id: 900 + sendAttempts }
      },
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: finalText }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(40)

  assert.ok(calls.sendMessage.length >= 3)
  assert.equal(calls.sendMessage.filter((args) => args[1] === calls.sendMessage[0][1]).length, 1)
  assert.notEqual(calls.sendMessage[0][1], calls.sendMessage[2][1])
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated keeps multi-block retry progress across duplicate final events", async (t) => {
  const timers = useManualTimeouts(t)
  let sendAttempts = 0
  const finalText = Array.from({ length: 700 }, (_, index) => `line-${index}`).join("\n")
  const { calls, runtime, handlers } = createHarness({
    TEXT_ATTACHMENT_THRESHOLD: 10_000,
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        sendAttempts += 1
        if (sendAttempts === 2) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 429, message: "rate limited" })
        }
        return { message_id: 900 + sendAttempts }
      },
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: finalText }],
          }
        },
      },
    },
  })
  const event = {
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  }

  await handlers.handleMessageUpdated(event)
  assert.deepEqual(timers.pendingDelays(), [250])
  timers.runNext()
  await flushAsyncWork(20)
  assert.deepEqual(timers.pendingDelays(), [500])

  await handlers.handleMessageUpdated(event)
  assert.deepEqual(timers.pendingDelays(), [500])
  timers.runNext()
  await flushAsyncWork(20)

  assert.equal(calls.sendMessage.filter((args) => args[1] === calls.sendMessage[0][1]).length, 1)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated ignores duplicate final events while assistant delivery is in flight", async (t) => {
  const timers = useManualTimeouts(t)
  let sendAttempts = 0
  let resolveSecondSend = () => {}
  const secondSendStarted = new Promise((resolve) => {
    resolveSecondSend = resolve
  })
  let releaseSecondSend = () => {}
  const secondSendRelease = new Promise((resolve) => {
    releaseSecondSend = resolve
  })
  const finalText = Array.from({ length: 700 }, (_, index) => `line-${index}`).join("\n")
  const { calls, runtime, handlers } = createHarness({
    TEXT_ATTACHMENT_THRESHOLD: 10_000,
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        sendAttempts += 1
        if (sendAttempts === 2) {
          resolveSecondSend()
          await secondSendRelease
        }
        return { message_id: 900 + sendAttempts }
      },
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: finalText }],
          }
        },
      },
    },
  })
  const event = {
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  }

  await handlers.handleMessageUpdated(event)
  timers.runNext()
  await secondSendStarted

  await handlers.handleMessageUpdated(event)
  assert.deepEqual(timers.pendingDelays(), [])

  releaseSecondSend()
  await flushAsyncWork(20)

  assert.equal(calls.sendMessage.filter((args) => args[1] === calls.sendMessage[0][1]).length, 1)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), true)
})

test("handleMessageUpdated logs final assistant delivery failures without marking the reply forwarded", async (t) => {
  useImmediateTimeouts(t)
  const loggerErrors = []
  const failedSendBlocks = []
  const { runtime, handlers } = createHarness({
    logger: {
      error(...args) {
        loggerErrors.push(args)
      },
    },
    async sendBlocksToThread(...args) {
      failedSendBlocks.push(args)
      throw new Error("telegram down")
    },
    ocByAlias: {
      demo: {
        async getMessage() {
          return {
            info: { id: "msg_1", role: "assistant", time: { completed: 1 } },
            parts: [{ type: "text", text: "Final" }],
          }
        },
      },
    },
  })

  await handlers.handleMessageUpdated({
    projectAlias: "demo",
    props: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant", time: { completed: 1 } } },
  })
  await flushAsyncWork(16)

  assert.equal(failedSendBlocks.length, 1)
  assert.match(loggerErrors[0].join(" "), /Assistant final delivery failed: demo ses_1 msg_1 telegram down/)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), false)
})
