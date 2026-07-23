import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { startConnector } from "../src/index.js"
import { makeBoundaryError } from "../src/boundary-errors.js"
import { defaultState, StateStore } from "../src/state/store.js"
import { permissionReplyIdempotencyKey, questionReplyIdempotencyKey } from "../src/connector/idempotency.js"
import { makeCallbackStore } from "../src/runtime/connector-bootstrap.js"
import { getRequestContext } from "../src/runtime/request-context.js"
import { startHealthServer } from "../src/runtime/health-server.js"
import { canonicalOpenCodeSseEventPath, openCodeSseEventPathRequiresDirectoryRouting, OPENCODE_SSE_EVENT_META } from "../src/opencode/sse.js"
import { USER_ATTACHMENT_LIMITS } from "../src/connector/incoming-attachments.js"
import { formatMarkdownToTelegramHtmlBlocks } from "../src/telegram/formatter.js"
import { formatUserMirrorBlocks } from "../src/connector/mirroring/user-format.js"
import { formatChangedFilesText } from "../src/message-display.js"
import { splitTelegramText } from "../src/telegram/client.js"
import { createDurableOutboxRuntime } from "../src/runtime/durable-outbox-runtime.js"

function makeLogger(entries) {
  const push = (level, args) => entries?.push({ level, args })
  return {
    info(...args) { push("info", args) },
    warn(...args) { push("warn", args) },
    error(...args) { push("error", args) },
    debug(...args) { push("debug", args) },
  }
}

function shortDelay(ms) {
  return delay(Math.min(ms, 2))
}

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function withSseEventMeta(evt, meta = {}) {
  const eventPath = canonicalOpenCodeSseEventPath(meta.eventPath || "/global/event")
  Object.defineProperty(evt, OPENCODE_SSE_EVENT_META, {
    value: Object.freeze({
      directory: typeof meta.directory === "string" && meta.directory.trim() ? meta.directory.trim() : null,
      eventPath,
      wrapped: meta.wrapped ?? true,
      requiresDirectoryRouting: meta.requiresDirectoryRouting ?? openCodeSseEventPathRequiresDirectoryRouting(eventPath),
    }),
    enumerable: false,
  })
  return evt
}

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function makeFakeLauncherDir(t, ...names) {
  const dir = await makeTempDir()
  for (const name of names) {
    await fs.writeFile(path.join(dir, name), "", "utf8")
  }
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
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

function makeMessageUpdate(updateId, text, { userId = 42, chatId = 100, chatType = "supergroup", threadIdOr0 = 7, messageId = updateId, languageCode } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: chatType },
      from: { id: userId, ...(languageCode ? { language_code: languageCode } : {}) },
      ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      text,
    },
  }
}

function makeCallbackUpdate(updateId, data, { userId = 42, chatId = 100, chatType = "supergroup", threadIdOr0 = 7, messageId = 900, languageCode } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId, ...(languageCode ? { language_code: languageCode } : {}) },
      data,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: chatType },
        ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      },
    },
  }
}

function makeDocumentUpdate(updateId, document, { userId = 42, chatId = 100, chatType = "supergroup", threadIdOr0 = 7, messageId = updateId, caption = "" } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: chatType },
      from: { id: userId },
      ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
      ...(caption ? { caption } : {}),
      document,
    },
  }
}

function acceptedThenLostOpenCodeOptions() {
  const accepted = new Map()
  return {
    accepted,
    options: {
      promptAsyncImpl: async (sessionId, text, options) => {
        accepted.set(options.messageID, { info: { id: options.messageID, role: "user", sessionID: sessionId }, parts: [{ type: "text", text }] })
        throw makeBoundaryError({
          source: "opencode",
          operation: "POST /session/:id/prompt_async",
          method: "POST",
          pathname: `/session/${sessionId}/prompt_async`,
          status: 503,
          outcome: "retryable",
          message: "response lost after accept",
        })
      },
      getMessageImpl: async (_sessionId, messageId) => {
        const message = accepted.get(messageId)
        if (message) return message
        throw makeBoundaryError({ source: "opencode", operation: "GET message", status: 404, outcome: "stale", message: "not found" })
      },
    },
  }
}

function createFakeTelegramClient({ emptyPollDelayMs = 10, getMeImpl, setMyCommandsImpl, sendMessageImpl, sendHtmlBlocksImpl, sendDocumentImpl, editMessageTextImpl, getFileImpl, downloadFileImpl, beforeGetUpdates, afterNegativeOffsetSnapshot } = {}) {
  let nextMessageId = 1000
  const updates = []
  const sentMessages = []
  const sentHtmlBlocks = []
  const sentDocuments = []
  const callbackAnswers = []
  const editedMessages = []
  const deletedMessages = []
  const getUpdatesCalls = []
  const setMyCommandsCalls = []
  const getUpdatesErrors = []
  let getUpdatesError = null

  return {
    sentMessages,
    sentHtmlBlocks,
    sentDocuments,
    callbackAnswers,
    editedMessages,
    deletedMessages,
    getUpdatesCalls,
    setMyCommandsCalls,
    enqueue(update) {
      updates.push(update)
    },
    enqueueBatch(batch) {
      updates.push(batch)
    },
    enqueueGetUpdatesError(err) {
      getUpdatesErrors.push(err)
    },
    setGetUpdatesError(err) {
      getUpdatesError = err || null
    },
    get pendingUpdates() {
      return updates.length
    },
    async getMe() {
      if (getMeImpl) return getMeImpl()
      return { id: 1, username: "test_bot", has_topics_enabled: true }
    },
    async setMyCommands(commands, options = {}) {
      setMyCommandsCalls.push({ commands, options })
      if (setMyCommandsImpl) return setMyCommandsImpl({ commands, options, callIndex: setMyCommandsCalls.length })
      return true
    },
    async getUpdates(input) {
      getUpdatesCalls.push(input)
      await beforeGetUpdates?.({
        input,
        callIndex: getUpdatesCalls.length,
        enqueue(update) { updates.push(update) },
      })
      if (getUpdatesError) throw getUpdatesError
      if (getUpdatesErrors.length > 0) throw getUpdatesErrors.shift()
      if (input?.offset < 0) {
        const pending = updates.splice(0).flatMap((entry) => Array.isArray(entry) ? entry : [entry])
        const count = Math.max(1, Math.abs(Math.trunc(input.offset)))
        const result = pending.slice(-count)
        await afterNegativeOffsetSnapshot?.({
          input,
          result,
          enqueue(update) { updates.push(update) },
        })
        return result
      }
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
      const maybeResult = sendHtmlBlocksImpl
        ? await sendHtmlBlocksImpl({ chatId, blocks, replyMarkup, options, result, callIndex: sentHtmlBlocks.length + 1 })
        : undefined
      const finalResult = maybeResult ?? result
      sentHtmlBlocks.push({ chatId, blocks, replyMarkup, options, result: finalResult })
      return finalResult
    },
    async sendDocument(chatId, contents, filename, caption, options = {}) {
      const result = { message_id: nextMessageId++ }
      const maybeResult = sendDocumentImpl
        ? await sendDocumentImpl({ chatId, contents, filename, caption, options, result, callIndex: sentDocuments.length + 1 })
        : undefined
      const finalResult = maybeResult ?? result
      sentDocuments.push({ chatId, contents, filename, caption, options, result: finalResult })
      return finalResult
    },
    async editMessageText(chatId, messageId, text, replyMarkup, options = {}) {
      if (editMessageTextImpl) {
        await editMessageTextImpl({ chatId, messageId, text, replyMarkup, options, callIndex: editedMessages.length + 1 })
      }
      editedMessages.push({ kind: "text", chatId, messageId, text, replyMarkup, options })
      return { message_id: messageId }
    },
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      editedMessages.push({ kind: "replyMarkup", chatId, messageId, replyMarkup })
      return true
    },
    async deleteMessage(chatId, messageId) {
      deletedMessages.push({ chatId, messageId })
      return true
    },
    async answerCallbackQuery(callbackQueryId, text) {
      callbackAnswers.push({ callbackQueryId, text })
      return true
    },
    async getFile(fileId) {
      if (getFileImpl) return getFileImpl(fileId)
      return { file_path: `files/${fileId}.txt`, file_size: 16 }
    },
    async downloadFile(filePath, options) {
      if (downloadFileImpl) return downloadFileImpl(filePath, options)
      return new TextEncoder().encode("attachment text")
    },
  }
}

