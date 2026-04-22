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
    getModelPreference: (ctxKey) => storeState.modelPrefsByContext?.[ctxKey] ?? { mode: "inherit" },
    setModelPreference: (ctxKey, value) => {
      storeState.modelPrefsByContext ||= {}
      if (!value || value.mode === "inherit") {
        delete storeState.modelPrefsByContext[ctxKey]
        return
      }
      storeState.modelPrefsByContext[ctxKey] = value
    },
    clearModelPreference: (ctxKey) => {
      const existed = !!storeState.modelPrefsByContext?.[ctxKey]
      if (storeState.modelPrefsByContext) delete storeState.modelPrefsByContext[ctxKey]
      return existed
    },
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
    isRetryableProjectError: () => false,
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

test("createCommandHandlers handleBindings rejects non-private chats", async () => {
  const { runtime, sent } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindings({ chatId: 100, chatType: "supergroup", threadIdOr0: 11, ctxKey: "100:11" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "Use /bindings only in a private chat with the bot. Bindings contain sensitive session IDs.")
})

test("createCommandHandlers handleBindings reports when there are no bindings", async () => {
  const { runtime, sent } = makeRuntime({ storeState: { bindings: {} } })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindings({ chatId: 100, chatType: "private", threadIdOr0: 11, ctxKey: "100:11" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "No bindings.")
})

test("createCommandHandlers handleAbort without binding returns guidance", async () => {
  const { runtime, sent } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleAbort({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "Not bound. Use /bind <projectAlias> first.")
})

test("createCommandHandlers handleSessions swallows Telegram send failures for the not-bound guidance", async () => {
  const handlers = createCommandHandlers(
    makeRuntime({
      sendToThread: async () => {
        throw new Error("telegram send failed")
      },
    }).runtime,
  )

  await assert.doesNotReject(() => handlers.handleSessions({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }))
})

test("createCommandHandlers handleAbort reports when there is no active run", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async abortSession(sessionId) {
          assert.equal(sessionId, "ses_current")
          return false
        },
      },
    },
    markProjectUp() {},
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleAbort({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "No active run to abort for session: ses_current")
})

test("createCommandHandlers handleSendLast reports unknown projects and missing assistant replies", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: {
        "100:7": { projectAlias: "missing", sessionId: "ses_current" },
        "100:8": { projectAlias: "demo", sessionId: "ses_other" },
      },
    },
    ocByAlias: {
      demo: {
        async listMessages(sessionId) {
          assert.equal(sessionId, "ses_other")
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleSendLast({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })
  await handlers.handleSendLast({ chatId: 100, threadIdOr0: 8, ctxKey: "100:8" })

  assert.equal(sent[0].text, "Unknown project: missing")
  assert.equal(sent[1].text, "No assistant message yet.")
})

test("createCommandHandlers handleSendLast fetches the final assistant text when list data is incomplete", async () => {
  const delivered = []
  const lastAssistantBySession = new Map()
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async listMessages(sessionId) {
          assert.equal(sessionId, "ses_current")
          return [{ info: { id: "msg_1", role: "assistant" } }]
        },
        async getMessage(sessionId, messageId) {
          assert.equal(sessionId, "ses_current")
          assert.equal(messageId, "msg_1")
          return { info: { id: "msg_1", role: "assistant" }, text: "final text" }
        },
      },
    },
    extractAssistantDisplayText: (_projectAlias, msg) => msg?.text || "",
    deliverAssistantText: async (...args) => {
      delivered.push(args)
    },
    lastAssistantBySession,
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleSendLast({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 0)
  assert.deepEqual(delivered, [[{ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "demo", "ses_current", "msg_1", "final text"]])
  assert.deepEqual(lastAssistantBySession.get("demo:ses_current"), {
    messageId: "msg_1",
    sessionId: "ses_current",
    text: "final text",
  })
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

test("createCommandHandlers handleBindCommand validates arguments and current bindings", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, [])
  await handlers.handleBindCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["demo"])

  assert.equal(sent[0].text, "Usage: /bind <projectAlias>")
  assert.equal(sent[1].text, "Already bound: demo / ses_current")
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

test("createCommandHandlers handleUnbind reports whether a binding existed", async () => {
  let calls = 0
  const { runtime, sent } = makeRuntime({
    store: {
      unbind() {
        calls += 1
        return calls === 1
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUnbind({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })
  await handlers.handleUnbind({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent[0].text, "Unbound.")
  assert.equal(sent[1].text, "Not bound.")
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

test("createCommandHandlers handleNewCommand reports configured model and variant", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async createSession(input) {
          assert.deepEqual(input, { title: "Demo title" })
          return { id: "ses_new" }
        },
        async getConfig(input) {
          assert.deepEqual(input, { directory: undefined })
          return {
            model: "openai/gpt-5",
            default_agent: "build",
            agent: {
              build: {
                variant: "xhigh",
              },
            },
          }
        },
      },
    },
    bindCtxToSession: async (ctxMeta, alias, sessionId) => {
      bindCalls.push({ ctxMeta, alias, sessionId })
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      alias: "demo",
      sessionId: "ses_new",
    },
  ])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "Created and switched to session: ses_new\nModel: openai/gpt-5 xhigh\nSource: Inherited from project default")
})

test("createCommandHandlers renderSessionsList shows the current model when available", async () => {
  const { runtime, sent } = makeRuntime({
    startupSessionByProject: { demo: "ses_startup" },
    ocByAlias: {
      demo: {
        async listSessions() {
          return [
            { id: "ses_current", title: "Current session" },
            { id: "ses_startup", title: "Startup session" },
          ]
        },
        async listMessages(sessionId) {
          assert.equal(sessionId, "ses_current")
          return [{ info: { role: "assistant", providerID: "openai", modelID: "gpt-5", variant: "xhigh", time: { completed: "2026-01-01T00:00:00.000Z" } } }]
        },
      },
    },
    markProjectUp: () => {},
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Current: ses_current/)
  assert.match(sent[0].text, /Current model: openai\/gpt-5 xhigh \(Inherited from session history\)/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.at(-1)?.[0]?.text, "Close")
})

test("createCommandHandlers renderModelSettings shows provider selection before models", async () => {
  const editCalls = []
  const { runtime } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    tg: {
      async editMessageText(chatId, messageId, text, replyMarkup) {
        editCalls.push({ chatId, messageId, text, replyMarkup })
      },
    },
    ocByAlias: {
      demo: {
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async getConfigProviders() {
          return {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5": { id: "gpt-5", name: "GPT-5" },
                },
              },
            ],
          }
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderModelSettings({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, { editMessageId: 123 })

  assert.equal(editCalls.length, 1)
  assert.match(editCalls[0].text, /Pick a mode, then choose a provider below\./)
  const labels = editCalls[0].replyMarkup.inline_keyboard.flat().map((button) => button.text)
  assert.ok(labels.includes("Project default"))
  assert.ok(labels.includes("openai"))
  assert.ok(labels.includes("Close"))
})

test("createCommandHandlers renderModelSettings edits the message for model and variant selection", async () => {
  const editCalls = []
  const { runtime } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
      modelPrefsByContext: { "100:7": { mode: "project-default" } },
    },
    tg: {
      async editMessageText(chatId, messageId, text, replyMarkup) {
        editCalls.push({ chatId, messageId, text, replyMarkup })
      },
    },
    ocByAlias: {
      demo: {
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async getConfigProviders() {
          return {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5": { id: "gpt-5", name: "GPT-5" },
                },
              },
            ],
          }
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderModelSettings(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { editMessageId: 123, selectedProviderId: "openai", selectedModelKey: "openai/gpt-5" },
  )

  assert.equal(editCalls.length, 1)
  assert.equal(editCalls[0].chatId, 100)
  assert.equal(editCalls[0].messageId, 123)
  assert.match(editCalls[0].text, /Mode: Project default override/)
  assert.match(editCalls[0].text, /Active: openai\/gpt-5/)
  assert.match(editCalls[0].text, /Source: Thread project default override/)
  assert.match(editCalls[0].text, /Pick a variant for: openai\/gpt-5/)
  assert.match(editCalls[0].text, /Use 'No variant' to keep only provider\/model\./)
  const labels = editCalls[0].replyMarkup.inline_keyboard.flat().map((button) => button.text)
  assert.ok(labels.includes("No variant"))
  assert.ok(labels.includes("xhigh"))
  assert.ok(labels.includes("Back"))
  assert.ok(labels.includes("Close"))
})

test("createCommandHandlers handleModelCommand covers no-binding, reset, and invalid model branches", async () => {
  const storeState = {
    bindings: {},
    modelPrefsByContext: { "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" } },
  }
  const { runtime, sent } = makeRuntime({
    storeState,
    ocByAlias: {
      demo: {
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderModelSettings({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })
  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, [])

  storeState.bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_current" }

  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, [])
  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["reset"])
  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["bad-model"]) 

  assert.equal(sent[0].text, "Not bound. Use /bind <projectAlias> first.")
  assert.equal(sent[1].text, "Not bound. Use /bind <projectAlias> first.")
  assert.match(sent[2].text, /Model for this thread:/)
  assert.match(sent[3].text, /Mode: Inherit/)
  assert.equal(sent[4].text, "Usage: /model\n/model default\n/model reset\n/model <provider/model> \[variant\]")
  assert.deepEqual(storeState.modelPrefsByContext, {})
})

test("createCommandHandlers advances awaiting custom-answer wizards to the next step", async () => {
  const awaitingCustomAnswer = new Map([["100:7", { projectAlias: "demo", requestId: "q_1", qIndex: 0 }]])
  const wizard = {
    projectAlias: "demo",
    id: "q_1",
    index: 0,
    request: {
      questions: [
        { header: "First", question: "one" },
        { header: "Second", question: "two" },
      ],
    },
    answers: [[], []],
  }
  const applyCalls = []
  const persistCalls = []
  const customStateCalls = []
  const stepCalls = []
  const { runtime, sent } = makeRuntime({
    awaitingCustomAnswer,
    getWizard: () => wizard,
    applyWizardState: (target, nextWizard) => {
      applyCalls.push({ target, nextWizard })
      target.index = nextWizard.index
      target.answers = nextWizard.answers
    },
    persistQuestionWizard: (nextWizard) => {
      persistCalls.push(nextWizard)
    },
    sendCurrentQuestionStep: async (nextWizard) => {
      stepCalls.push(nextWizard)
    },
    setAwaitingCustomAnswerState: (ctxKey, value) => {
      customStateCalls.push({ ctxKey, value })
      if (value) awaitingCustomAnswer.set(ctxKey, value)
      else awaitingCustomAnswer.delete(ctxKey)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_thread_id: 7,
    text: "next answer",
  })

  assert.equal(sent.length, 0)
  assert.equal(stepCalls.length, 1)
  assert.equal(stepCalls[0].index, 1)
  assert.deepEqual(stepCalls[0].answers, [["next answer"], []])
  assert.equal(applyCalls.length, 1)
  assert.equal(persistCalls.length, 1)
  assert.deepEqual(customStateCalls, [{ ctxKey: "100:7", value: null }])
  assert.equal(awaitingCustomAnswer.has("100:7"), false)
})

test("createCommandHandlers handleModelCommand stores a custom per-thread override", async () => {
  const storeState = {
    bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    modelPrefsByContext: {},
  }
  const handlers = createCommandHandlers(
    makeRuntime({
      storeState,
      ocByAlias: {
        demo: {
          async getConfig() {
            return { model: "openai/gpt-5" }
          },
          async listMessages() {
            return []
          },
        },
      },
    }).runtime,
  )

  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["openai/gpt-5", "xhigh"])

  assert.deepEqual(storeState.modelPrefsByContext, {
    "100:7": {
      mode: "custom",
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "xhigh",
    },
  })
})

test("createCommandHandlers handleModelCommand rejects reserved second-token modes", async () => {
  const storeState = {
    bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    modelPrefsByContext: {},
  }
  const { runtime, sent } = makeRuntime({ storeState })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["openai/gpt-5", "reset"])

  assert.deepEqual(storeState.modelPrefsByContext, {})
  assert.equal(sent[0].text, "Usage: /model\n/model default\n/model reset\n/model <provider/model> [variant]")
})

test("createCommandHandlers handleModelCommand refuses project default when none is configured", async () => {
  const storeState = {
    bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    modelPrefsByContext: {},
  }
  const { runtime, sent } = makeRuntime({
    storeState,
    ocByAlias: {
      demo: {
        async getConfig() {
          return {}
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleModelCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["default"])

  assert.deepEqual(storeState.modelPrefsByContext, {})
  assert.equal(sent[0].text, "Project default model is not configured for this project.")
})

test("createCommandHandlers handleTelegramMessage forwards the custom model override", async () => {
  const promptCalls = []
  const { runtime } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
      modelPrefsByContext: {
        "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text, options) {
          promptCalls.push({ sessionId, text, options })
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_thread_id: 7,
    text: "hello model",
  })

  assert.deepEqual(promptCalls, [
    {
      sessionId: "ses_current",
      text: "[TG] hello model",
      options: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
    },
  ])
})

test("createCommandHandlers handleTelegramMessage serves help and unknown commands", async () => {
  const { runtime, sent } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/help",
  })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/wat",
  })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/cancel",
  })

  assert.match(sent[0].text, /^Commands:/)
  assert.match(sent[0].text, /\/bind <projectAlias>/)
  assert.equal(sent[1].text, "Unknown command. Use /help.")
  assert.equal(sent[2].text, "Nothing to cancel.")
})

