import test from "node:test"
import assert from "node:assert/strict"
import { makeBoundaryError } from "../src/boundary-errors.js"
import { createCommandHandlers } from "../src/connector/commands.js"
import {
  hashIdempotencyValue,
  permissionNoteIdempotencyKey,
  promptScopedSubmissionIdempotencyKey,
  promptSubmissionIdempotencyKey,
  telegramMessageIdempotencyKey,
} from "../src/connector/idempotency.js"
import { buildProjectsOverviewText as buildProjectsOverviewTextBase } from "../src/connector/overview.js"
import { USER_ATTACHMENT_LIMITS } from "../src/connector/incoming-attachments.js"
import { decodeCallbackData } from "../src/connector/callback-data.js"

function callbackParts(data) {
  const parts = decodeCallbackData(data)
  assert.ok(parts, `Expected decodable callback data: ${data}`)
  return parts
}

function attachmentTokenFromButton(button) {
  const parts = callbackParts(button.callback_data)
  assert.equal(parts[0], "att")
  assert.equal(parts[1], "send")
  return parts[2]
}

function expectAmbiguousPromptFailure(err, cause) {
  assert.equal(err?.kind, "ambiguous_delivery")
  assert.equal(err?.outcome, "retryable")
  if (cause) assert.equal(err.cause, cause)
  return true
}

function makeRuntime(overrides = {}) {
  const { store: storeOverrides, ...runtimeOverrides } = overrides
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
    ...(storeOverrides || {}),
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
    feedModeLabel: (mode, locale = "en") => {
      if (locale === "ru") return { main: "Основное", verbose: "Подробно" }[mode] || "Основное + изменения"
      return { main: "Main", verbose: "Verbose" }[mode] || "Main + changes"
    },
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
    markProjectUp() {},
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
    ...runtimeOverrides,
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
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() { return [] },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project: demo/)
  assert.match(sent[0].text, /Session: ses_current/)
  assert.match(sent[0].text, /Startup session: ses_startup/)
  assert.match(sent[0].text, /Feed: Verbose/)
  assert.match(sent[0].text, /Agent: not running/)
  assert.match(sent[0].text, /SSE: connected/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Sessions", "New", "Feed", "Model", "Unbind", "Close"])
})

test("createCommandHandlers handleWhere keeps local running state when message listing lags", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() { return [] },
      },
    },
    getAgentActivityStatus: () => ({
      state: "running",
      activeMessages: 0,
      activeTools: 1,
      activeToolMessageIds: ["asst_running"],
      updatedAt: 1,
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Agent: running/)
})

test("createCommandHandlers handleWhere reports stale active turns", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    config: { activeTurnStaleMs: 20 * 60 * 1000 },
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() {
          return [{
            info: { id: "msg_stuck", role: "assistant", time: { created: Date.now() - 31 * 60 * 1000 } },
            parts: [{ type: "tool", state: { status: "running", time: { started: Date.now() - 30 * 60 * 1000 } } }],
          }]
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Agent: stale \(\d+m without progress; message msg_stuck; use \/abort or \/new\)/)
})

test("createCommandHandlers handleWhere ignores stale remote running messages after local completion", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() {
          return [{ info: { id: "asst_done", role: "assistant", time: { updated: Date.now() } } }]
        },
      },
    },
    getAgentActivityStatus: () => ({
      state: "not-running",
      endedMessageIds: ["asst_done"],
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Agent: not running/)
})

test("createCommandHandlers handleWhere keeps local running state when remote summary lacks timings", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() {
          return [{ info: { id: "asst_running", role: "assistant" } }]
        },
      },
    },
    getAgentActivityStatus: () => ({
      state: "running",
      activeMessageIds: ["asst_running"],
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Agent: running/)
})

test("createCommandHandlers handleWhere does not treat completed tools as completed assistant messages", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) { return { id: sessionId } },
        async listMessages() {
          return [{ info: { id: "asst_running", role: "assistant", time: { updated: Date.now() } } }]
        },
      },
    },
    getAgentActivityStatus: () => ({
      state: "not-running",
      endedToolMessageIds: ["asst_running"],
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Agent: running/)
})

test("createCommandHandlers handleWhere reports stale session health with repair actions", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_missing" } },
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          throw makeBoundaryError({ message: `GET /session/${sessionId} failed: 404`, method: "GET", pathname: `/session/${sessionId}`, status: 404 })
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleWhere({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Binding health: stale: session missing/)
  assert.deepEqual(
    sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text),
    ["Sessions", "New", "Feed", "Model", "Remove 100:7", "Rebind startup 100:7", "New session 100:7", "Keep 100:7", "Close"],
  )
  assert.deepEqual(callbackParts(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Remove 100:7")?.callback_data), ["b", "confirm-unbind", "100:7"])
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
  assert.match(text, /Binding health:/)
  assert.match(text, /- demo: ok=0 stale=2 unreachable=0 unknown=0/)
  assert.match(text, /- other: ok=0 stale=1 unreachable=0 unknown=0/)
})

test("createCommandHandlers handleProjects includes project action keyboard", async () => {
  const replyMarkup = { inline_keyboard: [[{ text: "Status demo", callback_data: "srv|demo|health" }]] }
  const { runtime, sent } = makeRuntime({
    buildProjectsOverviewKeyboard: (input) => {
      assert.deepEqual(input, { platform: "win32", showProjectControls: true, showSessions: true, showBindControls: true, currentBinding: null })
      return replyMarkup
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleProjects({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].replyMarkup, replyMarkup)
})

test("createCommandHandlers handleRuntime renders private runtime status", async () => {
  const { runtime, sent } = makeRuntime({
    buildGlobalRuntimeStatusLines: () => [
      "Runtime: managedTasks=3 taskKinds=loop=2 timer=1 shutdown=running",
      "Telegram poll: retries=1 aborted=0 lastRetry=2026-04-24T00:00:00.000Z",
      "Updates: retryable=1 skipped=2",
    ],
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleRuntime({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^Runtime:/)
  assert.match(sent[0].text, /managedTasks=3/)
  assert.match(sent[0].text, /Telegram poll:/)
  assert.match(sent[0].text, /Updates: retryable=1 skipped=2/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Restart", "Stop", "Close"])
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => callbackParts(button.callback_data)), [
    ["rt", "confirm-restart"],
    ["rt", "confirm-stop"],
    ["rt", "close"],
  ])
})

test("createCommandHandlers handleRuntime is private-chat only", async () => {
  const { runtime, sent } = makeRuntime({ buildGlobalRuntimeStatusLines: () => ["should not render"] })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleRuntime({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Use \/runtime only in a private chat/)
})

test("createCommandHandlers renderProjectSessions is view-only when private chat is unbound", async () => {
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async listSessions() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderProjectSessions({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, "demo")

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Viewing only/)
  assert.match(sent[0].text, /Bind the target chat\/thread to this project/)
  assert.doesNotMatch(sent[0].text, /\/use <sessionId\|shareLink> to switch/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Close"])
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

test("createCommandHandlers handlePermissions renders bound project read-only outside private chat", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "suggest",
      permission: {},
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, [])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /OpenCode permissions:/)
  assert.match(sent[0].text, /Project: demo/)
  assert.match(sent[0].text, /Profile: Suggest/)
  assert.doesNotMatch(sent[0].text, /C:\/repo\/demo\/opencode\.json|Config:/)
  assert.match(sent[0].text, /read-only here/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Close"])
})

test("createCommandHandlers handlePermissions renders Russian permission UI without English profile terms", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0", locale: "ru" }, [])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Права OpenCode:/)
  assert.match(sent[0].text, /Профиль: Автоправки/)
  assert.match(sent[0].text, /С подтверждением:/)
  assert.match(sent[0].text, /Полный авто:/)
  assert.doesNotMatch(sent[0].text, /Suggest|Auto Edit|Full Auto|Custom|OpenCode default|subagents|skills|todo writes|Web search|catch-all|clone\/overview|loop/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), [
    "С подтверждением",
    "Автоправки",
    "Полный авто",
    "Дефолт OpenCode",
    "Показать текущие",
    "Закрыть",
  ])
})

test("createCommandHandlers renderPermissionDetails is private-chat only", async () => {
  let readCalls = 0
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => {
      readCalls += 1
      return {
        ok: true,
        editable: true,
        status: "ok",
        filePath: "C:/repo/demo/opencode.json",
        profile: "suggest",
        permission: { edit: "ask" },
      }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderPermissionDetails({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, "demo")

  assert.equal(sent.length, 1)
  assert.equal(readCalls, 0)
  assert.match(sent[0].text, /Raw OpenCode permission config is available only in a private chat/)
  assert.doesNotMatch(sent[0].text, /C:\/repo\/demo\/opencode\.json|Config:|"edit"|ask/)
})

test("createCommandHandlers permission renderers edit existing messages for unknown projects", async () => {
  const editCalls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
    },
  })
  const handlers = createCommandHandlers(runtime)
  const ctxMeta = { chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }

  await handlers.renderPermissionSettings(ctxMeta, { projectAlias: "missing", editMessageId: 321 })
  await handlers.renderPermissionDetails(ctxMeta, "missing", { editMessageId: 322 })

  assert.deepEqual(sent, [])
  assert.equal(editCalls.length, 2)
  assert.deepEqual(editCalls[0].slice(0, 2), [100, 321])
  assert.match(editCalls[0][2], /Unknown project\./)
  assert.deepEqual(editCalls[0][3].inline_keyboard.flat().map((button) => button.text), ["Close"])
  assert.deepEqual(editCalls[1].slice(0, 2), [100, 322])
  assert.match(editCalls[1][2], /Unknown project\./)
})

test("createCommandHandlers renderPermissionSettings requires a binding in unbound group chats", async () => {
  let readCalls = 0
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => {
      readCalls += 1
      return { ok: true, editable: true, status: "ok", profile: "suggest", permission: {} }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderPermissionSettings({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(readCalls, 0)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Permissions need a bound thread/)
})

test("createCommandHandlers applyPermissionProfile rejects missing projects and group writes", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.applyPermissionProfile({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, "missing", "auto-edit")
  await handlers.applyPermissionProfile({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, "demo", "auto-edit")

  assert.deepEqual(writes, [])
  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /Unknown project\./)
  assert.match(sent[1].text, /Profile changes are private-chat only/)
})

test("createCommandHandlers handlePermissions explains unavailable permission config paths", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", permissionConfigPath: "C:/repo/demo/opencode.remote.json" } },
    readPermissionConfig: async () => ({
      ok: false,
      editable: false,
      status: "unavailable",
      filePath: "",
      profile: "custom",
      permission: undefined,
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, [])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /No valid local opencode\.json\/opencode\.jsonc permission config path is available/)
})

test("createCommandHandlers handlePermissions explains access-denied permission configs", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: false,
      editable: false,
      status: "unavailable",
      reason: "access-denied",
      filePath: "C:/repo/demo/opencode.json",
      profile: "custom",
      permission: undefined,
    }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, [])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /cannot be read or written by this connector process/)
  assert.doesNotMatch(sent[0].text, /No valid local opencode\.json/)
})

test("createCommandHandlers handlePermissions explains unavailable write paths", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", permissionConfigPath: "C:/repo/demo/opencode.remote.json" } },
    writePermissionProfile: async () => ({ ok: false, editable: false, status: "unavailable" }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["auto-edit"])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Permission config cannot be changed for this project\./)
  assert.match(sent[0].text, /No valid local opencode\.json\/opencode\.jsonc permission config path is available/)
})