function createFakeOpenCodeClient({
  startupSessions,
  messagesById = {},
  healthImpl,
  getConfigImpl,
  getConfigProvidersImpl,
  listSessionsImpl,
  getSessionImpl,
  createSessionImpl,
  selectTuiSessionImpl,
  getActiveTuiSessionImpl,
  abortSessionImpl,
  promptAsyncImpl,
  getMessageImpl,
  listMessagesImpl,
  replyPermissionImpl,
  listPermissionsImpl,
  listQuestionsImpl,
  replyQuestionImpl,
  rejectQuestionImpl,
} = {}) {
  function defaultStartupSessions(input = {}) {
    return input?.directory ? [{ id: "ses_startup", directory: input.directory }] : [{ id: "ses_startup" }]
  }

  const calls = {
    health: 0,
    getConfig: [],
    getConfigProviders: 0,
    listSessions: [],
    getSession: [],
    createSession: [],
    selectTuiSession: [],
    getActiveTuiSession: [],
    abortSession: [],
    promptAsync: [],
    promptMessageIDs: [],
    getMessage: [],
    listMessages: [],
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
    async getConfig(input = {}) {
      calls.getConfig.push(input)
      return getConfigImpl ? getConfigImpl(input) : { model: "openai/gpt-5" }
    },
    async getConfigProviders() {
      calls.getConfigProviders += 1
      return getConfigProvidersImpl ? getConfigProvidersImpl() : { providers: [], default: {} }
    },
    async listSessions(input = {}) {
      calls.listSessions.push(input)
      return listSessionsImpl ? listSessionsImpl(input) : (startupSessions ?? defaultStartupSessions(input))
    },
    async getSession(sessionId) {
      calls.getSession.push(sessionId)
      return getSessionImpl ? getSessionImpl(sessionId) : { id: sessionId, parentID: null }
    },
    async createSession(input = {}) {
      calls.createSession.push(input)
      const created = createSessionImpl ? await createSessionImpl(input) : { id: "ses_created" }
      if (input?.directory && created && typeof created === "object" && !("directory" in created)) {
        return { ...created, directory: input.directory }
      }
      return created
    },
    async selectTuiSession(sessionId, options = {}) {
      calls.selectTuiSession.push(options === undefined ? { sessionId } : { sessionId, options })
      return selectTuiSessionImpl ? selectTuiSessionImpl(sessionId, options) : true
    },
    async getActiveTuiSession(options = {}) {
      calls.getActiveTuiSession.push(options)
      return getActiveTuiSessionImpl ? getActiveTuiSessionImpl(options) : null
    },
    async abortSession(sessionId) {
      calls.abortSession.push(sessionId)
      return abortSessionImpl ? abortSessionImpl(sessionId) : true
    },
    async promptAsync(sessionId, text, options = undefined) {
      const { messageID, ...legacyOptions } = options || {}
      calls.promptMessageIDs.push(messageID || null)
      calls.promptAsync.push(Object.keys(legacyOptions).length === 0 ? { sessionId, text } : { sessionId, text, options: legacyOptions })
      return promptAsyncImpl ? promptAsyncImpl(sessionId, text, options) : { ok: true }
    },
    async getMessage(sessionId, messageId, input = {}) {
      calls.getMessage.push({ sessionId, messageId })
      if (getMessageImpl) return getMessageImpl(sessionId, messageId, input)
      if (messagesById[messageId] != null) return messagesById[messageId]
      if (String(messageId).startsWith("msg_tgc_")) {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET prompt message",
          method: "GET",
          pathname: `/session/${sessionId}/message/${messageId}`,
          status: 404,
          outcome: "stale",
          message: "message not found",
        })
      }
      return null
    },
    async listMessages(sessionId, input = {}) {
      calls.listMessages.push({ sessionId, input })
      return listMessagesImpl ? listMessagesImpl(sessionId, input) : []
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
  startSseLoopImpl,
  startHealthServerImpl,
  onFatalErrorImpl,
  ensureOpenCodeRunningImpl,
  stopOpenCodeServeOnPortImpl,
  stopOpenCodeUiOnPortImpl,
  ensureStartupSessionImpl,
  openAttachWindowWindowsImpl,
  platform,
  delayImpl = shortDelay,
  wizardTtlMs,
  wizardGcIntervalMs,
  assistantDrainTimeoutMs,
  autoStartStaggerMs,
  autoStartRetryDelayMs,
  autoStartRetryAttempts,
  opencodeWatchdog,
  createStateStoreImpl,
  createDurableOutboxRuntimeImpl,
  configPatch,
  logger = makeLogger(),
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
      openTuiOnAutoStart: true,
      openAttachOnNewMode: "same-window",
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
    ...(configPatch || {}),
  }

  const ocAliases = Object.keys(projects)

  const connector = await startConnector({
    config,
    logger,
    deps: {
      createTelegramClient: () => tg,
      ...(createStateStoreImpl ? { createStateStore: createStateStoreImpl } : {}),
      ...(createDurableOutboxRuntimeImpl ? { createDurableOutboxRuntime: createDurableOutboxRuntimeImpl } : {}),
      createOpenCodeClient: () => ocClientsByAlias[ocAliases.shift()],
      startSseLoop: ({ projectAlias, ...rest }) => {
        sseHandlers.set(projectAlias, rest)
        return startSseLoopImpl ? startSseLoopImpl({ projectAlias, ...rest }) : { stop() {} }
      },
      ...(startHealthServerImpl ? { startHealthServer: startHealthServerImpl } : {}),
      ...(onFatalErrorImpl ? { onFatalError: onFatalErrorImpl } : {}),
      ...(ensureOpenCodeRunningImpl ? { ensureOpenCodeRunning: ensureOpenCodeRunningImpl } : {}),
      ...(stopOpenCodeServeOnPortImpl ? { stopOpenCodeServeOnPort: stopOpenCodeServeOnPortImpl } : {}),
      ...(stopOpenCodeUiOnPortImpl ? { stopOpenCodeUiOnPort: stopOpenCodeUiOnPortImpl } : {}),
      ...(ensureStartupSessionImpl ? { ensureStartupSession: ensureStartupSessionImpl } : {}),
      ...(openAttachWindowWindowsImpl ? { openAttachWindowWindows: openAttachWindowWindowsImpl } : {}),
      ...(platform ? { platform } : {}),
      ...(wizardTtlMs != null ? { wizardTtlMs } : {}),
      ...(wizardGcIntervalMs != null ? { wizardGcIntervalMs } : {}),
      ...(assistantDrainTimeoutMs != null ? { assistantDrainTimeoutMs } : {}),
      ...(autoStartStaggerMs != null ? { autoStartStaggerMs } : {}),
      ...(autoStartRetryDelayMs != null ? { autoStartRetryDelayMs } : {}),
      ...(autoStartRetryAttempts != null ? { autoStartRetryAttempts } : {}),
      ...(opencodeWatchdog ? { opencodeWatchdog } : {}),
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
    hasSseHandler(projectAlias) {
      return sseHandlers.has(projectAlias)
    },
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

test("startConnector publishes localized Telegram command menus", async () => {
  const harness = await createHarness()

  try {
    await waitFor(() => harness.tg.setMyCommandsCalls.length >= 2)

    assert.equal(harness.tg.setMyCommandsCalls[0].options.language_code, undefined)
    assert.ok(harness.tg.setMyCommandsCalls[0].commands.some((entry) => entry.command === "language" && entry.description === "Choose bot language"))
    assert.equal(harness.tg.setMyCommandsCalls[1].options.language_code, "ru")
    assert.ok(harness.tg.setMyCommandsCalls[1].commands.some((entry) => entry.command === "language" && entry.description === "Выбрать язык бота"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector validates public API config before runtime startup", async () => {
  await assert.rejects(
    () => startConnector({ config: { telegram: { botToken: "x", allowedUserId: 42 } } }),
    /config\.projects is required/,
  )
  await assert.rejects(
    () => startConnector({ config: { telegram: { botToken: "x", allowedUserId: 42 }, projects: {} } }),
    /config\.projects must contain at least one project/,
  )
  await assert.rejects(
    () => startConnector({ config: { telegram: { botToken: "x" }, projects: { demo: { baseUrl: "http:\/\/127.0.0.1:4312" } } } }),
    /config\.telegram\.allowedUserId must be an integer/,
  )
  await assert.rejects(
    () => startConnector({ config: { telegram: { botToken: "x", allowedUserId: 42 }, projects: { demo: {} } } }),
    /config\.projects\.demo\.baseUrl is required/,
  )
})

test("startConnector prunes expired callback payloads from current-schema state on startup", async () => {
  const harness = await createHarness({
    statePatch: {
      callbackPayloads: {
        expired_token: { data: "expired", createdAt: 1, expiresAt: 2 },
        live_token: { data: "live", createdAt: 10, expiresAt: Date.now() + 60_000 },
      },
    },
  })

  try {
    const state = await readState(harness.stateFile)
    assert.deepEqual(Object.keys(state.callbackPayloads), ["live_token"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector continues publishing bot command locales after one locale fails", async () => {
  const harness = await createHarness({
    configPatch: { i18n: { defaultLocale: "en", supportedLocales: ["en", "ru"], botCommandLocales: ["en", "ru"] } },
    tgOptions: {
      setMyCommandsImpl: ({ options }) => {
        if (!options.language_code) throw new Error("telegram rejected default menu")
        return true
      },
    },
  })

  try {
    await waitFor(() => harness.tg.setMyCommandsCalls.length >= 2)

    assert.equal(harness.tg.setMyCommandsCalls[0].options.language_code, undefined)
    assert.equal(harness.tg.setMyCommandsCalls[1].options.language_code, "ru")
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector detects and changes thread language", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(101, "/language", { languageCode: "ru-RU" }))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Язык для этого треда")))

    let state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.localeByContext?.["100:7"]?.locale === "ru" ? current : null
    })
    assert.deepEqual(state.localeByContext, { "100:7": { locale: "ru", source: "telegram" } })

    const keyboard = harness.tg.sentMessages.at(-1).replyMarkup.inline_keyboard
    const englishButton = keyboard.flat().find((button) => button.text.includes("English"))
    assert.ok(englishButton)

    harness.tg.enqueue(makeCallbackUpdate(102, englishButton.callback_data, { languageCode: "ru-RU", messageId: harness.tg.sentMessages.at(-1).result.message_id }))
    await waitFor(() => harness.tg.editedMessages.some((entry) => entry.kind === "text" && entry.text.includes("Language for this thread")))

    state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.localeByContext?.["100:7"]?.locale === "en" ? current : null
    })
    assert.deepEqual(state.localeByContext, { "100:7": { locale: "en", source: "manual" } })
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.text === "Language changed to English."))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector ignores stored Telegram-detected locales when auto-detect is disabled", async () => {
  const harness = await createHarness({
    configPatch: { i18n: { defaultLocale: "en", autoDetectTelegramLanguage: false } },
    statePatch: { localeByContext: { "100:7": { locale: "ru", source: "telegram" } } },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(103, "/language", { languageCode: "ru-RU" }))
    await waitFor(() => harness.tg.sentMessages.length > 0)

    assert.match(harness.tg.sentMessages.at(-1).text, /Language for this thread:/)
    assert.doesNotMatch(harness.tg.sentMessages.at(-1).text, /Язык для этого треда:/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector language reset falls back to default when detection is disabled", async () => {
  const harness = await createHarness({
    configPatch: { i18n: { defaultLocale: "en", autoDetectTelegramLanguage: false } },
    statePatch: { localeByContext: { "100:7": { locale: "ru", source: "manual" } } },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(104, "/language reset", { languageCode: "ru-RU" }))
    await waitFor(() => harness.tg.sentMessages.length > 0)

    assert.match(harness.tg.sentMessages.at(-1).text, /Language preference reset/)
    assert.match(harness.tg.sentMessages.at(-1).text, /Current: English/)
    const state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return !current.localeByContext?.["100:7"] ? current : null
    })
    assert.deepEqual(state.localeByContext, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector ignores stored locales outside current supportedLocales", async () => {
  const harness = await createHarness({
    configPatch: { i18n: { defaultLocale: "en", supportedLocales: ["en"] } },
    statePatch: { localeByContext: { "100:7": { locale: "ru", source: "manual" } } },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(105, "/language"))
    await waitFor(() => harness.tg.sentMessages.length > 0)

    assert.match(harness.tg.sentMessages.at(-1).text, /Language for this thread:/)
    assert.match(harness.tg.sentMessages.at(-1).text, /Current: English/)
    assert.doesNotMatch(harness.tg.sentMessages.at(-1).text, /русский/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector binds a thread and forwards only allowed-user messages", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(101, "/bind demo"))
    harness.tg.enqueue(makeMessageUpdate(102, "hello from telegram"))
    harness.tg.enqueue(makeMessageUpdate(103, "blocked", { userId: 999 }))

    await waitFor(
      () => harness.tg.pendingUpdates === 0 && harness.ocCalls.promptAsync.length === 1,
      { timeoutMs: 5000 },
    )
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

test("startConnector scopes Telegram message context through OpenCode prompts", async () => {
  const seenContexts = []
  const harness = await createHarness({
    statePatch: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_startup" } },
      sessionIndex: { "demo:ses_startup": { chatId: 100, threadIdOr0: 7 } },
    },
    ocOptions: {
      promptAsyncImpl: async () => {
        seenContexts.push(getRequestContext())
        return { ok: true }
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(101, "hello from telegram"))

    await waitFor(() => harness.ocCalls.promptAsync.length === 1 && seenContexts.length === 1)
    await harness.connector.stop()

    assert.match(seenContexts[0].correlationId, /^tg-101-message-/)
    assert.equal(seenContexts[0].source, "telegram")
    assert.equal(seenContexts[0].eventType, "message")
    assert.equal(seenContexts[0].updateId, 101)
    assert.equal(seenContexts[0].ctxKey, "100:7")
    assert.equal(seenContexts[0].projectAlias, "demo")
    assert.equal(seenContexts[0].sessionId, "ses_startup")
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector scopes Telegram callback context through OpenCode calls", async () => {
  const seenContexts = []
  const harness = await createHarness({
    statePatch: {
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_startup" } },
      sessionIndex: { "demo:ses_startup": { chatId: 100, threadIdOr0: 7 } },
    },
    startupSessions: [{ id: "ses_startup" }, { id: "ses_other" }],
    ocOptions: {
      getSessionImpl: async (sessionId) => {
        seenContexts.push(getRequestContext())
        return { id: sessionId, parentID: null }
      },
    },
  })

  try {
    harness.tg.enqueue(makeCallbackUpdate(101, JSON.stringify(["s", "demo", "ses_other"])))

    await waitFor(() => seenContexts.length >= 1)
    await harness.connector.stop()

    assert.match(seenContexts[0].correlationId, /^tg-101-callback-/)
    assert.equal(seenContexts[0].source, "telegram")
    assert.equal(seenContexts[0].eventType, "callback")
    assert.equal(seenContexts[0].updateId, 101)
    assert.equal(seenContexts[0].ctxKey, "100:7")
    assert.equal(seenContexts[0].projectAlias, "demo")
    assert.equal(seenContexts[0].sessionId, "ses_startup")
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector ignores commands addressed to another bot", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(101, "/start@OtherBot"))
    harness.tg.enqueue(makeMessageUpdate(102, "/start@test_bot"))

    await waitFor(() => harness.tg.pendingUpdates === 0 && harness.tg.sentMessages.length === 1)
    await harness.connector.stop()

    assert.match(harness.tg.sentMessages[0].text, /^Telegram connector help:/)
    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 103)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector fails startup when Telegram getMe authentication is rejected", async () => {
  for (const status of [401, 403]) {
    const loggerEntries = []
    await assert.rejects(
      () => createHarness({
        tgOptions: {
          getMeImpl: async () => {
            throw makeBoundaryError({
              source: "telegram",
              operation: "POST getMe",
              method: "POST",
              pathname: "/getMe",
              status,
              outcome: "fatal",
              message: `getMe failed: ${status === 401 ? "Unauthorized" : "Forbidden"}`,
            })
          },
        },
        logger: makeLogger(loggerEntries),
      }),
      status === 401 ? /Unauthorized/ : /Forbidden/,
    )
    assert.doesNotMatch(JSON.stringify(loggerEntries), /test-token/)
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

test("startConnector ignores global SSE events with missing or mismatched project directory", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const demoDir = path.join(os.tmpdir(), `telegram-connector-demo-${crypto.randomUUID()}`)
  const otherDir = path.join(os.tmpdir(), `telegram-connector-other-${crypto.randomUUID()}`)
  const harness = await createHarness({
    projectPatch: {
      directory: demoDir,
    },
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_missing_directory: {
        info: { id: "msg_missing_directory", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Unscoped global reply" }],
      },
      msg_foreign: {
        info: { id: "msg_foreign", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Foreign reply" }],
      },
      msg_local: {
        info: { id: "msg_local", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Local reply" }],
      },
    },
  })

  try {
    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_missing_directory", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: null },
      ),
    )
    await delay(350)

    assert.equal(harness.ocCalls.getMessage.length, 0)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)

    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_foreign", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: otherDir },
      ),
    )
    await delay(350)

    assert.equal(harness.ocCalls.getMessage.length, 0)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)

    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_local", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: demoDir },
      ),
    )

    await waitFor(() => harness.tg.sentHtmlBlocks.length === 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Local reply")
    assert.deepEqual(harness.ocCalls.getMessage, [{ sessionId: "ses_1", messageId: "msg_local" }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps remote POSIX SSE directory routing case-sensitive on Windows", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    platform: "win32",
    projectPatch: {
      directory: "/srv/App",
    },
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_foreign_case: {
        info: { id: "msg_foreign_case", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Wrong-case POSIX reply" }],
      },
      msg_local_case: {
        info: { id: "msg_local_case", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Exact-case POSIX reply" }],
      },
    },
  })

  try {
    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_foreign_case", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: "/srv/app" },
      ),
    )
    await delay(350)

    assert.equal(harness.ocCalls.getMessage.length, 0)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)

    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_local_case", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: "/srv/App" },
      ),
    )

    await waitFor(() => harness.tg.sentHtmlBlocks.length === 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Exact-case POSIX reply")
    assert.deepEqual(harness.ocCalls.getMessage, [{ sessionId: "ses_1", messageId: "msg_local_case" }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps Windows SSE directory routing case-insensitive", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    platform: "win32",
    projectPatch: {
      directory: "C:/Repo/App",
    },
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_windows_case: {
        info: { id: "msg_windows_case", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Windows-case reply" }],
      },
    },
  })

  try {
    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_windows_case", role: "assistant", time: { completed: completedAt } },
          },
        },
        { directory: "c:\\repo\\app" },
      ),
    )

    await waitFor(() => harness.tg.sentHtmlBlocks.length === 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Windows-case reply")
    assert.deepEqual(harness.ocCalls.getMessage, [{ sessionId: "ses_1", messageId: "msg_windows_case" }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector accepts legacy SSE /event events without directory metadata", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_legacy: {
        info: { id: "msg_legacy", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Legacy reply" }],
      },
    },
  })

  try {
    await harness.emitSse(
      "demo",
      withSseEventMeta(
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_1",
            info: { id: "msg_legacy", role: "assistant", time: { completed: completedAt } },
          },
        },
        { eventPath: "/event", wrapped: false, requiresDirectoryRouting: false },
      ),
    )

    await waitFor(() => harness.tg.sentHtmlBlocks.length === 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Legacy reply")
    assert.deepEqual(harness.ocCalls.getMessage, [{ sessionId: "ses_1", messageId: "msg_legacy" }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector disables default global SSE without project directory but keeps prompt polling", async (t) => {
  swapEnv(t, { OPENCODE_SSE_EVENT_PATH: undefined })
  const permission = { id: "perm_missing_directory_poll", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  let exposePermission = false
  let sseStarts = 0
  const loggerEntries = []
  const harness = await createHarness({
    projectPatch: {
      directory: undefined,
    },
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => (exposePermission ? [permission] : []),
      listQuestionsImpl: async () => [],
    },
    startSseLoopImpl: () => {
      sseStarts += 1
      return { stop() {} }
    },
    logger: makeLogger(loggerEntries),
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    await waitFor(() => loggerEntries.some((entry) =>
      entry.level === "error" &&
      entry.args[0] === "SSE disabled for project" &&
      entry.args[1]?.projectAlias === "demo" &&
      entry.args[1]?.reason === "project_directory_missing",
    ))

    const sseDisabledLogs = loggerEntries.filter((entry) =>
      entry.level === "error" &&
      entry.args[0] === "SSE disabled for project" &&
      entry.args[1]?.projectAlias === "demo" &&
      entry.args[1]?.reason === "project_directory_missing",
    )
    assert.equal(sseDisabledLogs.length, 1)
    assert.equal(sseStarts, 0)
    assert.equal(harness.hasSseHandler("demo"), false)

    exposePermission = true
    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_missing_directory_poll/.test(block.html))))

    harness.tg.enqueue(makeMessageUpdate(203, "/status"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => /SSE: unavailable \(missing directory\)/.test(entry.text)))
    const status = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(status, /SSE observed: retries=0 aborted=0 connected=never .*lastError=.*requires project 'directory'/)
    assert.match(status, /Prompt poll observed: .*hits=1/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector allows legacy SSE /event without project directory", async (t) => {
  swapEnv(t, { OPENCODE_SSE_EVENT_PATH: "/event" })
  let sseStarts = 0
  const harness = await createHarness({
    projectPatch: {
      directory: undefined,
    },
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    startSseLoopImpl: () => {
      sseStarts += 1
      return { stop() {} }
    },
  })

  try {
    await waitFor(() => harness.hasSseHandler("demo"))
    assert.equal(sseStarts, 1)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /sendlast fetches the latest assistant reply from the current session when SSE cache is empty", async () => {
  const olderAt = new Date(Date.now() + 60_000).toISOString()
  const newerAt = new Date(Date.now() + 61_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 202,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listMessagesImpl: async (sessionId) => {
        assert.equal(sessionId, "ses_1")
        return [
          { info: { id: "user_latest", role: "user", time: { completed: new Date(Date.now() + 62_000).toISOString() } }, parts: [{ type: "text", text: "follow-up" }] },
          { info: { id: "assistant_old", role: "assistant", time: { completed: olderAt } }, parts: [{ type: "text", text: "Old answer" }] },
          { id: "assistant_new", role: "assistant", time: { completed: newerAt }, parts: [{ type: "text", text: "Fresh **answer**" }] },
        ]
      },
    },
    initialUpdates: [makeMessageUpdate(202, "/sendlast")],
  })

  try {
    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1)
    await harness.connector.stop()

    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Fresh <b>answer</b>")
    assert.deepEqual(harness.ocCalls.listMessages, [{ sessionId: "ses_1", input: {} }])
    assert.deepEqual(harness.ocCalls.getMessage, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector streams assistant replies in isolated threads and finalizes them in place", async () => {
  const updatedAt = new Date(Date.now() + 60_000).toISOString()
  const completedAt = new Date(Date.now() + 61_000).toISOString()
  const messagesById = {
    msg_alpha: {
      info: { id: "msg_alpha", role: "assistant", time: { updated: updatedAt } },
      parts: [{ type: "text", text: "alpha partial" }],
    },
    msg_beta: {
      info: { id: "msg_beta", role: "assistant", time: { updated: updatedAt } },
      parts: [{ type: "text", text: "beta partial" }],
    },
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 205,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_alpha" },
        "100:9": { projectAlias: "demo", sessionId: "ses_beta" },
      },
      sessionIndex: {
        "demo:ses_alpha": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_beta": { chatId: 100, threadIdOr0: 9 },
      },
      feedByContext: {
        "100:7": { mode: "verbose" },
        "100:9": { mode: "verbose" },
      },
    },
    messagesById,
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_alpha",
        info: { id: "msg_alpha", role: "assistant", time: { updated: updatedAt } },
      },
    })
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_beta",
        info: { id: "msg_beta", role: "assistant", time: { updated: updatedAt } },
      },
    })

    await waitFor(() => harness.tg.sentMessages.length >= 2)

    const previewAlpha = harness.tg.sentMessages[0]
    const previewBeta = harness.tg.sentMessages[1]
    assert.equal(previewAlpha.text, "alpha partial")
    assert.equal(previewBeta.text, "beta partial")
    assert.equal(previewAlpha.options.message_thread_id, 7)
    assert.equal(previewBeta.options.message_thread_id, 9)

    messagesById.msg_alpha = {
      info: { id: "msg_alpha", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Hello **alpha**" }],
    }
    messagesById.msg_beta = {
      info: { id: "msg_beta", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Hello **beta**" }],
    }

    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_alpha",
        info: { id: "msg_alpha", role: "assistant", time: { completed: completedAt } },
      },
    })
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_beta",
        info: { id: "msg_beta", role: "assistant", time: { completed: completedAt } },
      },
    })

    await waitFor(() => harness.tg.editedMessages.filter((entry) => entry.kind === "text").length >= 2)

    const editedTexts = harness.tg.editedMessages.filter((entry) => entry.kind === "text")
    assert.ok(editedTexts.some((entry) => entry.messageId === previewAlpha.result.message_id && entry.text === "Hello <b>alpha</b>"))
    assert.ok(editedTexts.some((entry) => entry.messageId === previewBeta.result.message_id && entry.text === "Hello <b>beta</b>"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector falls back to a .txt attachment for very long assistant output", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const longOutput = `\`\`\`\n${Array.from({ length: 1200 }, (_, index) => `line ${index}: ${"x".repeat(20)}`).join("\n")}\n\`\`\``
  const harness = await createHarness({
    statePatch: {
      updateOffset: 206,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_long: {
        info: { id: "msg_long", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: longOutput }],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "msg_long", role: "assistant", time: { completed: completedAt } },
      },
    })

    await waitFor(() => harness.tg.sentMessages.length >= 1 && harness.tg.sentDocuments.length >= 1)

    assert.match(harness.tg.sentMessages[0].text, /attached as a \.txt file/i)
    assert.equal(harness.tg.sentDocuments[0].options.message_thread_id, 7)
    assert.match(harness.tg.sentDocuments[0].filename, /demo-ses_1-msg_long-assistant\.txt/)
    assert.match(String(harness.tg.sentDocuments[0].contents), /line 0: x{20}/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries fetching final assistant content after a transient getMessage failure", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let finalFetchAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 206,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      getMessageImpl: async (sessionId, messageId) => {
        if (messageId !== "msg_retry") return null
        finalFetchAttempts += 1
        if (finalFetchAttempts === 1) throw new Error("temporary final fetch failure")
        return {
          info: { id: "msg_retry", role: "assistant", time: { created: completedAt, completed: completedAt } },
          parts: [{ type: "text", text: "Hello after retry" }],
        }
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "msg_retry", role: "assistant", time: { completed: completedAt } },
      },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1)

    assert.equal(finalFetchAttempts, 2)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Hello after retry")
    assert.equal(
      harness.tg.sentMessages.some((entry) => /final content could not be fetched yet/i.test(entry.text)),
      false,
    )
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector resends the final assistant reply when Telegram proves the preview cannot be edited", async () => {
  const updatedAt = new Date(Date.now() + 60_000).toISOString()
  const completedAt = new Date(Date.now() + 61_000).toISOString()
  const messagesById = {
    msg_preview: {
      info: { id: "msg_preview", role: "assistant", time: { updated: updatedAt } },
      parts: [{ type: "text", text: "partial" }],
    },
  }
  let editAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 207,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      feedByContext: {
        "100:7": { mode: "verbose" },
      },
    },
    messagesById,
    tgOptions: {
      editMessageTextImpl: async () => {
        editAttempts += 1
        throw makeBoundaryError({
          source: "telegram",
          operation: "editMessageText",
          kind: "http",
          outcome: "fatal",
          status: 400,
          message: "Bad Request: message to edit not found",
        })
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "msg_preview", role: "assistant", time: { updated: updatedAt } },
      },
    })
    await waitFor(() => harness.tg.sentMessages.length >= 1)

    messagesById.msg_preview = {
      info: { id: "msg_preview", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Final **reply**" }],
    }
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "msg_preview", role: "assistant", time: { completed: completedAt } },
      },
    })

    await waitFor(() => editAttempts >= 1 && harness.tg.sentHtmlBlocks.length >= 1)

    assert.equal(harness.tg.sentHtmlBlocks[0].options.message_thread_id, 7)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Final <b>reply</b>")
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
  const projectDirectory = path.join(os.tmpdir(), `telegram-connector-use-${crypto.randomUUID()}`)
  const harness = await createHarness({
    projectPatch: { directory: projectDirectory },
    ocOptions: {
      getSessionImpl: async (sessionId) => ({ id: sessionId, parentID: null, directory: projectDirectory }),
    },
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
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses session ses_manual.")))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use rejects raw session ids with pipes", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 225,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(226, "/use abc|def"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(harness.tg.sentMessages.some((entry) => /Invalid session id\..*pipe/.test(entry.text)))
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use share link requires an existing binding", async () => {
  const harness = await createHarness()

  try {
    harness.tg.enqueue(makeMessageUpdate(231, "/use https://opncd.ai/share/abc123"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.ok(harness.tg.sentMessages.some((entry) => /Switching sessions needs a bound thread\./.test(entry.text)))
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
        entry.text.startsWith(
          "Unsupported link. Use an OpenCode share link like https://opncd.ai/share/<share-id> (or https://opncd.ai/s/<share-id>) or a raw session id.",
        ),
      ),
    )
    assert.deepEqual(harness.ocCalls.getSession, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use accepts a shared session link for the current project", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
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
      listSessionsImpl: (input = {}) => [
        { id: "ses_current", title: "Current", directory: input.directory },
        { id: "ses_shared", title: "Shared", directory: input.directory, share: { url: "https://opncd.ai/share/abc123/" } },
      ],
      listMessagesImpl: async (sessionId) => {
        return sessionId === "ses_shared"
          ? [{ info: { role: "assistant", providerID: "openai", modelID: "gpt-5", variant: "xhigh", time: { completed: completedAt } } }]
          : []
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(251, "/use https://opncd.ai/share/abc123?utm_source=tg"))

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
    assert.ok(
      harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses session ses_shared.") && entry.text.includes("Model: openai/gpt-5 xhigh")),
    )
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /use rejects share links resolving to unsafe session ids", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 252,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listSessionsImpl: (input = {}) => [
        { id: "ses_current", title: "Current", directory: input.directory },
        { id: "ses/unsafe", title: "Unsafe shared", directory: input.directory, share: { url: "https://opncd.ai/share/unsafe" } },
      ],
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(253, "/use https://opncd.ai/share/unsafe"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await delay(30)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_current" },
    })
    assert.ok(
      harness.tg.sentMessages.some((entry) => entry.text.includes("Share link resolved to a session id this connector cannot safely bind")),
    )
    assert.deepEqual(harness.ocCalls.getSession, [])
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
      listSessionsImpl: (input = {}) => [{ id: "ses_current", title: "Current", directory: input.directory }],
    },
    extraProjects: {
      other: {
        baseUrl: "http://127.0.0.1:4313",
        directory: path.join(os.tmpdir(), `telegram-connector-other-${crypto.randomUUID()}`),
        autoStart: false,
        openTuiOnAutoStart: true,
        openAttachOnNewMode: "same-window",
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
        openTuiOnAutoStart: true,
        openAttachOnNewMode: "same-window",
        username: "",
        password: "",
      },
    },
    ocOptionsByAlias: {
      other: {
        listSessionsImpl: (input = {}) => [{ id: "ses_other", directory: input.directory, share: { url: "https://opncd.ai/s/xyz789" } }],
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
      listSessionsImpl: (input = {}) => [{ id: "ses_current", title: "Current", directory: input.directory }],
    },
    extraProjects: {
      broken: {
        baseUrl: "http://127.0.0.1:4313",
        directory: brokenDir,
        autoStart: false,
        openTuiOnAutoStart: true,
        openAttachOnNewMode: "same-window",
        username: "",
        password: "",
      },
      other: {
        baseUrl: "http://127.0.0.1:4314",
        directory: otherDir,
        autoStart: false,
        openTuiOnAutoStart: true,
        openAttachOnNewMode: "same-window",
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
        listSessionsImpl: (input = {}) => [{ id: "ses_other", directory: input.directory, share: { url: "https://opncd.ai/s/xyz789" } }],
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
        openTuiOnAutoStart: true,
        openAttachOnNewMode: "same-window",
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
    assert.ok(harness.tg.sentMessages.some((entry) => /Abort needs a bound thread\./.test(entry.text)))
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
    assert.match(status, /Feed: Main \+ changes/)
    assert.match(status, /Agent: not running/)
    assert.match(status, /SSE: connected/)
    assert.match(status, /Base URL: http:\/\/example\.test:4312\/path\?token=\*\*\*/) 
    assert.doesNotMatch(status, /secret|user|frag|abc/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /status shows when the agent is currently running even if message listing lags", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 294,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listMessagesImpl: async () => [],
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_current",
        part: { id: "tool_running", messageID: "asst_running", type: "tool", tool: "bash", state: { status: "running", title: "Run checks" } },
      },
    })
    harness.tg.enqueue(makeMessageUpdate(295, "/status"))

    await waitFor(() => harness.tg.sentMessages.some((entry) => /Agent: running/.test(entry.text)))

    const status = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(status, /Project: demo/)
    assert.match(status, /Session: ses_current/)
    assert.match(status, /Agent: running/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /status includes runtime observability lines", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 294,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(295, "/status"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const status = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(status, /Prompt recovery: restored=0 stale=0 retryable=0 fatal=0/)
    assert.match(status, /Callback outcomes: stale=0 retryable=0 fatal=0/)
    assert.match(status, /SSE observed: retries=0 aborted=0 connected=never/)
    assert.match(status, /Runtime: update retries=0 skipped=0 telegram retries=0 backlog retries=0/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /runtime shows compact private-chat runtime state", async () => {
  const harness = await createHarness({
    statePatch: { updateOffset: 295 },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(295, "/runtime", { chatType: "private", threadIdOr0: 0 }))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const runtimeText = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(runtimeText, /^Runtime:/)
    assert.match(runtimeText, /managedTasks=/)
    assert.match(runtimeText, /Telegram poll:/)
    assert.match(runtimeText, /Backlog drain:/)
    assert.match(runtimeText, /Updates: retryable=0 skipped=0/)
    assert.doesNotMatch(runtimeText, /state\.json|test-token/)
    assert.deepEqual(harness.tg.sentMessages.at(-1)?.replyMarkup?.inline_keyboard?.flat().map((button) => button.text), ["Restart", "Stop", "Close"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /runtime refuses group chats", async () => {
  const harness = await createHarness({ statePatch: { updateOffset: 296 } })

  try {
    harness.tg.enqueue(makeMessageUpdate(296, "/runtime"))
    await waitFor(() => harness.tg.sentMessages.length >= 1)

    assert.match(harness.tg.sentMessages.at(-1)?.text || "", /Use \/runtime only in a private chat/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector serves optional health endpoints", async () => {
  let healthAddress = null
  const harness = await createHarness({
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    startHealthServerImpl: async (options) => {
      const handle = await startHealthServer(options)
      healthAddress = handle.address
      return handle
    },
  })

  try {
    assert.ok(healthAddress?.port)
    const baseUrl = `http://127.0.0.1:${healthAddress.port}`

    const live = await fetch(`${baseUrl}/livez`)
    assert.equal(live.status, 200)
    assert.equal((await live.json()).status, "live")

    const ready = await waitFor(async () => {
      const res = await fetch(`${baseUrl}/readyz`)
      if (res.status !== 200) return null
      return res
    })
    const payload = await ready.json()
    assert.equal(payload.status, "ready")
    assert.equal(payload.checks.state.ok, true)
    assert.equal(payload.checks.telegramPoll.ok, true)

    harness.tg.setGetUpdatesError(new Error("network down while polling Telegram"))
    const notReady = await waitFor(async () => {
      const res = await fetch(`${baseUrl}/readyz`)
      if (res.status !== 503) return null
      const body = await res.json()
      return body.checks?.telegramPoll?.ok === false ? body : null
    })
    assert.equal(notReady.status, "not_ready")
    assert.match(notReady.checks.telegramPoll.lastError, /network down while polling Telegram/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector readiness stays false until the first-run backlog cutoff is durably persisted", async () => {
  let healthAddress = null
  let releaseSnapshot
  let markSnapshotStarted
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve })
  const snapshotStarted = new Promise((resolve) => { markSnapshotStarted = resolve })
  const harness = await createHarness({
    statePatch: { updateOffset: null },
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    tgOptions: {
      afterNegativeOffsetSnapshot: async () => {
        markSnapshotStarted()
        await snapshotRelease
      },
    },
    startHealthServerImpl: async (options) => {
      const handle = await startHealthServer(options)
      healthAddress = handle.address
      return handle
    },
  })

  try {
    await snapshotStarted
    const baseUrl = `http://127.0.0.1:${healthAddress.port}`
    const pending = await fetch(`${baseUrl}/readyz`)
    assert.equal(pending.status, 503)
    const pendingBody = await pending.json()
    assert.equal(pendingBody.status, "not_ready")
    assert.equal(pendingBody.checks.telegramPoll.ok, false)

    releaseSnapshot()
    const ready = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/readyz`)
      return response.status === 200 ? response : null
    })
    assert.equal((await ready.json()).status, "ready")
  } finally {
    releaseSnapshot?.()
    await harness.connector.stop()
  }
})

test("startConnector sends pending runtime restart online notice on startup", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 297,
      pendingRuntimeOnlineNotice: { kind: "restart", chatId: 100, createdAt: 123 },
    },
  })

  try {
    await waitFor(() => harness.tg.sentMessages.some((message) => /online again after restart/.test(message.text || "")))

    const notice = harness.tg.sentMessages.find((message) => /online again after restart/.test(message.text || ""))
    assert.equal(notice.chatId, 100)
    const state = await readState(harness.stateFile)
    assert.equal(state.pendingRuntimeOnlineNotice, null)
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

test("startConnector /feed shows the current mode and updates it via callbacks", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 297,
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(298, "/feed", { threadIdOr0: 11 }))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const feedMessage = harness.tg.sentMessages[0]
    assert.match(feedMessage.text, /Feed for this thread: Main \+ changes/)
    assert.deepEqual(feedMessage.replyMarkup.inline_keyboard.map((row) => row[0].text), [
      "Main",
      "✓ Main + changes",
      "Verbose",
      "Close",
    ])

    harness.tg.enqueue(makeCallbackUpdate(299, "feed|verbose", { threadIdOr0: 11, messageId: feedMessage.result.message_id }))

    await waitFor(() => harness.tg.editedMessages.length >= 1)
    await harness.connector.stop()

    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_299" && entry.text === "Feed: Verbose"))
    assert.match(harness.tg.editedMessages[0].text, /Feed for this thread: Verbose/)

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.feedByContext, {
      "100:11": { mode: "verbose" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /projects hides binding scopes in group chats", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 296,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
        "100:11": { projectAlias: "demo", sessionId: "ses_topic" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_topic": { chatId: 100, threadIdOr0: 11 },
      },
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(297, "/projects", { threadIdOr0: 7 }))

    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const text = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(text, /^Projects:/)
    assert.match(text, /Bindings: hidden outside private chat/)
    assert.doesNotMatch(text, /URL:/)
    assert.doesNotMatch(text, /Startup session:/)
    assert.doesNotMatch(text, /ses_startup/)
    assert.doesNotMatch(text, /chat 100\/main|chat 100\/topic 11/)
    const labels = harness.tg.sentMessages.at(-1)?.replyMarkup?.inline_keyboard.flat().map((button) => button.text) || []
    assert.ok(labels.includes("Close"))
    assert.equal(labels.includes("Retry demo"), false)
    assert.equal(labels.includes("Start demo"), false)
    assert.equal(labels.includes("Sessions demo"), false)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector /projects actions retry health, show sessions, and close", async () => {
  const harness = await createHarness({
    statePatch: { updateOffset: 298 },
    startupSessions: [{ id: "ses_startup", title: "Startup" }, { id: "ses_other", title: "Other" }],
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(298, "/projects", { chatType: "private", threadIdOr0: 0 }))
    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const projectMessage = harness.tg.sentMessages.at(-1)
    const labels = projectMessage.replyMarkup.inline_keyboard.flat().map((button) => button.text)
    assert.ok(labels.includes("Status demo"))
    assert.ok(labels.includes("Bind demo"))
    assert.ok(labels.includes("Sessions demo"))
    assert.ok(labels.includes("Close"))

    harness.tg.enqueue(makeCallbackUpdate(299, "srv|demo|health", { chatType: "private", threadIdOr0: 0, messageId: projectMessage.result.message_id }))
    await waitFor(() => harness.tg.sentMessages.some((entry) => /health check: online/.test(entry.text)))

    harness.tg.enqueue(makeCallbackUpdate(300, "srv|demo|sessions", { chatType: "private", threadIdOr0: 0, messageId: projectMessage.result.message_id }))
    await waitFor(() => harness.tg.editedMessages.some((entry) => entry.messageId === projectMessage.result.message_id && /Sessions for 'demo':/.test(entry.text)))
    const sessionsEdit = harness.tg.editedMessages.find((entry) => entry.messageId === projectMessage.result.message_id && /Sessions for 'demo':/.test(entry.text))
    assert.match(sessionsEdit.text, /Viewing only/)
    assert.deepEqual(sessionsEdit.replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Close"])

    harness.tg.enqueue(makeCallbackUpdate(301, "srv|close", { chatType: "private", threadIdOr0: 0, messageId: projectMessage.result.message_id }))
    await waitFor(() => harness.tg.deletedMessages.some((entry) => entry.messageId === projectMessage.result.message_id))

    assert.ok(harness.ocCalls.health >= 1)
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_299" && entry.text === "Checking…"))
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_300" && entry.text === "Sessions"))
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_301" && entry.text === "Closed"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector finalizes an in-flight preview when /feed switches to a mode that filters the completion", async () => {
  const updatedAt = new Date(Date.now() + 60_000).toISOString()
  const completedAt = new Date(Date.now() + 61_000).toISOString()
  const messagesById = {
    msg_feed_transition: {
      info: { id: "msg_feed_transition", role: "assistant", time: { updated: updatedAt } },
      parts: [{ type: "text", text: "preview text" }],
    },
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 299,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      feedByContext: {
        "100:7": { mode: "verbose" },
      },
    },
    messagesById,
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_feed_transition", role: "assistant", time: { updated: updatedAt } } },
    })
    await waitFor(() => harness.tg.sentMessages.length >= 1)

    const previewMessage = harness.tg.sentMessages[0]
    harness.tg.enqueue(makeMessageUpdate(300, "/feed"))
    await waitFor(() => harness.tg.sentMessages.length >= 2)
    const feedMessage = harness.tg.sentMessages[1]

    harness.tg.enqueue(makeCallbackUpdate(301, "feed|main", { threadIdOr0: 7, messageId: feedMessage.result.message_id }))
    await waitFor(() => harness.tg.editedMessages.some((entry) => entry.messageId === feedMessage.result.message_id))

    messagesById.msg_feed_transition = {
      info: { id: "msg_feed_transition", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "patch", files: ["/repo/only-change.js"], diff: "--- a/only-change.js\n+++ b/only-change.js" }],
    }
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_feed_transition", role: "assistant", time: { completed: completedAt } } },
    })

    await waitFor(
      () => harness.tg.editedMessages.some((entry) => entry.messageId === previewMessage.result.message_id && /no updates matched/.test(entry.text)),
    )

    assert.ok(!harness.tg.sentMessages.slice(2).some((entry) => /Changed files:/.test(entry.text)))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector applies feed modes per thread for assistant, user, and changed-file updates", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const updatedAt = new Date(Date.now() + 59_000).toISOString()
  const messagesById = {
    user_main: { info: { id: "user_main", role: "user", time: { created: completedAt, completed: completedAt } }, parts: [{ type: "text", text: "main user" }] },
    user_changes: { info: { id: "user_changes", role: "user", time: { created: completedAt, completed: completedAt } }, parts: [{ type: "text", text: "changes user" }] },
    user_verbose: { info: { id: "user_verbose", role: "user", time: { created: completedAt, completed: completedAt } }, parts: [{ type: "text", text: "verbose user" }] },
    asst_main: {
      info: { id: "asst_main", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Main answer" }, { type: "patch", files: ["/repo/main.js"], diff: "--- a/main.js\n+++ b/main.js" }],
    },
    asst_changes: {
      info: { id: "asst_changes", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Changes answer" }, { type: "patch", files: ["/repo/changes.js"], diff: "--- a/changes.js\n+++ b/changes.js" }],
    },
    asst_verbose: {
      info: { id: "asst_verbose", role: "assistant", time: { updated: updatedAt } },
      parts: [{ type: "text", text: "Streaming verbose reply" }],
    },
    asst_verbose_final: {
      info: { id: "asst_verbose", role: "assistant", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "Verbose answer" }, { type: "patch", files: ["/repo/verbose.js"], diff: "--- a/verbose.js\n+++ b/verbose.js" }],
    },
    asst_compaction: {
      info: { id: "asst_compaction", role: "assistant", mode: "compaction", time: { created: completedAt, completed: completedAt } },
      parts: [{ type: "text", text: "internal" }],
    },
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 300,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_main" },
        "100:9": { projectAlias: "demo", sessionId: "ses_changes" },
        "100:11": { projectAlias: "demo", sessionId: "ses_verbose" },
      },
      sessionIndex: {
        "demo:ses_main": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_changes": { chatId: 100, threadIdOr0: 9 },
        "demo:ses_verbose": { chatId: 100, threadIdOr0: 11 },
      },
      feedByContext: {
        "100:7": { mode: "main" },
        "100:9": { mode: "main+changes" },
        "100:11": { mode: "verbose" },
      },
    },
    messagesById,
  })

  try {
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_main", info: { id: "user_main", role: "user", time: { completed: completedAt } } } })
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_changes", info: { id: "user_changes", role: "user", time: { completed: completedAt } } } })
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_verbose", info: { id: "user_verbose", role: "user", time: { completed: completedAt } } } })
    await harness.emitSse("demo", {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_main",
        part: { id: "tool_main", messageID: "asst_main", type: "tool", tool: "bash", state: { status: "running", title: "Run main checks", time: { start: updatedAt } } },
      },
    })
    await harness.emitSse("demo", {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_changes",
        part: { id: "tool_changes", messageID: "asst_changes", type: "tool", tool: "bash", state: { status: "running", title: "Run changes checks", time: { start: updatedAt } } },
      },
    })
    await harness.emitSse("demo", {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_verbose",
        part: { id: "tool_verbose", messageID: "asst_verbose", type: "tool", tool: "bash", state: { status: "running", title: "Run verbose checks", time: { start: updatedAt } } },
      },
    })
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_verbose", info: { id: "asst_verbose", role: "assistant", time: { updated: updatedAt } } } })
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_main", info: { id: "asst_main", role: "assistant", time: { completed: completedAt } } } })
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_changes", info: { id: "asst_changes", role: "assistant", time: { completed: completedAt } } } })
    messagesById.asst_verbose = messagesById.asst_verbose_final
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_verbose", info: { id: "asst_verbose", role: "assistant", time: { completed: completedAt } } } })
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_verbose", info: { id: "asst_compaction", role: "assistant", mode: "compaction", time: { completed: completedAt } } },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 2 && harness.tg.sentMessages.length >= 4 && harness.tg.editedMessages.length >= 1)

    const htmlByThread = harness.tg.sentHtmlBlocks.map((entry) => ({ threadId: entry.options.message_thread_id, first: entry.blocks[0]?.html }))
    const textByThread = harness.tg.sentMessages.map((entry) => ({ threadId: entry.options.message_thread_id, text: entry.text }))

    assert.ok(htmlByThread.some((entry) => entry.threadId === 7 && entry.first === "Main answer"))
    assert.ok(htmlByThread.some((entry) => entry.threadId === 9 && entry.first === "Changes answer"))
    assert.ok(harness.tg.editedMessages.some((entry) => entry.kind === "text" && entry.messageId && entry.text === "Verbose answer"))
    assert.ok(!htmlByThread.some((entry) => entry.threadId === 7 && entry.first?.startsWith("<i>User:</i>")))
    assert.ok(!htmlByThread.some((entry) => entry.threadId === 9 && entry.first?.startsWith("<i>User:</i>")))
    assert.ok(!htmlByThread.some((entry) => entry.threadId === 11 && entry.first?.startsWith("<i>User:</i>")))

    assert.ok(textByThread.some((entry) => entry.threadId === 9 && /Changed files:/.test(entry.text)))
    assert.ok(textByThread.some((entry) => entry.threadId === 11 && entry.text === "Streaming verbose reply"))
    assert.ok(textByThread.some((entry) => entry.threadId === 11 && /Agent action\nRunning: Run verbose checks/.test(entry.text)))
    assert.ok(textByThread.some((entry) => entry.threadId === 11 && /Changed files:/.test(entry.text)))
    assert.ok(!textByThread.some((entry) => entry.threadId === 7 && /Changed files:/.test(entry.text)))
    assert.ok(!textByThread.some((entry) => entry.threadId === 9 && /Streaming verbose reply/.test(entry.text)))
    assert.ok(!textByThread.some((entry) => entry.threadId === 7 && /Agent action/.test(entry.text)))
    assert.ok(!textByThread.some((entry) => entry.threadId === 9 && /Agent action/.test(entry.text)))
    assert.ok(!textByThread.some((entry) => /internal/.test(entry.text)))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector durably retries TUI user mirroring after a Telegram 503", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let attempts = 0
  const messagesById = {
    user_main: { info: { id: "user_main", role: "user", time: { created: completedAt, completed: completedAt } }, parts: [{ type: "text", text: "typed in tui" }] },
  }
  const harness = await createHarness({
    configPatch: { mirrorTuiUserMessages: true },
    statePatch: {
      updateOffset: 300,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_main" } },
      sessionIndex: { "demo:ses_main": { chatId: 100, threadIdOr0: 7 } },
      feedByContext: { "100:7": { mode: "main" } },
    },
    messagesById,
    tgOptions: {
      sendHtmlBlocksImpl: async () => {
        attempts += 1
        if (attempts === 1) throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 503, outcome: "retryable", message: "temporarily unavailable" })
      },
    },
  })

  try {
    await harness.emitSse("demo", { type: "message.updated", properties: { sessionID: "ses_main", info: { id: "user_main", role: "user", time: { completed: completedAt } } } })

    await waitFor(async () => {
      const delivered = harness.tg.sentHtmlBlocks.some((entry) => entry.options.message_thread_id === 7 && entry.blocks[0]?.html === "<i>User:</i>\ntyped in tui")
      return delivered && Object.keys((await readState(harness.stateFile)).outbox.items).length === 0
    })
    const mirrored = harness.tg.sentHtmlBlocks.find((entry) => entry.options.message_thread_id === 7 && entry.blocks[0]?.html === "<i>User:</i>\ntyped in tui")
    assert.equal(mirrored.blocks.length, 1)
    assert.equal(attempts, 2)
    assert.deepEqual((await readState(harness.stateFile)).outbox.items, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector changed-files cards support Show diff and Back", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 301,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_patch: {
        info: { id: "msg_patch", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [
          { type: "text", text: "Patched" },
          { type: "patch", files: ["/repo/a.js"], diff: "--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new" },
        ],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_patch", role: "assistant", time: { completed: completedAt } } },
    })

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    const summary = harness.tg.sentMessages[0]
    assert.match(summary.text, /Changed files:/)

    harness.tg.enqueue(makeCallbackUpdate(302, "cf|demo|ses_1|msg_patch|show", { threadIdOr0: 7, messageId: summary.result.message_id }))
    await waitFor(() => harness.tg.editedMessages.length >= 1)
    assert.match(harness.tg.editedMessages[0].text, /Changed files diff/)
    assert.match(harness.tg.editedMessages[0].text, /🔴 -old/)
    assert.match(harness.tg.editedMessages[0].text, /🟢 \+new/)
    assert.deepEqual(harness.tg.editedMessages[0].options, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })

    harness.tg.enqueue(makeCallbackUpdate(303, "cf|demo|ses_1|msg_patch|back", { threadIdOr0: 7, messageId: summary.result.message_id }))
    await waitFor(() => harness.tg.editedMessages.length >= 2)
    assert.match(harness.tg.editedMessages[1].text, /Changed files:/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector changed-files Show diff falls back gracefully when diff is unavailable", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 302,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_patch_unavailable: {
        info: { id: "msg_patch_unavailable", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "patch", files: ["/repo/a.js"] }],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_patch_unavailable", role: "assistant", time: { completed: completedAt } } },
    })

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    const summary = harness.tg.sentMessages[0]
    harness.tg.enqueue(makeCallbackUpdate(304, "cf|demo|ses_1|msg_patch_unavailable|show", { threadIdOr0: 7, messageId: summary.result.message_id }))

    await waitFor(() => harness.tg.editedMessages.length >= 1)
    assert.equal(harness.tg.editedMessages[0].text, "Diff unavailable for this update.")
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector changed-files Show diff attaches large diffs as patch files", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const longDiff = Array.from({ length: 900 }, (_, index) => `+line ${index} ${"x".repeat(10)}`).join("\n")
  const harness = await createHarness({
    statePatch: {
      updateOffset: 303,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_patch_large: {
        info: { id: "msg_patch_large", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "patch", files: ["/repo/a.js"], diff: longDiff }],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_patch_large", role: "assistant", time: { completed: completedAt } } },
    })

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    const summary = harness.tg.sentMessages[0]
    harness.tg.enqueue(makeCallbackUpdate(305, "cf|demo|ses_1|msg_patch_large|show", { threadIdOr0: 7, messageId: summary.result.message_id }))

    await waitFor(() => harness.tg.editedMessages.length >= 1 && harness.tg.sentDocuments.length >= 1)
    assert.match(harness.tg.editedMessages[0].text, /Diff is too large for an inline preview/)
    assert.match(harness.tg.sentDocuments[0].filename, /msg_patch_large.*changed-files\.patch/)
    assert.match(String(harness.tg.sentDocuments[0].contents), /\+line 0/)
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

test("startConnector repairs an in-memory stale binding index from private binding controls", async () => {
  let store
  const harness = await createHarness({
    statePatch: {
      updateOffset: 310,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_topic" },
        "200:0": { projectAlias: "demo", sessionId: "ses_other" },
      },
      sessionIndex: {
        "demo:ses_topic": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_other": { chatId: 200, threadIdOr0: 0 },
      },
    },
    createStateStoreImpl: (options) => {
      store = new StateStore(options)
      return store
    },
  })

  try {
    store.state.sessionIndex = {
      "demo:ses_topic": { chatId: 999, threadIdOr0: 0 },
      "demo:ghost": { chatId: 1, threadIdOr0: 1 },
    }
    harness.tg.enqueue(makeMessageUpdate(311, "/bindings", { chatId: 42, chatType: "private", threadIdOr0: 0 }))

    await waitFor(() => harness.tg.sentMessages.some((entry) => /Index repair available/.test(entry.text)))
    const bindingsMessage = harness.tg.sentMessages.at(-1)
    assert.match(bindingsMessage.text, /Index repair available: removedBindings=0 removedIndex=1 rebuilt=2/)
    const repairButton = bindingsMessage.replyMarkup.inline_keyboard.flat().find((button) => button.text === "Repair index")
    assert.ok(repairButton)

    harness.tg.enqueue(makeCallbackUpdate(312, repairButton.callback_data, { chatId: 42, chatType: "private", threadIdOr0: 0, messageId: bindingsMessage.result.message_id }))

    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.text === "Repaired"))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_topic" },
      "200:0": { projectAlias: "demo", sessionId: "ses_other" },
    })
    assert.deepEqual(state.sessionIndex, {
      "demo:ses_topic": { chatId: 100, threadIdOr0: 7 },
      "demo:ses_other": { chatId: 200, threadIdOr0: 0 },
    })
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
    await waitFor(() => harness.tg.sentMessages.some((entry) => /Confirm unbind for this thread:/.test(entry.text)))
    const confirmMessage = harness.tg.sentMessages.find((entry) => /Confirm unbind for this thread:/.test(entry.text))
    const removeButton = confirmMessage.replyMarkup.inline_keyboard.flat().find((button) => button.text === "Remove this thread binding")
    assert.ok(removeButton)
    harness.tg.enqueue(makeCallbackUpdate(299, removeButton.callback_data, { messageId: confirmMessage.result.message_id }))
    harness.tg.enqueue(makeMessageUpdate(300, "hello after unbind"))

    await waitFor(
      () =>
        harness.tg.sentMessages.some((entry) => /Changed: binding removed\./.test(entry.text)) &&
        harness.tg.sentMessages.some((entry) => /This thread is not bound yet\./.test(entry.text)),
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

test("startConnector restores pending permission reject-note flows after restart", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 360,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_1": {
            projectAlias: "demo",
            permissionId: "perm_1",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_1" },
        },
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [
        {
          id: "perm_1",
          sessionID: "ses_1",
          permission: "shell",
          patterns: ["npm test"],
        },
      ],
    },
  })

  try {
    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1 && harness.tg.sentMessages.length >= 1)

    assert.match(harness.tg.sentHtmlBlocks[0].blocks[0].html, /Permission request/)
    assert.match(harness.tg.sentMessages[0].text, /Resumed\. Send rejection note for perm_1/)

    harness.tg.enqueue(makeMessageUpdate(361, "because it is unsafe"))
    await waitFor(() => harness.ocCalls.replyPermission.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [
      { permissionId: "perm_1", payload: { reply: "reject", message: "because it is unsafe" } },
    ])

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
    assert.deepEqual(state.pendingPrompts.rejectNotes, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector recovers pending prompts before first-run backlog drain", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: null,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:ses_1:perm_first_run": {
            projectAlias: "demo",
            permissionId: "perm_first_run",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_first_run", sessionID: "ses_1" },
        },
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [
        {
          id: "perm_first_run",
          sessionID: "ses_1",
          permission: "shell",
          patterns: ["npm test"],
        },
      ],
    },
    initialUpdates: [[makeMessageUpdate(1, "because the restored prompt is still active")]],
  })

  try {
    await waitFor(() => harness.ocCalls.replyPermission.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [
      { permissionId: "perm_first_run", payload: { reply: "reject", message: "because the restored prompt is still active" } },
    ])

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 2)
    assert.deepEqual(state.pendingPrompts.permissions, {})
    assert.deepEqual(state.pendingPrompts.rejectNotes, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries reject-note input after a transient permission reply failure", async () => {
  let replyAttempts = 0
  const firstNoteUpdate = makeMessageUpdate(362, "because it is unsafe")
  const secondNoteUpdate = makeMessageUpdate(363, "because it is unsafe")
  const harness = await createHarness({
    statePatch: {
      updateOffset: 362,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_retry": {
            projectAlias: "demo",
            permissionId: "perm_retry",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_retry" },
        },
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [
        {
          id: "perm_retry",
          sessionID: "ses_1",
          permission: "shell",
          patterns: ["npm test"],
        },
      ],
      replyPermissionImpl: async () => {
        replyAttempts += 1
        if (replyAttempts === 1) {
          throw makeBoundaryError({
            source: "opencode",
            operation: "POST /permission/perm_retry/reply",
            method: "POST",
            pathname: "/permission/perm_retry/reply",
            kind: "network",
            outcome: "retryable",
            message: "temporary permission failure",
          })
        }
        return { ok: true }
      },
    },
    initialUpdates: [[firstNoteUpdate], [secondNoteUpdate]],
  })

  try {
    await waitFor(() => harness.ocCalls.replyPermission.length === 2)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text === "Rejection note sent."))
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [
      { permissionId: "perm_retry", payload: { reply: "reject", message: "because it is unsafe" } },
      { permissionId: "perm_retry", payload: { reply: "reject", message: "because it is unsafe" } },
    ])
    assert.deepEqual(harness.ocCalls.promptAsync, [])

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
    assert.deepEqual(state.pendingPrompts.rejectNotes, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector does not submit recovered child reject-note while route check is retryable", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 364,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_other" },
      },
      sessionIndex: {
        "demo:ses_other": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:ses_child:perm_child_note": {
            projectAlias: "demo",
            permissionId: "perm_child_note",
            sessionID: "ses_child",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_child_note", sessionID: "ses_child" },
        },
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      getSessionImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /session/ses_child",
          method: "GET",
          pathname: "/session/ses_child",
          status: 503,
          outcome: "retryable",
          message: "session lookup unavailable",
        })
      },
    },
    initialUpdates: [[makeMessageUpdate(365, "because it is unsafe")]],
  })

  try {
    await waitFor(() => harness.tg.sentMessages.some((entry) => /Permission reply is temporarily unavailable/.test(entry.text)))
    await delay(30)

    assert.deepEqual(harness.ocCalls.replyPermission, [])
    assert.deepEqual(harness.ocCalls.promptAsync, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector restores pending question custom-answer flows after restart", async () => {
  const request = {
    id: "q_restore",
    sessionID: "ses_1",
    questions: [
      {
        header: "Checks",
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
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 370,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_restore", qIndex: 1 },
        },
        questionWizards: {
          "demo:q_restore": {
            projectAlias: "demo",
            id: "q_restore",
            sessionID: "ses_1",
            request,
            index: 1,
            answers: [["lint"], []],
            selectedByIndex: { 0: ["lint"] },
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listQuestionsImpl: async () => [request],
    },
  })

  try {
    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 1 && harness.tg.sentMessages.length >= 2)

    assert.match(harness.tg.sentHtmlBlocks[0].blocks[0].html, /Question request resumed/)
    assert.match(harness.tg.sentMessages[0].text, /Reason \(2\/2\)/)
    assert.match(harness.tg.sentMessages[1].text, /Resumed\. Send your answer for: Reason/)

    harness.tg.enqueue(makeMessageUpdate(371, "because restarts happen"))
    await waitFor(() => harness.ocCalls.replyQuestion.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyQuestion, [
      { questionId: "q_restore", answers: [["lint"], ["because restarts happen"]] },
    ])

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps retryable custom-answer recovery usable without another restart", async () => {
  const request = {
    id: "q_retry_live",
    sessionID: "ses_1",
    questions: [
      {
        header: "Checks",
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
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 371,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_retry_live", qIndex: 1 },
        },
        questionWizards: {
          "demo:q_retry_live": {
            projectAlias: "demo",
            id: "q_retry_live",
            sessionID: "ses_1",
            request,
            index: 1,
            answers: [["lint"], []],
            selectedByIndex: { 0: ["lint"] },
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listQuestionsImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /question",
          method: "GET",
          pathname: "/question",
          kind: "network",
          outcome: "retryable",
          message: "temporary question poll failure",
        })
      },
      replyQuestionImpl: async () => ({ ok: true }),
    },
  })

  try {
    await delay(30)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)
    assert.equal(harness.tg.sentMessages.length, 0)

    await harness.emitSse("demo", { type: "question.asked", properties: request })
    harness.tg.enqueue(makeMessageUpdate(372, "because the backend recovered"))
    await waitFor(() => harness.ocCalls.replyQuestion.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyQuestion, [
      { questionId: "q_retry_live", answers: [["lint"], ["because the backend recovered"]] },
    ])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Answered: q_retry_live"))

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector drops orphaned custom-answer recovery state on restart", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 370,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_missing", qIndex: 0 },
        },
        questionWizards: {},
      },
    },
  })

  try {
    await delay(30)
    harness.tg.enqueue(makeMessageUpdate(371, "normal prompt after restart"))
    await waitFor(() => harness.ocCalls.promptAsync.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.promptAsync, [{ sessionId: "ses_1", text: "[TG] normal prompt after restart" }])
    assert.equal(
      harness.tg.sentMessages.some((entry) => entry.text === "Question is no longer active."),
      false,
    )

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector expires stale custom-answer wizards and allows the pending question to be delivered again", async () => {
  const request = {
    id: "q_expire",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 371,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_expire", qIndex: 0 },
        },
        questionWizards: {
          "demo:q_expire": {
            projectAlias: "demo",
            id: "q_expire",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now() - 10_000,
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listQuestionsImpl: async () => [request],
    },
    wizardTtlMs: 1,
    wizardGcIntervalMs: 2,
  })

  try {
    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 2 && harness.tg.sentMessages.length >= 3)
    await harness.connector.stop()

    assert.match(harness.tg.sentHtmlBlocks[0].blocks[0].html, /Question request resumed/)
    assert.match(harness.tg.sentMessages[1].text, /Resumed\. Send your answer for: Reason/)
    assert.match(harness.tg.sentHtmlBlocks[1].blocks[0].html, /Question request/)
    assert.doesNotMatch(harness.tg.sentHtmlBlocks[1].blocks[0].html, /resumed/i)

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector restores final question submission after a restart during reply failure", async () => {
  const request = {
    id: "q_restart",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const firstAnswer = makeMessageUpdate(372, "because the first try failed")
  const firstHarness = await createHarness({
    statePatch: {
      updateOffset: 372,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_restart", qIndex: 0 },
        },
        questionWizards: {
          "demo:q_restart": {
            projectAlias: "demo",
            id: "q_restart",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listQuestionsImpl: async () => [request],
      replyQuestionImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "POST /question/q_restart/reply",
          method: "POST",
          pathname: "/question/q_restart/reply",
          kind: "network",
          outcome: "retryable",
          message: "temporary question failure",
        })
      },
    },
    initialUpdates: [[firstAnswer]],
  })

  let persistedState
  try {
    await waitFor(() => firstHarness.ocCalls.replyQuestion.length === 1)
    await firstHarness.connector.stop()
    persistedState = await readState(firstHarness.stateFile)
  } finally {
    await firstHarness.connector.stop()
  }

  assert.ok(Object.keys(persistedState.pendingPrompts.questionWizards).includes("demo:ses_1:q_restart"))
  assert.deepEqual(persistedState.pendingPrompts.customAnswers, {
    "100:7": { projectAlias: "demo", requestId: "q_restart", sessionID: "ses_1", qIndex: 0 },
  })

  const secondHarness = await createHarness({
    statePatch: persistedState,
    ocOptions: {
      listQuestionsImpl: async () => [request],
    },
  })

  try {
    await waitFor(() => secondHarness.tg.sentHtmlBlocks.length >= 1 && secondHarness.tg.sentMessages.length >= 2)
    secondHarness.tg.enqueue(makeMessageUpdate(373, "because the first try failed"))
    await waitFor(() => secondHarness.ocCalls.replyQuestion.length === 1)
    await secondHarness.connector.stop()

    assert.deepEqual(secondHarness.ocCalls.replyQuestion, [
      { questionId: "q_restart", answers: [["because the first try failed"]] },
    ])

    const finalState = await readState(secondHarness.stateFile)
    assert.deepEqual(finalState.pendingPrompts.questionWizards, {})
    assert.deepEqual(finalState.pendingPrompts.customAnswers, {})
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

    const promptMessageId = prompt.result.message_id
    harness.tg.enqueue(makeCallbackUpdate(301, prompt.replyMarkup.inline_keyboard[0][0].callback_data, { messageId: promptMessageId }))
    await waitFor(() => harness.ocCalls.replyPermission.length === 1)
    await waitFor(() => harness.tg.callbackAnswers.length === 1)

    assert.deepEqual(harness.ocCalls.replyPermission, [{ permissionId: "perm_1", payload: { reply: "once" } }])
    assert.deepEqual(harness.tg.callbackAnswers, [{ callbackQueryId: "cb_301", text: "OK" }])
    assert.deepEqual(harness.tg.deletedMessages, [{ chatId: 100, messageId: promptMessageId }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries child-session permission prompts after parent becomes visible", async () => {
  const permission = { id: "perm_child_late_parent", sessionID: "ses_child", permission: "shell", patterns: ["npm test"] }
  let parentVisible = false
  const harness = await createHarness({
    statePatch: {
      updateOffset: 305,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_root" },
      },
      sessionIndex: {
        "demo:ses_root": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      getSessionImpl: async (sessionId) => {
        if (sessionId === "ses_child") return { id: sessionId, parentID: parentVisible ? "ses_root" : null }
        return { id: sessionId, parentID: null }
      },
      listPermissionsImpl: async () => [],
    },
  })

  try {
    await harness.emitSse("demo", { type: "permission.asked", properties: permission })
    await delay(30)
    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /perm_child_late_parent/.test(block.html))).length, 0)

    parentVisible = true
    await harness.emitSse("demo", { type: "permission.asked", properties: permission })

    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_child_late_parent/.test(block.html))))
    const state = await readState(harness.stateFile)
    assert.ok(state.pendingPrompts.permissions["demo:ses_child:perm_child_late_parent"])
    assert.deepEqual(harness.ocCalls.getSession, ["ses_child", "ses_child"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector delivers permission prompts from nested child sessions", async () => {
  const permissions = [
    { id: "perm_subagent", sessionID: "ses_subagent", permission: "shell", patterns: ["npm test"] },
    { id: "perm_subsubagent", sessionID: "ses_subsubagent", permission: "shell", patterns: ["npm run check"] },
  ]
  const parents = new Map([
    ["ses_subagent", "ses_root"],
    ["ses_subsubagent", "ses_subagent"],
  ])
  const harness = await createHarness({
    statePatch: {
      updateOffset: 306,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_root" },
      },
      sessionIndex: {
        "demo:ses_root": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      getSessionImpl: async (sessionId) => ({ id: sessionId, parentID: parents.get(sessionId) || null }),
      listPermissionsImpl: async () => [],
    },
  })

  try {
    for (const permission of permissions) {
      await harness.emitSse("demo", { type: "permission.asked", properties: permission })
    }

    await waitFor(() => permissions.every((permission) => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => new RegExp(permission.id).test(block.html)))))
    const state = await readState(harness.stateFile)
    for (const permission of permissions) {
      assert.ok(state.pendingPrompts.permissions[`demo:${permission.sessionID}:${permission.id}`])
    }

    for (let index = 0; index < permissions.length; index += 1) {
      const permission = permissions[index]
      const prompt = harness.tg.sentHtmlBlocks.find((entry) => entry.blocks.some((block) => new RegExp(permission.id).test(block.html)))
      harness.tg.enqueue(makeCallbackUpdate(307 + index, `p|demo|${permission.sessionID}|${permission.id}|once`, { messageId: prompt.result.message_id }))
    }

    await waitFor(() => harness.ocCalls.replyPermission.length === permissions.length)
    assert.deepEqual(harness.ocCalls.replyPermission, permissions.map((permission) => ({ permissionId: permission.id, payload: { reply: "once" } })))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector restores child-session permission prompts through ancestor bindings", async () => {
  const permission = { id: "perm_restore_subsubagent", sessionID: "ses_subsubagent", permission: "shell", patterns: ["npm test"] }
  const parents = new Map([
    ["ses_subagent", "ses_root"],
    ["ses_subsubagent", "ses_subagent"],
  ])
  const harness = await createHarness({
    statePatch: {
      updateOffset: 309,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_root" },
      },
      sessionIndex: {
        "demo:ses_root": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:ses_subsubagent:perm_restore_subsubagent": {
            projectAlias: "demo",
            permissionId: permission.id,
            sessionID: permission.sessionID,
            permission: permission.permission,
            patterns: permission.patterns,
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      getSessionImpl: async (sessionId) => ({ id: sessionId, parentID: parents.get(sessionId) || null }),
      listPermissionsImpl: async () => [permission],
      listQuestionsImpl: async () => [],
    },
  })

  try {
    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_restore_subsubagent/.test(block.html))))
    const state = await readState(harness.stateFile)
    assert.ok(state.pendingPrompts.permissions["demo:ses_subsubagent:perm_restore_subsubagent"])
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
    harness.tg.enqueue(makeCallbackUpdate(401, "q|demo|ses_1|q_1|0|t|0", { messageId: firstStepMessageId }))
    await waitFor(() => harness.tg.editedMessages.length >= 1)
    assert.equal(harness.tg.editedMessages[0].kind, "text")

    harness.tg.enqueue(makeCallbackUpdate(402, "q|demo|ses_1|q_1|0|done", { messageId: firstStepMessageId }))
    await waitFor(() => harness.tg.sentMessages.length >= 2)
    assert.match(harness.tg.sentMessages[1].text, /Reason \(2\/2\)/)
    await waitFor(() => harness.tg.deletedMessages.some((entry) => entry.messageId === firstStepMessageId))

    const secondStepMessageId = harness.tg.sentMessages[1].result.message_id
    harness.tg.enqueue(makeCallbackUpdate(403, "q|demo|ses_1|q_1|1|custom", { messageId: secondStepMessageId }))
    await waitFor(() => harness.tg.sentMessages.length >= 3)
    assert.match(harness.tg.sentMessages[2].text, /Send your answer for: Reason/)
    await waitFor(() => harness.tg.deletedMessages.some((entry) => entry.messageId === secondStepMessageId))

    harness.tg.enqueue(makeMessageUpdate(404, "because safety matters"))
    await waitFor(() => harness.ocCalls.replyQuestion.length === 1)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text === "Answered: q_1"))

    assert.deepEqual(harness.ocCalls.replyQuestion, [
      { questionId: "q_1", answers: [["lint"], ["because safety matters"]] },
    ])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Answered: q_1"))
    assert.deepEqual(harness.tg.deletedMessages, [
      { chatId: 100, messageId: firstStepMessageId },
      { chatId: 100, messageId: secondStepMessageId },
    ])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector defers SSE startup until the initial auto-start settles", async () => {
  let releaseStart = null
  const startGate = new Promise((resolve) => {
    releaseStart = resolve
  })
  const startCalls = []
  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
    },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      await startGate
      return { stop() {} }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await waitFor(() => startCalls.length === 1)
    assert.equal(harness.hasSseHandler("demo"), false)

    releaseStart()
    await waitFor(() => harness.hasSseHandler("demo"))
  } finally {
    releaseStart?.()
    await harness.connector.stop()
  }
})

test("startConnector treats startup-session refresh failures as best-effort after auto-start succeeds", async () => {
  const startCalls = []
  let startupSessionCalls = 0
  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
    },
    autoStartRetryDelayMs: 1,
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      return { stop() {} }
    },
    ensureStartupSessionImpl: async () => {
      startupSessionCalls += 1
      throw makeBoundaryError({ source: "opencode", kind: "network", outcome: "retryable", message: "session list unavailable" })
    },
  })

  try {
    await waitFor(() => harness.hasSseHandler("demo"))
    await delay(20)

    assert.deepEqual(startCalls, ["demo"])
    assert.ok(startupSessionCalls >= 1)
    assert.equal(harness.tg.sentMessages.some((entry) => /Project 'demo' is unavailable/.test(entry.text)), false)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector starts initial auto-start projects sequentially and retries failures", async () => {
  const startCalls = []
  const attemptsByAlias = new Map()
  const activeStarts = new Set()
  let maxConcurrentStarts = 0
  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
    },
    extraProjects: {
      alpha: {
        baseUrl: "http://127.0.0.1:4313",
        directory: "C:/alpha",
        autoStart: true,
        port: 4313,
      },
      beta: {
        baseUrl: "http://127.0.0.1:4314",
        directory: "C:/beta",
        autoStart: true,
        port: 4314,
      },
    },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      activeStarts.add(projectAlias)
      maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts.size)
      await delay(1)
      activeStarts.delete(projectAlias)

      const attempt = (attemptsByAlias.get(projectAlias) || 0) + 1
      attemptsByAlias.set(projectAlias, attempt)
      if (projectAlias === "alpha" && attempt === 1) {
        throw makeBoundaryError({ source: "opencode", kind: "network", outcome: "retryable", message: "fetch failed" })
      }
      return { stop() {} }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = `ses_${alias}`
      return `ses_${alias}`
    },
  })

  try {
    await waitFor(() => startCalls.length === 4 && harness.hasSseHandler("demo") && harness.hasSseHandler("alpha") && harness.hasSseHandler("beta"))

    assert.equal(maxConcurrentStarts, 1)
    assert.deepEqual(startCalls, ["demo", "alpha", "beta", "alpha"])
    assert.deepEqual(Object.fromEntries(attemptsByAlias), { demo: 1, alpha: 2, beta: 1 })
    assert.equal(harness.tg.sentMessages.some((entry) => /Project 'alpha' is unavailable/.test(entry.text)), false)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector defers queued initial auto-start session prefetch until project start settles", async () => {
  const started = new Set()
  const listBeforeStart = []
  let releaseDemoStart = () => {}
  const demoStartGate = new Promise((resolve) => {
    releaseDemoStart = resolve
  })
  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
    },
    extraProjects: {
      alpha: {
        baseUrl: "http://127.0.0.1:4313",
        directory: "C:/alpha",
        autoStart: true,
        port: 4313,
      },
    },
    ocOptionsByAlias: {
      alpha: {
        listSessionsImpl: async (input = {}) => {
          if (!started.has("alpha")) listBeforeStart.push("alpha")
          return [{ id: "ses_alpha", directory: input.directory }]
        },
      },
    },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      if (projectAlias === "demo") await demoStartGate
      started.add(projectAlias)
      return { stop() {} }
    },
  })

  try {
    await delay(5)
    assert.deepEqual(listBeforeStart, [])
    assert.equal(harness.ocCallsByAlias.alpha.listSessions.length, 0)

    releaseDemoStart()
    await waitFor(() => started.has("alpha") && harness.hasSseHandler("alpha"))

    assert.deepEqual(listBeforeStart, [])
    assert.equal(harness.ocCallsByAlias.alpha.listSessions.length, 1)
  } finally {
    releaseDemoStart()
    await harness.connector.stop()
  }
})

test("startConnector suppresses watchdog restarts while initial auto-start retry is pending", async () => {
  const retryableErr = makeBoundaryError({
    source: "opencode",
    operation: "POST /session/:id/prompt_async",
    method: "POST",
    pathname: "/session/ses_current/prompt_async",
    kind: "network",
    outcome: "retryable",
    message: "fetch failed",
  })
  const startCalls = []
  const stopCalls = []
  const portStopCalls = []
  const uiStopCalls = []
  const loggerEntries = []
  let promptFailuresRemaining = 1
  let retryDelayHasStarted = false
  let markRetryDelayStarted = () => {
    retryDelayHasStarted = true
  }
  let releaseRetryDelayGate = () => {}
  let retryDelayReleased = false
  const retryDelayGate = new Promise((resolve) => {
    releaseRetryDelayGate = resolve
  })
  function releaseRetryDelay() {
    if (retryDelayReleased) return
    retryDelayReleased = true
    releaseRetryDelayGate()
  }
  const delayImpl = async (ms) => {
    if (ms === 100) {
      markRetryDelayStarted()
      await retryDelayGate
      return
    }
    await delay(Math.min(ms, 2))
  }

  const harness = await createHarness({
    statePatch: {
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_current" },
      },
      sessionIndex: {
        "demo:ses_current": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      autoStart: true,
      port: 4312,
      openTuiOnAutoStart: true,
    },
    ocOptions: {
      promptAsyncImpl: async () => {
        if (promptFailuresRemaining > 0) {
          promptFailuresRemaining -= 1
          throw retryableErr
        }
        return { ok: true }
      },
    },
    opencodeWatchdog: { failureThreshold: 1, windowMs: 60_000, cooldownMs: 0 },
    autoStartStaggerMs: 0,
    autoStartRetryDelayMs: 100,
    autoStartRetryAttempts: 1,
    delayImpl,
    logger: makeLogger(loggerEntries),
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      if (startCalls.length === 1) throw retryableErr
      return {
        stop: async () => {
          stopCalls.push(projectAlias)
        },
      }
    },
    stopOpenCodeServeOnPortImpl: async ({ projectAlias, port }) => {
      portStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [1234] }
    },
    stopOpenCodeUiOnPortImpl: async ({ projectAlias, port }) => {
      uiStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [5678] }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_current"
      return "ses_current"
    },
  })

  try {
    await waitFor(() => retryDelayHasStarted)
    assert.deepEqual(startCalls, ["demo"])

    harness.tg.enqueue(makeMessageUpdate(411, "hello during initial retry"))
    await waitFor(() => harness.ocCalls.promptAsync.length >= 1)
    await waitFor(() => loggerEntries.some((entry) =>
      entry.level === "warn" &&
      entry.args[0] === "Retryable update handler error" &&
      entry.args[1]?.updateId === 411,
    ))

    assert.deepEqual(startCalls, ["demo"])
    assert.deepEqual(stopCalls, [])
    assert.deepEqual(portStopCalls, [])
    assert.deepEqual(uiStopCalls, [])

    releaseRetryDelay()
    await waitFor(() => startCalls.length >= 2 && harness.hasSseHandler("demo"), { timeoutMs: 5000 })

    assert.deepEqual(startCalls, ["demo", "demo"])
    assert.deepEqual(stopCalls, [])
    assert.deepEqual(portStopCalls, [])
    assert.deepEqual(uiStopCalls, [])
  } finally {
    releaseRetryDelay()
    await harness.connector.stop()
  }
})

test("startConnector watchdog restarts an autoStart project after repeated SSE failures", async () => {
  const startCalls = []
  const stopCalls = []
  const portStopCalls = []
  const uiStopCalls = []
  let nextHandleId = 0
  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
      openTuiOnAutoStart: true,
    },
    opencodeWatchdog: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 0 },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      const handleId = ++nextHandleId
      return {
        stop: async () => {
          stopCalls.push({ projectAlias, handleId })
        },
      }
    },
    stopOpenCodeServeOnPortImpl: async ({ projectAlias, port }) => {
      portStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [1234] }
    },
    stopOpenCodeUiOnPortImpl: async ({ projectAlias, port }) => {
      uiStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [5678] }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await waitFor(() => startCalls.length === 1 && harness.hasSseHandler("demo"))
    const err = makeBoundaryError({
      source: "opencode",
      operation: "GET /event",
      method: "GET",
      pathname: "/event",
      kind: "network",
      outcome: "retryable",
      message: "fetch failed",
    })

    await harness.failSse("demo", err)
    assert.equal(startCalls.length, 1)

    await harness.failSse("demo", err)
    await waitFor(() => startCalls.length === 2)

    assert.deepEqual(stopCalls, [{ projectAlias: "demo", handleId: 1 }])
    assert.deepEqual(uiStopCalls, [{ projectAlias: "demo", port: 4312 }])
    assert.deepEqual(portStopCalls, [{ projectAlias: "demo", port: 4312 }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector watchdog does not kill UI or serve after shutdown abort", async () => {
  const startCalls = []
  const stopCalls = []
  const portStopCalls = []
  const uiStopCalls = []
  let releaseHandleStop = () => {}
  const handleStopGate = new Promise((resolve) => {
    releaseHandleStop = resolve
  })
  let markHandleStopEntered = () => {}
  const handleStopEntered = new Promise((resolve) => {
    markHandleStopEntered = resolve
  })
  let handleStopPromise = null

  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
      port: 4312,
      openTuiOnAutoStart: true,
    },
    opencodeWatchdog: { failureThreshold: 1, windowMs: 60_000, cooldownMs: 0 },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      return {
        stop: async () => {
          if (!handleStopPromise) {
            stopCalls.push(projectAlias)
            markHandleStopEntered()
            handleStopPromise = handleStopGate
          }
          return handleStopPromise
        },
      }
    },
    stopOpenCodeServeOnPortImpl: async ({ projectAlias, port }) => {
      portStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [1234] }
    },
    stopOpenCodeUiOnPortImpl: async ({ projectAlias, port }) => {
      uiStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [5678] }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await waitFor(() => startCalls.length === 1 && harness.hasSseHandler("demo"))
    await harness.failSse(
      "demo",
      makeBoundaryError({
        source: "opencode",
        operation: "GET /event",
        method: "GET",
        pathname: "/event",
        kind: "network",
        outcome: "retryable",
        message: "fetch failed",
      }),
    )
    await handleStopEntered

    const stopPromise = harness.connector.stop()
    releaseHandleStop()
    await stopPromise

    assert.deepEqual(stopCalls, ["demo"])
    assert.deepEqual(uiStopCalls, [])
    assert.deepEqual(portStopCalls, [])
  } finally {
    releaseHandleStop()
    await harness.connector.stop()
  }
})

test("startConnector watchdog restarts an autoStart project after repeated prompt poll failures", async () => {
  const startCalls = []
  const portStopCalls = []
  const uiStopCalls = []
  let pollHealthy = false
  let permissionCalls = 0
  let questionCalls = 0
  const retryablePermissionError = () =>
    makeBoundaryError({
      source: "opencode",
      operation: "GET /permission",
      method: "GET",
      pathname: "/permission",
      kind: "timeout",
      outcome: "retryable",
      message: "This operation was aborted",
    })
  const retryableQuestionError = () =>
    makeBoundaryError({
      source: "opencode",
      operation: "GET /question",
      method: "GET",
      pathname: "/question",
      kind: "timeout",
      outcome: "retryable",
      message: "This operation was aborted",
    })

  const harness = await createHarness({
    statePatch: { updateOffset: null },
    projectPatch: {
      autoStart: true,
      port: 4312,
      openTuiOnAutoStart: false,
    },
    opencodeWatchdog: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 0 },
    ocOptions: {
      listPermissionsImpl: async () => {
        permissionCalls += 1
        if (permissionCalls === 1 || pollHealthy) return []
        throw retryablePermissionError()
      },
      listQuestionsImpl: async () => {
        questionCalls += 1
        if (questionCalls === 1 || pollHealthy) return []
        throw retryableQuestionError()
      },
    },
    ensureOpenCodeRunningImpl: async ({ projectAlias }) => {
      startCalls.push(projectAlias)
      if (startCalls.length >= 2) pollHealthy = true
      return { stop() {} }
    },
    stopOpenCodeServeOnPortImpl: async ({ projectAlias, port }) => {
      portStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [1234] }
    },
    stopOpenCodeUiOnPortImpl: async ({ projectAlias, port }) => {
      uiStopCalls.push({ projectAlias, port })
      return { stopped: true, count: 1, pids: [5678] }
    },
    ensureStartupSessionImpl: async ({ alias, startupSessionByProject }) => {
      startupSessionByProject[alias] = "ses_startup"
      return "ses_startup"
    },
  })

  try {
    await waitFor(() => startCalls.length === 2)
    assert.deepEqual(uiStopCalls, [{ projectAlias: "demo", port: 4312 }])
    assert.deepEqual(portStopCalls, [{ projectAlias: "demo", port: 4312 }])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector stop stays bounded while auto-start health wait is in flight", async () => {
  let startCalls = 0
  let observedAbort = false
  let releaseAbortWait = () => {}
  const abortObserved = new Promise((resolve) => {
    releaseAbortWait = resolve
  })

  const harness = await createHarness({
    projectPatch: {
      autoStart: true,
    },
    ensureOpenCodeRunningImpl: async ({ abortSignal }) => {
      startCalls += 1
      if (abortSignal?.aborted) {
        observedAbort = true
        releaseAbortWait()
        return null
      }
      await new Promise((resolve) => {
        abortSignal?.addEventListener?.(
          "abort",
          () => {
            observedAbort = true
            releaseAbortWait()
            resolve()
          },
          { once: true },
        )
      })
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    },
  })

  try {
    await waitFor(() => startCalls === 1)

    let stopped = false
    const stopPromise = harness.connector.stop().then(() => {
      stopped = true
    })

    await abortObserved
    await stopPromise

    assert.equal(observedAbort, true)
    assert.equal(stopped, true)
  } finally {
    releaseAbortWait()
    await harness.connector.stop()
  }
})

test("startConnector surfaces state flush failures during shutdown", async () => {
  let failShutdownFlush = false
  const harness = await createHarness({
    createStateStoreImpl: (options) => {
      const store = new StateStore(options)
      const originalFlush = store.flush.bind(store)
      store.flush = async () => {
        if (failShutdownFlush) throw new Error("shutdown write failed")
        return originalFlush()
      }
      return store
    },
  })

  failShutdownFlush = true
  await assert.rejects(() => harness.connector.stop(), /shutdown write failed/)
})

test("startConnector fails closed when pending prompt recovery cleanup is not durable", async () => {
  let autoStartCalls = 0
  let sseStarts = 0

  await assert.rejects(
    () => createHarness({
      statePatch: {
        updateOffset: 700,
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_other" },
        },
        sessionIndex: {
          "demo:ses_other": { chatId: 100, threadIdOr0: 7 },
        },
        pendingPrompts: {
          permissions: {
            "demo:ses_1:perm_stale": {
              projectAlias: "demo",
              permissionId: "perm_stale",
              sessionID: "ses_1",
              permission: "shell",
              patterns: [],
              ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            },
          },
          rejectNotes: {},
          customAnswers: {},
          questionWizards: {},
        },
      },
      projectPatch: {
        autoStart: true,
        port: 4312,
      },
      createStateStoreImpl: (options) => {
        const store = new StateStore(options)
        store.flush = async () => {
          throw new Error("recovery write failed")
        }
        return store
      },
      startSseLoopImpl: () => {
        sseStarts += 1
        return { stop() {} }
      },
      ensureOpenCodeRunningImpl: async () => {
        autoStartCalls += 1
        return { stop() {} }
      },
    }),
    (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.kind, "durability")
      assert.match(err.message, /persist pending prompt recovery state failed: recovery write failed/)
      return true
    },
  )
  assert.equal(autoStartCalls, 0)
  assert.equal(sseStarts, 0)
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
    await waitFor(() => startCalls.length >= 2)
    const sentBeforePrompt = harness.tg.sentMessages.length

    harness.tg.enqueue(makeMessageUpdate(501, "hello after outage"))
    await waitFor(() => promptAttempts === 1 && harness.tg.sentMessages.length > sentBeforePrompt)

    const recoveryPrompt = harness.tg.sentMessages.slice(sentBeforePrompt).find((entry) => {
      return entry.replyMarkup?.inline_keyboard?.[0]?.[0]?.text === "Start 'demo'"
    })
    assert.ok(recoveryPrompt)
    assert.match(recoveryPrompt.text, /Project 'demo' is unavailable/)

    harness.tg.enqueue(makeCallbackUpdate(502, "srv|demo|start", { messageId: recoveryPrompt.result.message_id }))
    await waitFor(() => startCalls.length >= 3)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text === "Starting opencode for 'demo'…"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Project 'demo' is up:")))

    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_502" && entry.text === "Starting…"))
    assert.deepEqual(startCalls, ["demo", "demo", "demo"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector sends one reconnected notice after project recovery", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 550,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /permission",
          method: "GET",
          pathname: "/permission",
          kind: "network",
          outcome: "retryable",
          message: "temporary permission poll failure",
        })
      },
      listQuestionsImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /question",
          method: "GET",
          pathname: "/question",
          kind: "network",
          outcome: "retryable",
          message: "temporary question poll failure",
        })
      },
    },
  })

  try {
    await harness.failSse("demo", new Error("SSE 503 unavailable"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => /Project 'demo' is unavailable/.test(entry.text)))

    const sentAfterFailure = harness.tg.sentMessages.length
    await harness.connectSse("demo")
    await waitFor(() => harness.tg.sentMessages.length > sentAfterFailure)

    const recovered = harness.tg.sentMessages.at(-1)?.text || ""
    assert.match(recovered, /Project 'demo' is back online/)

    const sentAfterRecovery = harness.tg.sentMessages.length
    await harness.connectSse("demo")
    await delay(30)
    assert.equal(harness.tg.sentMessages.length, sentAfterRecovery)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector captures an atomic old-backlog cutoff before processing live updates", async () => {
  const loggerEntries = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: null,
    },
    initialUpdates: [makeMessageUpdate(10, "/help"), makeMessageUpdate(11, "/help"), makeMessageUpdate(12, "/help")],
    logger: makeLogger(loggerEntries),
  })

  try {
    await waitFor(() => harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30))
    harness.tg.enqueue(makeMessageUpdate(13, "/help"))

    await waitFor(() => harness.tg.sentMessages.length >= 1)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(harness.tg.sentMessages.length, 1)
    assert.match(harness.tg.sentMessages[0].text, /Telegram connector help:/)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 0 && call?.offset === -1 && call?.limit === 1))
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 13))
    assert.equal(state.updateOffset, 14)
    assert.ok(loggerEntries.some((entry) =>
      entry.level === "info" &&
      entry.args[0] === "Telegram backlog cutoff captured." &&
      entry.args[1]?.cutoffUpdateId === 12 &&
      entry.args[1]?.offset === 13,
    ))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector preserves an update that arrives immediately after the first-run backlog snapshot", async () => {
  let snapshotCalls = 0
  const harness = await createHarness({
    statePatch: { updateOffset: null },
    initialUpdates: [makeMessageUpdate(30, "/help"), makeMessageUpdate(31, "/help")],
    tgOptions: {
      afterNegativeOffsetSnapshot: async ({ enqueue }) => {
        snapshotCalls += 1
        enqueue(makeMessageUpdate(32, "/help"))
      },
    },
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length === 1)
    const state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.updateOffset === 33 ? current : null
    })

    assert.equal(snapshotCalls, 1)
    assert.equal(state.updateOffset, 33)
    assert.equal(harness.tg.sentMessages.length, 1)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.offset === -1 && call?.limit === 1))
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.offset === 32 && call?.timeout === 30))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector never repeats an ambiguous first-run backlog snapshot and exposes the durable fallback", async () => {
  let snapshotCalls = 0
  const loggerEntries = []
  const harness = await createHarness({
    statePatch: { updateOffset: null },
    initialUpdates: [makeMessageUpdate(30, "/help"), makeMessageUpdate(31, "/help")],
    logger: makeLogger(loggerEntries),
    tgOptions: {
      afterNegativeOffsetSnapshot: async ({ enqueue }) => {
        snapshotCalls += 1
        if (snapshotCalls !== 1) return
        enqueue(makeMessageUpdate(32, "/runtime", { chatType: "private", threadIdOr0: 0 }))
        const err = new Error("Telegram response was lost after the cutoff reached the server")
        err.code = "ECONNRESET"
        throw err
      },
    },
  })

  try {
    const runtimeMessage = await waitFor(() => harness.tg.sentMessages.find((entry) => /^Runtime:/.test(entry.text || "")))
    const state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.updateOffset === 33 ? current : null
    })

    assert.equal(snapshotCalls, 1)
    assert.equal(state.updateOffset, 33)
    assert.equal(harness.tg.getUpdatesCalls.filter((call) => call?.offset === -1).length, 1)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.offset === 0 && call?.timeout === 30))
    assert.match(runtimeMessage.text, /Backlog drain: retries=1 aborted=0 hits=1/)
    assert.ok(loggerEntries.some((entry) =>
      entry.level === "warn" &&
      entry.args[0] === "Telegram backlog cutoff response was ambiguous. Continuing safely from offset 0.",
    ))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries a first-run backlog snapshot only when the request was clearly unsent", async () => {
  let negativeAttempts = 0
  let snapshotCalls = 0
  const harness = await createHarness({
    statePatch: { updateOffset: null },
    initialUpdates: [makeMessageUpdate(50, "/help")],
    tgOptions: {
      beforeGetUpdates: async ({ input }) => {
        if (input?.offset !== -1) return
        negativeAttempts += 1
        if (negativeAttempts !== 1) return
        const cause = new Error("DNS lookup failed before connecting")
        cause.code = "ENOTFOUND"
        throw new Error("fetch failed", { cause })
      },
      afterNegativeOffsetSnapshot: async ({ enqueue }) => {
        snapshotCalls += 1
        enqueue(makeMessageUpdate(51, "/help"))
      },
    },
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length === 1)
    const state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.updateOffset === 52 ? current : null
    })

    assert.equal(negativeAttempts, 2)
    assert.equal(snapshotCalls, 1)
    assert.equal(state.updateOffset, 52)
    assert.equal(harness.tg.getUpdatesCalls.filter((call) => call?.offset === -1).length, 2)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.offset === 51 && call?.timeout === 30))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector readiness stays false until an ambiguous backlog fallback is durably persisted", async () => {
  let healthAddress = null
  let ambiguousResponseObserved = false
  let fallbackFlushStarted = false
  let releaseFallbackFlush
  const fallbackFlushRelease = new Promise((resolve) => { releaseFallbackFlush = resolve })
  const harness = await createHarness({
    statePatch: { updateOffset: null },
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    tgOptions: {
      afterNegativeOffsetSnapshot: async () => {
        ambiguousResponseObserved = true
        const err = new Error("socket disconnected after request write")
        err.code = "EPIPE"
        throw err
      },
    },
    createStateStoreImpl: (options) => {
      const store = new StateStore(options)
      const writeJsonFileAtomic = store._writeJsonFileAtomic
      let fallbackFlushGated = false
      store._writeJsonFileAtomic = async (filePath, state, writeOptions) => {
        if (ambiguousResponseObserved && state.updateOffset === 0 && !fallbackFlushGated) {
          fallbackFlushGated = true
          fallbackFlushStarted = true
          await fallbackFlushRelease
        }
        return writeJsonFileAtomic(filePath, state, writeOptions)
      }
      return store
    },
    startHealthServerImpl: async (options) => {
      const handle = await startHealthServer(options)
      healthAddress = handle.address
      return handle
    },
  })

  try {
    await waitFor(() => fallbackFlushStarted)
    const baseUrl = `http://127.0.0.1:${healthAddress.port}`
    const pending = await fetch(`${baseUrl}/readyz`)
    assert.equal(pending.status, 503)
    const pendingBody = await pending.json()
    assert.equal(pendingBody.status, "not_ready")
    assert.equal(pendingBody.checks.state.ok, false)
    assert.equal(pendingBody.checks.state.flushInFlight, true)
    assert.equal(pendingBody.checks.telegramPoll.ok, false)
    assert.equal((await readState(harness.stateFile)).updateOffset, -1)

    releaseFallbackFlush()
    const ready = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/readyz`)
      return response.status === 200 ? response : null
    })
    assert.equal((await ready.json()).status, "ready")
  } finally {
    releaseFallbackFlush?.()
    await harness.connector.stop()
  }
})

test("startConnector fails safe after an interrupted backlog cutoff instead of discarding more updates", async () => {
  const loggerEntries = []
  const harness = await createHarness({
    statePatch: { updateOffset: -1 },
    initialUpdates: [makeMessageUpdate(40, "/help")],
    logger: makeLogger(loggerEntries),
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length === 1)
    const state = await waitFor(async () => {
      const current = await readState(harness.stateFile)
      return current.updateOffset === 41 ? current : null
    })

    assert.equal(state.updateOffset, 41)
    assert.equal(harness.tg.getUpdatesCalls.some((call) => call?.offset === -1), false)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.offset === 0 && call?.timeout === 30))
    assert.ok(loggerEntries.some((entry) => entry.level === "warn" && entry.args[0] === "Recovering an interrupted Telegram backlog cutoff without discarding queued updates."))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector processes first-run backlog when drain policy is disabled", async () => {
  const loggerEntries = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: null,
    },
    configPatch: {
      drainTelegramBacklogOnFirstRun: false,
    },
    initialUpdates: [makeMessageUpdate(20, "/help"), makeMessageUpdate(21, "/help")],
    logger: makeLogger(loggerEntries),
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length >= 2)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 22)
    assert.equal(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 0), false)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 0))
    assert.ok(loggerEntries.some((entry) => entry.level === "info" && entry.args[0] === "Telegram backlog drain disabled on first run. Processing queued updates from offset 0."))
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

test("startConnector replays retryable continuation prompt delivery without checkpointing the callback", async () => {
  let rejectNotePromptAttempts = 0
  const callbackUpdate = makeCallbackUpdate(620, "p|demo|ses_1|perm_note|reject_note")
  const harness = await createHarness({
    statePatch: {
      updateOffset: 620,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
      pendingPrompts: {
        permissions: {
          "demo:ses_1:perm_note": {
            projectAlias: "demo",
            permissionId: "perm_note",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [{ id: "perm_note", sessionID: "ses_1" }],
      listQuestionsImpl: async () => [],
    },
    tgOptions: {
      sendMessageImpl: async ({ text }) => {
        if (String(text || "").includes("Send rejection note")) {
          rejectNotePromptAttempts += 1
          if (rejectNotePromptAttempts === 1) {
            throw makeBoundaryError({
              source: "telegram",
              operation: "sendMessage",
              kind: "network",
              outcome: "retryable",
              message: "temporary Telegram send failure",
            })
          }
        }
      },
    },
    initialUpdates: [[callbackUpdate], [callbackUpdate]],
  })

  try {
    await waitFor(() => rejectNotePromptAttempts === 2)
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.text === "Send note"))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 621)
    assert.deepEqual(harness.tg.callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable", "Send note"])
    assert.ok(harness.tg.getUpdatesCalls.filter((call) => call?.offset === 620).length >= 2)
  } finally {
    await harness.connector.stop().catch(() => {})
  }
})

test("startConnector treats Telegram checkpoint flush failures as fatal", async () => {
  const fatalErrors = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: 500,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    createStateStoreImpl: (options) => {
      const store = new StateStore(options)
      store.flush = async () => {
        throw new Error("disk full")
      }
      return store
    },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(501, "blocked", { userId: 999 }))

    await waitFor(() => fatalErrors.length === 1)

    assert.match(fatalErrors[0].message, /persist Telegram update checkpoint failed: disk full/)
    assert.deepEqual(harness.ocCalls.promptAsync, [])
    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 500)
  } finally {
    await harness.connector.stop().catch(() => {})
  }
})

test("startConnector skips non-retryable updates without wedging later updates", async () => {
  let sendAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 610,
    },
    tgOptions: {
      sendMessageImpl: async () => {
        sendAttempts += 1
        if (sendAttempts === 2) {
          throw makeBoundaryError({
            source: "telegram",
            operation: "sendMessage",
            method: "POST",
            pathname: "/sendMessage",
            outcome: "fatal",
            message: "chat not found",
          })
        }
      },
    },
    initialUpdates: [[makeMessageUpdate(610, "/help"), makeMessageUpdate(611, "/help"), makeMessageUpdate(612, "/help")]],
  })

  try {
    await waitFor(() => harness.tg.sentMessages.length === 2)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 613)
    assert.ok(harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 610))
    assert.ok(!harness.tg.getUpdatesCalls.some((call) => call?.timeout === 30 && call?.offset === 611))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector skips replayed Telegram message updates without duplicate prompts", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 620,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    initialUpdates: [
      [makeMessageUpdate(620, "hello once", { messageId: 5000 })],
      [makeMessageUpdate(621, "hello once", { messageId: 5000 })],
    ],
  })

  try {
    await waitFor(() => harness.tg.getUpdatesCalls.some((call) => call?.offset === 622))
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.promptAsync, [{ sessionId: "ses_1", text: "[TG] hello once" }])
    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 622)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries user prompts after a clearly unsent promptAsync failure", async () => {
  let attempts = 0
  const update = makeMessageUpdate(625, "hello retry", { messageId: 5050 })
  const harness = await createHarness({
    statePatch: {
      updateOffset: 625,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      promptAsyncImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          const err = new Error("OpenCode connection timed out before the request was sent")
          err.code = "UND_ERR_CONNECT_TIMEOUT"
          throw err
        }
        return { ok: true }
      },
    },
    initialUpdates: [[update], [update]],
  })

  try {
    await waitFor(() => harness.ocCalls.promptAsync.length === 2)
    await waitFor(async () => (await readState(harness.stateFile)).updateOffset === 626)

    assert.deepEqual(harness.ocCalls.promptAsync, [
      { sessionId: "ses_1", text: "[TG] hello retry" },
      { sessionId: "ses_1", text: "[TG] hello retry" },
    ])
    assert.match(harness.tg.sentMessages[0].text, /Project 'demo' is unavailable/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector reconciles an accepted text prompt after a lost response without another POST", async () => {
  const lost = acceptedThenLostOpenCodeOptions()
  const update = makeMessageUpdate(627, "accepted once", { messageId: 5052 })
  const harness = await createHarness({
    statePatch: {
      updateOffset: 627,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    ocOptions: lost.options,
    initialUpdates: [[update], [update]],
  })

  try {
    await waitFor(async () => (await readState(harness.stateFile)).updateOffset === 628)
    assert.equal(harness.ocCalls.promptAsync.length, 1)
    assert.equal(harness.ocCalls.getMessage.length, 1)
    assert.equal(lost.accepted.size, 1)
    assert.equal(harness.ocCalls.promptMessageIDs[0], harness.ocCalls.getMessage[0].messageId)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector reconciles an accepted direct attachment prompt after a lost response", async () => {
  const lost = acceptedThenLostOpenCodeOptions()
  let downloadCalls = 0
  const update = makeDocumentUpdate(628, {
    file_id: "direct_file",
    file_name: "direct.txt",
    mime_type: "text/plain",
    file_size: 16,
  }, { messageId: 5053 })
  const harness = await createHarness({
    statePatch: {
      updateOffset: 628,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    ocOptions: lost.options,
    tgOptions: {
      downloadFileImpl: async () => {
        downloadCalls += 1
        if (downloadCalls > 1) {
          throw makeBoundaryError({ source: "telegram", operation: "downloadFile", status: 400, outcome: "fatal", message: "file expired" })
        }
        return new TextEncoder().encode("attachment text")
      },
    },
    initialUpdates: [[update], [update]],
  })

  try {
    await waitFor(async () => (await readState(harness.stateFile)).updateOffset === 629)
    assert.equal(harness.ocCalls.promptAsync.length, 1)
    assert.equal(harness.ocCalls.getMessage.length, 1)
    assert.equal(lost.accepted.size, 1)
    assert.equal(downloadCalls, 1)
    assert.equal(harness.ocCalls.promptMessageIDs[0], harness.ocCalls.getMessage[0].messageId)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector replays and reconciles an accepted confirmed attachment callback after a lost response", async () => {
  const lost = acceptedThenLostOpenCodeOptions()
  let downloadCalls = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 629,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    ocOptions: lost.options,
    tgOptions: {
      downloadFileImpl: async () => {
        downloadCalls += 1
        if (downloadCalls > 1) {
          throw makeBoundaryError({ source: "telegram", operation: "downloadFile", status: 400, outcome: "fatal", message: "file expired" })
        }
        return new TextEncoder().encode("attachment text")
      },
    },
  })

  try {
    harness.tg.enqueue(makeDocumentUpdate(629, {
      file_id: "confirmed_file",
      file_name: "confirmed.txt",
      mime_type: "text/plain",
      file_size: USER_ATTACHMENT_LIMITS.confirmBytes,
    }, { messageId: 5054 }))
    const confirmation = await waitFor(() => harness.tg.sentMessages.find((entry) => entry.text.includes("Confirm sending this file")))
    const sendButton = confirmation.replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")
    assert.ok(sendButton)

    const callback = makeCallbackUpdate(630, sendButton.callback_data, { messageId: confirmation.result.message_id })
    harness.tg.enqueueBatch([callback])
    harness.tg.enqueueBatch([callback])
    await waitFor(async () => (await readState(harness.stateFile)).updateOffset === 631)

    assert.equal(harness.ocCalls.promptAsync.length, 1)
    assert.equal(harness.ocCalls.getMessage.length, 1)
    assert.equal(lost.accepted.size, 1)
    assert.equal(downloadCalls, 1)
    assert.equal(harness.ocCalls.promptMessageIDs[0], harness.ocCalls.getMessage[0].messageId)
    assert.deepEqual(
      harness.tg.callbackAnswers.filter((entry) => entry.callbackQueryId === "cb_630").map((entry) => entry.text),
      ["Sending…", "Temporarily unavailable", "Sending…"],
    )
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector reconciles an accepted confirmed attachment after restart without a second POST or download", async () => {
  const lost = acceptedThenLostOpenCodeOptions()
  let downloadCalls = 0
  const first = await createHarness({
    statePatch: {
      updateOffset: 629,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    ocOptions: lost.options,
    tgOptions: {
      downloadFileImpl: async () => {
        downloadCalls += 1
        return new TextEncoder().encode("attachment text")
      },
    },
  })

  let callback
  let persistedState
  try {
    first.tg.enqueue(makeDocumentUpdate(629, {
      file_id: "confirmed_restart_file",
      file_unique_id: "confirmed_restart_unique",
      file_name: "confirmed-restart.txt",
      mime_type: "text/plain",
      file_size: USER_ATTACHMENT_LIMITS.confirmBytes,
    }, { messageId: 5055 }))
    const confirmation = await waitFor(() => first.tg.sentMessages.find((entry) => entry.text.includes("Confirm sending this file")))
    const sendButton = confirmation.replyMarkup.inline_keyboard.flat().find((button) => button.text === "Send file")
    callback = makeCallbackUpdate(630, sendButton.callback_data, { messageId: confirmation.result.message_id })
    first.tg.enqueue(callback)

    await waitFor(async () => {
      const state = await readState(first.stateFile)
      return Object.values(state.promptDeliveries.records).some((record) => record.state === "outcome_unknown")
    })
  } finally {
    await first.connector.stop()
    persistedState = await readState(first.stateFile)
  }

  assert.equal(Object.keys(persistedState.attachmentConfirmations.records).length, 1)
  assert.equal(first.ocCalls.promptAsync.length, 1)
  assert.equal(downloadCalls, 1)

  const restarted = await createHarness({
    statePatch: persistedState,
    ocOptions: lost.options,
    tgOptions: {
      downloadFileImpl: async () => {
        downloadCalls += 1
        throw new Error("reconciliation must happen before a second download")
      },
    },
    initialUpdates: [[callback]],
  })
  try {
    await waitFor(async () => (await readState(restarted.stateFile)).updateOffset === 631)
    const state = await readState(restarted.stateFile)

    assert.equal(restarted.ocCalls.promptAsync.length, 0)
    assert.equal(restarted.ocCalls.getMessage.length, 1)
    assert.equal(downloadCalls, 1)
    assert.deepEqual(state.attachmentConfirmations, { records: {} })
    assert.ok(Object.keys(state.idempotency.keys).some((key) => key.startsWith("tg-attachment-send:")))
    assert.ok(restarted.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_630" && entry.text === "Sending…"))
    assert.ok(restarted.tg.editedMessages.some((entry) => /Attachment sent to demo\/ses_1/.test(entry.text)))
  } finally {
    await restarted.connector.stop()
  }
})

test("startConnector skips duplicate permission callback replays after ledger persistence", async () => {
  const pendingPermission = {
    projectAlias: "demo",
    permissionId: "perm_replay",
    sessionID: "ses_1",
    permission: "shell",
    patterns: ["npm test"],
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    createdAt: Date.now(),
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 630,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: { "demo:perm_replay": pendingPermission },
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {},
      },
      idempotency: {
        keys: {
          [permissionReplyIdempotencyKey("demo", "ses_1", "perm_replay", "once")]: {
            createdAt: Date.now(),
            kind: "permission-reply",
            projectAlias: "demo",
            operation: "replyPermission",
            action: "once",
          },
        },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [{ id: "perm_replay" }],
      listQuestionsImpl: async () => [],
    },
    initialUpdates: [[makeCallbackUpdate(630, "p|demo|ses_1|perm_replay|once")]],
  })

  try {
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_630"))
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [])
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_630" && entry.text === "Already handled"))
    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector skips duplicate question reply after restart ledger replay", async () => {
  const request = {
    id: "q_replay",
    sessionID: "ses_1",
    questions: [{ header: "Pick", question: "Pick one", options: [{ label: "A" }] }],
  }
  const answers = [["A"]]
  const replyKey = questionReplyIdempotencyKey("demo", "ses_1", "q_replay", answers)
  const harness = await createHarness({
    statePatch: {
      updateOffset: 640,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {
          "demo:q_replay": {
            projectAlias: "demo",
            id: "q_replay",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
      idempotency: {
        keys: {
          [replyKey]: {
            createdAt: Date.now(),
            kind: "question-reply",
            projectAlias: "demo",
            operation: "replyQuestion",
          },
        },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [],
      listQuestionsImpl: async () => [request],
    },
    initialUpdates: [[makeCallbackUpdate(640, "q|demo|ses_1|q_replay|0|o|0")]],
  })

  try {
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_640"))
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyQuestion, [])
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_640" && (entry.text === "Selected" || entry.text === "Already handled")))
    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector does not duplicate prompts seen by both SSE and polling fallback", async () => {
  const permission = { id: "perm_race", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  let exposePermission = false
  const harness = await createHarness({
    statePatch: {
      updateOffset: 645,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => (exposePermission ? [permission] : []),
      listQuestionsImpl: async () => [],
    },
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    exposePermission = true
    await harness.emitSse("demo", { type: "permission.asked", properties: permission })
    await delay(30)

    const permissionPrompts = harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /Permission request/.test(block.html)))
    assert.equal(permissionPrompts.length, 1)
    await harness.connector.stop()
    const state = await readState(harness.stateFile)
    assert.equal(Object.keys(state.pendingPrompts.permissions).length, 1)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector does not baseline-suppress another live prompt when startup baseline is unavailable", async () => {
  const permission = { id: "perm_first_sse", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  const question = {
    id: "q_second_sse",
    sessionID: "ses_1",
    questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }],
  }
  let livePromptsVisible = false
  const harness = await createHarness({
    statePatch: {
      updateOffset: 641,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => (livePromptsVisible ? [permission] : null),
      listQuestionsImpl: async () => (livePromptsVisible ? [question] : null),
    },
    delayImpl: (ms) => (ms >= 15_000 ? new Promise(() => {}) : shortDelay(ms)),
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    livePromptsVisible = true
    await harness.emitSse("demo", { type: "permission.asked", properties: permission })
    await harness.emitSse("demo", { type: "question.asked", properties: question })
    await waitFor(() =>
      harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_first_sse/.test(block.html))) &&
      harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /q_second_sse/.test(block.html))),
    )

    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /perm_first_sse/.test(block.html))).length, 1)
    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /q_second_sse/.test(block.html))).length, 1)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector treats prompts present in the initial poll snapshot as pre-existing", async () => {
  const permission = { id: "perm_baseline", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  const question = {
    id: "q_baseline",
    sessionID: "ses_1",
    questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }],
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 642,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [permission],
      listQuestionsImpl: async () => [question],
    },
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    await delay(30)
    await harness.emitSse("demo", { type: "permission.asked", properties: permission })
    await harness.emitSse("demo", { type: "question.asked", properties: question })

    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /perm_baseline/.test(block.html))).length, 0)
    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /q_baseline/.test(block.html))).length, 0)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector delivers prompts through polling fallback while SSE is down", async () => {
  const permission = { id: "perm_poll", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  let exposePermission = false
  const harness = await createHarness({
    statePatch: {
      updateOffset: 645,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => (exposePermission ? [permission] : []),
      listQuestionsImpl: async () => [],
    },
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    await harness.failSse("demo", new Error("sse down"))
    exposePermission = true
    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_poll/.test(block.html))))

    harness.tg.enqueue(makeMessageUpdate(646, "/status"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => /Prompt poll observed:/.test(entry.text) && /hits=1/.test(entry.text)))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.ok(state.pendingPrompts.permissions["demo:ses_1:perm_poll"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector polling fallback delivers new prompts after startup baseline was unavailable", async () => {
  const permission = { id: "perm_poll_after_baseline_fail", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  let livePromptsVisible = false
  const harness = await createHarness({
    statePatch: {
      updateOffset: 647,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => (livePromptsVisible ? [permission] : null),
      listQuestionsImpl: async () => (livePromptsVisible ? [] : null),
    },
  })

  try {
    await waitFor(() => harness.ocCalls.listPermissions > 0)
    await harness.failSse("demo", new Error("sse down"))
    livePromptsVisible = true
    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_poll_after_baseline_fail/.test(block.html))))

    assert.equal(harness.tg.sentHtmlBlocks.filter((entry) => entry.blocks.some((block) => /perm_poll_after_baseline_fail/.test(block.html))).length, 1)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector flushes Telegram-side prompt state immediately after delivery", async () => {
  const question = {
    id: "q_flush",
    sessionID: "ses_2",
    questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }],
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 650,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
        "100:9": { projectAlias: "demo", sessionId: "ses_2" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_2": { chatId: 100, threadIdOr0: 9 },
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: { id: "perm_flush", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] },
    })
    await waitFor(() => harness.tg.sentHtmlBlocks.some((entry) => entry.blocks.some((block) => /perm_flush/.test(block.html))))
    let state = await readState(harness.stateFile)
    assert.ok(state.pendingPrompts.permissions["demo:ses_1:perm_flush"])

    harness.tg.enqueue(makeCallbackUpdate(650, "p|demo|ses_1|perm_flush|reject_note", { threadIdOr0: 7 }))
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_650" && entry.text === "Send note"))
    state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.rejectNotes["100:7"], { projectAlias: "demo", permissionId: "perm_flush", sessionID: "ses_1" })

    await harness.emitSse("demo", { type: "question.asked", properties: question })
    await waitFor(() => harness.tg.sentMessages.some((entry) => /Reason \(1\/1\)/.test(entry.text)))
    state = await readState(harness.stateFile)
    assert.ok(state.pendingPrompts.questionWizards["demo:ses_2:q_flush"])

    harness.tg.enqueue(makeCallbackUpdate(651, "q|demo|ses_2|q_flush|0|custom", { threadIdOr0: 9 }))
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_651" && entry.text === "Send answer"))
    state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.customAnswers["100:9"], { projectAlias: "demo", requestId: "q_flush", sessionID: "ses_2", qIndex: 0 })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector flushes packed callback payloads before prompt buttons become visible", async () => {
  const permissionId = `perm_${"x".repeat(90)}`
  const questionId = `q_${"y".repeat(90)}`
  const harness = await createHarness({
    statePatch: {
      updateOffset: 652,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
        "100:9": { projectAlias: "demo", sessionId: "ses_2" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_2": { chatId: 100, threadIdOr0: 9 },
      },
    },
  })

  async function assertPackedCallbackWasFlushed(callbackData, expectedFragment) {
    assert.match(callbackData, /^cb\|/)
    const token = callbackData.slice(3)
    const persisted = await readState(harness.stateFile)
    assert.ok(persisted.callbackPayloads[token], "packed callback payload should be flushed to disk before Telegram delivery")

    const reloaded = new StateStore({ filePath: harness.stateFile, logger: makeLogger() })
    await reloaded.load()
    const unpacked = makeCallbackStore({ store: reloaded }).unpack(callbackData)
    assert.match(unpacked, new RegExp(expectedFragment))
  }

  try {
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: { id: permissionId, sessionID: "ses_1", permission: "shell", patterns: ["npm test"] },
    })
    const permissionPrompt = await waitFor(() => harness.tg.sentHtmlBlocks.find((entry) => entry.blocks.some((block) => block.html.includes(permissionId))))
    await assertPackedCallbackWasFlushed(permissionPrompt.replyMarkup.inline_keyboard[0][0].callback_data, permissionId)

    await harness.emitSse("demo", {
      type: "question.asked",
      properties: {
        id: questionId,
        sessionID: "ses_2",
        questions: [{ header: "Reason", question: "Why?", options: [{ label: "Run checks" }], custom: true }],
      },
    })
    const questionPrompt = await waitFor(() => harness.tg.sentMessages.find((entry) => /Reason \(1\/1\)/.test(entry.text)))
    await assertPackedCallbackWasFlushed(questionPrompt.replyMarkup.inline_keyboard[0][0].callback_data, questionId)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps simultaneous prompts isolated across projects and threads", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 646,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_demo" },
        "100:9": { projectAlias: "other", sessionId: "ses_other" },
      },
      sessionIndex: {
        "demo:ses_demo": { chatId: 100, threadIdOr0: 7 },
        "other:ses_other": { chatId: 100, threadIdOr0: 9 },
      },
    },
    extraProjects: {
      other: {
        baseUrl: "http://127.0.0.1:4313",
        directory: "other",
        autoStart: false,
        openTuiOnAutoStart: false,
        openAttachOnNewMode: "same-window",
        username: "",
        password: "",
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: { id: "perm_demo", sessionID: "ses_demo", permission: "shell", patterns: ["npm test"] },
    })
    await harness.emitSse("other", {
      type: "permission.asked",
      properties: { id: "perm_other", sessionID: "ses_other", permission: "shell", patterns: ["npm test"] },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 2)
    const delivered = harness.tg.sentHtmlBlocks.map((entry) => ({
      threadId: entry.options.message_thread_id,
      text: entry.blocks.map((block) => block.html).join("\n"),
    }))

    assert.ok(delivered.some((entry) => entry.threadId === 7 && /perm_demo/.test(entry.text)))
    assert.ok(delivered.some((entry) => entry.threadId === 9 && /perm_other/.test(entry.text)))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps same prompt ids isolated across sessions in one project", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 647,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
        "100:9": { projectAlias: "demo", sessionId: "ses_2" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_2": { chatId: 100, threadIdOr0: 9 },
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: { id: "perm_same", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] },
    })
    await harness.emitSse("demo", {
      type: "permission.asked",
      properties: { id: "perm_same", sessionID: "ses_2", permission: "shell", patterns: ["npm test"] },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length >= 2)
    await harness.connector.stop()

    const deliveredThreads = harness.tg.sentHtmlBlocks.map((entry) => entry.options.message_thread_id).sort()
    assert.deepEqual(deliveredThreads, [7, 9])
    const state = await readState(harness.stateFile)
    assert.deepEqual(Object.keys(state.pendingPrompts.permissions).sort(), ["demo:ses_1:perm_same", "demo:ses_2:perm_same"])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector finalizes assistant replies independently when sessions reuse the same message id", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 650,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
        "100:9": { projectAlias: "demo", sessionId: "ses_2" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_2": { chatId: 100, threadIdOr0: 9 },
      },
    },
    ocOptions: {
      getMessageImpl: async (sessionId, messageId) => ({
        info: { id: messageId, role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: sessionId === "ses_1" ? "First reply" : "Second reply" }],
      }),
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_same", role: "assistant", time: { completed: completedAt } } },
    })
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_2", info: { id: "msg_same", role: "assistant", time: { completed: completedAt } } },
    })

    await waitFor(() => harness.tg.sentHtmlBlocks.length === 2)

    const delivered = harness.tg.sentHtmlBlocks.map((entry) => ({
      threadId: entry.options.message_thread_id,
      text: entry.blocks[0]?.html,
    }))

    assert.ok(delivered.some((entry) => entry.threadId === 7 && entry.text === "First reply"))
    assert.ok(delivered.some((entry) => entry.threadId === 9 && entry.text === "Second reply"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector stop drains pending assistant finalization timers", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 660,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    messagesById: {
      msg_stop: {
        info: { id: "msg_stop", role: "assistant", time: { created: completedAt, completed: completedAt } },
        parts: [{ type: "text", text: "Delivered while stopping" }],
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_stop", role: "assistant", time: { completed: completedAt } } },
    })

    await harness.connector.stop()
    await delay(350)

    assert.equal(harness.tg.sentHtmlBlocks.length, 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0]?.html, "Delivered while stopping")
    assert.equal(harness.tg.sentMessages.length, 0)
    assert.equal(harness.tg.sentDocuments.length, 0)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector bounds pending assistant drain during shutdown", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const harness = await createHarness({
    statePatch: {
      updateOffset: 662,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      getMessageImpl: (_sessionId, _messageId, { signal } = {}) => new Promise((_resolve, reject) => {
        signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
      }),
    },
    assistantDrainTimeoutMs: 5,
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_hung", role: "assistant", time: { completed: completedAt } } },
    })

    const startedAt = Date.now()
    await harness.connector.stop()

    assert.ok(Date.now() - startedAt < 500)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector aborts an in-flight durable Telegram send and leaves it queued during shutdown", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let markSendStarted
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve })
  let observedSignal
  const harness = await createHarness({
    statePatch: {
      updateOffset: 663,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById: {
      msg_outbox_abort: {
        info: { id: "msg_outbox_abort", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "send interrupted by shutdown" }],
      },
    },
    tgOptions: {
      sendHtmlBlocksImpl: async ({ options }) => {
        observedSignal = options.signal
        markSendStarted()
        await new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          if (options.signal?.aborted) rejectAbort()
          else options.signal?.addEventListener?.("abort", rejectAbort, { once: true })
        })
      },
    },
    assistantDrainTimeoutMs: 5,
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_outbox_abort", role: "assistant", time: { completed: completedAt } } },
    })
    await sendStarted

    const startedAt = Date.now()
    await harness.connector.stop()

    assert.ok(Date.now() - startedAt < 500)
    assert.equal(observedSignal?.aborted, true)
    assert.equal(harness.tg.sentHtmlBlocks.length, 0)
    assert.equal(Object.keys((await readState(harness.stateFile)).outbox.items).length, 1)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector retries a durable final assistant delivery after Telegram 503 and removes it only after success", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let attempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 662,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById: {
      msg_durable_503: {
        info: { id: "msg_durable_503", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "recover after Telegram outage" }],
      },
    },
    tgOptions: {
      sendHtmlBlocksImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          throw makeBoundaryError({ source: "telegram", operation: "sendHtmlBlocks", status: 503, outcome: "retryable", message: "temporarily unavailable" })
        }
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_durable_503", role: "assistant", time: { completed: completedAt } } },
    })
    await waitFor(async () => {
      const state = await readState(harness.stateFile)
      const item = Object.values(state.outbox.items)[0]
      return item?.attemptCount === 1 && item.lastError === "http:503" ? item : null
    }, { timeoutMs: 3000 })
    await waitFor(async () => {
      const state = await readState(harness.stateFile)
      return harness.tg.sentHtmlBlocks.length === 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    assert.equal(attempts, 2)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "recover after Telegram outage")
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector holds an SSE event until durable outbox capacity is released", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let releaseFirstSend
  let markFirstSendStarted
  const firstSendStarted = new Promise((resolve) => { markFirstSendStarted = resolve })
  const firstSendGate = new Promise((resolve) => { releaseFirstSend = resolve })
  const attempts = []
  let getHealthSnapshot
  const harness = await createHarness({
    statePatch: {
      updateOffset: 664,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    messagesById: {
      msg_capacity_1: {
        info: { id: "msg_capacity_1", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "capacity item one" }],
      },
      msg_capacity_2: {
        info: { id: "msg_capacity_2", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "capacity item two" }],
      },
    },
    tgOptions: {
      sendHtmlBlocksImpl: async ({ blocks }) => {
        const text = blocks.map((block) => block.html).join("")
        attempts.push(text)
        if (text === "capacity item one") {
          markFirstSendStarted()
          await firstSendGate
        }
      },
    },
    createDurableOutboxRuntimeImpl: (options) => createDurableOutboxRuntime({ ...options, maxEntries: 1 }),
    startHealthServerImpl: async ({ getSnapshot }) => {
      getHealthSnapshot = getSnapshot
      return { address: { address: "127.0.0.1", port: 8787 }, stop() {} }
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_capacity_1", role: "assistant", time: { completed: completedAt } } },
    })
    await firstSendStarted

    let secondSettled = false
    const secondEvent = harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_capacity_2", role: "assistant", time: { completed: completedAt } } },
    }).then(() => {
      secondSettled = true
    })

    await waitFor(() => getHealthSnapshot?.().checks?.outbox?.blockedWaiters === 1)
    assert.equal(secondSettled, false)
    assert.equal(getHealthSnapshot().ready, false)
    assert.equal(getHealthSnapshot().checks.outbox.full, true)
    assert.equal(Object.keys((await readState(harness.stateFile)).outbox.items).length, 1)

    releaseFirstSend()
    await secondEvent
    await waitFor(async () =>
      harness.tg.sentHtmlBlocks.length === 2
      && Object.keys((await readState(harness.stateFile)).outbox.items).length === 0
      && getHealthSnapshot().ready === true,
    )

    assert.deepEqual(attempts, ["capacity item one", "capacity item two"])
    assert.deepEqual(harness.tg.sentHtmlBlocks.map((entry) => entry.blocks[0].html), ["capacity item one", "capacity item two"])
  } finally {
    releaseFirstSend()
    await harness.connector.stop()
  }
})

test("startConnector discards a terminal outbox item and continues delivery, polling, and readiness", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const fatalErrors = []
  let rejectedTerminalItem = false
  let getHealthSnapshot
  const harness = await createHarness({
    statePatch: {
      updateOffset: 664,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    messagesById: {
      msg_terminal_400: {
        info: { id: "msg_terminal_400", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "terminal item" }],
      },
      msg_after_terminal: {
        info: { id: "msg_after_terminal", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "delivered after terminal item" }],
      },
    },
    tgOptions: {
      sendHtmlBlocksImpl: async ({ blocks }) => {
        if (!rejectedTerminalItem && blocks.some((block) => block.html === "terminal item")) {
          rejectedTerminalItem = true
          throw makeBoundaryError({
            source: "telegram",
            operation: "POST sendMessage",
            pathname: "/sendMessage",
            status: 400,
            outcome: "fatal",
            message: "chat not found",
          })
        }
      },
    },
    startHealthServerImpl: async ({ getSnapshot }) => {
      getHealthSnapshot = getSnapshot
      return { address: { address: "127.0.0.1", port: 8787 }, stop() {} }
    },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_terminal_400", role: "assistant", time: { completed: completedAt } } },
    })
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_after_terminal", role: "assistant", time: { completed: completedAt } } },
    })
    harness.tg.enqueue(makeMessageUpdate(664, "/help"))

    await waitFor(async () => {
      const state = await readState(harness.stateFile)
      return state.updateOffset === 665
        && Object.keys(state.outbox.items).length === 0
        && harness.tg.sentHtmlBlocks.some((entry) => entry.blocks[0]?.html === "delivered after terminal item")
    }, { timeoutMs: 4000 })

    assert.equal(fatalErrors.length, 0)
    assert.equal(getHealthSnapshot().ready, true)
    const state = await readState(harness.stateFile)
    assert.ok(Object.values(state.idempotency.keys).some((entry) => entry.kind === "telegram-outbox-discarded"))
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector preserves a Telegram 401 outbox item and reports one controlled fatal shutdown", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const fatalErrors = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: 665,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById: {
      msg_global_401: {
        info: { id: "msg_global_401", role: "assistant", time: { completed: completedAt } },
        parts: [{ type: "text", text: "global auth failure" }],
      },
    },
    tgOptions: {
      sendHtmlBlocksImpl: async () => {
        throw makeBoundaryError({
          source: "telegram",
          operation: "POST sendMessage",
          pathname: "/sendMessage",
          status: 401,
          outcome: "fatal",
          message: "unauthorized",
        })
      },
    },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_global_401", role: "assistant", time: { completed: completedAt } } },
    })
    await waitFor(() => fatalErrors.length === 1)
    await delay(30)

    assert.equal(fatalErrors.length, 1)
    assert.equal(fatalErrors[0].status, 401)
    const [retained] = Object.values((await readState(harness.stateFile)).outbox.items)
    assert.equal(retained.messageId, "msg_global_401")
    assert.equal(retained.attemptCount, 0)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector checkpoints assistant text before retrying changed-files delivery", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  let changedFilesAttempts = 0
  const harness = await createHarness({
    statePatch: {
      updateOffset: 662,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById: {
      msg_durable_changes: {
        info: { id: "msg_durable_changes", role: "assistant", time: { completed: completedAt } },
        parts: [
          { type: "text", text: "Patched once" },
          { type: "patch", files: ["/repo/a.js"], diff: "--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new" },
        ],
      },
    },
    tgOptions: {
      sendMessageImpl: async () => {
        changedFilesAttempts += 1
        if (changedFilesAttempts === 1) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 503, outcome: "retryable", message: "temporarily unavailable" })
        }
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_durable_changes", role: "assistant", time: { completed: completedAt } } },
    })
    await waitFor(async () => {
      const item = Object.values((await readState(harness.stateFile)).outbox.items)[0]
      return item?.attemptCount === 1 && item.progress?.assistantTextDelivered === true && item.progress?.changedFilesDelivered !== true ? item : null
    }, { timeoutMs: 3000 })
    await waitFor(async () => {
      const state = await readState(harness.stateFile)
      return harness.tg.sentMessages.length === 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    assert.equal(changedFilesAttempts, 2)
    assert.equal(harness.tg.sentHtmlBlocks.length, 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "Patched once")
    assert.match(harness.tg.sentMessages[0].text, /Changed files:/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector durably retries an agent error notice after Telegram 503", async () => {
  const createdAt = new Date(Date.now() + 60_000).toISOString()
  let attempts = 0
  const errorInfo = { id: "msg_durable_error", role: "assistant", time: { created: createdAt }, error: { name: "AgentError", message: "tool failed" } }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 662,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById: {
      msg_durable_error: { info: errorInfo, parts: [] },
    },
    tgOptions: {
      sendMessageImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", status: 503, outcome: "retryable", message: "temporarily unavailable" })
        }
      },
    },
  })

  try {
    await harness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: errorInfo },
    })
    await waitFor(async () => {
      const item = Object.values((await readState(harness.stateFile)).outbox.items)[0]
      return item?.type === "agent-error" && item.attemptCount === 1 ? item : null
    }, { timeoutMs: 3000 })
    await waitFor(async () => {
      const state = await readState(harness.stateFile)
      return harness.tg.sentMessages.length === 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    assert.equal(attempts, 2)
    assert.match(harness.tg.sentMessages[0].text, /Assistant reply failed/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector resumes durable multipart assistant delivery after restart without resending the first block", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const longText = "A".repeat(5000)
  const messagesById = {
    msg_durable_blocks: {
      info: { id: "msg_durable_blocks", role: "assistant", time: { completed: completedAt } },
      parts: [{ type: "text", text: longText }],
    },
  }
  const firstHarness = await createHarness({
    statePatch: {
      updateOffset: 663,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById,
    tgOptions: {
      sendMessageImpl: async ({ callIndex }) => {
        if (callIndex === 2) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", kind: "network", outcome: "retryable", message: "connection lost" })
        }
      },
    },
  })

  let persistedState
  let firstBlock
  try {
    await firstHarness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_durable_blocks", role: "assistant", time: { completed: completedAt } } },
    })
    persistedState = await waitFor(async () => {
      const state = await readState(firstHarness.stateFile)
      const item = Object.values(state.outbox.items)[0]
      return item?.progress?.assistantTextBlockIndex === 1 && item.attemptCount === 1 ? state : null
    }, { timeoutMs: 3000 })
    firstBlock = firstHarness.tg.sentMessages[0]?.text
    assert.equal(firstHarness.tg.sentMessages.length, 1)
  } finally {
    await firstHarness.connector.stop()
  }

  const secondHarness = await createHarness({ statePatch: persistedState, messagesById })
  try {
    await waitFor(async () => {
      const state = await readState(secondHarness.stateFile)
      return secondHarness.tg.sentMessages.length === 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    const expectedBlocks = formatMarkdownToTelegramHtmlBlocks(longText).map((block) => block.html)
    assert.deepEqual([firstBlock, secondHarness.tg.sentMessages[0].text], expectedBlocks)
  } finally {
    await secondHarness.connector.stop()
  }
})

test("startConnector resumes durable multipart TUI user mirroring after restart without resending the first block", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const longText = "U".repeat(5000)
  const messagesById = {
    user_durable_blocks: {
      info: { id: "user_durable_blocks", role: "user", time: { completed: completedAt } },
      parts: [{ type: "text", text: longText }],
    },
  }
  const firstHarness = await createHarness({
    configPatch: { mirrorTuiUserMessages: true },
    statePatch: {
      updateOffset: 664,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById,
    tgOptions: {
      sendHtmlBlocksImpl: async ({ callIndex }) => {
        if (callIndex === 2) {
          throw makeBoundaryError({ source: "telegram", operation: "sendHtmlBlocks", kind: "network", outcome: "retryable", message: "connection lost" })
        }
      },
    },
  })

  let persistedState
  let firstBlock
  try {
    await firstHarness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "user_durable_blocks", role: "user", time: { completed: completedAt } } },
    })
    await waitFor(async () => {
      const item = Object.values((await readState(firstHarness.stateFile)).outbox.items)[0]
      return item?.progress?.userBlockIndex === 1 && item.attemptCount >= 1 ? item : null
    }, { timeoutMs: 3000 })
    firstBlock = firstHarness.tg.sentHtmlBlocks[0]?.blocks[0]?.html
    assert.equal(firstHarness.tg.sentHtmlBlocks.length, 1)
  } finally {
    await firstHarness.connector.stop()
    persistedState = await readState(firstHarness.stateFile)
  }

  const secondHarness = await createHarness({ configPatch: { mirrorTuiUserMessages: true }, statePatch: persistedState, messagesById })
  try {
    const expectedBlocks = formatUserMirrorBlocks(longText).map((block) => block.html)
    await waitFor(async () => {
      const state = await readState(secondHarness.stateFile)
      return secondHarness.tg.sentHtmlBlocks.length === expectedBlocks.length - 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    assert.deepEqual(
      [firstBlock, ...secondHarness.tg.sentHtmlBlocks.map((entry) => entry.blocks[0]?.html)],
      expectedBlocks,
    )
  } finally {
    await secondHarness.connector.stop()
  }
})

test("startConnector resumes multipart changed-files delivery after restart without resending completed chunks", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const files = Array.from({ length: 30 }, (_, index) => `src/${String(index).padStart(2, "0")}-${"nested-path-".repeat(20)}.js`)
  const expectedChunks = splitTelegramText(formatChangedFilesText(files, { limit: files.length })).filter((chunk) => chunk.trim())
  assert.ok(expectedChunks.length > 1)
  const messagesById = {
    msg_durable_changed_chunks: {
      info: { id: "msg_durable_changed_chunks", role: "assistant", time: { completed: completedAt } },
      parts: [{ type: "patch", files }],
    },
  }
  const configPatch = { limits: { changedFilesLimit: files.length } }
  const firstHarness = await createHarness({
    configPatch,
    statePatch: {
      updateOffset: 665,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById,
    tgOptions: {
      sendMessageImpl: async ({ callIndex }) => {
        if (callIndex === 2) {
          throw makeBoundaryError({ source: "telegram", operation: "sendMessage", kind: "network", outcome: "retryable", message: "connection lost" })
        }
      },
    },
  })

  let persistedState
  let firstChunk
  try {
    await firstHarness.emitSse("demo", {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_durable_changed_chunks", role: "assistant", time: { completed: completedAt } } },
    })
    await waitFor(async () => {
      const item = Object.values((await readState(firstHarness.stateFile)).outbox.items)[0]
      return item?.progress?.changedFilesChunkIndex === 1 && item.attemptCount >= 1 ? item : null
    }, { timeoutMs: 3000 })
    firstChunk = firstHarness.tg.sentMessages[0]?.text
    assert.equal(firstHarness.tg.sentMessages.length, 1)
  } finally {
    await firstHarness.connector.stop()
    persistedState = await readState(firstHarness.stateFile)
  }

  const secondHarness = await createHarness({ configPatch, statePatch: persistedState, messagesById })
  try {
    await waitFor(async () => {
      const state = await readState(secondHarness.stateFile)
      return secondHarness.tg.sentMessages.length === expectedChunks.length - 1 && Object.keys(state.outbox.items).length === 0
    }, { timeoutMs: 4000 })

    assert.deepEqual([firstChunk, ...secondHarness.tg.sentMessages.map((entry) => entry.text)], expectedChunks)
  } finally {
    await secondHarness.connector.stop()
  }
})

test("startConnector deduplicates repeated assistant SSE completions through the durable outbox", async () => {
  const completedAt = new Date(Date.now() + 60_000).toISOString()
  const messagesById = {
    msg_durable_dedupe: {
      info: { id: "msg_durable_dedupe", role: "assistant", time: { completed: completedAt } },
      parts: [{ type: "text", text: "deliver once" }],
    },
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 664,
      bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
      sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
    },
    messagesById,
  })
  const event = {
    type: "message.updated",
    properties: { sessionID: "ses_1", info: { id: "msg_durable_dedupe", role: "assistant", time: { completed: completedAt } } },
  }

  let persistedState
  try {
    await Promise.all([harness.emitSse("demo", event), harness.emitSse("demo", event)])
    await waitFor(() => harness.tg.sentHtmlBlocks.length === 1)
    await harness.emitSse("demo", event)
    await delay(300)

    assert.equal(harness.tg.sentHtmlBlocks.length, 1)
    assert.equal(harness.tg.sentHtmlBlocks[0].blocks[0].html, "deliver once")
    persistedState = await readState(harness.stateFile)
  } finally {
    await harness.connector.stop()
  }

  const restarted = await createHarness({ statePatch: persistedState, messagesById })
  try {
    await restarted.emitSse("demo", event)
    await delay(300)
    assert.equal(restarted.tg.sentHtmlBlocks.length, 0)
    assert.deepEqual((await readState(restarted.stateFile)).outbox.items, {})
  } finally {
    await restarted.connector.stop()
  }
})

test("startConnector stop waits for SSE done after synchronous stop request", async () => {
  let resolveSseStop = () => {}
  let stopCalls = 0
  const sseStopped = new Promise((resolve) => {
    resolveSseStop = resolve
  })

  const harness = await createHarness({
    statePatch: {
      updateOffset: 665,
    },
    startSseLoopImpl: () => ({
      stop() {
        stopCalls += 1
      },
      done: sseStopped,
    }),
  })

  try {
    await waitFor(() => harness.hasSseHandler("demo"))

    let stopped = false
    const stopPromise = harness.connector.stop().then(() => {
      stopped = true
    })

    await delay(20)
    assert.equal(stopCalls, 1)
    assert.equal(stopped, false)

    resolveSseStop()
    await stopPromise
    assert.equal(stopped, true)
  } finally {
    resolveSseStop()
    await harness.connector.stop()
  }
})

test("startConnector stop completes managed cleanup and final state flush when outbox drain fails", async () => {
  const loggerEntries = []
  let flushCalls = 0
  let sseStopCalls = 0
  let healthStopCalls = 0
  let drainCalls = 0
  const harness = await createHarness({
    statePatch: { updateOffset: 665 },
    configPatch: { healthServer: { enabled: true, host: "127.0.0.1", port: 0 } },
    logger: makeLogger(loggerEntries),
    createStateStoreImpl: (options) => {
      const store = new StateStore(options)
      const flush = store.flush.bind(store)
      store.flush = async () => {
        flushCalls += 1
        return flush()
      }
      return store
    },
    createDurableOutboxRuntimeImpl: () => ({
      outbox: {},
      start: () => Promise.resolve(),
      async drain() {
        drainCalls += 1
        throw new Error("dedicated drain failed")
      },
    }),
    startSseLoopImpl: () => ({
      stop() {
        sseStopCalls += 1
      },
    }),
    startHealthServerImpl: async () => ({
      address: { address: "127.0.0.1", port: 8787 },
      async stop() {
        healthStopCalls += 1
      },
    }),
  })

  const flushCallsBeforeStop = flushCalls
  await harness.connector.stop()

  assert.equal(drainCalls, 1)
  assert.equal(sseStopCalls, 1)
  assert.equal(healthStopCalls, 1)
  assert.ok(flushCalls > flushCallsBeforeStop)
  assert.ok(loggerEntries.some((entry) => entry.level === "error" && /dedicated drain failed/.test(entry.args.join(" "))))
})

test("startConnector reports fatal escaped core-loop errors instead of swallowing them", async () => {
  const fatalErrors = []
  const harness = await createHarness({
    statePatch: {
      updateOffset: 666,
    },
    delayImpl: async () => {
      throw new Error("fatal loop crash")
    },
    onFatalErrorImpl: (err) => {
      fatalErrors.push(err)
    },
  })

  try {
    await waitFor(() => fatalErrors.length === 1)
    const getUpdatesCount = harness.tg.getUpdatesCalls.length
    await delay(30)

    assert.match(fatalErrors[0]?.message || "", /fatal loop crash/)
    assert.equal(harness.tg.getUpdatesCalls.length, getUpdatesCount)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector treats fatal getUpdates authentication failures as one controlled runtime failure", async () => {
  const fatalErrors = []
  const loggerEntries = []
  const harness = await createHarness({
    statePatch: { updateOffset: 666 },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
    logger: makeLogger(loggerEntries),
  })

  try {
    harness.tg.setGetUpdatesError(makeBoundaryError({
      source: "telegram",
      operation: "POST getUpdates",
      method: "POST",
      pathname: "/getUpdates",
      status: 401,
      outcome: "fatal",
      message: "getUpdates failed: Unauthorized",
    }))
    await waitFor(() => fatalErrors.length === 1)
    const pollCount = harness.tg.getUpdatesCalls.length
    await delay(30)

    assert.equal(fatalErrors.length, 1)
    assert.equal(harness.tg.getUpdatesCalls.length, pollCount)
    assert.equal(fatalErrors[0].status, 401)
    assert.doesNotMatch(JSON.stringify(loggerEntries), /test-token/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector treats a malformed successful getUpdates response as one controlled runtime failure", async () => {
  const fatalErrors = []
  const harness = await createHarness({
    statePatch: { updateOffset: 666 },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
  })

  try {
    harness.tg.setGetUpdatesError(makeBoundaryError({
      source: "telegram",
      operation: "POST getUpdates",
      method: "POST",
      pathname: "/getUpdates",
      status: 200,
      kind: "protocol",
      outcome: "fatal",
      message: "getUpdates returned malformed JSON",
    }))
    await waitFor(() => fatalErrors.length === 1)
    const pollCount = harness.tg.getUpdatesCalls.length
    await delay(30)

    assert.equal(fatalErrors.length, 1)
    assert.equal(fatalErrors[0].kind, "protocol")
    assert.equal(harness.tg.getUpdatesCalls.length, pollCount)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector continues polling after retryable Telegram 429 and 503 responses", async () => {
  const fatalErrors = []
  const harness = await createHarness({
    statePatch: { updateOffset: 666 },
    onFatalErrorImpl: (err) => fatalErrors.push(err),
  })

  try {
    harness.tg.enqueueGetUpdatesError(makeBoundaryError({
      source: "telegram",
      operation: "POST getUpdates",
      status: 429,
      retryAfterMs: 1,
      outcome: "retryable",
      message: "rate limited",
    }))
    harness.tg.enqueueGetUpdatesError(makeBoundaryError({
      source: "telegram",
      operation: "POST getUpdates",
      status: 503,
      outcome: "retryable",
      message: "temporarily unavailable",
    }))
    const initialPolls = harness.tg.getUpdatesCalls.length
    await waitFor(() => harness.tg.getUpdatesCalls.length >= initialPolls + 3)

    assert.deepEqual(fatalErrors, [])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector reports fatal SSE done rejections through lifecycle fatal handling", async () => {
  const fatalErrors = []
  let rejectSseDone = () => {}
  const sseDone = new Promise((_resolve, reject) => {
    rejectSseDone = reject
  })
  const harness = await createHarness({
    statePatch: {
      updateOffset: 667,
    },
    startSseLoopImpl: () => ({
      stop() {},
      done: sseDone,
    }),
    onFatalErrorImpl: (err) => {
      fatalErrors.push(err)
    },
  })

  try {
    await waitFor(() => harness.hasSseHandler("demo"))
    rejectSseDone(makeBoundaryError({
      source: "opencode",
      operation: "GET /global/event",
      method: "GET",
      pathname: "/global/event",
      kind: "protocol",
      outcome: "fatal",
      message: "fatal SSE protocol error",
    }))

    await waitFor(() => fatalErrors.length === 1)
    assert.match(fatalErrors[0].message, /fatal SSE protocol error/)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector clears stale permission callbacks without blocking later updates", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 670,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_stale": {
            projectAlias: "demo",
            permissionId: "perm_stale",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      replyPermissionImpl: async () => {
        throw new Error("POST /permission/perm_stale/reply failed: 404 not found")
      },
    },
    initialUpdates: [[makeCallbackUpdate(670, "p|demo|ses_1|perm_stale|once"), makeMessageUpdate(671, "hello after stale permission")]],
  })

  try {
    await waitFor(() => harness.ocCalls.promptAsync.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [{ permissionId: "perm_stale", payload: { reply: "once" } }])
    assert.deepEqual(harness.ocCalls.promptAsync, [{ sessionId: "ses_1", text: "[TG] hello after stale permission" }])
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_670" && entry.text === "No longer active"))

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps retryable callback failures uncheckpointed without thread notices", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 675,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_retry": {
            projectAlias: "demo",
            permissionId: "perm_retry",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {},
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      replyPermissionImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "POST /permission/perm_retry/reply",
          method: "POST",
          pathname: "/permission/perm_retry/reply",
          kind: "network",
          outcome: "retryable",
          message: "temporary permission failure",
        })
      },
    },
    initialUpdates: [[makeCallbackUpdate(675, "p|demo|ses_1|perm_retry|once"), makeMessageUpdate(676, "hello after callback failure")]],
  })

  try {
    await waitFor(() => harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_675"))
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyPermission, [{ permissionId: "perm_retry", payload: { reply: "once" } }])
    assert.deepEqual(harness.ocCalls.promptAsync, [])
    assert.ok(harness.tg.callbackAnswers.some((entry) => entry.callbackQueryId === "cb_675" && entry.text === "Temporarily unavailable"))
    assert.equal(harness.tg.sentMessages.some((entry) => entry.text === "Action is temporarily unavailable. Please try again."), false)

    const state = await readState(harness.stateFile)
    assert.equal(state.updateOffset, 675)
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector clears stale custom-answer submissions without blocking later updates", async () => {
  const request = {
    id: "q_stale",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 680,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_stale", qIndex: 0 },
        },
        questionWizards: {
          "demo:q_stale": {
            projectAlias: "demo",
            id: "q_stale",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listQuestionsImpl: async () => [request],
      replyQuestionImpl: async () => {
        throw new Error("POST /question/q_stale/reply failed: 404 not found")
      },
    },
    initialUpdates: [[makeMessageUpdate(680, "too late"), makeMessageUpdate(681, "hello after stale question")]],
  })

  try {
    await waitFor(() => harness.ocCalls.promptAsync.length === 1)
    await harness.connector.stop()

    assert.deepEqual(harness.ocCalls.replyQuestion, [{ questionId: "q_stale", answers: [["too late"]] }])
    assert.deepEqual(harness.ocCalls.promptAsync, [{ sessionId: "ses_1", text: "[TG] hello after stale question" }])
    assert.ok(harness.tg.sentMessages.some((entry) => entry.text === "Question is no longer active."))

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector drops stale persisted prompts before replaying restart recovery", async () => {
  const request = {
    id: "q_stale_restore",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 690,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_stale": {
            projectAlias: "demo",
            permissionId: "perm_stale",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_stale" },
        },
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_stale_restore", qIndex: 0 },
        },
        questionWizards: {
          "demo:q_stale_restore": {
            projectAlias: "demo",
            id: "q_stale_restore",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [],
      listQuestionsImpl: async () => [],
    },
  })

  try {
    const stateBeforeStop = await readState(harness.stateFile)
    assert.deepEqual(stateBeforeStop.pendingPrompts.permissions, {})
    assert.deepEqual(stateBeforeStop.pendingPrompts.rejectNotes, {})
    assert.deepEqual(stateBeforeStop.pendingPrompts.questionWizards, {})
    assert.deepEqual(stateBeforeStop.pendingPrompts.customAnswers, {})

    await delay(50)
    await harness.connector.stop()

    assert.equal(harness.tg.sentHtmlBlocks.length, 0)
    assert.equal(harness.tg.sentMessages.length, 0)
    assert.ok(harness.ocCalls.listPermissions >= 1)
    assert.ok(harness.ocCalls.listQuestions >= 1)

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
    assert.deepEqual(state.pendingPrompts.rejectNotes, {})
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps pending prompts when restart recovery hits retryable backend errors", async () => {
  const request = {
    id: "q_retry_restore",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const pendingPrompts = {
    permissions: {
      "demo:ses_1:perm_retry": {
        projectAlias: "demo",
        permissionId: "perm_retry",
        sessionID: "ses_1",
        permission: "shell",
        patterns: ["npm test"],
        ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
        createdAt: Date.now(),
      },
    },
    rejectNotes: {
      "100:7": { projectAlias: "demo", permissionId: "perm_retry", sessionID: "" },
    },
    customAnswers: {
      "100:7": { projectAlias: "demo", requestId: "q_retry_restore", sessionID: "", qIndex: 0 },
    },
    questionWizards: {
      "demo:ses_1:q_retry_restore": {
        projectAlias: "demo",
        id: "q_retry_restore",
        sessionID: "ses_1",
        request,
        index: 0,
        answers: [[]],
        selectedByIndex: {},
        createdAt: Date.now(),
        ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      },
    },
  }
  const harness = await createHarness({
    statePatch: {
      updateOffset: 692,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts,
    },
    ocOptions: {
      listPermissionsImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /permission",
          method: "GET",
          pathname: "/permission",
          kind: "network",
          outcome: "retryable",
          message: "temporary permission poll failure",
        })
      },
      listQuestionsImpl: async () => {
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /question",
          method: "GET",
          pathname: "/question",
          kind: "network",
          outcome: "retryable",
          message: "temporary question poll failure",
        })
      },
    },
  })

  try {
    await delay(40)
    await harness.connector.stop()

    assert.equal(harness.tg.sentHtmlBlocks.length, 0)
    assert.equal(harness.tg.sentMessages.length, 0)

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.pendingPrompts, {
      ...pendingPrompts,
      rejectNotes: {
        "100:7": { projectAlias: "demo", permissionId: "perm_retry", sessionID: "ses_1" },
      },
      customAnswers: {
        "100:7": { projectAlias: "demo", requestId: "q_retry_restore", sessionID: "ses_1", qIndex: 0 },
      },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector validates permissions and questions independently during restart recovery", async () => {
  const permissionHarness = await createHarness({
    statePatch: {
      updateOffset: 695,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {
          "demo:perm_partial": {
            projectAlias: "demo",
            permissionId: "perm_partial",
            sessionID: "ses_1",
            permission: "shell",
            patterns: ["npm test"],
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
            createdAt: Date.now(),
          },
        },
        rejectNotes: {
          "100:7": { projectAlias: "demo", permissionId: "perm_partial" },
        },
        customAnswers: {},
        questionWizards: {},
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => [],
      listQuestionsImpl: async () => {
        throw new Error("temporary question poll failure")
      },
    },
  })

  try {
    await delay(40)
    await permissionHarness.connector.stop()

    const state = await readState(permissionHarness.stateFile)
    assert.deepEqual(state.pendingPrompts.permissions, {})
    assert.deepEqual(state.pendingPrompts.rejectNotes, {})
    assert.equal(permissionHarness.tg.sentHtmlBlocks.length, 0)
    assert.equal(permissionHarness.tg.sentMessages.length, 0)
  } finally {
    await permissionHarness.connector.stop()
  }

  const request = {
    id: "q_partial",
    sessionID: "ses_1",
    questions: [
      {
        header: "Reason",
        question: "Why do you want this?",
        custom: true,
        options: [],
      },
    ],
  }
  const questionHarness = await createHarness({
    statePatch: {
      updateOffset: 696,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
      pendingPrompts: {
        permissions: {},
        rejectNotes: {},
        customAnswers: {
          "100:7": { projectAlias: "demo", requestId: "q_partial", qIndex: 0 },
        },
        questionWizards: {
          "demo:q_partial": {
            projectAlias: "demo",
            id: "q_partial",
            sessionID: "ses_1",
            request,
            index: 0,
            answers: [[]],
            selectedByIndex: {},
            createdAt: Date.now(),
            ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
          },
        },
      },
    },
    ocOptions: {
      listPermissionsImpl: async () => {
        throw new Error("temporary permission poll failure")
      },
      listQuestionsImpl: async () => [],
    },
  })

  try {
    await delay(40)
    await questionHarness.connector.stop()

    const state = await readState(questionHarness.stateFile)
    assert.deepEqual(state.pendingPrompts.questionWizards, {})
    assert.deepEqual(state.pendingPrompts.customAnswers, {})
    assert.equal(questionHarness.tg.sentHtmlBlocks.length, 0)
    assert.equal(questionHarness.tg.sentMessages.length, 0)
  } finally {
    await questionHarness.connector.stop()
  }
})

test("startConnector opens an attach window after /new when openAttachOnNewMode is new-window on Windows", async () => {
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
      openAttachOnNewMode: "new-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_new_Demo-title" }),
      getConfigImpl: async () => ({ model: "openai/gpt-5", default_agent: "build", agent: { build: { variant: "xhigh" } } }),
    },
    openAttachWindowWindowsImpl: async (args) => {
      attachCalls.push(args)
    },
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(701, "/new Demo title"))
    await waitFor(() => attachCalls.length === 1)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_new_Demo-title.")))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(attachCalls, [
      {
        directory: path.join(harness.dir, "demo"),
        baseUrl: "http://127.0.0.1:4312",
        sessionId: "ses_new_Demo-title",
        platform: "win32",
      },
    ])
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_new_Demo-title" },
    })
    assert.ok(
      harness.tg.sentMessages.some(
        (entry) => entry.text.includes("Changed: this thread now uses new session ses_new_Demo-title.") && entry.text.includes("Model: openai/gpt-5 xhigh"),
      ),
    )
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector opens an attach window after /new on Linux when openAttachOnNewMode is new-window", async (t) => {
  const fakeBin = await makeFakeLauncherDir(t, "x-terminal-emulator")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: undefined })

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
      openAttachOnNewMode: "new-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_linux" }),
      getConfigImpl: async () => ({ model: "openai/gpt-5", default_agent: "build", agent: { build: { variant: "medium" } } }),
    },
    openAttachWindowWindowsImpl: async (args) => {
      attachCalls.push(args)
    },
    platform: "linux",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(801, "/new Linux title"))
    await waitFor(() => attachCalls.length === 1)
    await waitFor(
      () => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_linux.") && entry.text.includes("Model: openai/gpt-5 medium")),
    )
    await harness.connector.stop()

    assert.deepEqual(attachCalls, [
      {
        directory: path.join(harness.dir, "demo"),
        baseUrl: "http://127.0.0.1:4312",
        sessionId: "ses_linux",
        platform: "linux",
      },
    ])
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector binds /new immediately in same-window mode without opening another attach window", async () => {
  const attachCalls = []
  const activeSessions = [{ id: "ses_1" }, null, { id: "ses_1" }]
  const harness = await createHarness({
    statePatch: {
      updateOffset: 820,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNewMode: "same-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_same_window" }),
      getConfigImpl: async () => ({ model: "openai/gpt-5", default_agent: "build", agent: { build: { variant: "medium" } } }),
      getActiveTuiSessionImpl: async () => (activeSessions.length ? activeSessions.shift() : { id: "ses_same_window" }),
    },
    openAttachWindowWindowsImpl: async (args) => {
      attachCalls.push(args)
    },
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(821, "/new Same window title"))
    harness.tg.enqueue(makeMessageUpdate(822, "prompt after same-window new"))
    await waitFor(() => harness.ocCalls.selectTuiSession.length === 1)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_same_window.")))
    await waitFor(() => harness.ocCalls.promptAsync.some((entry) => entry.sessionId === "ses_same_window"))
    await waitFor(() => harness.ocCalls.getActiveTuiSession.length >= 3)
    await harness.connector.stop()

    assert.deepEqual(attachCalls, [])
    assert.deepEqual(harness.ocCalls.selectTuiSession, [{ sessionId: "ses_same_window", options: { timeoutMs: 2500 } }])
    assert.deepEqual(harness.ocCalls.promptAsync.find((entry) => entry.sessionId === "ses_same_window"), {
      sessionId: "ses_same_window",
      text: "[TG] prompt after same-window new",
    })
    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_same_window" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps the new binding after /new when same-window TUI switch fails", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 830,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_old" },
      },
      sessionIndex: {
        "demo:ses_old": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNewMode: "same-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_created_but_not_switched" }),
      selectTuiSessionImpl: async () => {
        throw Object.assign(new Error("unsupported"), { isBoundaryError: true, status: 404 })
      },
      getActiveTuiSessionImpl: async () => ({ id: "ses_old" }),
      getConfigImpl: async () => ({ model: "openai/gpt-5" }),
    },
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(831, "/new Switch failure"))
    await waitFor(() => harness.ocCalls.selectTuiSession.length === 1)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_created_but_not_switched.")))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_created_but_not_switched" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps the new binding after /new when active TUI session tracking is unavailable", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 835,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_old" },
      },
      sessionIndex: {
        "demo:ses_old": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNewMode: "same-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_created_without_active_tracking" }),
      selectTuiSessionImpl: async () => true,
      getActiveTuiSessionImpl: async () => {
        throw Object.assign(new Error("missing"), { isBoundaryError: true, status: 404 })
      },
      getConfigImpl: async () => ({ model: "openai/gpt-5" }),
    },
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(836, "/new No active tracking"))
    await waitFor(() => harness.ocCalls.selectTuiSession.length === 1)
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_created_without_active_tracking.")))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_created_without_active_tracking" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector auto-switches the Telegram binding to the active TUI session", async () => {
  const activeSessions = [
    { id: "ses_parent" },
    null,
    { id: "ses_tui_new" },
  ]
  const harness = await createHarness({
    statePatch: {
      updateOffset: 840,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_parent" },
      },
      sessionIndex: {
        "demo:ses_parent": { chatId: 100, threadIdOr0: 7 },
      },
    },
    ocOptions: {
      getActiveTuiSessionImpl: async () => (activeSessions.length ? activeSessions.shift() : { id: "ses_tui_new" }),
    },
  })

  try {
    await waitFor(() => harness.ocCalls.getActiveTuiSession.length >= 3)
    await waitFor(() => harness.tg.sentMessages.some((m) => m.text.includes("TUI switched to session: ses_tui_new")))
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_tui_new" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector does not announce TUI auto-switch when binding flush fails", async () => {
  const activeSessions = [
    { id: "ses_parent" },
    { id: "ses_tui_new" },
    { id: "ses_tui_new" },
  ]
  let failBindingFlush = true
  const harness = await createHarness({
    statePatch: {
      updateOffset: 845,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_parent" },
      },
      sessionIndex: {
        "demo:ses_parent": { chatId: 100, threadIdOr0: 7 },
      },
    },
    createStateStoreImpl: (options) => {
      const store = new StateStore(options)
      const originalFlush = store.flush.bind(store)
      store.flush = async () => {
        if (failBindingFlush) throw new Error("binding write failed")
        return originalFlush()
      }
      return store
    },
    ocOptions: {
      getActiveTuiSessionImpl: async () => (activeSessions.length ? activeSessions.shift() : { id: "ses_tui_new" }),
    },
  })

  try {
    await waitFor(() => harness.ocCalls.getActiveTuiSession.length >= 3)
    await delay(20)

    assert.equal(harness.tg.sentMessages.some((m) => m.text.includes("TUI switched to session: ses_tui_new")), false)

    failBindingFlush = false
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_parent" },
    })
  } finally {
    failBindingFlush = false
    await harness.connector.stop()
  }
})

test("startConnector keeps following the original Telegram thread across a conflicting active TUI session hop", async () => {
  const activeSessions = [{ id: "ses_a" }, { id: "ses_b" }, { id: "ses_c" }]
  const harness = await createHarness({
    statePatch: {
      updateOffset: 850,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_a" },
        "100:9": { projectAlias: "demo", sessionId: "ses_b" },
      },
      sessionIndex: {
        "demo:ses_a": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_b": { chatId: 100, threadIdOr0: 9 },
      },
    },
    ocOptions: {
      getActiveTuiSessionImpl: async () => (activeSessions.length ? activeSessions.shift() : { id: "ses_c" }),
    },
  })

  try {
    await waitFor(() => harness.ocCalls.getActiveTuiSession.length >= 3)
    await waitFor(
      () => harness.tg.sentMessages.some((m) => m.options?.message_thread_id === 7 && m.text.includes("TUI switched to session: ses_c")),
    )
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.bindings, {
      "100:7": { projectAlias: "demo", sessionId: "ses_c" },
      "100:9": { projectAlias: "demo", sessionId: "ses_b" },
    })
  } finally {
    await harness.connector.stop()
  }
})

test("startConnector keeps a custom /model override isolated per thread and across restart", async () => {
  let secondHarness = null
  const harness = await createHarness({
    statePatch: {
      updateOffset: 900,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
        "100:9": { projectAlias: "demo", sessionId: "ses_2" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
        "demo:ses_2": { chatId: 100, threadIdOr0: 9 },
      },
    },
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(901, "/model openai/gpt-5 xhigh"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Model for this thread:") && entry.text.includes("Active: openai/gpt-5 xhigh")))

    harness.tg.enqueue(makeMessageUpdate(902, "hello thread 7"))
    harness.tg.enqueue(makeMessageUpdate(903, "hello thread 9", { threadIdOr0: 9 }))
    await waitFor(() => harness.ocCalls.promptAsync.length >= 2)
    await harness.connector.stop()

    const state = await readState(harness.stateFile)
    assert.deepEqual(state.modelPrefsByContext, {
      "100:7": {
        mode: "custom",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "xhigh",
      },
    })
    assert.deepEqual(harness.ocCalls.promptAsync, [
      {
        sessionId: "ses_1",
        text: "[TG] hello thread 7",
        options: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
      },
      {
        sessionId: "ses_2",
        text: "[TG] hello thread 9",
      },
    ])

    secondHarness = await createHarness({ statePatch: state })
    secondHarness.tg.enqueue(makeMessageUpdate(904, "after restart"))
    await waitFor(() => secondHarness.ocCalls.promptAsync.length >= 1)

    assert.deepEqual(secondHarness.ocCalls.promptAsync[0], {
      sessionId: "ses_1",
      text: "[TG] after restart",
      options: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
    })
  } finally {
    await harness.connector.stop()
    await secondHarness?.connector.stop()
  }
})

test("startConnector keeps the thread model override after /new", async () => {
  const harness = await createHarness({
    statePatch: {
      updateOffset: 950,
      bindings: {
        "100:7": { projectAlias: "demo", sessionId: "ses_1" },
      },
      sessionIndex: {
        "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
      },
    },
    projectPatch: {
      openAttachOnNewMode: "new-window",
    },
    ocOptions: {
      createSessionImpl: async () => ({ id: "ses_new_Demo-model" }),
    },
    openAttachWindowWindowsImpl: async () => {},
    platform: "win32",
  })

  try {
    harness.tg.enqueue(makeMessageUpdate(951, "/model openai/gpt-5 xhigh"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Active: openai/gpt-5 xhigh")))

    harness.tg.enqueue(makeMessageUpdate(952, "/new Demo model"))
    await waitFor(() => harness.tg.sentMessages.some((entry) => entry.text.includes("Changed: this thread now uses new session ses_new_Demo-model.")))

    harness.tg.enqueue(makeMessageUpdate(953, "prompt after new"))
    await waitFor(() => harness.ocCalls.promptAsync.some((entry) => entry.sessionId === "ses_new_Demo-model"))

    assert.ok(
      harness.tg.sentMessages.some(
        (entry) =>
          entry.text.includes("Changed: this thread now uses new session ses_new_Demo-model.") &&
          entry.text.includes("Model: openai/gpt-5 xhigh") &&
          entry.text.includes("Source: Thread custom override"),
      ),
    )
    assert.deepEqual(
      harness.ocCalls.promptAsync.find((entry) => entry.sessionId === "ses_new_Demo-model"),
      {
        sessionId: "ses_new_Demo-model",
        text: "[TG] prompt after new",
        options: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
      },
    )
  } finally {
    await harness.connector.stop()
  }
})
