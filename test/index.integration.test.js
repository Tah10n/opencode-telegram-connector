import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { startConnector } from "../src/index.js"
import { defaultState } from "../src/state/store.js"

function makeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

function shortDelay(ms) {
  return delay(Math.min(ms, 2))
}

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeState(filePath, patch = {}) {
  const state = {
    ...defaultState(),
    ...patch,
    bindings: patch.bindings ?? {},
    sessionIndex: patch.sessionIndex ?? {},
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8")
}

async function readState(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function waitFor(predicate, { timeoutMs = 1500, intervalMs = 10 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await delay(intervalMs)
  }
  throw new Error("Timed out waiting for condition")
}

function makeMessageUpdate(updateId, text, { userId = 42, chatId = 100, chatType = "supergroup", threadIdOr0 = 7, messageId = updateId } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: chatType },
      from: { id: userId },
      ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      text,
    },
  }
}

function makeCallbackUpdate(updateId, data, { userId = 42, chatId = 100, chatType = "supergroup", threadIdOr0 = 7, messageId = 900 } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId },
      data,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: chatType },
        ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      },
    },
  }
}

function createFakeTelegramClient({ emptyPollDelayMs = 10, sendMessageImpl } = {}) {
  let nextMessageId = 1000
  const updates = []
  const sentMessages = []
  const sentHtmlBlocks = []
  const callbackAnswers = []
  const editedMessages = []
  const getUpdatesCalls = []

  return {
    sentMessages,
    sentHtmlBlocks,
    callbackAnswers,
    editedMessages,
    getUpdatesCalls,
    enqueue(update) {
      updates.push(update)
    },
    enqueueBatch(batch) {
      updates.push(batch)
    },
    get pendingUpdates() {
      return updates.length
    },
    async getMe() {
      return { id: 1, username: "test_bot", has_topics_enabled: true }
    },
    async setMyCommands() {
      return true
    },
    async getUpdates(input) {
      getUpdatesCalls.push(input)
      if (updates.length === 0) {
        await delay(emptyPollDelayMs)
        return []
      }
      const next = updates.shift()
      return Array.isArray(next) ? next : [next]
    },
    async sendMessage(chatId, text, replyMarkup, options = {}) {
      const result = { message_id: nextMessageId++ }
      const maybeResult = sendMessageImpl
        ? await sendMessageImpl({ chatId, text, replyMarkup, options, result, callIndex: sentMessages.length + 1 })
        : undefined
      const finalResult = maybeResult ?? result
      sentMessages.push({ chatId, text, replyMarkup, options, result: finalResult })
      return finalResult
    },
    async sendHtmlBlocks(chatId, blocks, replyMarkup, options = {}) {
      const result = { message_id: nextMessageId++ }
      sentHtmlBlocks.push({ chatId, blocks, replyMarkup, options, result })
      return result
    },
    async editMessageText(chatId, messageId, text, replyMarkup, options = {}) {
      editedMessages.push({ kind: "text", chatId, messageId, text, replyMarkup, options })
      return { message_id: messageId }
    },
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      editedMessages.push({ kind: "replyMarkup", chatId, messageId, replyMarkup })
      return true
    },
    async answerCallbackQuery(callbackQueryId, text) {
      callbackAnswers.push({ callbackQueryId, text })
      return true
    },
  }
}

