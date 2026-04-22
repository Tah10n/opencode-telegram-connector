import test from "node:test"
import assert from "node:assert/strict"
import { createCommandHandlers } from "../src/connector/commands.js"
import { buildProjectsOverviewText as buildProjectsOverviewTextBase } from "../src/connector/overview.js"

function makeRuntime(overrides = {}) {
  const sent = []
  const feedCalls = []

  const storeState = overrides.storeState || { bindings: {} }
  const store = {
    getBinding: (ctxKey) => storeState.bindings?.[ctxKey] ?? null,
    get: () => storeState,
    unbind: () => false,
    ...(overrides.store || {}),
  }

  const projects = overrides.projects || {
    demo: { baseUrl: "http://127.0.0.1:4312" },
    other: { baseUrl: "http://127.0.0.1:4313" },
  }

  const runtime = {
    store,
    projects,
    ocByAlias: overrides.ocByAlias || {},
    startupSessionByProject: overrides.startupSessionByProject || {},
    config: overrides.config || {},
    logger: { info() {}, warn() {}, error() {}, ...(overrides.logger || {}) },
    platform: overrides.platform || "win32",
    tg: { editMessageText() {}, ...(overrides.tg || {}) },
    cb: { pack: (value) => value, ...(overrides.cb || {}) },
    getStartupSession: async () => null,
    openAttachWindowWindowsFn: async () => {},
    validateProject: async () => {},
    bindCtxToSession: async () => {},
    sendToThread: async (ctxMeta, text, replyMarkup) => {
      sent.push({ ctxMeta, text, replyMarkup })
    },
    parseCtxKey: (key) => {
      const match = String(key).match(/^(-?\d+):(\d+)$/)
      if (!match) return null
      return { chatId: Number(match[1]), threadIdOr0: Number(match[2]), ctxKey: key }
    },
    formatThreadLabel: (threadIdOr0) => (threadIdOr0 ? `topic ${threadIdOr0}` : "main"),
    getProjectSseStatus: (alias) => overrides.sseByAlias?.[alias] || "unknown",
    renderFeedSettings: async (ctxMeta, options) => {
      feedCalls.push({ ctxMeta, options })
    },
    feedModeLabel: (mode) => ({ main: "Main", verbose: "Verbose" }[mode] || "Main + changes"),
    getFeedMode: (ctxKey) => overrides.feedByContext?.[ctxKey] || "main+changes",
    deliverAssistantText: async () => {},
    extractAssistantDisplayText: () => "",
    lastAssistantBySession: new Map(),
    canAutoStartProject: () => false,
    isLikelyConnectError: () => false,
    startServerKeyboard: () => null,
    ensureRecentPromptSet: () => ({ add() {} }),
    hashTextForEcho: () => "hash",
    formatProjectUnavailable: (alias) => `Project '${alias}' is unavailable.`,
    buildProjectsOverviewText: ({ startupSessionByProject, formatThreadLabel, previewLimit, showBindingScopes, hiddenBindingsLabel }) =>
      buildProjectsOverviewTextBase({
        projects,
        bindings: store.get().bindings,
        startupSessionByProject,
        getProjectSseStatus: runtime.getProjectSseStatus,
        parseCtxKey: runtime.parseCtxKey,
        formatThreadLabel,
        previewLimit,
        showBindingScopes,
        hiddenBindingsLabel,
      }),
    isCommand: (text) => typeof text === "string" && text.trim().startsWith("/"),
    parseCommand: (text) => {
      const trimmed = text.trim()
      const [cmd, ...rest] = trimmed.split(/\s+/)
      return { cmd: String(cmd || "").toLowerCase().split("@")[0], args: rest.join(" ").trim(), argv: rest }
    },
    rejectNoteAwaiting: new Map(),
    awaitingCustomAnswer: new Map(),
    bindAliasAwaiting: new Map(),
    getWizard: () => null,
    cloneWizardState: (wizard) => ({ ...wizard }),
    applyWizardState() {},
    persistQuestionWizard() {},
    finishQuestionWizard: async () => {},
    sendCurrentQuestionStep: async () => {},
    setRejectNoteAwaitingState() {},
    setAwaitingCustomAnswerState() {},
    compareNumbers: (a, b) => (a === b ? 0 : a < b ? -1 : 1),
    isAllowedUser: () => true,
    ctxMetaFromMessage: (msg) => ({ chatId: msg?.chat?.id, threadIdOr0: msg?.message_thread_id || 0, ctxKey: `${msg?.chat?.id}:${msg?.message_thread_id || 0}` }),
    mirrorCompaction: false,
    ...overrides,
  }

  return { runtime, sent, feedCalls }
}

test("createCommandHandlers handleWhere renders operator status fields", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    startupSessionByProject: { demo: "ses_startup" },
    sseByAlias: { demo: "connected" },
    feedByContext: { "100:7": "verbose" },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project: demo/)
  assert.match(sent[0].text, /Session: ses_current/)
  assert.match(sent[0].text, /Startup session: ses_startup/)
  assert.match(sent[0].text, /Feed: Verbose/)
  assert.match(sent[0].text, /SSE: connected/)
})