test("createCommandHandlers handlePermissions explains concurrent write conflicts", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    writePermissionProfile: async () => ({ ok: false, editable: false, status: "conflict", reason: "changed" }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["auto-edit"])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Permission config cannot be changed for this project\./)
  assert.match(sent[0].text, /changed while applying the profile/)
})

test("createCommandHandlers handlePermissions applies non-dangerous profiles in private chat", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId, filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["auto-edit"])

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "auto-edit" }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: permissions profile is now Auto Edit\./)
  assert.match(sent[0].text, /Config: C:\/repo\/demo\/opencode\.json/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Suggest", "Auto Edit", "Full Auto", "OpenCode default", "View current", "Close"])
})

test("createCommandHandlers handleTelegramMessage routes /permissions and records the command", async () => {
  const writes = []
  const marked = []
  const flushes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    store: {
      markIdempotencyKey: (key, metadata) => {
        marked.push({ key, metadata })
        return true
      },
      flush: async () => {
        flushes.push(true)
      },
    },
    ctxMetaFromMessage: (msg) => ({
      chatId: msg?.chat?.id,
      chatType: msg?.chat?.type,
      threadIdOr0: msg?.message_thread_id || 0,
      ctxKey: `${msg?.chat?.id}:${msg?.message_thread_id || 0}`,
    }),
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId, filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    message_id: 55,
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/permissions auto-edit",
  }, { updateId: 77 })

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "auto-edit" }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: permissions profile is now Auto Edit\./)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].metadata.operation, "permissions")
  assert.equal(marked[0].metadata.updateId, 77)
  assert.equal(marked[0].metadata.messageId, 55)
  assert.equal(flushes.length, 1)
})

test("createCommandHandlers handlePermissions reports no-op profile writes without changed notice", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, changed: false, profile: profileId, filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["auto-edit"])

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "auto-edit" }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /No permission changes were needed\./)
  assert.doesNotMatch(sent[0].text, /Changed: permissions profile is now/)
})

test("createCommandHandlers handlePermissions applies reset profile in private chat", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "opencode-default",
      permission: undefined,
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: "opencode-default", filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["reset"])

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "reset" }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: OpenCode permission config reset to default\./)
  assert.match(sent[0].text, /Profile: OpenCode default/)
  assert.match(sent[0].text, /Config: C:\/repo\/demo\/opencode\.json/)
})

test("createCommandHandlers handlePermissions reports no-op reset without reset-changed notice", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "opencode-default",
      permission: undefined,
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, changed: false, profile: "opencode-default", filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["reset"])

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "reset" }])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /No permission changes were needed\./)
  assert.doesNotMatch(sent[0].text, /Changed: OpenCode permission config reset to default\./)
})

test("createCommandHandlers applyPermissionProfile keeps successful write when post-write render fails", async () => {
  const loggerErrors = []
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    tg: {
      editMessageText: async () => {
        throw new Error("edit failed")
      },
    },
    logger: {
      error: (...args) => loggerErrors.push(args.map((arg) => String(arg)).join(" ")),
    },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/demo/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId, filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  const result = await handlers.applyPermissionProfile(
    { chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" },
    "demo",
    "auto-edit",
    { editMessageId: 321 },
  )

  assert.deepEqual(writes, [{ project: runtime.projects.demo, profileId: "auto-edit" }])
  assert.deepEqual(result, { ok: true, profile: "auto-edit", filePath: "C:/repo/demo/opencode.json", renderOk: false })
  assert.equal(loggerErrors.length, 1)
  assert.match(loggerErrors[0], /Failed to render permission settings after profile write: demo edit failed/)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Permissions changed, but I could not refresh this view/)
})

test("createCommandHandlers handlePermissions targets explicit project aliases before profile shorthand", async () => {
  const writes = []
  const { runtime } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" },
      suggest: { baseUrl: "http://127.0.0.1:4313", directory: "C:/repo/suggest" },
    },
    readPermissionConfig: async () => ({
      ok: true,
      editable: true,
      status: "ok",
      filePath: "C:/repo/suggest/opencode.json",
      profile: "auto-edit",
      permission: {},
    }),
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId, filePath: "C:/repo/suggest/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["suggest", "auto-edit"])

  assert.deepEqual(writes, [{ project: runtime.projects.suggest, profileId: "auto-edit" }])
})

test("createCommandHandlers handlePermissions renders one-arg project alias before bound profile shorthand", async () => {
  const reads = []
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" },
      suggest: { baseUrl: "http://127.0.0.1:4313", directory: "C:/repo/suggest" },
    },
    readPermissionConfig: async (project) => {
      reads.push(project)
      return {
        ok: true,
        editable: true,
        status: "ok",
        filePath: "C:/repo/suggest/opencode.json",
        profile: "auto-edit",
        permission: {},
      }
    },
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId, filePath: "C:/repo/demo/opencode.json" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["suggest"])

  assert.deepEqual(writes, [])
  assert.deepEqual(reads, [runtime.projects.suggest])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project: suggest/)
  assert.match(sent[0].text, /Profile: Auto Edit/)
})

test("createCommandHandlers handlePermissions rejects invalid profile arguments", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" },
      other: { baseUrl: "http://127.0.0.1:4313", directory: "C:/repo/other" },
    },
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true, profile: profileId }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["other", "ful-auto"])
  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["auto-edit", "extra"])

  assert.deepEqual(writes, [])
  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /^Usage: \/permissions/)
  assert.match(sent[1].text, /^Usage: \/permissions/)
})

test("createCommandHandlers handlePermissions asks confirmation for full-auto", async () => {
  const writes = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    writePermissionProfile: async (project, profileId) => {
      writes.push({ project, profileId })
      return { ok: true }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, ["full-auto"])

  assert.deepEqual(writes, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Confirm Full Auto permissions:/)
  assert.match(sent[0].text, /Shell commands still ask for approval\./)
  assert.deepEqual(callbackParts(sent[0].replyMarkup.inline_keyboard[0][0].callback_data), ["pc", "apply", "demo", "full-auto"])
})

test("createCommandHandlers handlePermissions shows project picker in unbound private chat", async () => {
  const { runtime, sent } = makeRuntime({
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312" },
      other: { baseUrl: "http://127.0.0.1:4313", displayName: "Other project" },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }, [])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Choose a project for permissions:/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["demo", "other (Other project)", "Close"])
})

test("createCommandHandlers handlePermissions does not target arbitrary projects from unbound groups", async () => {
  let readCalls = 0
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    readPermissionConfig: async () => {
      readCalls += 1
      return { ok: true, editable: true, status: "ok", profile: "suggest", permission: {} }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handlePermissionsCommand({ chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, ["demo"])

  assert.equal(readCalls, 0)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Permissions need a bound thread/)
})

test("createCommandHandlers permission renderers do not read forged group callback project aliases", async () => {
  const reads = []
  const { runtime, sent } = makeRuntime({
    storeState: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    },
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" },
      other: { baseUrl: "http://127.0.0.1:4313", directory: "C:/repo/other" },
    },
    readPermissionConfig: async (project) => {
      reads.push(project)
      return { ok: true, editable: true, status: "ok", filePath: "C:/repo/other/opencode.json", profile: "suggest", permission: {} }
    },
  })
  const handlers = createCommandHandlers(runtime)
  const ctxMeta = { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }

  await handlers.renderPermissionSettings(ctxMeta, { projectAlias: "other", editMessageId: 901 })
  await handlers.renderPermissionDetails(ctxMeta, "other")

  assert.deepEqual(reads, [])
  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /Permissions need a bound thread/)
  assert.match(sent[1].text, /Raw OpenCode permission config is available only in a private chat/)
  assert.doesNotMatch(sent.map((entry) => entry.text).join("\n"), /Project: other|C:\/repo\/other/)
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
    ocByAlias: {
      demo: { async getSession(sessionId) { return { id: sessionId } } },
      other: { async getSession(sessionId) { return { id: sessionId } } },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindings({ chatId: 100, chatType: "private", threadIdOr0: 11, ctxKey: "100:11" })

  assert.equal(sent.length, 1)
  assert.equal(
    sent[0].text,
    [
      "Bindings:",
      "- chat 100 / main -> demo / ses_main [ok]",
      "- chat 100 / topic 11 (current) -> demo / ses_topic [ok]",
      "- chat 200 / topic 3 -> other / ses_other [ok]",
    ].join("\n"),
  )
})

