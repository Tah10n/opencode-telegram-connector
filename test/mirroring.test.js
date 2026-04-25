import test from "node:test"
import assert from "node:assert/strict"
import { createMirroringHandlers } from "../src/connector/mirroring.js"
import { sessionKey } from "../src/state/store.js"

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
  const { calls, handlers } = createHarness({
    tg: {
      async editMessageText(...args) {
        calls.editMessageText.push(args)
        throw new Error("cannot edit")
      },
    },
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
  assert.match(calls.editMessageText[0][2], /\+new/)
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
  assert.match(calls.editMessageText[1][2], /\+right/)
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
  assert.equal(runtime.assistantPreviewBySession.has(sessionKey("demo", "ses_1")), false)
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
  const { calls, runtime, handlers } = createHarness({
    store: { getFeedMode: () => "verbose" },
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
  await flushAsyncWork()

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
  await flushAsyncWork()

  assert.equal(failedSendBlocks.length, 1)
  assert.match(loggerErrors[0].join(" "), /Assistant final delivery failed: demo ses_1 msg_1 telegram down/)
  const sets = runtime.forwardedBySession.get(sessionKey("demo", "ses_1"))
  assert.equal(sets.assistant.has("msg_1"), false)
})
