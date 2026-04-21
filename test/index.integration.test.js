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

function makeMessageUpdate(updateId, text, { userId = 42, chatId = 100, threadIdOr0 = 7, messageId = updateId } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: "supergroup" },
      from: { id: userId },
      ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      text,
    },
  }
}

function makeCallbackUpdate(updateId, data, { userId = 42, chatId = 100, threadIdOr0 = 7, messageId = 900 } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId },
      data,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "supergroup" },
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
    listSessions: 0,
    getSession: [],
    createSession: [],
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
    async listSessions() {
      calls.listSessions += 1
      return listSessionsImpl ? listSessionsImpl() : startupSessions
    },
    async getSession(sessionId) {
      calls.getSession.push(sessionId)
      return getSessionImpl ? getSessionImpl(sessionId) : { id: sessionId, parentID: null }
    },
    async createSession(input = {}) {
      calls.createSession.push(input)
      return createSessionImpl ? createSessionImpl(input) : { id: "ses_created" }
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
  projectPatch,
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
  const { client: oc, calls: ocCalls } = createFakeOpenCodeClient({ startupSessions, messagesById, ...(ocOptions || {}) })
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
    projects: {
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
    },
  }

  const connector = await startConnector({
    config,
    logger: makeLogger(),
    deps: {
      createTelegramClient: () => tg,
      createOpenCodeClient: () => oc,
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
    connector,
    async emitSse(projectAlias, evt) {
      const handler = sseHandlers.get(projectAlias)
      assert.ok(handler, `Missing SSE handler for ${projectAlias}`)
      await handler.onEvent({ projectAlias, evt })
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