test("createCommandHandlers handleBindings shows health labels and index repair preview", async () => {
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    storeState: {
      bindings: {
        "100:0": { projectAlias: "demo", sessionId: "ses_ok" },
        "200:0": { projectAlias: "removed", sessionId: "ses_old" },
      },
    },
    store: {
      repairBindingIndex(options) {
        assert.deepEqual(options, { dryRun: true })
        return { changed: true, removedBindings: [], removedIndexEntries: ["demo:ghost"], rebuiltIndexEntries: 1 }
      },
    },
    ocByAlias: {
      demo: { async getSession(sessionId) { return { id: sessionId } } },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindings({ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /demo \/ ses_ok \[ok\]/)
  assert.match(sent[0].text, /removed \/ ses_old \[stale: project missing\]/)
  assert.match(sent[0].text, /Index repair available: removedBindings=0 removedIndex=1 rebuilt=1/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Repair index"), true)
  assert.deepEqual(callbackParts(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Remove 100:0")?.callback_data), ["b", "confirm-unbind", "100:0"])
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
  assert.match(sent[0].text, /Abort needs a bound thread\./)
  assert.match(sent[0].text, /Scope: chat 100 \/ topic 7/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Projects", "Close"])
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
    message_id: 319,
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
  assert.match(sent[1].text, /This thread is not bound yet\./)
  assert.match(sent[1].text, /Use \/projects to see available aliases\./)
})

test("createCommandHandlers continues sessionless awaiting custom answers when one scoped wizard matches", async () => {
  const awaitingCustomAnswer = new Map([
    ["100:7", { projectAlias: "demo", requestId: "q_same", qIndex: 0 }],
  ])
  const wizard = {
    projectAlias: "demo",
    id: "q_same",
    sessionID: "ses_scoped",
    index: 0,
    request: { id: "q_same", questions: [{ header: "First", question: "one" }, { header: "Second", question: "two" }] },
    answers: [[], []],
    selectedByIndex: {},
    messageIdByIndex: {},
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  }
  const cleared = []
  const progressCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_scoped" } } },
    awaitingCustomAnswer,
    getWizard: (projectAlias, requestId, sessionID) => {
      assert.equal(projectAlias, "demo")
      assert.equal(requestId, "q_same")
      assert.equal(sessionID || "", "")
      return null
    },
    getUniqueWizard: (projectAlias, requestId) => {
      assert.equal(projectAlias, "demo")
      assert.equal(requestId, "q_same")
      return wizard
    },
    applyWizardState: (target, source) => {
      progressCalls.push(["applyWizardState", source.index, source.answers])
      target.index = source.index
      target.answers = source.answers
      target.selectedByIndex = source.selectedByIndex
      target.messageIdByIndex = source.messageIdByIndex
    },
    persistQuestionWizard: (...args) => progressCalls.push(["persistQuestionWizard", args]),
    finishQuestionWizard: async (...args) => progressCalls.push(["finishQuestionWizard", args]),
    sendCurrentQuestionStep: async (...args) => progressCalls.push(["sendCurrentQuestionStep", args]),
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
    text: "first answer",
  })

  assert.deepEqual(cleared, [{ ctxKey: "100:7", value: null }])
  assert.equal(awaitingCustomAnswer.has("100:7"), false)
  assert.ok(progressCalls.findIndex((entry) => entry[0] === "persistQuestionWizard") < progressCalls.findIndex((entry) => entry[0] === "sendCurrentQuestionStep"))
  assert.equal(progressCalls.some((entry) => entry[0] === "finishQuestionWizard"), false)
  assert.equal(wizard.index, 1)
  assert.deepEqual(wizard.answers, [["first answer"], []])
  assert.equal(sent.length, 0)
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

test("createCommandHandlers handleBindCommand reports moved session conflicts", async () => {
  const { runtime, sent } = makeRuntime({
    startupSessionByProject: { demo: "ses_shared" },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
    bindCtxToSession: async () => ({ movedFromCtxKey: "200:3", movedFromRoute: { chatId: 200, threadIdOr0: 3 } }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["demo"])

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Bound to project 'demo' \(startup session\): ses_shared/)
  assert.match(sent[0].text, /already bound to chat 200 \/ topic 3 and was moved to this thread/)
})

test("createCommandHandlers handleUseCommand reports moved session conflicts", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
    bindCtxToSession: async () => ({ movedFromCtxKey: "200:3", movedFromRoute: { chatId: 200, threadIdOr0: 3 } }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "ses_shared")

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: this thread now uses session ses_shared\./)
  assert.match(sent[0].text, /Project: demo/)
  assert.match(sent[0].text, /Feed: Main \+ changes/)
  assert.match(sent[0].text, /already bound to chat 200 \/ topic 3 and was moved to this thread/)
})

test("createCommandHandlers handleUseCommand localizes switch notices and moved conflicts", async () => {
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
        async getConfig(input) {
          assert.deepEqual(input, { directory: undefined })
          return { model: "openai/gpt-5" }
        },
      },
    },
    bindCtxToSession: async () => ({ movedFromCtxKey: "200:3", movedFromRoute: { chatId: 200, threadIdOr0: 3 } }),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7", locale: "ru" }, "ses_shared")

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Изменено: этот тред теперь использует сессию ses_shared\./)
  assert.match(sent[0].text, /Проект: demo/)
  assert.match(sent[0].text, /Сессия: ses_shared/)
  assert.match(sent[0].text, /Feed: Основное \+ изменения/)
  assert.match(sent[0].text, /Модель: openai\/gpt-5/)
  assert.match(sent[0].text, /Источник: Наследуется из дефолта проекта/)
  assert.match(sent[0].text, /Заметка: эта сессия уже была привязана к chat 200 \/ topic 3/)
  assert.doesNotMatch(sent[0].text, /Changed:|Project:|Session:|Main \+ changes|Source:|Note:/)
})

test("createCommandHandlers handleUseCommand rejects unsafe raw session ids", async () => {
  const getSessionCalls = []
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          getSessionCalls.push(sessionId)
          return { id: sessionId }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "../config")

  assert.deepEqual(getSessionCalls, [])
  assert.deepEqual(bindCalls, [])
  assert.match(sent[0].text, /Invalid session id/)
})

test("createCommandHandlers handleUseCommand rejects raw sessions outside the bound project directory", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId, directory: "C:/repo/other" }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "ses_other")

  assert.deepEqual(bindCalls, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /cannot be used for project 'demo'/)
  assert.match(sent[0].text, /different project directory/)
  assert.doesNotMatch(sent[0].text, /C:\/repo\/other/)
})

test("createCommandHandlers handleUseCommand rejects directoryless raw sessions by default", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "ses_hidden")

  assert.deepEqual(bindCalls, [])
  assert.match(sent[0].text, /did not return project directory evidence/)
})

test("createCommandHandlers handleUnbind asks for confirmation before removing a binding", async () => {
  let calls = 0
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      unbind() {
        calls += 1
        return calls === 1
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUnbind({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" })

  assert.equal(calls, 0)
  assert.match(sent[0].text, /Confirm unbind for this thread:/)
  assert.match(sent[0].text, /Project: demo/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Remove this thread binding", "Close"])
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
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "new-window" } },
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
  assert.equal(sent[0].text, "Changed: this thread now uses new session ses_new.\nProject: demo\nSession: ses_new\nFeed: Main + changes\nModel: openai/gpt-5 xhigh\nSource: Inherited from project default")
})

test("createCommandHandlers handleNewCommand localizes new-session notices", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "new-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
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

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7", locale: "ru" }, "")

  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7", locale: "ru" },
      alias: "demo",
      sessionId: "ses_new",
    },
  ])
  assert.equal(sent.length, 1)
  assert.equal(
    sent[0].text,
    "Изменено: этот тред теперь использует новую сессию ses_new.\nПроект: demo\nСессия: ses_new\nFeed: Основное + изменения\nМодель: openai/gpt-5 xhigh\nИсточник: Наследуется из дефолта проекта",
  )
})