test("createCommandHandlers handleTelegramMessage prompts for bind alias and can cancel it", async () => {
  const { runtime, sent } = makeRuntime()
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/bind",
  })
  assert.equal(runtime.bindAliasAwaiting.has("100:0"), true)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/cancel",
  })

  assert.equal(sent[0].text, "Send project alias (or /projects to list). You can /cancel.")
  assert.equal(sent[1].text, "Cancelled.")
  assert.equal(runtime.bindAliasAwaiting.has("100:0"), false)
})

test("createCommandHandlers handleTelegramMessage binds after receiving a plain-text alias", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async createSession(input) {
          assert.deepEqual(input, {})
          return { id: "ses_created" }
        },
      },
    },
    bindCtxToSession: async (ctxMeta, alias, sessionId) => {
      bindCalls.push({ ctxMeta, alias, sessionId })
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/bind",
  })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "demo extra words",
  })

  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, threadIdOr0: 0, ctxKey: "100:0" },
      alias: "demo",
      sessionId: "ses_created",
    },
  ])
  assert.equal(sent[0].text, "Send project alias (or /projects to list). You can /cancel.")
  assert.equal(sent[1].text, "Bound to project 'demo' with new session: ses_created")
  assert.equal(runtime.bindAliasAwaiting.has("100:0"), false)
})