function createFakeOpenCodeClient({
  startupSessions = [{ id: "ses_startup" }],
  messagesById = {},
  healthImpl,
  listSessionsImpl,
  getSessionImpl,
  createSessionImpl,
  abortSessionImpl,
  promptAsyncImpl,
  getMessageImpl,
  replyPermissionImpl,
  listPermissionsImpl,
  listQuestionsImpl,
  replyQuestionImpl,
  rejectQuestionImpl,
} = {}) {
  const calls = {
    health: 0,
    listSessions: [],
    getSession: [],
    createSession: [],
    abortSession: [],
    promptAsync: [],
    getMessage: [],
    replyPermission: [],
    listPermissions: 0,
    listQuestions: 0,
    replyQuestion: [],
    rejectQuestion: [],
  }

  const client = {
    baseUrl: "http://127.0.0.1:4312",
    async health() {
      calls.health += 1
      return healthImpl ? healthImpl() : { ok: true }
    },
    async listSessions(input = {}) {
      calls.listSessions.push(input)
      return listSessionsImpl ? listSessionsImpl(input) : startupSessions
    },
    async getSession(sessionId) {
      calls.getSession.push(sessionId)
      return getSessionImpl ? getSessionImpl(sessionId) : { id: sessionId, parentID: null }
    },
    async createSession(input = {}) {
      calls.createSession.push(input)
      return createSessionImpl ? createSessionImpl(input) : { id: "ses_created" }
    },
    async abortSession(sessionId) {
      calls.abortSession.push(sessionId)
      return abortSessionImpl ? abortSessionImpl(sessionId) : true
    },
    async promptAsync(sessionId, text) {
      calls.promptAsync.push({ sessionId, text })
      return promptAsyncImpl ? promptAsyncImpl(sessionId, text) : { ok: true }
    },
    async getMessage(sessionId, messageId) {
      calls.getMessage.push({ sessionId, messageId })
      return getMessageImpl ? getMessageImpl(sessionId, messageId) : (messagesById[messageId] ?? null)
    },
    async replyPermission(permissionId, payload) {
      calls.replyPermission.push({ permissionId, payload })
      return replyPermissionImpl ? replyPermissionImpl(permissionId, payload) : { ok: true }
    },
    async listPermissions() {
      calls.listPermissions += 1
      return listPermissionsImpl ? listPermissionsImpl() : []
    },
    async listQuestions() {
      calls.listQuestions += 1
      return listQuestionsImpl ? listQuestionsImpl() : []
    },
    async replyQuestion(questionId, answers) {
      calls.replyQuestion.push({ questionId, answers })
      return replyQuestionImpl ? replyQuestionImpl(questionId, answers) : { ok: true }
    },
    async rejectQuestion(questionId) {
      calls.rejectQuestion.push({ questionId })
      return rejectQuestionImpl ? rejectQuestionImpl(questionId) : { ok: true }
    },
  }

  return { client, calls }
}

async function createHarness({
  statePatch = {},
  startupSessions,
  messagesById,
  tgOptions,
  ocOptions,
  ocOptionsByAlias,
  projectPatch,
  extraProjects,
  initialUpdates = [],
  ensureOpenCodeRunningImpl,
  ensureStartupSessionImpl,
  openAttachWindowWindowsImpl,
  platform,
  delayImpl = shortDelay,
} = {}) {
  const dir = await makeTempDir()
  const stateFile = path.join(dir, "state.json")
  await writeState(stateFile, { updateOffset: 1, ...statePatch })

  const tg = createFakeTelegramClient(tgOptions)
  for (const update of initialUpdates) tg.enqueue(update)
  const projects = {
    demo: {
      baseUrl: "http://127.0.0.1:4312",
      directory: path.join(dir, "demo"),
      autoStart: false,
      startMode: "tui",
      openAttachOnNew: false,
      username: "",
      password: "",
      ...(projectPatch || {}),
    },
    ...(extraProjects || {}),
  }

  const ocClientsByAlias = {}
  const ocCallsByAlias = {}
  for (const alias of Object.keys(projects)) {
    const perAliasOptions = alias === "demo" ? { startupSessions, messagesById, ...(ocOptions || {}) } : { ...(ocOptionsByAlias?.[alias] || {}) }
    const { client, calls } = createFakeOpenCodeClient(perAliasOptions)
    ocClientsByAlias[alias] = client
    ocCallsByAlias[alias] = calls
  }

  const oc = ocClientsByAlias.demo
  const ocCalls = ocCallsByAlias.demo
  const sseHandlers = new Map()

  const config = {
    stateFile,
    cwd: dir,
    defaultProject: undefined,
    tgPrefix: "[TG] ",
    echoFilterMode: "recent",
    allowInsecureHttp: false,
    telegram: {
      botToken: "test-token",
      allowedUserId: 42,
    },
    projects,
  }

  const ocAliases = Object.keys(projects)

  const connector = await startConnector({
    config,
    logger: makeLogger(),
    deps: {
      createTelegramClient: () => tg,
      createOpenCodeClient: () => ocClientsByAlias[ocAliases.shift()],
      startSseLoop: ({ projectAlias, ...rest }) => {
        sseHandlers.set(projectAlias, rest)
        return { stop() {} }
      },
      ...(ensureOpenCodeRunningImpl ? { ensureOpenCodeRunning: ensureOpenCodeRunningImpl } : {}),
      ...(ensureStartupSessionImpl ? { ensureStartupSession: ensureStartupSessionImpl } : {}),
      ...(openAttachWindowWindowsImpl ? { openAttachWindowWindows: openAttachWindowWindowsImpl } : {}),
      ...(platform ? { platform } : {}),
      delay: delayImpl,
    },
  })

  return {
    dir,
    stateFile,
    tg,
    oc,
    ocCalls,
    ocByAlias: ocClientsByAlias,
    ocCallsByAlias,
    connector,
    async emitSse(projectAlias, evt) {
      const handler = sseHandlers.get(projectAlias)
      assert.ok(handler, `Missing SSE handler for ${projectAlias}`)
      await handler.onEvent({ projectAlias, evt })
    },
    async connectSse(projectAlias) {
      const handler = sseHandlers.get(projectAlias)
      assert.ok(handler, `Missing SSE handler for ${projectAlias}`)
      await handler.onConnect?.({ projectAlias })
    },
    async failSse(projectAlias, err) {
      const handler = sseHandlers.get(projectAlias)
      assert.ok(handler, `Missing SSE handler for ${projectAlias}`)
      await handler.onError?.({ projectAlias, err })
    },
  }
}