test("createCommandHandlers handleNewCommand refuses invalid created session ids", async () => {
  const bindCalls = []
  const selectCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "same-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "bad/id" }
        },
        async selectTuiSession(sessionId) {
          selectCalls.push(sessionId)
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(selectCalls, [])
  assert.deepEqual(bindCalls, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
})

test("createCommandHandlers handleBindCommand rejects created scoped sessions without directory evidence", async () => {
  const bindCalls = []
  const createCalls = []
  const startupSessionByProject = {}
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/demo" } },
    startupSessionByProject,
    getStartupSession: async () => null,
    ocByAlias: {
      demo: {
        async createSession(options) {
          createCalls.push(options)
          return { id: "ses_new" }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleBindCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, ["demo"])

  assert.deepEqual(createCalls, [{ directory: "C:/demo" }])
  assert.deepEqual(bindCalls, [])
  assert.deepEqual(startupSessionByProject, {})
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
})

test("createCommandHandlers handleNewCommand rejects created scoped sessions from another directory", async () => {
  const bindCalls = []
  const selectCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/demo", openAttachOnNewMode: "same-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "ses_new", directory: "C:/other" }
        },
        async selectTuiSession(sessionId) {
          selectCalls.push(sessionId)
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(selectCalls, [])
  assert.deepEqual(bindCalls, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
})

test("createCommandHandlers handleNewCommand binds immediately in same-window mode after requesting TUI switch", async () => {
  const bindCalls = []
  const primeCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "same-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "ses_new" }
        },
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async selectTuiSession() {
          return true
        },
        async getActiveTuiSession() {
          return { id: "ses_current" }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
    primeTuiActiveSessionFollow: (...args) => {
      primeCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(bindCalls, [[{ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "demo", "ses_new"]])
  assert.deepEqual(primeCalls, [["demo", { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "ses_current", { pendingTargetSessionId: "ses_new" }]])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: this thread now uses new session ses_new/)
  assert.match(sent[0].text, /Requested same-window TUI switch to session: ses_new/)
})

test("createCommandHandlers handleNewCommand still binds when active TUI session tracking is unavailable", async () => {
  const bindCalls = []
  const primeCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "same-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "ses_new" }
        },
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async selectTuiSession() {
          return true
        },
        async getActiveTuiSession() {
          throw Object.assign(new Error("missing"), { isBoundaryError: true, status: 404 })
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
    primeTuiActiveSessionFollow: (...args) => {
      primeCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(bindCalls, [[{ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "demo", "ses_new"]])
  assert.deepEqual(primeCalls, [["demo", { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "ses_current", { pendingTargetSessionId: "ses_new" }]])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: this thread now uses new session ses_new/)
  assert.match(sent[0].text, /does not expose active TUI session tracking/i)
  assert.match(sent[0].text, /Telegram is already using the new session/i)
})

test("createCommandHandlers handleNewCommand binds and includes a note when TUI switching fails in same-window mode", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", openAttachOnNewMode: "same-window" } },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "ses_new" }
        },
        async getConfig() {
          return { model: "openai/gpt-5" }
        },
        async selectTuiSession() {
          throw new Error("not supported")
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleNewCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "Demo title")

  assert.deepEqual(bindCalls, [[{ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "demo", "ses_new"]])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Changed: this thread now uses new session ses_new/)
  assert.match(sent[0].text, /Could not switch the existing TUI automatically/i)
  assert.match(sent[0].text, /Telegram is already using the new session/i)
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
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.at(-1)?.map((button) => button.text), ["Refresh", "New", "Close"])
})

test("createCommandHandlers renderSessionsList hides subagent sessions", async () => {
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async listSessions() {
          return [
            { id: "ses_root", title: "Root session" },
            { id: "ses_child", title: "Child agent", parentID: "ses_root" },
            { id: "ses_child_alt", title: "Child agent alt", parentId: "ses_root" },
          ]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_root" } },
  )

  const buttons = sent[0].replyMarkup.inline_keyboard.flat()
  assert.match(sent[0].text, /ses_root.*Root session/)
  assert.doesNotMatch(sent[0].text, /ses_child/)
  assert.doesNotMatch(sent[0].text, /Child agent/)
  assert.deepEqual(buttons.map((button) => button.text), ["✅ Root session", "Refresh", "New", "Close"])
})

test("createCommandHandlers renderSessionsList applies display limit after hiding subagent sessions", async () => {
  const calls = []
  const subagents = Array.from({ length: 10 }, (_, index) => ({ id: `ses_child_${index}`, title: `Child ${index}`, parentID: "ses_root" }))
  const roots = Array.from({ length: 11 }, (_, index) => ({ id: `ses_root_${index}`, title: `Root ${index}` }))
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          return [...subagents, ...roots]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_root_0" } },
  )

  const buttons = sent[0].replyMarkup.inline_keyboard.flat()
  assert.deepEqual(calls, [{}])
  assert.match(sent[0].text, /ses_root_0.*Root 0/)
  assert.match(sent[0].text, /ses_root_9.*Root 9/)
  assert.match(sent[0].text, /1 more/)
  assert.doesNotMatch(sent[0].text, /ses_root_10/)
  assert.doesNotMatch(sent[0].text, /ses_child_/)
  assert.equal(buttons.some((button) => /Child/.test(button.text)), false)
  assert.equal(buttons.filter((button) => /^Root /.test(button.text) || /^✅ Root /.test(button.text)).length, 10)
})

test("createCommandHandlers renderSessionsList hides scoped directoryless sessions by default", async () => {
  const calls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          return [{ id: "ses_hidden", title: "Hidden session" }]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.deepEqual(calls, [{ directory: "C:/repo/demo" }])
  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_hidden/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Hidden session"), false)
})

test("createCommandHandlers renderSessionsList allows scoped directoryless sessions with explicit legacy fallback", async () => {
  const calls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          return [{ id: "ses_legacy", title: "Legacy session" }]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.deepEqual(calls, [{ directory: "C:/repo/demo" }])
  assert.match(sent[0].text, /ses_legacy.*Legacy session/)
  assert.ok(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Legacy session"))
})

test("createCommandHandlers handleUseCommand does not bind hidden directoryless share-link sessions by default", async () => {
  const listCalls = []
  const getSessionCalls = []
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          listCalls.push(input)
          return [{ id: "ses_hidden", title: "Hidden session", share: { url: "https://opncd.ai/share/hidden" } }]
        },
        async getSession(sessionId) {
          getSessionCalls.push(sessionId)
          return { id: sessionId }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "https://opncd.ai/share/hidden")

  assert.deepEqual(listCalls, [{ directory: "C:/repo/demo" }])
  assert.deepEqual(getSessionCalls, [])
  assert.deepEqual(bindCalls, [])
  assert.match(sent[0].text, /Share link not found in project 'demo'/)
})

test("createCommandHandlers handleUseCommand does not bind subagent share-link sessions", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    ocByAlias: {
      demo: {
        async listSessions() {
          return [
            { id: "ses_child", title: "Child agent", parentID: "ses_root", share: { url: "https://opncd.ai/share/child" } },
          ]
        },
        async getSession(sessionId) {
          return { id: sessionId, parentID: "ses_root" }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleUseCommand({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "https://opncd.ai/share/child")

  assert.deepEqual(bindCalls, [])
  assert.match(sent[0].text, /Share link not found in project 'demo'/)
  assert.doesNotMatch(sent[0].text, /ses_child/)
})

test("createCommandHandlers renderSessionsList hides unscoped fallback sessions by default", async () => {
  const calls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          if (input.directory) return []
          return [{ id: "ses_unscoped", title: "Unscoped session" }]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.deepEqual(calls, [{ directory: "C:/repo/demo" }, {}])
  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_unscoped/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Unscoped session"), false)
})

test("createCommandHandlers renderSessionsList allows explicit legacy unscoped fallback without directory evidence", async () => {
  const calls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          if (input.directory) return []
          return [{ id: "ses_unscoped", title: "Unscoped session" }]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.deepEqual(calls, [{ directory: "C:/repo/demo" }, {}])
  assert.match(sent[0].text, /ses_unscoped.*Unscoped session/)
  assert.ok(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Unscoped session"))
})

test("createCommandHandlers renderSessionsList treats hidden subagent directories as fallback-blocking evidence", async () => {
  const calls = []
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          calls.push(input)
          if (input.directory) return []
          return [
            { id: "ses_unscoped", title: "Directoryless root" },
            { id: "ses_child_other", title: "Hidden other child", parentID: "ses_root", directory: "C:/repo/other" },
          ]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.deepEqual(calls, [{ directory: "C:/repo/demo" }, {}])
  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_unscoped/)
  assert.doesNotMatch(sent[0].text, /ses_child_other|Hidden other child/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Directoryless root"), false)
})

test("createCommandHandlers does not display or bind hidden subagents that match project directory", async () => {
  const getSessionCalls = []
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          if (input.directory) return []
          return [
            {
              id: "ses_child_demo",
              title: "Hidden demo child",
              parentID: "ses_root",
              directory: "C:/repo/demo",
              share: { url: "https://opncd.ai/share/child-demo" },
            },
          ]
        },
        async listMessages() {
          return []
        },
        async getSession(sessionId) {
          getSessionCalls.push(sessionId)
          return { id: sessionId, directory: "C:/repo/demo", parentID: "ses_root" }
        },
      },
    },
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)
  const ctxMeta = { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }

  await handlers.renderSessionsList(ctxMeta, { binding: { projectAlias: "demo", sessionId: "ses_current" } })
  await handlers.handleUseCommand(ctxMeta, "https://opncd.ai/share/child-demo")

  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_child_demo|Hidden demo child/)
  assert.equal(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Hidden demo child"), false)
  assert.deepEqual(getSessionCalls, [])
  assert.deepEqual(bindCalls, [])
  assert.match(sent[1].text, /Share link not found in project 'demo'/)
  assert.doesNotMatch(sent[1].text, /ses_child_demo/)
})

test("createCommandHandlers renderSessionsList ignores unscoped fallback opt-in when directory evidence mismatches", async () => {
  const { runtime, sent } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true } },
    ocByAlias: {
      demo: {
        async listSessions(input = {}) {
          if (input.directory) return []
          return [{ id: "ses_other", title: "Other project", directory: "C:/repo/other" }]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_other/)
})

test("createCommandHandlers renderSessionsList keeps shared-client unscoped sessions hidden without directory evidence", async () => {
  const sharedClient = {
    async listSessions(input = {}) {
      if (input.directory) return []
      return [{ id: "ses_other", title: "Other project" }]
    },
    async listMessages() {
      return []
    },
  }
  const { runtime, sent } = makeRuntime({
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo", allowUnscopedSessionListFallback: true },
      other: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/other" },
    },
    ocByAlias: { demo: sharedClient, other: sharedClient },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.match(sent[0].text, /No sessions found/)
  assert.doesNotMatch(sent[0].text, /ses_other/)
})

test("createCommandHandlers renderSessionsList filters scoped shared-client sessions by directory evidence", async () => {
  const sharedClient = {
    async listSessions(input = {}) {
      assert.deepEqual(input, { directory: "C:/repo/demo" })
      return [
        { id: "ses_missing_dir", title: "Missing directory" },
        { id: "ses_other", title: "Other project", directory: "C:/repo/other" },
        { id: "ses_demo", title: "Demo project", directory: "C:/repo/demo" },
      ]
    },
    async listMessages() {
      return []
    },
  }
  const { runtime, sent } = makeRuntime({
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/demo" },
      other: { baseUrl: "http://127.0.0.1:4312", directory: "C:/repo/other" },
    },
    ocByAlias: { demo: sharedClient, other: sharedClient },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  assert.match(sent[0].text, /ses_demo.*Demo project/)
  assert.doesNotMatch(sent[0].text, /ses_other/)
  assert.doesNotMatch(sent[0].text, /ses_missing_dir/)
  assert.ok(sent[0].replyMarkup.inline_keyboard.flat().some((button) => button.text === "Demo project"))
})

test("createCommandHandlers renderSessionsList omits buttons for unsafe session ids", async () => {
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async listSessions() {
          return [
            { id: "ses_safe", title: "Safe" },
            { id: "abc|def", title: "Unsafe" },
          ]
        },
        async listMessages() {
          return []
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_safe" } },
  )

  const buttons = sent[0].replyMarkup.inline_keyboard.flat()
  assert.match(sent[0].text, /abc\|def \[unsupported id\] — Unsafe/)
  assert.equal(buttons.some((button) => button.text === "Unsafe"), false)
  assert.deepEqual(callbackParts(buttons.find((button) => button.text === "✅ Safe")?.callback_data), ["s", "demo", "ses_safe"])
})

test("createCommandHandlers renderSessionsList keeps buttons aligned with visible sessions", async () => {
  const { runtime, sent } = makeRuntime({
    ocByAlias: {
      demo: {
        async listSessions() {
          return [
            ...Array.from({ length: 10 }, (_, index) => ({ id: `unsafe|${index}`, title: `Unsafe ${index}` })),
            { id: "ses_after_limit", title: "After limit" },
          ]
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.renderSessionsList(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    { binding: { projectAlias: "demo", sessionId: "ses_current" } },
  )

  const buttons = sent[0].replyMarkup.inline_keyboard.flat()
  assert.doesNotMatch(sent[0].text, /ses_after_limit/)
  assert.equal(buttons.some((button) => button.text === "After limit"), false)
  assert.deepEqual(buttons.map((button) => button.text), ["Refresh", "New", "Close"])
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

  assert.match(sent[0].text, /Model settings need a bound thread\./)
  assert.match(sent[1].text, /Model changes need a bound thread\./)
  assert.match(sent[2].text, /Model for this thread:/)
  assert.match(sent[3].text, /Changed: this thread now inherits its model/)
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

test("createCommandHandlers rolls back custom-answer wizard progress when flush fails", async () => {
  const awaitingState = { projectAlias: "demo", requestId: "q_1", qIndex: 0, sessionID: "ses_1" }
  const awaitingCustomAnswer = new Map([["100:7", awaitingState]])
  const wizard = {
    projectAlias: "demo",
    id: "q_1",
    sessionID: "ses_1",
    index: 0,
    request: {
      questions: [
        { header: "First", question: "one" },
        { header: "Second", question: "two" },
      ],
    },
    answers: [[], []],
  }
  const cloneWizard = (value) => ({ ...value, answers: value.answers.map((entry) => [...entry]) })
  const persistCalls = []
  const customStateCalls = []
  const stepCalls = []
  const { runtime } = makeRuntime({
    awaitingCustomAnswer,
    getWizard: () => wizard,
    cloneWizardState: cloneWizard,
    applyWizardState: (target, nextWizard) => {
      target.index = nextWizard.index
      target.answers = nextWizard.answers.map((entry) => [...entry])
    },
    persistQuestionWizard: (nextWizard) => {
      persistCalls.push(cloneWizard(nextWizard))
    },
    sendCurrentQuestionStep: async (nextWizard) => {
      stepCalls.push(cloneWizard(nextWizard))
    },
    setAwaitingCustomAnswerState: (ctxKey, value) => {
      customStateCalls.push({ ctxKey, value })
      if (value) awaitingCustomAnswer.set(ctxKey, value)
      else awaitingCustomAnswer.delete(ctxKey)
    },
    store: {
      async flush() {
        throw new Error("state write failed")
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_thread_id: 7,
      text: "next answer",
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.outcome, "retryable")
      return true
    },
  )

  assert.equal(stepCalls.length, 0)
  assert.deepEqual(persistCalls.map((entry) => ({ index: entry.index, answers: entry.answers })), [
    { index: 1, answers: [["next answer"], []] },
    { index: 0, answers: [[], []] },
  ])
  assert.deepEqual(customStateCalls, [
    { ctxKey: "100:7", value: null },
    { ctxKey: "100:7", value: awaitingState },
  ])
  assert.equal(wizard.index, 0)
  assert.deepEqual(wizard.answers, [[], []])
  assert.deepEqual(awaitingCustomAnswer.get("100:7"), awaitingState)
})

test("createCommandHandlers passes message idempotency into final custom-answer persistence", async () => {
  const awaitingCustomAnswer = new Map([[
    "100:7",
    { projectAlias: "demo", requestId: "q_final", qIndex: 0, sessionID: "ses_1" },
  ]])
  const wizard = {
    projectAlias: "demo",
    id: "q_final",
    sessionID: "ses_1",
    index: 0,
    request: { questions: [{ header: "Only", question: "one" }] },
    answers: [[]],
  }
  const finishCalls = []
  const { runtime } = makeRuntime({
    awaitingCustomAnswer,
    getWizard: () => wizard,
    applyWizardState: (target, nextWizard) => {
      target.answers = nextWizard.answers
    },
    persistQuestionWizard: () => {},
    finishQuestionWizard: async (currentWizard, options) => {
      finishCalls.push({ currentWizard, options })
      return { outcome: "ok" }
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 777,
    message_thread_id: 7,
    text: "final answer",
  })

  assert.equal(finishCalls.length, 1)
  assert.deepEqual(finishCalls[0].currentWizard.answers, [["final answer"]])
  assert.equal(finishCalls[0].options.idempotencyEntries.length, 1)
  assert.match(finishCalls[0].options.idempotencyEntries[0].key, /tg-message:100:7:777$/)
  assert.deepEqual(finishCalls[0].options.idempotencyEntries[0].metadata, {
    kind: "telegram-message",
    ctxKey: "100:7",
    operation: "replyQuestion",
    updateId: undefined,
    messageId: 777,
    projectAlias: "demo",
    sessionId: "ses_1",
  })
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
  const markProjectUpCalls = []
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
    markProjectUp: (alias) => markProjectUpCalls.push(alias),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 319,
    message_thread_id: 7,
    text: "hello model",
  })

  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].sessionId, "ses_current")
  assert.equal(promptCalls[0].text, "[TG] hello model")
  assert.deepEqual(promptCalls[0].options.model, { providerID: "openai", modelID: "gpt-5" })
  assert.equal(promptCalls[0].options.variant, "xhigh")
  assert.match(promptCalls[0].options.messageID, /^msg_tgc_[a-f0-9]{48}$/)
  assert.deepEqual(markProjectUpCalls, ["demo"])
})

test("createCommandHandlers handleTelegramMessage blocks prompts behind stale active turns", async () => {
  const promptCalls = []
  let recentPromptAdded = false
  const marked = []
  const { runtime, sent } = makeRuntime({
    config: { tgPrefix: "[TG] ", activeTurnStaleMs: 20 * 60 * 1000 },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        return true
      },
      async flush() {},
    },
    ensureRecentPromptSet: () => ({ add() { recentPromptAdded = true } }),
    ocByAlias: {
      demo: {
        async listMessages() {
          return [{ info: { id: "msg_stuck", role: "assistant", time: { updated: Date.now() - 25 * 60 * 1000 } } }]
        },
        async promptAsync(sessionId, text) {
          promptCalls.push({ sessionId, text })
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 330,
    message_thread_id: 7,
    text: "do the next thing",
  })

  assert.deepEqual(promptCalls, [])
  assert.equal(recentPromptAdded, false)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].metadata.operation, "staleActiveTurn")
  assert.match(sent[0].text, /Agent appears stuck/)
  assert.match(sent[0].text, /did not send this prompt/)
})

test("createCommandHandlers handleTelegramMessage rethrows retryable promptAsync failures", async () => {
  const promptCalls = []
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 503,
    message: "opencode unavailable",
  })
  const { runtime, sent } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text) {
          promptCalls.push({ sessionId, text })
          throw err
        },
      },
    },
    isRetryableProjectError: () => true,
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 320,
      message_thread_id: 7,
      text: "retry me",
    }),
    (actual) => expectAmbiguousPromptFailure(actual, err),
  )

  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].sessionId, "ses_current")
  assert.equal(promptCalls[0].text, "[TG] retry me")
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
})