test("createCommandHandlers handleProjects renders overview with binding counts and scope preview", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: {
        "100:0": { projectAlias: "demo", sessionId: "ses_1" },
        "100:11": { projectAlias: "demo", sessionId: "ses_2" },
        "200:0": { projectAlias: "other", sessionId: "ses_3" },
      },
    },
    startupSessionByProject: { demo: "ses_startup", other: "ses_other" },
    sseByAlias: { demo: "connected", other: "down" },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleProjects({ chatId: 100, chatType: "private", threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  const text = sent[0].text
  assert.match(text, /^Projects:/)
  assert.match(text, /- demo/)
  assert.match(text, /Startup session: ses_startup/)
  assert.match(text, /SSE: connected/)
  assert.match(text, /Bindings: 2 \(chat 100\/main, chat 100\/topic 11\)/)
  assert.match(text, /- other/)
  assert.match(text, /Bindings: 1 \(chat 200\/main\)/)
})

test("createCommandHandlers handleProjects hides binding scopes outside private chats", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: {
        "100:0": { projectAlias: "demo", sessionId: "ses_1" },
        "100:11": { projectAlias: "demo", sessionId: "ses_2" },
      },
    },
    startupSessionByProject: { demo: "ses_startup" },
    sseByAlias: { demo: "connected" },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleProjects({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  const text = sent[0].text
  assert.match(text, /^Projects:/)
  assert.match(text, /- demo/)
  assert.match(text, /Bindings: hidden outside private chat/)
  assert.doesNotMatch(text, /chat 100\/main/)
  assert.doesNotMatch(text, /chat 100\/topic 11/)
})

test("createCommandHandlers handleFeed delegates to feed renderer", async () => {
  const { runtime, feedCalls } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleFeed({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, { editMessageId: 123 })

  assert.deepEqual(feedCalls, [{ ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, options: { editMessageId: 123 } }])
})

test("createCommandHandlers handleBindings renders sorted bindings in private chat", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: {
        "100:11": { projectAlias: "demo", sessionId: "ses_topic" },
        "100:0": { projectAlias: "demo", sessionId: "ses_main" },
        "200:3": { projectAlias: "other", sessionId: "ses_other" },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindings({ chatId: 100, chatType: "private", threadIdOr0: 11, ctxKey: "100:11" })

  assert.equal(sent.length, 1)
  assert.equal(
    sent[0].text,
    [
      "Bindings:",
      "- chat 100 / main -> demo / ses_main",
      "- chat 100 / topic 11 (current) -> demo / ses_topic",
      "- chat 200 / topic 3 -> other / ses_other",
    ].join("\n"),
  )
})

test("createCommandHandlers handleAbort without binding returns guidance", async () => {
  const { runtime, sent } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleAbort({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "Not bound. Use /bind <projectAlias> first.")
})

test("createCommandHandlers clears stale awaiting custom-answer state", async () => {
  const awaitingCustomAnswer = new Map([
    ["100:7", { projectAlias: "demo", requestId: "q_stale", qIndex: 0 }],
  ])
  const cleared = []
  const { runtime, sent } = makeRuntime({
    awaitingCustomAnswer,
    getWizard: () => null,
    setAwaitingCustomAnswerState: (ctxKey, value) => {
      cleared.push({ ctxKey, value })
      if (value) awaitingCustomAnswer.set(ctxKey, value)
      else awaitingCustomAnswer.delete(ctxKey)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_thread_id: 7,
    text: "first reply",
  })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_thread_id: 7,
    text: "second reply",
  })

  assert.deepEqual(cleared, [{ ctxKey: "100:7", value: null }])
  assert.equal(awaitingCustomAnswer.has("100:7"), false)
  assert.equal(sent[0].text, "Question is no longer active.")
  assert.equal(sent[1].text, "Not bound. Use /bind <projectAlias>.")
})

test("createCommandHandlers handleBindCommand refreshes a stale startup session", async () => {
  const startupSessionByProject = { demo: "ses_stale" }
  const bindCalls = []
  const startupCalls = []
  const { runtime, sent } = makeRuntime({
    startupSessionByProject,
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          if (sessionId === "ses_stale") throw new Error("missing session")
          return { id: sessionId }
        },
        async createSession() {
          throw new Error("should not create")
        },
      },
    },
    getStartupSession: async (alias, options) => {
      startupCalls.push({ alias, options })
      if (options?.forceRefresh) {
        startupSessionByProject[alias] = "ses_fresh"
      }
      return startupSessionByProject[alias] || null
    },
    validateProject: async () => {},
    bindCtxToSession: async (ctxMeta, alias, sessionId) => {
      bindCalls.push({ ctxMeta, alias, sessionId })
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["demo"])

  assert.deepEqual(startupCalls, [{ alias: "demo", options: { waitForStart: false, forceRefresh: true } }])
  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      alias: "demo",
      sessionId: "ses_fresh",
    },
  ])
  assert.equal(startupSessionByProject.demo, "ses_fresh")
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "Bound to project 'demo' (startup session): ses_fresh")
})

test("createCommandHandlers handleProjects refreshes startup sessions without waiting for auto-start", async () => {
  const startupCalls = []
  const { runtime, sent } = makeRuntime({
    startupSessionByProject: { demo: "ses_demo", other: "ses_other" },
    getStartupSession: async (alias, options) => {
      startupCalls.push({ alias, options })
      return null
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleProjects({ chatId: 100, chatType: "private", threadIdOr0: 7, ctxKey: "100:7" })

  assert.deepEqual(startupCalls, [
    { alias: "demo", options: { waitForStart: false, forceRefresh: true } },
    { alias: "other", options: { waitForStart: false, forceRefresh: true } },
  ])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^Projects:/)
})