test("startConnector binds a thread and forwards only allowed-user messages", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(101, "/bind demo"))
    harness.tg.enqueue(makeMessageUpdate(102, "hello from telegram"))
    harness.tg.enqueue(makeMessageUpdate(103, "blocked", { userId: 999 }))

    await waitFor(() => harness.tg.pendingUpdates === 0 && harness.ocCalls.promptAsync.length === 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_startup" },
    })
    assert.deepEqual(state.sessionIndex, {
      "demo:ses_startup": { chatId: 100, threadIdOr0: 7 },
    })
    assert.equal(state.updateOffset, 104)
    assert.deepEqual(harness.ocCalls.promptAsync, [{ sessionId: "ses_startup", text: "[TG] hello from telegram" }])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text.includes("Bound to project 'demo'")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector mirrors assistant SSE output and /sendlast replays the latest assistant message", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 200,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_assistant: {
        info: { id: "msg_assistant", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Hello **world**" }],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_assistant",
          role: "assistant",
          time: { completed: completedAt },
        },
      },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].chatId, 100)
    assert.equal(harness.tg.sentHtmlBlocks[0].options.message_thread_id, 7)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Hello <b>world</b>")

    harness.tg.enqueue(makeMessageUpdate(201, "/sendlast"))
    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 2)

    assert.equal(harness.tg.sentHtmlBlocks[1].blocks[0].html, "Hello <b>world</b>")
    assert.deepEqual(harness.ocCalls.getMessage, [
      { sessionId: "ses_1", messageId: "msg_assistant" },
      { sessionId: "ses_1", messageId: "msg_assistant" },
    ])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use without arguments returns usage", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(211, "/use"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Usage: /use <sessionId|shareLink>"))
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use keeps supporting raw session ids", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 220,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(221, "/use ses_manual"))

    await waitFor(() => harness.ocCalls.getSession.includes("ses_manual"))
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_manual" },
    })
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text.includes("Switched to session: ses_manual")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use share link requires an existing binding", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(231, "/use https://opncd.ai/s/abc123"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Not bound. Use /bind <projectAlias> first."))
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use rejects unsupported links", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 240,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(241, "/use https://opncd.ai/session/ses_123"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.ok(
      harness.tg.sentMessages.some((entry) =>
        entry.text.startsWith("Unsupported link. Use an OpenCode share link like https://opncd.ai/s/<share-id> or a raw session id."),
      ),
    )
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use accepts a shared session link for the current project", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 250,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: () => [
        { id: "ses_current", title: "Current" },
        { id: "ses_shared", title: "Shared", share: { url: "https://opncd.ai/s/abc123/" } },
      ],
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(251, "/use https://opncd.ai/s/abc123?utm_source=tg"))

    await waitFor(() => harness.ocCalls.getSession.includes("ses_shared"))
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_shared" },
    })
    assert.ok(
      harness.ocCalls.listSessions.some(
        (call) => call?.directory === path.join(harness.dir, "demo") && !Object.hasOwn(call, "limit"),
      ),
    )
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text.includes("Switched to session: ses_shared")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use reports when a shared session link is not found", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 255,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: () => [{ id: "ses_current", title: "Current" }],
    },
    extraProjects: {
      other: {
        baseUrl: "http://127.0.0.1:4313",
        directory: path.join(os.tmpdir(), `telegram-connector-other-${crypto.randomUUID()}`),
        autoStart: false,
        startMode: "tui",
        openAttachOnNew: false,
        username: "",
        password: "",
      },
    },
    ocOptionsByAlias: {
      other: {
        listSessionsImpl: () => [{ id: "ses_other", share: { url: "https://opncd.ai/s/not-this-one" } }],
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(256, "/use https://opncd.ai/s/missing"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(
      harness.tg.sentMessages.some((entry) => entry.text.includes("Share link not found in project 'demo'")),
    )
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector rejects a shared session link from a different project", async () => {
  const otherDir = path.join(os.tmpdir(), `telegram-connector-other-${crypto.randomUUID()}`)
  const harness = await createHarness({
    statePatch: {
      updateOffset: 260,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: () => [{ id: "ses_current", title: "Current" }],
    },
    extraProjects: {
      other: {
        baseUrl: "http://127.0.0.1:4313",
        directory: otherDir,
        autoStart: false,
        startMode: "tui",
        openAttachOnNew: false,
        username: "",
        password: "",
      },
    },
    ocOptionsByAlias: {
      other: {
        listSessionsImpl: () => [{ id: "ses_other", share: { url: "https://opncd.ai/s/xyz789" } }],
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(261, "/use https://opncd.ai/s/xyz789"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(
      harness.tg.sentMessages.some((entry) => entry.text.includes("belongs to project 'other'") && entry.text.includes("Use /bind other first")),
    )
    assert.ok(harness.ocCallsByAlias.other.listSessions.some((call) => call?.directory === otherDir && !Object.hasOwn(call, "limit")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use keeps checking other projects when one lookup fails", async () => {
  const brokenDir = path.join(os.tmpdir(), `telegram-connector-broken-${crypto.randomUUID()}`)
  const otherDir = path.join(os.tmpdir(), `telegram-connector-other-${crypto.randomUUID()}`)
  const harness = await createHarness({
    statePatch: {
      updateOffset: 270,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: () => [{ id: "ses_current", title: "Current" }],
    },
    extraProjects: {
      broken: {
        baseUrl: "http://127.0.0.1:4313",
        directory: brokenDir,
        autoStart: false,
        startMode: "tui",
        openAttachOnNew: false,
        username: "",
        password: "",
      },
      other: {
        baseUrl: "http://127.0.0.1:4314",
        directory: otherDir,
        autoStart: false,
        startMode: "tui",
        openAttachOnNew: false,
        username: "",
        password: "",
      },
    },
    ocOptionsByAlias: {
      broken: {
        listSessionsImpl: () => {
          throw new Error("temporary failure")
        },
      },
      other: {
        listSessionsImpl: () => [{ id: "ses_other", share: { url: "https://opncd.ai/s/xyz789" } }],
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(271, "/use https://opncd.ai/s/xyz789"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(
      harness.tg.sentMessages.some((entry) => entry.text.includes("belongs to project 'other'") && entry.text.includes("Use /bind other first")),
    )
    assert.ok(harness.ocCallsByAlias.broken.listSessions.some((call) => call?.directory === brokenDir && !Object.hasOwn(call, "limit")))
    assert.ok(harness.ocCallsByAlias.other.listSessions.some((call) => call?.directory === otherDir && !Object.hasOwn(call, "limit")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use reports cross-project lookup failures honestly", async () => {
  const brokenDir = path.join(os.tmpdir(), `telegram-connector-broken-${crypto.randomUUID()}`)
  const harness = await createHarness({
    statePatch: {
      updateOffset: 280,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: () => [{ id: "ses_current", title: "Current" }],
    },
    extraProjects: {
      broken: {
        baseUrl: "http://127.0.0.1:4313",
        directory: brokenDir,
        autoStart: false,
        startMode: "tui",
        openAttachOnNew: false,
        username: "",
        password: "",
      },
    },
    ocOptionsByAlias: {
      broken: {
        listSessionsImpl: () => {
          throw new Error("temporary failure")
        },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(281, "/use https://opncd.ai/s/missing"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(
      harness.tg.sentMessages.some(
        (entry) =>
          entry.text.includes("Share link was not found in project 'demo'") &&
          entry.text.includes("these project lookups failed: broken"),
      ),
    )
    assert.ok(harness.ocCallsByAlias.broken.listSessions.some((call) => call?.directory === brokenDir && !Object.hasOwn(call, "limit")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /abort aborts the currently bound session", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 290,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(291, "/abort"))

    await waitFor(() => harness.ocCalls.abortSession.length === 1)

    assert.deepEqual(harness.ocCalls.abortSession, ["ses_current"])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Abort requested for session: ses_current"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /abort without binding returns guidance", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(292, "/abort"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.deepEqual(harness.ocCalls.abortSession, [])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Not bound. Use /bind <projectAlias> first."))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /status shows startup session, SSE status, and sanitized base URL", async () => {
  let startupCalls = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 293,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      baseUrl: "http://user:secret@example.test:4312/path?token=abc#frag",
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupCalls += 1
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await waitFor(() => startupCalls > 0)
    await harness.connectSse("demo")
    harness.tg.enqueue(makeMessageUpdate(294, "/status"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const status = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(status, /Project: demo/)
    assert.match(status, /Session: ses_current/)
    assert.match(status, /Startup session: ses_startup/)
    assert.match(status, /SSE: connected/)
    assert.match(status, /Base URL: http:\/\/example\.test:4312\/path\?token=\*\*\*/) 
    assert.doesNotMatch(status, /secret|user|frag|abc/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /status keeps SSE connected after a non-SSE request failure", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 295,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: async () => {
        throw new Error("GET /session failed: 503 unavailable")
      },
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await harness.connectSse("demo")
    harness.tg.enqueue(makeMessageUpdate(296, "/sessions"))
    harness.tg.enqueue(makeMessageUpdate(297, "/status"))

    await waitFor(() => harness.tg.sentMessages.length >= 2)

    const unavailable = harness.tg.sentMessages[0]?.text || ""
    const status = harness.tg.sentMessages[1]?.text || ""
    assert.match(unavailable, /Project 'demo' is unavailable/)
    assert.match(status, /SSE: connected/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /bindings refuses to leak bindings in group chats", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 298,
      bindings: {
        "100:0": { projectAlias: "demo", sessionId: "ses_main" },
        "100:11": { projectAlias: "demo", sessionId: "ses_topic" },
        "200:3": { projectAlias: "demo", sessionId: "ses_other" },
      },
      sessionIndex: {
        "demo:ses_main": { chatId: 100, threadIdOr0: 0 },
        "demo:ses_topic": { chatId: 100, threadIdOr0: 11 },
        "demo:ses_other": { chatId: 200, threadIdOr0: 3 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(299, "/bindings", { threadIdOr0: 11 }))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const text = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(text, /private chat/i)
    assert.doesNotMatch(text, /ses_main|ses_topic|ses_other/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /bindings lists all active bindings in a private chat", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 300,
      bindings: {
        "42:0": { projectAlias: "demo", sessionId: "ses_dm" },
        "100:0": { projectAlias: "demo", sessionId: "ses_main" },
        "100:11": { projectAlias: "demo", sessionId: "ses_topic" },
        "200:3": { projectAlias: "demo", sessionId: "ses_other" },
      },
      sessionIndex: {
        "demo:ses_dm": { chatId: 42, threadIdOr0: 0 },
        "demo:ses_main": { chatId: 100, threadIdOr0: 0 },
        "demo:ses_topic": { chatId: 100, threadIdOr0: 11 },
        "demo:ses_other": { chatId: 200, threadIdOr0: 3 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(301, "/bindings", { chatId: 42, chatType: "private", threadIdOr0: 0 }))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const text = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(text, /^Bindings:/)
    assert.match(text, /- chat 42 \/ main \(current\) -> demo \/ ses_dm/)
    assert.match(text, /- chat 100 \/ main -> demo \/ ses_main/)
    assert.match(text, /- chat 100 \/ topic 11 -> demo \/ ses_topic/)
    assert.match(text, /- chat 200 \/ topic 3 -> demo \/ ses_other/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /unbind removes the current binding and blocks further prompts", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 297,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(298, "/unbind"))
    harness.tg.enqueue(makeMessageUpdate(299, "hello after unbind"))

    await waitFor(
      () =>
        harness.tg.sentMessages.some((entry) => entry.text === "Unbound.") &&
        harness.tg.sentMessages.some((entry) => entry.text === "Not bound. Use /bind <projectAlias>."),
    )
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(harness.ocCalls.promptAsync, [])
    assert.deepEqual(state.bindings, {})
    assert.deepEqual(state.sessionIndex, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector restores persisted multi-topic bindings after restart", async () => {
  const firstHarness = await createHarness({
    statePatch: {
      updateOffset: 350,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_alpha" },
        "100:9": { projectAlias: "demo", sessionId: "ses_beta" },
      },
      sessionIndex: {
        "demo:ses_alpha": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_beta": { chatId: 100, threadIdOr0: 9 },
      },
    },
  })

  let persistedState
  try {
    await firstHarness.connector.stop()
    persistedState = await readState(firstHarness.stateFile)
  } finally {
    await firstHarness.connector.stop()
  }

  const secondHarness = await createHarness({
    statePatch: persistedState,
  })

  try {
    secondHarness.tg.enqueue(makeMessageUpdate(351, "hello alpha", { threadIdOr0: 7 }))
    secondHarness.tg.enqueue(makeMessageUpdate(352, "hello beta", { threadIdOr0: 9 }))

    await waitFor(() => secondHarness.ocCalls.promptAsync.length === 2)

    assert.deepEqual(secondHarness.ocCalls.promptAsync, [
      { sessionId: "ses_alpha", text: "[TG] hello alpha" },
      { sessionId: "ses_beta", text: "[TG] hello beta" },
    ])
  } finally {
    await secondHarness.connector.stop()
  }
})

test("startConnector delivers permission prompts and handles allow callbacks", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 300,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID: "ses_1",
        permission: "shell",
        patterns: ["npm test"],
      },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1)
    const prompt = harness.tg.sentHtmlBlocks[0]
    assert.match(prompt.blocks[0].html, /Permission request/)
    assert.match(prompt.blocks[0].html, /Project: demo/)
    assert.match(prompt.blocks[0].html, /Permission: shell/)
    assert.deepEqual(prompt.replyMarkup.inline_keyboard[0].map((button) => button.text), ["Allow once", "Always allow"])

    harness.tg.enqueue(makeCallbackUpdate(301, "p|demo|perm_1|once"))
    await waitFor(() => harness.ocCalls.replyPermission.length === 1)

    assert.deepEqual(harness.ocCalls.replyPermission, [{ permissionId: "perm_1", payload: { reply: "once" } }])
    assert.deepEqual(harness.tg.callbackAnswers, [{ callbackQueryId: "cb_301", text: "OK" }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector completes multi-step question wizard flows", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 400,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "question.asked",
      properties: {
        id: "q_1",
        sessionID: "ses_1",
        questions: [
          {
            header: "Pick checks",
            question: "Which checks should run?",
            multiple: true,
            options: [{ label: "lint" }, { label: "test" }],
          },
          {
            header: "Reason",
            question: "Why do you want this?",
            custom: true,
            options: [],
          },
        ],
      },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1 && harness.tg.sentMessages.length >= 1)
    assert.match(harness.tg.sentHtmlBlocks[0].blocks[0].html, /Question request/)
    assert.match(harness.tg.sentMessages[0].text, /Pick checks \(1\/2\)/)

    const firstStepMessageId = harness.tg.sentMessages[0].result.message_id
    harness.tg.enqueue(makeCallbackUpdate(401, "q|demo|q_1|0|t|0", { messageId: firstStepMessageId }))
    await waitFor(() => harness.tg.editedMessages.length >= 1)
    assert.equal(harness.tg.editedMessages[0].kind, "text")

    harness.tg.enqueue(makeCallbackUpdate(402, "q|demo|q_1|0|done", { messageId: firstStepMessageId }))
    await waitFor(() => harness.tg.sentMessages.length >= 2)
    assert.match(harness.tg.sentMessages[1].text, /Reason \(2\/2\)/)

    const secondStepMessageId = harness.tg.sentMessages[1].result.message_id
    harness.tg.enqueue(makeCallbackUpdate(403, "q|demo|q_1|1|custom", { messageId: secondStepMessageId }))
    await waitFor(() => harness.tg.sentMessages.length >= 3)
    assert.match(harness.tg.sentMessages[2].text, /Send your answer for: Reason/)

    harness.tg.enqueue(makeMessageUpdate(404, "because safety matters"))
    await waitFor(() => harness.ocCalls.replyQuestion.length === 1)

    assert.deepEqual(harness.ocCalls.replyQuestion, [
      { questionId: "q_1", answers: [["lint"], ["because safety matters"]] },
    ])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Answered: q_1"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector offers a start button on connect errors and recovers after start callback", async () => {
  const startCalls = []
  let promptAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 500,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      autoStart: true,
      port: 4312,
    },
    ocOptions: {
      promptAsyncImpl: async () => {
        promptAttempts += 1
        throw new Error("ECONNREFUSED: connect failed")
      },
    },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      if (startCalls.length === 1) throw new Error("initial start failed")
      return { stop() {} }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_1"
      return "ses_1"
    },
  })

  try {
    await waitFor(() => startCalls.length >= 1 && harness.tg.sentMessages.length >= 1)
    const sentBeforePrompt = harness.tg.sentMessages.length

    harness.tg.enqueue(makeMessageUpdate(501, "hello after outage"))
    await waitFor(() => promptAttempts === 1 && harness.tg.sentMessages.length > sentBeforePrompt)

    const recoveryPrompt = harness.tg.sentMessages.slice(sentBeforePrompt).find((entry) => {
      return entry.replyMarkup?.inline_keyboard?.[0]?.[0]?.text === "Start 'demo'"
    })
    assert.ok(recoveryPrompt)
    assert.match(recoveryPrompt.text, /Project 'demo' is unavailable/)

    harness.tg.enqueue(makeCallbackUpdate(502, "srv|demo|start", { messageId: recoveryPrompt.result.message_id }))
    await waitFor(() => startCalls.length >= 2)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text === "Starting opencode for 'demo'…"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Project 'demo' is up:")))

    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_502" && entry.text === "Starting…"))
    assert.deepEqual(startCalls, ["demo", "demo"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector drains old backlog before processing live updates and advances offset", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: null,
    },
    initialUpdates: [makeMessageUpdate(10, "/help"), makeMessageUpdate(11, "/help"), makeMessageUpdate(12, "/help")],
  })

  try {
    await waitFor(() => harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30))
    harness.tg.enqueue(makeMessageUpdate(13, "/help"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(harness.tg.sentMessages.length, 1)
    assert.match(harness.tg.sentMessages[0].text, /Commands:/)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 0 && call?.offset === 0))
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 13))
    assert.equal(state.updateOffset, 14)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector replays remaining updates after a mid-batch Telegram handler failure", async () => {
  let sendAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 600,
    },
    tgOptions: {
      sendMessageImpl: async () => {
        sendAttempts += 1
        if (sendAttempts === 2) throw new Error("temporary send failure")
      },
    },
    initialUpdates: [
      [makeMessageUpdate(600, "/help"), makeMessageUpdate(601, "/help"), makeMessageUpdate(602, "/help")],
      [makeMessageUpdate(601, "/help"), makeMessageUpdate(602, "/help")],
    ],
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length === 3)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 603)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 600))
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 601))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector opens an attach window after /new when openAttachOnNew is enabled on Windows", async () => {
  const attachCalls = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: 700,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNew: true,
    },
    ocOptions: {
      createSessionImpl: async (input) => ({ id: `ses_new:${input.title}` }),
    },
    openAttachWindowWindowsImpl: async (args) => {
      attachCalls.push(args)
    },
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(701, "/new Demo title"))
    await waitFor(() => attachCalls.length === 1)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(attachCalls, [
      {
        directory: path.join(harness.dir, "demo"),
        baseUrl: "http://127.0.0.1:4312",
        sessionId: "ses_new:Demo title",
      },
    ])
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_new:Demo title" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector skips attach window auto-open after /new on non-Windows platforms", async () => {
  const attachCalls = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: 800,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNew: true,
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_linux" }),
    },
    openAttachWindowWindowsImpl: async (args) => {
      attachCalls.push(args)
    },
    platform: "linux",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(801, "/new Linux title"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text === "Created and switched to session: ses_linux"))
    await harness.connector.stop()

    assert.deepEqual(attachCalls, [])
  } finally {
    await harness.connector.stop()
  }
})