test("createCommandHandlers reports stale configured bindings before prompt handling", async () => {
  const cases = [
    { name: "text", message: { text: "hello after config change" } },
    { name: "document", message: { document: { file_id: "file_1", file_name: "notes.txt", mime_type: "text/plain", file_size: 10 } } },
    { name: "media", message: { photo: [{ file_id: "photo_1" }] } },
  ]

  for (const entry of cases) {
    const marked = []
    const promptCalls = []
    const { runtime, sent } = makeRuntime({
      projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
      storeState: {
        bindings: { "100:7": { projectAlias: "old-project", sessionId: "ses_old" } },
      },
      store: {
        markIdempotencyKey(key, metadata) {
          marked.push({ key, metadata })
          return true
        },
        async flush() {},
      },
      tg: {
        async downloadFile() {
          throw new Error("stale binding should not download attachments")
        },
      },
      ocByAlias: {
        demo: {
          async promptAsync(...args) {
            promptCalls.push(args)
          },
        },
      },
    })
    const handlers = createCommandHandlers(runtime)

    await handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 4000 + cases.indexOf(entry),
      message_thread_id: 7,
      ...entry.message,
    })

    assert.equal(promptCalls.length, 0, entry.name)
    assert.equal(sent.length, 1, entry.name)
    assert.match(sent[0].text, /old-project/, entry.name)
    assert.equal(marked.length, 1, entry.name)
    assert.equal(marked[0].metadata.operation, "missingProjectBinding", entry.name)
    assert.equal(marked[0].metadata.projectAlias, "old-project", entry.name)
    assert.equal(marked[0].metadata.sessionId, "ses_old", entry.name)
  }
})

test("createCommandHandlers delegates retryable promptAsync failure notices to the throttled notifier", async () => {
  const notices = []
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 503,
    message: "opencode unavailable",
  })
  const { runtime, sent } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async promptAsync() {
          throw err
        },
      },
    },
    isRetryableProjectError: () => true,
    notifyProjectUnavailableForThread: async (ctxMeta, alias, error, options) => {
      notices.push({ ctxMeta, alias, error, options })
      return true
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(() => handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 322,
    message_thread_id: 7,
    text: "retry me",
  }), (actual) => expectAmbiguousPromptFailure(actual, err))

  assert.equal(sent.length, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].ctxMeta.ctxKey, "100:7")
  assert.equal(notices[0].alias, "demo")
  assert.equal(notices[0].error.cause, err)
  assert.equal(notices[0].options.platform, "win32")
})

test("createCommandHandlers keeps ambiguous prompt delivery state without a Telegram handled marker", async () => {
  const keys = new Set()
  const deletes = []
  const { runtime } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key) {
        keys.add(key)
        return true
      },
      deleteIdempotencyKey(key) {
        deletes.push(key)
        return keys.delete(key)
      },
      async flush() {},
    },
    ocByAlias: {
      demo: {
        async promptAsync() {
          throw makeBoundaryError({ source: "opencode", method: "POST", pathname: "/session/ses_current/prompt_async", status: 503, message: "down" })
        },
      },
    },
    isRetryableProjectError: () => true,
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(() => handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 320,
    message_thread_id: 7,
    text: "retry me",
  }), (actual) => expectAmbiguousPromptFailure(actual))

  assert.equal(deletes.length, 0)
  assert.equal(keys.size, 0)
  assert.equal(Object.values(runtime.store.get().promptDeliveries.records)[0].state, "outcome_unknown")
})

test("createCommandHandlers persists pending prompt delivery before promptAsync", async () => {
  const promptCalls = []
  const marked = []
  const keys = new Set()
  const { runtime, sent } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        keys.add(key)
        return true
      },
      deleteIdempotencyKey(key) {
        return keys.delete(key)
      },
      async flush() {
        throw new Error("disk full")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text) {
          promptCalls.push({ sessionId, text })
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 321,
      message_thread_id: 7,
      text: "persist me",
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.outcome, "retryable")
      assert.match(err.message, /disk full/)
      return true
    },
  )

  assert.deepEqual(promptCalls, [])
  assert.equal(marked.length, 0)
  assert.equal(keys.size, 0)
  assert.equal(Object.values(runtime.store.get().promptDeliveries.records)[0].state, "pending")
  assert.deepEqual(sent, [])
})

test("createCommandHandlers retries replayed message idempotency until it is durable", async () => {
  const flushCalls = []
  const promptCalls = []
  const { runtime } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey: () => true,
      async flush() {
        flushCalls.push(true)
        throw new Error("disk still full")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 321,
      message_thread_id: 7,
      text: "already sent",
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.outcome, "retryable")
      assert.match(err.message, /disk still full/)
      return true
    },
  )

  assert.deepEqual(flushCalls, [true])
  assert.deepEqual(promptCalls, [])
})

test("createCommandHandlers rethrows reject-note durability failures before remote side effects", async () => {
  const replyCalls = []
  const marked = []
  const rejectNoteAwaiting = new Map([
    ["100:7", { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1" }],
  ])
  const { runtime } = makeRuntime({
    rejectNoteAwaiting,
    store: {
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        return true
      },
      deletePendingPermission: () => true,
      async flush() {
        throw new Error("state write failed")
      },
    },
    ocByAlias: {
      demo: {
        async replyPermission(permissionId, payload) {
          replyCalls.push({ permissionId, payload })
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 322,
      message_thread_id: 7,
      text: "no, thanks",
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.outcome, "retryable")
      return true
    },
  )

  assert.deepEqual(replyCalls, [])
  assert.deepEqual(marked.map((entry) => entry.metadata.kind), ["prompt-submission-scope", "prompt-submission"])
})

test("createCommandHandlers finalizes submitted reject notes without reposting inactive prompts", async () => {
  const noteText = "no, thanks"
  const noteKey = permissionNoteIdempotencyKey("demo", "ses_1", "perm_1", noteText)
  const submittedKey = promptSubmissionIdempotencyKey(noteKey)
  const idempotencyKeys = new Set([submittedKey])
  const replyCalls = []
  const rejectNoteAwaiting = new Map([
    ["100:7", { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1" }],
  ])
  const { runtime, sent } = makeRuntime({
    rejectNoteAwaiting,
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key) {
        idempotencyKeys.add(key)
        return true
      },
      deletePendingPermission: () => true,
      async flush() {},
    },
    setRejectNoteAwaitingState(ctxKey, value) {
      if (value) rejectNoteAwaiting.set(ctxKey, value)
      else rejectNoteAwaiting.delete(ctxKey)
    },
    ocByAlias: {
      demo: {
        async listPermissions() {
          return []
        },
        async replyPermission(permissionId, payload) {
          replyCalls.push({ permissionId, payload })
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 322,
    message_thread_id: 7,
    text: noteText,
  })

  assert.deepEqual(replyCalls, [])
  assert.equal(idempotencyKeys.has(noteKey), true)
  assert.equal(rejectNoteAwaiting.has("100:7"), false)
  assert.equal(sent.at(-1)?.text, "Rejection note already sent.")
})

test("createCommandHandlers blocks alternate reject notes while another permission submission is in flight", async () => {
  const originalNoteKey = permissionNoteIdempotencyKey("demo", "ses_1", "perm_1", "first note")
  const scopedSubmissionKey = promptScopedSubmissionIdempotencyKey("demo", "ses_1", "perm_1", "permission")
  const idempotencyKeys = new Set([scopedSubmissionKey, promptSubmissionIdempotencyKey(originalNoteKey)])
  const replyCalls = []
  const marked = []
  const rejectNoteAwaiting = new Map([
    ["100:7", { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1" }],
  ])
  const { runtime, sent } = makeRuntime({
    rejectNoteAwaiting,
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        idempotencyKeys.add(key)
        return true
      },
      deletePendingPermission: () => true,
      async flush() {},
    },
    setRejectNoteAwaitingState(ctxKey, value) {
      if (value) rejectNoteAwaiting.set(ctxKey, value)
      else rejectNoteAwaiting.delete(ctxKey)
    },
    ocByAlias: {
      demo: {
        async listPermissions() {
          return [{ id: "perm_1", sessionID: "ses_1" }]
        },
        async replyPermission(permissionId, payload) {
          replyCalls.push({ permissionId, payload })
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 323,
    message_thread_id: 7,
    text: "different note",
  })

  assert.deepEqual(replyCalls, [])
  assert.deepEqual(marked, [])
  assert.equal(rejectNoteAwaiting.has("100:7"), true)
  assert.equal(sent.at(-1)?.text, "Permission reply is temporarily unavailable. Send the note again or /cancel.")
})

test("createCommandHandlers handleTelegramMessage forwards small text documents as attachment prompts", async () => {
  const promptCalls = []
  const events = []
  const markProjectUpCalls = []
  const idempotencyKeys = new Set()
  const { runtime, sent } = makeRuntime({
    config: { tgPrefix: "[TG] " },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key, metadata) {
        events.push(`mark:${metadata.operation}`)
        idempotencyKeys.add(key)
        return true
      },
      async flush() {
        events.push("flush")
      },
    },
    tg: {
      async getFile(fileId) {
        assert.equal(fileId, "file_1")
        return { file_path: "files/app.js", file_size: 16 }
      },
      async downloadFile(filePath, options) {
        assert.equal(filePath, "files/app.js")
        assert.equal(options.maxBytes, USER_ATTACHMENT_LIMITS.maxBytes)
        return new TextEncoder().encode("console.log(1)")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text) {
          events.push("prompt")
          promptCalls.push({ sessionId, text })
          return { ok: true }
        },
      },
    },
    markProjectUp: (alias) => markProjectUpCalls.push(alias),
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 10,
    message_thread_id: 7,
    caption: "Review this file",
    document: { file_id: "file_1", file_name: "app.js", mime_type: "text/javascript", file_size: 16 },
  })

  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].sessionId, "ses_current")
  assert.match(promptCalls[0].text, /^\[TG\] Review this file/)
  assert.match(promptCalls[0].text, /Filename: app\.js/)
  assert.match(promptCalls[0].text, /console\.log\(1\)/)
  assert.deepEqual(events, ["flush", "flush", "prompt", "flush", "mark:promptAsyncAttachment", "flush"])
  assert.deepEqual(markProjectUpCalls, ["demo"])
  assert.match(sent.at(-1).text, /Attachment sent to demo\/ses_current: app\.js/)
})

test("createCommandHandlers blocks direct attachment prompts behind stale active turns", async () => {
  const events = []
  const { runtime, sent } = makeRuntime({
    config: { activeTurnStaleMs: 20 * 60 * 1000 },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(_key, metadata) {
        events.push(`mark:${metadata.operation}`)
        return true
      },
      async flush() {
        events.push("flush")
      },
    },
    tg: {
      async getFile() {
        events.push("download")
        return { file_path: "files/app.js", file_size: 16 }
      },
    },
    ocByAlias: {
      demo: {
        async listMessages() {
          return [{ info: { id: "msg_stuck", role: "assistant", time: { updated: Date.now() - 25 * 60 * 1000 } } }]
        },
        async promptAsync() {
          events.push("prompt")
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 11,
    message_thread_id: 7,
    document: { file_id: "file_1", file_name: "app.js", mime_type: "text/javascript", file_size: 16 },
  })

  assert.deepEqual(events, ["mark:staleActiveTurnAttachment", "flush"])
  assert.match(sent[0].text, /Agent appears stuck/)
})

test("createCommandHandlers rolls back small attachment idempotency when OpenCode send fails", async () => {
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 503,
    message: "opencode unavailable",
  })
  const events = []
  const idempotencyKeys = new Set()
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key, metadata) {
        events.push(`mark:${metadata.operation}`)
        idempotencyKeys.add(key)
        return true
      },
      deleteIdempotencyKey(key) {
        events.push("delete")
        return idempotencyKeys.delete(key)
      },
      async flush() {
        events.push("flush")
      },
    },
    tg: {
      async getFile() {
        return { file_path: "files/a.txt", file_size: 10 }
      },
      async downloadFile() {
        return new TextEncoder().encode("hello")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync() {
          events.push("prompt")
          throw err
        },
      },
    },
    isRetryableProjectError: () => true,
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 10,
      message_thread_id: 7,
      document: { file_id: "file_1", file_name: "a.txt", mime_type: "text/plain", file_size: 10 },
    }),
    (actual) => expectAmbiguousPromptFailure(actual, err),
  )

  assert.deepEqual(events, ["flush", "flush", "prompt", "flush"])
  assert.equal(idempotencyKeys.size, 0)
  assert.equal(Object.values(runtime.store.get().promptDeliveries.records)[0].state, "outcome_unknown")
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
})

test("createCommandHandlers rolls back small attachment idempotency when pre-send flush fails", async () => {
  const events = []
  const idempotencyKeys = new Set()
  const promptCalls = []
  const { runtime } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key, metadata) {
        events.push(`mark:${metadata.operation}`)
        idempotencyKeys.add(key)
        return true
      },
      deleteIdempotencyKey(key) {
        events.push("delete")
        return idempotencyKeys.delete(key)
      },
      async flush() {
        events.push("flush")
        throw new Error("state write failed")
      },
    },
    tg: {
      async getFile() {
        return { file_path: "files/a.txt", file_size: 10 }
      },
      async downloadFile() {
        return new TextEncoder().encode("hello")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 10,
      message_thread_id: 7,
      document: { file_id: "file_1", file_name: "a.txt", mime_type: "text/plain", file_size: 10 },
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.outcome, "retryable")
      return true
    },
  )

  assert.deepEqual(events, ["flush"])
  assert.equal(idempotencyKeys.size, 0)
  assert.deepEqual(promptCalls, [])
  assert.equal(Object.values(runtime.store.get().promptDeliveries.records)[0].state, "pending")
})

test("createCommandHandlers requires confirmation for large text documents and can cancel", async () => {
  const promptCalls = []
  const editCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 11,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 611 })

  assert.equal(promptCalls.length, 0)
  assert.match(sent[0].text, /Confirm sending this file/)
  const sendButton = sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")
  const token = attachmentTokenFromButton(sendButton)
  const wrongThread = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 8, ctxKey: "100:8" }, "cancel", token, { editMessageId: 76 })
  assert.deepEqual(wrongThread, { callbackText: "Wrong thread" })
  assert.equal(editCalls.length, 0)
  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "cancel", token, { editMessageId: 77 })

  assert.deepEqual(result, { callbackText: "Cancelled" })
  assert.equal(promptCalls.length, 0)
  assert.equal(editCalls[0][2], "Attachment sending cancelled.")
})

test("createCommandHandlers restores a durably flushed attachment confirmation after handler restart", async () => {
  const events = []
  const promptCalls = []
  const records = {}
  const idempotencyKeys = new Set()
  const storeState = {
    bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } },
    attachmentConfirmations: { records },
    promptDeliveries: { records: {} },
    idempotency: { keys: {} },
  }
  const store = {
    get: () => storeState,
    getBinding: (ctxKey) => storeState.bindings[ctxKey] || null,
    getAttachmentConfirmation: (token) => records[token] || null,
    setAttachmentConfirmation(record) {
      events.push(`set:${record.token}`)
      records[record.token] = { ...record }
      return true
    },
    deleteAttachmentConfirmation(token) {
      events.push(`delete:${token}`)
      if (!records[token]) return false
      delete records[token]
      return true
    },
    pruneAttachmentConfirmations: () => 0,
    hasIdempotencyKey: (key) => idempotencyKeys.has(key),
    markIdempotencyKey(key) {
      idempotencyKeys.add(key)
      return true
    },
    deleteIdempotencyKey: (key) => idempotencyKeys.delete(key),
    async flush() {
      events.push("flush")
    },
  }
  const msg = {
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 111,
    message_thread_id: 7,
    document: {
      file_id: "file_restart",
      file_unique_id: "unique_restart",
      file_name: "restart.log",
      mime_type: "text/plain",
      file_size: USER_ATTACHMENT_LIMITS.confirmBytes,
    },
  }
  const first = makeRuntime({
    storeState,
    store,
    tg: { async editMessageText() { return true } },
    ocByAlias: { demo: { async promptAsync() {} } },
    sendToThread: async (ctxMeta, text, replyMarkup) => {
      events.push("ui")
      first.sent.push({ ctxMeta, text, replyMarkup })
    },
  })
  const firstHandlers = createCommandHandlers(first.runtime)

  await firstHandlers.handleTelegramMessage(msg, { updateId: 711 })
  const sendButton = first.sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")
  const token = attachmentTokenFromButton(sendButton)
  assert.deepEqual(events.slice(0, 3), [`set:${token}`, "flush", "ui"])
  assert.equal(records[token].fileUniqueId, "unique_restart")

  const restarted = makeRuntime({
    storeState,
    store,
    tg: {
      async getFile() {
        return { file_path: "files/restart.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile() {
        return new TextEncoder().encode("restart-safe")
      },
      async editMessageText() {
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const restartedHandlers = createCommandHandlers(restarted.runtime)
  const result = await restartedHandlers.handleAttachmentConfirmation(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    "send",
    token,
    { editMessageId: 901 },
  )

  assert.deepEqual(result, { callbackText: "Sent" })
  assert.equal(promptCalls.length, 1)
  assert.equal(records[token], undefined)
})

test("createCommandHandlers refuses confirmed attachment when bound project is no longer configured", async () => {
  const editCalls = []
  const tgCalls = []
  const promptCalls = []
  const ocByAlias = {
    demo: {
      async promptAsync(...args) {
        promptCalls.push(args)
      },
    },
  }
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      async getFile(...args) {
        tgCalls.push(["getFile", args])
        return { file_path: "files/large.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile(...args) {
        tgCalls.push(["downloadFile", args])
        return new TextEncoder().encode("log line")
      },
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
    ocByAlias,
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 12,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 612 })
  const sendButton = sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")
  const token = attachmentTokenFromButton(sendButton)

  delete ocByAlias.demo
  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 78 })

  assert.deepEqual(result, { callbackText: "Project missing" })
  assert.match(editCalls[0][2], /project 'demo'.*no longer configured/)
  assert.deepEqual(tgCalls, [])
  assert.deepEqual(promptCalls, [])
})

test("createCommandHandlers does not mark large attachment handled when confirmation send fails", async () => {
  const marked = []
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }
  let flushes = 0
  const { runtime } = makeRuntime({
    storeState,
    store: {
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        return true
      },
      async flush() {
        flushes += 1
      },
    },
    sendToThread: async () => {
      throw new Error("telegram send failed")
    },
    ocByAlias: { demo: { async promptAsync() {} } },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 11,
      message_thread_id: 7,
      document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
    }, { updateId: 613 }),
    /telegram send failed/,
  )

  assert.deepEqual(marked, [])
  assert.equal(flushes, 1)
  assert.equal(Object.keys(storeState.attachmentConfirmations.records).length, 1)
})

test("createCommandHandlers sends confirmed large text documents", async () => {
  const promptCalls = []
  const editCalls = []
  const events = []
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } }, marked: [] }
  const { runtime, sent } = makeRuntime({
    storeState,
    store: {
      hasIdempotencyKey: () => false,
      markIdempotencyKey: (key, metadata) => {
        events.push(`mark:${metadata.action || metadata.operation}`)
        storeState.marked.push({ key, metadata })
        return true
      },
      flush: async () => {
        events.push("flush")
      },
    },
    tg: {
      async getFile() {
        return { file_path: "files/large.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile() {
        return new TextEncoder().encode("log line")
      },
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text) {
          events.push("prompt")
          promptCalls.push({ sessionId, text })
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 12,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 614 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))
  events.length = 0

  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 78 })

  assert.deepEqual(result, { callbackText: "Sent" })
  assert.equal(promptCalls.length, 1)
  assert.match(promptCalls[0].text, /large\.log/)
  assert.match(promptCalls[0].text, /log line/)
  assert.match(editCalls.at(-1)[2], /Attachment sent to demo\/ses_current: large\.log/)
  assert.equal(storeState.marked.some((entry) => entry.metadata.kind === "telegram-attachment"), true)
  assert.deepEqual(events, ["flush", "flush", "prompt", "flush", "mark:send-confirmed", "flush", "flush"])
})

test("createCommandHandlers rolls back confirmed attachment send idempotency when OpenCode send fails", async () => {
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 503,
    message: "opencode unavailable",
  })
  const events = []
  const idempotencyKeys = new Set()
  const metadataByKey = new Map()
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey(key, metadata) {
        events.push(`mark:${metadata.action || metadata.operation}`)
        idempotencyKeys.add(key)
        metadataByKey.set(key, metadata)
        return true
      },
      deleteIdempotencyKey(key) {
        events.push(`delete:${metadataByKey.get(key)?.action || metadataByKey.get(key)?.operation}`)
        const deleted = idempotencyKeys.delete(key)
        metadataByKey.delete(key)
        return deleted
      },
      async flush() {
        events.push("flush")
      },
    },
    tg: {
      async getFile() {
        return { file_path: "files/large.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile() {
        return new TextEncoder().encode("log line")
      },
      async editMessageText() {
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync() {
          events.push("prompt")
          throw err
        },
      },
    },
    isRetryableProjectError: () => true,
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 12,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 615 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))
  events.length = 0

  await assert.rejects(
    () => handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 78 }),
    (actual) => expectAmbiguousPromptFailure(actual, err),
  )
  assert.deepEqual(events, ["flush", "flush", "prompt", "flush"])
  assert.equal([...metadataByKey.values()].some((metadata) => metadata.action === "send-confirmed"), false)
  assert.equal(Object.values(runtime.store.get().promptDeliveries.records)[0].state, "outcome_unknown")
})

test("createCommandHandlers suppresses parallel confirmed attachment sends", async () => {
  const promptCalls = []
  let releasePrompt
  const promptStarted = new Promise((resolve) => {
    releasePrompt = resolve
  })
  let unblockPrompt
  const promptBlocked = new Promise((resolve) => {
    unblockPrompt = resolve
  })
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }
  const { runtime, sent } = makeRuntime({
    storeState,
    store: {
      hasIdempotencyKey: () => false,
      markIdempotencyKey: () => true,
      flush: async () => {},
    },
    tg: {
      async getFile() {
        return { file_path: "files/large.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile() {
        return new TextEncoder().encode("log line")
      },
      async editMessageText() {
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(sessionId, text) {
          promptCalls.push({ sessionId, text })
          releasePrompt()
          await promptBlocked
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 16,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 616 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))

  const first = handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 79 })
  await promptStarted
  const second = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 79 })
  unblockPrompt()
  await first

  assert.deepEqual(second, { callbackText: "Already sending" })
  assert.equal(promptCalls.length, 1)
})

test("createCommandHandlers reports expired attachment confirmations", async () => {
  const editCalls = []
  const { runtime } = makeRuntime({
    tg: {
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", "missing_token", { editMessageId: 80 })

  assert.deepEqual(result, { callbackText: "Expired" })
  assert.equal(editCalls.length, 1)
  assert.equal(editCalls[0][0], 100)
  assert.equal(editCalls[0][1], 80)
  assert.match(editCalls[0][2], /confirmation expired/i)
})

test("createCommandHandlers durably removes expired attachment confirmations", async () => {
  const token = "a".repeat(24)
  const storeState = {
    bindings: {},
    attachmentConfirmations: {
      records: {
        [token]: { token, expiresAt: Date.now() - 1 },
      },
    },
  }
  let flushes = 0
  const { runtime } = makeRuntime({
    storeState,
    store: {
      async flush() {
        flushes += 1
      },
    },
    tg: { async editMessageText() { return true } },
  })
  const handlers = createCommandHandlers(runtime)

  const result = await handlers.handleAttachmentConfirmation(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    "send",
    token,
    { editMessageId: 80 },
  )

  assert.deepEqual(result, { callbackText: "Expired" })
  assert.deepEqual(storeState.attachmentConfirmations, { records: {} })
  assert.equal(flushes, 1)
})

test("createCommandHandlers refuses confirmed attachment when binding changed", async () => {
  const editCalls = []
  const promptCalls = []
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }
  let flushes = 0
  const { runtime, sent } = makeRuntime({
    storeState,
    store: {
      async flush() {
        flushes += 1
      },
    },
    tg: {
      async downloadFile() {
        throw new Error("should not download")
      },
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 17,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 617 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))
  storeState.bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_new" }

  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 81 })

  assert.deepEqual(result, { callbackText: "Binding changed" })
  assert.equal(promptCalls.length, 0)
  assert.equal(storeState.attachmentConfirmations.records[token], undefined)
  assert.equal(flushes, 2)
  assert.match(editCalls.at(-1)[2], /binding changed/i)
})

test("createCommandHandlers treats repeated confirmed attachment sends as already sent", async () => {
  const editCalls = []
  const promptCalls = []
  const seenIdempotencyKeys = []
  const msg = {
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 18,
    message_thread_id: 7,
    document: { file_id: "file_large", file_name: "large.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }
  const messageKey = telegramMessageIdempotencyKey({ chatId: 100, threadIdOr0: 7 }, msg)
  let sendKey = ""
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      hasIdempotencyKey(key) {
        seenIdempotencyKeys.push(key)
        return key === sendKey
      },
    },
    tg: {
      async downloadFile() {
        throw new Error("should not download")
      },
      async editMessageText(...args) {
        editCalls.push(args)
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage(msg, { updateId: 618 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))
  sendKey = `tg-attachment-send:${token}`

  const result = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", token, { editMessageId: 82 })

  assert.deepEqual(result, { callbackText: "Already sent" })
  assert.deepEqual(seenIdempotencyKeys, [messageKey, sendKey])
  assert.equal(promptCalls.length, 0)
  assert.match(editCalls.at(-1)[2], /already sent/i)
})

test("createCommandHandlers returns retry guidance for confirmed attachment download failures", async () => {
  const retryableErr = makeBoundaryError({ source: "telegram", method: "POST", pathname: "/getFile", status: 503, message: "getFile unavailable" })
  const fatalErr = new Error("file path missing")
  const downloadErrors = [retryableErr, fatalErr]
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }
  let flushes = 0
  const { runtime, sent } = makeRuntime({
    storeState,
    store: {
      async flush() {
        flushes += 1
      },
    },
    tg: {
      async getFile() {
        throw downloadErrors.shift()
      },
      async downloadFile() {
        throw new Error("should not download")
      },
      async editMessageText() {
        return true
      },
    },
    ocByAlias: { demo: { async promptAsync() {} } },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 19,
    message_thread_id: 7,
    document: { file_id: "file_large_1", file_name: "one.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 619 })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 20,
    message_thread_id: 7,
    document: { file_id: "file_large_2", file_name: "two.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 620 })
  const tokens = sent
    .filter((entry) => /Confirm sending this file/.test(entry.text))
    .map((entry) => attachmentTokenFromButton(entry.replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")))

  const retryable = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", tokens[0], { editMessageId: 83 })
  const fatal = await handlers.handleAttachmentConfirmation({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }, "send", tokens[1], { editMessageId: 84 })

  assert.deepEqual(retryable, { callbackText: "Try again" })
  assert.deepEqual(fatal, { callbackText: "Download failed" })
  assert.ok(storeState.attachmentConfirmations.records[tokens[0]])
  assert.equal(storeState.attachmentConfirmations.records[tokens[1]], undefined)
  assert.equal(flushes, 3)
  assert.match(sent.at(-2).text, /could not be downloaded/)
  assert.match(sent.at(-1).text, /could not be downloaded/)
})

test("createCommandHandlers durably removes confirmed attachments after definitive OpenCode rejection", async () => {
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }
  const promptCalls = []
  let flushes = 0
  const rejected = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 400,
    outcome: "fatal",
    message: "invalid request",
  })
  const { runtime, sent } = makeRuntime({
    storeState,
    store: {
      async flush() {
        flushes += 1
      },
    },
    tg: {
      async getFile() {
        return { file_path: "files/rejected.log", file_size: USER_ATTACHMENT_LIMITS.confirmBytes }
      },
      async downloadFile() {
        return new TextEncoder().encode("rejected")
      },
      async editMessageText() {
        return true
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
          throw rejected
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 21,
    message_thread_id: 7,
    document: { file_id: "file_rejected", file_name: "rejected.log", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes },
  }, { updateId: 621 })
  const token = attachmentTokenFromButton(sent[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file"))

  const result = await handlers.handleAttachmentConfirmation(
    { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    "send",
    token,
    { editMessageId: 85 },
  )

  assert.deepEqual(result, { callbackText: "Send failed" })
  assert.equal(promptCalls.length, 1)
  assert.equal(storeState.attachmentConfirmations.records[token], undefined)
  assert.deepEqual(storeState.promptDeliveries, { records: {} })
  assert.ok(flushes >= 5)
})

test("createCommandHandlers rejects attachments that Telegram reports over the size limit", async () => {
  const marks = []
  const downloadCalls = []
  const promptCalls = []
  const { runtime, sent } = makeRuntime({
    config: { limits: { userAttachmentConfirmBytes: 5, userAttachmentMaxBytes: 5 } },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key, metadata) {
        marks.push(metadata)
        return true
      },
      async flush() {},
    },
    tg: {
      async getFile() {
        return { file_path: "files/huge.txt", file_size: 6 }
      },
      async downloadFile(...args) {
        downloadCalls.push(args)
      },
    },
    ocByAlias: { demo: { async promptAsync(...args) { promptCalls.push(args) } } },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 21,
    message_thread_id: 7,
    document: { file_id: "file_huge", file_name: "huge.txt", mime_type: "text/plain" },
  })

  assert.equal(downloadCalls.length, 0)
  assert.equal(promptCalls.length, 0)
  assert.match(sent[0].text, /too large/)
  assert.equal(marks.at(-1).operation, "attachmentTooLarge")
})

test("createCommandHandlers rejects attachments whose downloaded bytes exceed the limit", async () => {
  const marks = []
  const promptCalls = []
  const { runtime, sent } = makeRuntime({
    config: { limits: { userAttachmentConfirmBytes: 5, userAttachmentMaxBytes: 5 } },
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key, metadata) {
        marks.push(metadata)
        return true
      },
      async flush() {},
    },
    tg: {
      async getFile() {
        return { file_path: "files/grows.txt", file_size: 1 }
      },
      async downloadFile(filePath, options) {
        assert.equal(filePath, "files/grows.txt")
        assert.equal(options.maxBytes, 5)
        return new Uint8Array(6)
      },
    },
    ocByAlias: { demo: { async promptAsync(...args) { promptCalls.push(args) } } },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 22,
    message_thread_id: 7,
    document: { file_id: "file_grows", file_name: "grows.txt", mime_type: "text/plain", file_size: 1 },
  })

  assert.equal(promptCalls.length, 0)
  assert.match(sent[0].text, /too large/)
  assert.equal(marks.at(-1).operation, "attachmentTooLarge")
})

test("createCommandHandlers rejects binary attachment contents", async () => {
  const marks = []
  const promptCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey(key, metadata) {
        marks.push(metadata)
        return true
      },
      async flush() {},
    },
    tg: {
      async getFile() {
        return { file_path: "files/binary.txt", file_size: 2 }
      },
      async downloadFile() {
        return new Uint8Array([65, 0])
      },
    },
    ocByAlias: { demo: { async promptAsync(...args) { promptCalls.push(args) } } },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 23,
    message_thread_id: 7,
    document: { file_id: "file_binary", file_name: "binary.txt", mime_type: "text/plain", file_size: 2 },
  })

  assert.equal(promptCalls.length, 0)
  assert.match(sent[0].text, /not supported/)
  assert.match(sent[0].text, /binary, not UTF-8 text/)
  assert.equal(marks.at(-1).operation, "unsupportedAttachmentText")
})

test("createCommandHandlers rejects unsupported media messages", async () => {
  const promptCalls = []
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async promptAsync(...args) {
          promptCalls.push(args)
        },
      },
    },
  })
  const handlers = createCommandHandlers(runtime)

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "supergroup" },
    from: { id: 42 },
    message_id: 13,
    message_thread_id: 7,
    photo: [{ file_id: "photo_1" }],
  })

  assert.equal(promptCalls.length, 0)
  assert.match(sent[0].text, /photo messages are not supported/)
})

test("createCommandHandlers rethrows retryable Telegram attachment download failures", async () => {
  const err = makeBoundaryError({ source: "telegram", method: "POST", pathname: "/getFile", status: 503, message: "getFile unavailable" })
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      async getFile() {
        throw err
      },
      async downloadFile() {
        throw new Error("should not download")
      },
    },
    ocByAlias: { demo: { async promptAsync() {} } },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 14,
      message_thread_id: 7,
      document: { file_id: "file_1", file_name: "a.txt", mime_type: "text/plain", file_size: 10 },
    }),
    /getFile unavailable/,
  )
  assert.match(sent[0].text, /could not be downloaded/)
})

test("createCommandHandlers rethrows retryable OpenCode send failures for attachments", async () => {
  const notices = []
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/ses_current/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    status: 503,
    message: "opencode unavailable",
  })
  const { runtime, sent } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      async getFile() {
        return { file_path: "files/a.txt", file_size: 10 }
      },
      async downloadFile() {
        return new TextEncoder().encode("hello")
      },
    },
    ocByAlias: {
      demo: {
        async promptAsync() {
          throw err
        },
      },
    },
    isRetryableProjectError: () => true,
    notifyProjectUnavailableForThread: async (ctxMeta, alias, error, options) => {
      notices.push({ ctxMeta, alias, error, options })
      return true
    },
  })
  const handlers = createCommandHandlers(runtime)

  await assert.rejects(
    () => handlers.handleTelegramMessage({
      chat: { id: 100, type: "supergroup" },
      from: { id: 42 },
      message_id: 15,
      message_thread_id: 7,
      document: { file_id: "file_1", file_name: "a.txt", mime_type: "text/plain", file_size: 10 },
    }),
    (actual) => expectAmbiguousPromptFailure(actual, err),
  )
  assert.equal(sent.length, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].ctxMeta.ctxKey, "100:7")
  assert.equal(notices[0].alias, "demo")
  assert.equal(notices[0].error.cause, err)
  assert.ok(notices[0].options.fallbackReplyMarkup)
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

  assert.match(sent[0].text, /^Telegram connector help:/)
  assert.match(sent[0].text, /Scope: chat 100 \/ main/)
  assert.match(sent[0].text, /\/bind <projectAlias>/)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Projects", "Close"])
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

  assert.match(sent[0].text, /Send a project alias for this thread/)
  assert.match(sent[0].text, /You can \/cancel\./)
  assert.equal(sent[1].text, "Cancelled.")
  assert.equal(runtime.bindAliasAwaiting.has("100:0"), false)
})

test("createCommandHandlers ignores expired bind alias prompts", async () => {
  const bindCalls = []
  const { runtime, sent } = makeRuntime({
    bindAliasAwaitingTtlMs: 10,
    bindCtxToSession: async (...args) => {
      bindCalls.push(args)
    },
  })
  const handlers = createCommandHandlers(runtime)
  runtime.bindAliasAwaiting.set("100:0", { startedAt: Date.now() - 100 })

  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "demo",
  })

  assert.equal(runtime.bindAliasAwaiting.has("100:0"), false)
  assert.deepEqual(bindCalls, [])
  assert.doesNotMatch(sent.map((entry) => entry.text).join("\n"), /Bound to project/)

  runtime.bindAliasAwaiting.set("100:0", { startedAt: Date.now() - 100 })
  await handlers.handleTelegramMessage({
    chat: { id: 100, type: "private" },
    from: { id: 42 },
    text: "/cancel",
  })

  assert.equal(sent.at(-1).text, "Nothing to cancel.")
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
  assert.match(sent[0].text, /Send a project alias for this thread/)
  assert.equal(sent[1].text, "Bound to project 'demo' with new session: ses_created")
  assert.equal(runtime.bindAliasAwaiting.has("100:0"), false)
})
