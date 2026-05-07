import test from "node:test"
import assert from "node:assert/strict"
import { callbackToast, createCallbackHandlers, localizeCallbackToast } from "../src/connector/callbacks.js"
import { makeBoundaryError } from "../src/boundary-errors.js"
import { redactCmdlineSecrets } from "../src/url-utils.js"
import { encodeCallback } from "../src/connector/callback-data.js"

function callbackData(...parts) {
  return encodeCallback(parts)
}

test("localizeCallbackToast covers attachment and dynamic callback statuses", () => {
  for (const text of [
    "Wrong thread",
    "Expired",
    "Agent busy",
    "Already sending",
    "Already sent",
    "Too large",
    "Try again",
    "Download failed",
    "Sent",
  ]) {
    assert.notEqual(localizeCallbackToast(text, "ru"), text)
  }
  assert.equal(localizeCallbackToast(callbackToast("modelValue", { value: "openai/gpt-5" }), "ru"), "Модель: openai/gpt-5")
  assert.equal(localizeCallbackToast("Model: openai/gpt-5", "ru"), "Модель: openai/gpt-5")
  assert.equal(localizeCallbackToast("Feed: Verbose", "ru"), "Feed: Verbose")
})

function makeCallback(data, overrides = {}) {
  const threadIdOr0 = overrides.threadIdOr0 ?? 7
  return {
    id: overrides.id || "cb_1",
    from: { id: overrides.userId ?? 42 },
    data,
    message: {
      message_id: overrides.messageId ?? 900,
      chat: { id: overrides.chatId ?? 100, type: overrides.chatType || "supergroup" },
      ...(threadIdOr0 ? { message_thread_id: threadIdOr0 } : {}),
    },
  }
}

function cloneWizardState(wizard) {
  return {
    ...wizard,
    answers: Array.isArray(wizard.answers) ? wizard.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
    selectedByIndex:
      wizard.selectedByIndex && typeof wizard.selectedByIndex === "object"
        ? Object.fromEntries(Object.entries(wizard.selectedByIndex).map(([idx, value]) => [idx, Array.isArray(value) ? [...value] : []]))
        : {},
    messageIdByIndex: wizard.messageIdByIndex ? { ...wizard.messageIdByIndex } : {},
  }
}

function makeWizard({
  id = "q_1",
  projectAlias = "demo",
  index = 0,
  questions = [{ header: "Reason", question: "Why?", custom: true, options: [] }],
  answers,
  selectedByIndex = {},
} = {}) {
  return {
    projectAlias,
    id,
    request: { id, questions },
    index,
    answers: answers || Array.from({ length: questions.length }, () => []),
    selectedByIndex,
    messageIdByIndex: {},
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  }
}

function makeRuntime(overrides = {}) {
  const { tg: tgOverrides, cb: cbOverrides, store: storeOverrides, ...runtimeOverrides } = overrides
  const callbackAnswers = []
  const sentMessages = []
  const bindCalls = []
  const sessionListCalls = []
  const startCalls = []
  const feedCalls = []
  const changedFilesCalls = []
  const modelCalls = []
  const rejectStateCalls = []
  const customStateCalls = []
  const rejectedNotes = []
  const customPrompts = []
  const clearedQuestionIds = []
  const persistedWizards = []
  const finishCalls = []
  const sendQuestionStepCalls = []
  const deletedPermissions = []
  const loggerErrors = []

  const storeState = overrides.storeState || { bindings: {} }
  const questionWizards = overrides.questionWizards || new Map()
  const store = {
    getBinding: (ctxKey) => storeState.bindings?.[ctxKey] ?? null,
    setFeedMode: (ctxKey, mode) => feedCalls.push({ type: "set", ctxKey, mode }),
    setModelPreference: (ctxKey, value) => modelCalls.push({ type: "set", ctxKey, value }),
    clearModelPreference: (ctxKey) => {
      modelCalls.push({ type: "clear", ctxKey })
      return true
    },
    deletePendingPermission: (projectAlias, permissionId, sessionID = "") => {
      deletedPermissions.push({ projectAlias, permissionId, ...(sessionID ? { sessionID } : {}) })
      return true
    },
    ...(storeOverrides || {}),
  }

  const runtime = {
    tg: {
      answerCallbackQuery: async (callbackQueryId, text) => {
        callbackAnswers.push({ callbackQueryId, text })
        return true
      },
      deleteMessage: async () => true,
      ...(tgOverrides || {}),
    },
    cb: { unpack: (value) => value, ...(cbOverrides || {}) },
    store,
    projects: runtimeOverrides.projects || { demo: { baseUrl: "http://127.0.0.1:4312" } },
    ocByAlias: runtimeOverrides.ocByAlias || {},
    ctxMetaFromMessage: (msg) => ({
      chatId: msg?.chat?.id,
      chatType: msg?.chat?.type,
      threadIdOr0: msg?.message_thread_id || 0,
      ctxKey: `${msg?.chat?.id}:${msg?.message_thread_id || 0}`,
    }),
    parseCtxKey: (ctxKey) => {
      const match = String(ctxKey || "").match(/^(-?\d+):(\d+)$/)
      return match ? { chatId: Number(match[1]), threadIdOr0: Number(match[2]), ctxKey } : null
    },
    formatThreadLabel: (threadIdOr0) => (threadIdOr0 ? `topic ${threadIdOr0}` : "main"),
    isAllowedUser: runtimeOverrides.isAllowedUser || (() => true),
    bindCtxToSession: async (ctxMeta, projectAlias, sessionId) => {
      bindCalls.push({ ctxMeta, projectAlias, sessionId })
    },
    sendToThread: async (ctxMeta, text, replyMarkup) => {
      sentMessages.push({ ctxMeta, text, replyMarkup })
    },
    ensureProjectStarted: async (projectAlias, ctxMeta) => {
      startCalls.push({ projectAlias, ctxMeta })
    },
    getStartupSession: async (projectAlias) => `startup_${projectAlias}`,
    renderFeedSettings: async (ctxMeta, options) => {
      feedCalls.push({ type: "render", ctxMeta, options })
    },
    renderModelSettings: async (ctxMeta, options) => {
      modelCalls.push({ type: "render", ctxMeta, options })
    },
    setThreadModelPreference: async (ctxMeta, binding, value) => {
      if (!value || value.mode === "inherit") {
        modelCalls.push({ type: "clear", ctxKey: ctxMeta.ctxKey })
        return { ok: true, callbackText: "Model: inherit" }
      }
      modelCalls.push({ type: "set", ctxKey: ctxMeta.ctxKey, value })
      if (value.mode === "project-default") return { ok: true, callbackText: "Model: project default" }
      const modelLabel = typeof value.model === "string" ? value.model : `${value.model.providerID}/${value.model.modelID}`
      return { ok: true, callbackText: value.variant ? `Model: ${modelLabel} ${value.variant}` : `Model: ${modelLabel}` }
    },
    renderChangedFilesView: async (ctxMeta, projectAlias, sessionId, opencodeMessageId, action, options) => {
      changedFilesCalls.push({ ctxMeta, projectAlias, sessionId, opencodeMessageId, action, options })
    },
    renderSessionsList: async (ctxMeta, options) => {
      sessionListCalls.push({ ctxMeta, options })
    },
    feedModeLabel: (mode) => ({ main: "Main", verbose: "Verbose" }[mode] || "Main + changes"),
    setRejectNoteAwaitingState: (ctxKey, value) => {
      rejectStateCalls.push({ ctxKey, value })
    },
    sendRejectNotePrompt: async (ctxMeta, projectAlias, permissionId) => {
      rejectedNotes.push({ ctxMeta, projectAlias, permissionId })
    },
    getWizard: runtimeOverrides.getWizard || (() => null),
    clearPersistedQuestionWizard: (projectAlias, questionId, sessionID = "") => {
      clearedQuestionIds.push({ projectAlias, questionId, ...(sessionID ? { sessionID } : {}) })
    },
    setAwaitingCustomAnswerState: (ctxKey, value) => {
      customStateCalls.push({ ctxKey, value })
    },
    sendQuestionCustomAnswerPrompt: async (ctxMeta, projectAlias, questionId, qIndex, label) => {
      customPrompts.push({ ctxMeta, projectAlias, questionId, qIndex, label })
    },
    cloneWizardState,
    applyWizardState: (target, source) => {
      target.index = source.index
      target.answers = source.answers
      target.selectedByIndex = source.selectedByIndex
      target.messageIdByIndex = source.messageIdByIndex
    },
    persistQuestionWizard: (wizard) => {
      persistedWizards.push(cloneWizardState(wizard))
    },
    finishQuestionWizard: async (wizard) => {
      finishCalls.push(cloneWizardState(wizard))
      return { stale: false }
    },
    sendCurrentQuestionStep: async (wizard, options) => {
      sendQuestionStepCalls.push({ wizard: cloneWizardState(wizard), options })
    },
    formatProjectUnavailable: (alias, err) => `Project '${alias}' is unavailable: ${redactCmdlineSecrets(err?.message || String(err))}`,
    logger: { error: (...args) => loggerErrors.push(args.map((arg) => String(arg)).join(" ")) },
    questionWizards,
    ...runtimeOverrides,
  }

  return {
    runtime,
    callbackAnswers,
    sentMessages,
    bindCalls,
    sessionListCalls,
    startCalls,
    feedCalls,
    modelCalls,
    changedFilesCalls,
    rejectStateCalls,
    customStateCalls,
    rejectedNotes,
    customPrompts,
    clearedQuestionIds,
    persistedWizards,
    finishCalls,
    sendQuestionStepCalls,
    deletedPermissions,
    loggerErrors,
    questionWizards,
  }
}

test("createCallbackHandlers rejects invalid callback payloads", async () => {
  const { runtime, callbackAnswers } = makeRuntime({ cb: { unpack: () => null } })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("ignored"))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Invalid" }])
})

test("createCallbackHandlers rejects unknown callback kinds", async () => {
  const { runtime, callbackAnswers } = makeRuntime()
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("weird|payload"))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Invalid" }])
})

test("createCallbackHandlers records legacy callback fallback without raw payloads", async () => {
  const warnings = []
  const legacyFallbackProjects = []
  const { runtime, callbackAnswers } = makeRuntime({
    recordLegacyCallbackFallback: (projectAlias) => legacyFallbackProjects.push(projectAlias),
    logger: {
      error: () => {},
      warn: (message, fields) => warnings.push({ message, fields }),
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|cancel", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("rt|cancel", { id: "cb_2", chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers, [
    { callbackQueryId: "cb_1", text: "Cancelled" },
    { callbackQueryId: "cb_2", text: "Cancelled" },
  ])
  assert.deepEqual(legacyFallbackProjects, [null, null])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].message, "Legacy callback payload format used")
  assert.deepEqual(warnings[0].fields, { callbackPrefix: "rt", operation: "callback legacy fallback" })
  assert.doesNotMatch(JSON.stringify(warnings), /cancel|100:7|session|project/i)
})

test("createCallbackHandlers asks for confirmation before runtime stop", async () => {
  const editCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|confirm-stop", { chatType: "private", threadIdOr0: 0, messageId: 77 }))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Confirm stop" }])
  assert.equal(editCalls[0][0], 100)
  assert.equal(editCalls[0][1], 77)
  assert.match(editCalls[0][2], /Stop connector\?/)
  assert.deepEqual(editCalls[0][3].inline_keyboard.flat().map((button) => button.text), ["Confirm stop", "Cancel"])
  assert.deepEqual(editCalls[0][3].inline_keyboard.flat().map((button) => button.callback_data), [callbackData("rt", "stop"), callbackData("rt", "cancel")])
})

test("createCallbackHandlers asks for confirmation before runtime restart", async () => {
  const editCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|confirm-restart", { chatType: "private", threadIdOr0: 0, messageId: 78 }))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Confirm restart" }])
  assert.equal(editCalls[0][1], 78)
  assert.match(editCalls[0][2], /Restart connector\?/)
  assert.match(editCalls[0][2], /exit with code 1/)
  assert.deepEqual(editCalls[0][3].inline_keyboard.flat().map((button) => button.text), ["Confirm restart", "Cancel"])
  assert.deepEqual(editCalls[0][3].inline_keyboard.flat().map((button) => button.callback_data), [callbackData("rt", "restart"), callbackData("rt", "cancel")])
})

test("createCallbackHandlers deletes runtime confirmation after cancel", async () => {
  const editCalls = []
  const deletedMessages = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|cancel", { chatType: "private", threadIdOr0: 0, messageId: 78 }))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Cancelled" }])
  assert.deepEqual(editCalls, [])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 78 }])
})

test("createCallbackHandlers schedules confirmed runtime shutdown actions", async () => {
  const editCalls = []
  const deletedMessages = []
  const scheduled = []
  const shutdownRequests = []
  const runtimeNotices = []
  const flushCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    store: {
      setPendingRuntimeOnlineNotice: (notice) => {
        runtimeNotices.push(notice)
        return true
      },
      flush: async () => {
        flushCalls.push("flush")
      },
    },
    requestRuntimeShutdown: async (request) => {
      shutdownRequests.push(request)
    },
    scheduleRuntimeShutdown: (fn) => {
      scheduled.push(fn)
    },
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|stop", { chatType: "private", threadIdOr0: 0, messageId: 79 }))
  await handlers.handleTelegramCallback(makeCallback("rt|restart", { id: "cb_2", chatType: "private", threadIdOr0: 0, messageId: 80 }))

  assert.deepEqual(callbackAnswers, [
    { callbackQueryId: "cb_1", text: "Stopping…" },
    { callbackQueryId: "cb_2", text: "Restarting…" },
  ])
  assert.deepEqual(editCalls, [])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 79 },
    { chatId: 100, messageId: 80 },
  ])
  assert.equal(runtimeNotices.length, 1)
  assert.equal(runtimeNotices[0].kind, "restart")
  assert.equal(runtimeNotices[0].chatId, 100)
  assert.equal(typeof runtimeNotices[0].createdAt, "number")
  assert.deepEqual(flushCalls, ["flush"])
  assert.equal(scheduled.length, 2)
  await scheduled[0]()
  await scheduled[1]()
  assert.deepEqual(shutdownRequests, [{ action: "stop" }, { action: "restart" }])
})

test("createCallbackHandlers keeps runtime controls private and reports unavailable launchers", async () => {
  const editCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      editMessageText: async (...args) => {
        editCalls.push(args)
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("rt|confirm-stop", { chatType: "supergroup" }))
  await handlers.handleTelegramCallback(makeCallback("rt|stop", { id: "cb_2", chatType: "private", threadIdOr0: 0, messageId: 81 }))

  assert.deepEqual(callbackAnswers, [
    { callbackQueryId: "cb_1", text: "Private chat only" },
    { callbackQueryId: "cb_2", text: "Unavailable" },
  ])
  assert.equal(editCalls.length, 1)
  assert.match(editCalls[0][2], /unavailable/)
})

test("createCallbackHandlers switches sessions and refreshes the sessions list", async () => {
  const { runtime, callbackAnswers, bindCalls, sessionListCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|demo|ses_next"))

  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      projectAlias: "demo",
      sessionId: "ses_next",
    },
  ])
  assert.equal(callbackAnswers.at(-1)?.text, "Switched")
  assert.deepEqual(sessionListCalls, [
    {
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_next" }, editMessageId: 900 },
    },
  ])
})

test("createCallbackHandlers does not confirm state changes when flush fails", async () => {
  const switchState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } }, sessionIndex: {} }
  const switchRuntime = makeRuntime({
    storeState: switchState,
    store: {
      get: () => switchState,
      async flush() {
        throw new Error("state write failed")
      },
    },
    bindCtxToSession: async (ctxMeta, projectAlias, sessionId) => {
      switchState.bindings[ctxMeta.ctxKey] = { projectAlias, sessionId }
    },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
  })
  await assert.rejects(() => createCallbackHandlers(switchRuntime.runtime).handleTelegramCallback(makeCallback("s|demo|ses_next")), (err) => {
    assert.equal(err.isBoundaryError, true)
    assert.equal(err.source, "state")
    assert.equal(err.outcome, "retryable")
    return true
  })
  assert.deepEqual(switchRuntime.callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
  assert.deepEqual(switchRuntime.sessionListCalls, [])
  assert.deepEqual(switchState.bindings["100:7"], { projectAlias: "demo", sessionId: "ses_current" })

  const feedState = { feedByContext: { "100:7": "main" } }
  const feedMutations = []
  const feedRuntime = makeRuntime({
    store: {
      get: () => feedState,
      setFeedMode(ctxKey, mode) {
        feedMutations.push({ ctxKey, mode })
        feedState.feedByContext[ctxKey] = mode
      },
      async flush() {
        throw new Error("state write failed")
      },
    },
  })
  await assert.rejects(() => createCallbackHandlers(feedRuntime.runtime).handleTelegramCallback(makeCallback("feed|verbose")), (err) => {
    assert.equal(err.isBoundaryError, true)
    assert.equal(err.source, "state")
    assert.equal(err.outcome, "retryable")
    return true
  })
  assert.deepEqual(feedRuntime.callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
  assert.deepEqual(feedMutations, [{ ctxKey: "100:7", mode: "verbose" }])
  assert.deepEqual(feedState.feedByContext, { "100:7": "main" })

  const modelState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } }, modelPrefsByContext: {} }
  const modelMutations = []
  const modelRuntime = makeRuntime({
    storeState: modelState,
    store: {
      get: () => modelState,
      async flush() {
        throw new Error("state write failed")
      },
    },
    setThreadModelPreference: async (ctxMeta, _binding, value) => {
      modelMutations.push({ ctxKey: ctxMeta.ctxKey, value })
      modelState.modelPrefsByContext[ctxMeta.ctxKey] = value
      return { ok: true, callbackText: "Model: custom" }
    },
  })
  await assert.rejects(() => createCallbackHandlers(modelRuntime.runtime).handleTelegramCallback(makeCallback("m|apply|openai/gpt-5|xhigh")), (err) => {
    assert.equal(err.isBoundaryError, true)
    assert.equal(err.source, "state")
    assert.equal(err.outcome, "retryable")
    return true
  })
  assert.deepEqual(modelRuntime.callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
  assert.deepEqual(modelMutations, [{ ctxKey: "100:7", value: { mode: "custom", model: "openai/gpt-5", variant: "xhigh" } }])
  assert.deepEqual(modelState.modelPrefsByContext, {})
})

test("createCallbackHandlers decodes delimiter-safe model callbacks", async () => {
  const modelCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    setThreadModelPreference: async (ctxMeta, _binding, value) => {
      modelCalls.push({ ctxKey: ctxMeta.ctxKey, value })
      return { ok: true, callbackText: "Model: custom" }
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback(callbackData("m", "apply", "openai/gpt|5", "x|high")))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Model: custom" }])
  assert.deepEqual(modelCalls, [{ ctxKey: "100:7", value: { mode: "custom", model: "openai/gpt|5", variant: "x|high" } }])
})

test("createCallbackHandlers rejects unsafe session switch callback ids", async () => {
  const getSessionCalls = []
  const { runtime, callbackAnswers, bindCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          getSessionCalls.push(sessionId)
          return { id: sessionId }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|demo|bad/id"))

  assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Invalid" }])
  assert.deepEqual(getSessionCalls, [])
  assert.deepEqual(bindCalls, [])
})

test("createCallbackHandlers falls back to a switch message when refreshing sessions fails", async () => {
  const { runtime, callbackAnswers, bindCalls, sentMessages, loggerErrors } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
    renderSessionsList: async () => {
      throw new Error("refresh failed")
    },
    buildSessionSwitchText: async () => "Switched fallback",
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|demo|ses_next"))

  assert.equal(callbackAnswers.at(-1)?.text, "Switched")
  assert.equal(bindCalls.at(-1)?.sessionId, "ses_next")
  assert.equal(sentMessages.at(-1)?.text, "Switched fallback")
  assert.match(loggerErrors.at(-1) || "", /Failed to refresh sessions list: refresh failed/)
})

test("createCallbackHandlers swallows fallback send failures after a session switch", async () => {
  const { runtime, callbackAnswers, bindCalls, loggerErrors } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession(sessionId) {
          return { id: sessionId }
        },
      },
    },
    renderSessionsList: async () => {
      throw new Error("refresh failed")
    },
    sendToThread: async () => {
      throw new Error("send failed")
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|demo|ses_next"))

  assert.equal(callbackAnswers.at(-1)?.text, "Switched")
  assert.equal(bindCalls.at(-1)?.sessionId, "ses_next")
  assert.match(loggerErrors.at(-1) || "", /Failed to refresh sessions list: refresh failed/)
})

test("createCallbackHandlers reports unavailable target sessions", async () => {
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async getSession() {
          throw new Error("missing session")
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|demo|ses_missing"))

  assert.equal(callbackAnswers.at(-1)?.text, "Unavailable")
  assert.match(sentMessages[0].text, /Project 'demo' is unavailable: missing session/)
})

test("createCallbackHandlers reports session guard states and invalid start actions", async () => {
  const notBound = makeRuntime({ ocByAlias: { demo: {} } })
  await createCallbackHandlers(notBound.runtime).handleTelegramCallback(makeCallback("s|demo|ses_next"))

  const bindingChanged = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "other", sessionId: "ses_other" } } },
    ocByAlias: { demo: {} },
  })
  await createCallbackHandlers(bindingChanged.runtime).handleTelegramCallback(makeCallback("s|demo|ses_next"))

  const alreadyCurrent = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: { demo: {} },
  })
  await createCallbackHandlers(alreadyCurrent.runtime).handleTelegramCallback(makeCallback("s|demo|ses_current"))

  const invalidStart = makeRuntime({ projects: { demo: {} } })
  await createCallbackHandlers(invalidStart.runtime).handleTelegramCallback(makeCallback("srv|demo|stop"))
  await createCallbackHandlers(invalidStart.runtime).handleTelegramCallback(makeCallback("srv|missing|start"))

  assert.deepEqual(notBound.callbackAnswers.map((entry) => entry.text), ["Not bound"])
  assert.deepEqual(bindingChanged.callbackAnswers.map((entry) => entry.text), ["Binding changed"])
  assert.deepEqual(alreadyCurrent.callbackAnswers.map((entry) => entry.text), ["Already current"])
  assert.deepEqual(invalidStart.callbackAnswers.map((entry) => entry.text), ["Invalid", "Unknown project"])
})

test("createCallbackHandlers handles server-start, feed, and changed-files callbacks", async () => {
  const { runtime, callbackAnswers, startCalls, feedCalls, changedFilesCalls } = makeRuntime({
    projects: { demo: { autoStart: true } },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("srv|demo|start", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("feed|verbose"))
  await handlers.handleTelegramCallback(makeCallback(callbackData("cf", "demo", "ses_1", "msg|1", "show")))

  assert.equal(callbackAnswers[0].text, "Starting…")
  assert.deepEqual(startCalls, [{ projectAlias: "demo", ctxMeta: { chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" } }])
  assert.deepEqual(feedCalls, [
    { type: "set", ctxKey: "100:7", mode: "verbose" },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { editMessageId: 900, noticeText: "Changed: this thread feed is now Verbose." },
    },
  ])
  assert.deepEqual(changedFilesCalls, [
    {
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      projectAlias: "demo",
      sessionId: "ses_1",
      opencodeMessageId: "msg|1",
      action: "show",
      options: { editMessageId: 900 },
    },
  ])
})

test("createCallbackHandlers handles project health and sessions callbacks", async () => {
  const healthCalls = []
  const projectSessionCalls = []
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    validateProject: async (projectAlias) => {
      healthCalls.push(projectAlias)
    },
    renderProjectSessions: async (ctxMeta, projectAlias, options) => {
      projectSessionCalls.push({ ctxMeta, projectAlias, options })
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("srv|demo|health", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("srv|demo|sessions", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(healthCalls, ["demo"])
  assert.deepEqual(projectSessionCalls, [
    {
      ctxMeta: { chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" },
      projectAlias: "demo",
      options: { editMessageId: 900 },
    },
  ])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Checking…", "Sessions"])
  assert.match(sentMessages[0].text, /health check: online/)
})

test("createCallbackHandlers handles UX navigation callbacks", async () => {
  const projectCalls = []
  const bindCommandCalls = []
  const newCommandCalls = []
  const { runtime, callbackAnswers, sessionListCalls, feedCalls, modelCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    handleProjects: async (ctxMeta) => {
      projectCalls.push(ctxMeta)
    },
    handleBindCommand: async (ctxMeta, argv) => {
      bindCommandCalls.push({ ctxMeta, argv })
    },
    handleNewCommand: async (ctxMeta, title) => {
      newCommandCalls.push({ ctxMeta, title })
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("s|refresh"))
  await handlers.handleTelegramCallback(makeCallback("s|new"))
  await handlers.handleTelegramCallback(makeCallback("feed|settings"))
  await handlers.handleTelegramCallback(makeCallback("m|settings"))
  await handlers.handleTelegramCallback(makeCallback("srv|projects"))
  await handlers.handleTelegramCallback(makeCallback("srv|demo|bind"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Sessions", "Creating…", "Feed", "Model", "Projects", "Binding…"])
  assert.equal(sessionListCalls.length, 1)
  assert.equal(newCommandCalls.length, 1)
  assert.deepEqual(feedCalls.at(-1), { type: "render", ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, options: { editMessageId: 900 } })
  assert.equal(modelCalls.at(-1)?.type, "render")
  assert.equal(projectCalls.length, 1)
  assert.deepEqual(bindCommandCalls[0]?.argv, ["demo"])
})

test("createCallbackHandlers reports unavailable project health with start action", async () => {
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    validateProject: async () => {
      throw new Error("connect ECONNREFUSED http://127.0.0.1:4312?token=secret")
    },
    canAutoStartProject: () => true,
    startServerKeyboard: (projectAlias) => ({ inline_keyboard: [[{ text: "Start", callback_data: `srv|${projectAlias}|start` }]] }),
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("srv|demo|health", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Checking…"])
  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0].text, /Project 'demo' is unavailable/)
  assert.doesNotMatch(sentMessages[0].text, /token=secret|secret/)
})

test("createCallbackHandlers blocks project controls in unrelated group threads", async () => {
  const { runtime, callbackAnswers, startCalls } = makeRuntime({
    projects: { demo: { autoStart: true } },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("srv|demo|start"))
  await handlers.handleTelegramCallback(makeCallback("srv|demo|health"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Private chat only", "Private chat only"])
  assert.deepEqual(startCalls, [])
})

test("createCallbackHandlers repairs binding index from private chats", async () => {
  const repairCalls = []
  const flushCalls = []
  const handleBindingsCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    store: {
      repairBindingIndex: () => {
        repairCalls.push(true)
        return { changed: true }
      },
      flush: async () => {
        flushCalls.push(true)
      },
    },
    handleBindings: async (ctxMeta) => {
      handleBindingsCalls.push(ctxMeta)
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|repair", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(repairCalls, [true])
  assert.deepEqual(flushCalls, [true])
  assert.deepEqual(handleBindingsCalls, [{ chatId: 100, chatType: "private", threadIdOr0: 0, ctxKey: "100:0" }])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Repaired"])
})

test("createCallbackHandlers blocks binding repair outside private chats", async () => {
  const repairCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    store: {
      repairBindingIndex: () => {
        repairCalls.push(true)
        return { changed: true }
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|repair", { chatType: "supergroup", threadIdOr0: 7 }))

  assert.deepEqual(repairCalls, [])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Private chat only"])
})

test("createCallbackHandlers keeps and unbinds target bindings", async () => {
  const unbindCalls = []
  const flushCalls = []
  const deletedMessages = []
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      unbind: (ctxKey) => {
        unbindCalls.push(ctxKey)
        return true
      },
      flush: async () => {
        flushCalls.push(true)
      },
    },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|keep|100:7", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("b|confirm-unbind|100:7", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("b|unbind|100:7|demo|ses_current", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Kept", "Confirm", "Unbound"])
  assert.deepEqual(unbindCalls, ["100:7"])
  assert.deepEqual(flushCalls, [true])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 900 }])
  assert.match(sentMessages[0].text, /Kept binding for chat 100 \/ topic 7 unchanged\./)
  assert.match(sentMessages[1].text, /Confirm unbind for this thread:/)
  assert.deepEqual(sentMessages[1].replyMarkup.inline_keyboard.flat().map((button) => button.text), ["Remove this thread binding", "Close"])
  assert.match(sentMessages[2].text, /Changed: binding removed\./)
  assert.match(sentMessages[2].text, /Removed binding for chat 100 \/ topic 7\./)
})

test("createCallbackHandlers refuses stale unbind confirmations after binding changes", async () => {
  const storeState = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_old" } } }
  const unbindCalls = []
  const deletedMessages = []
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    storeState,
    store: {
      unbind: (ctxKey) => {
        unbindCalls.push(ctxKey)
        return true
      },
      flush: async () => {},
    },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|confirm-unbind|100:7", { chatType: "private", threadIdOr0: 0 }))
  const removeButton = sentMessages[0].replyMarkup.inline_keyboard.flat().find((button) => button.text === "Remove this thread binding")
  storeState.bindings["100:7"] = { projectAlias: "demo", sessionId: "ses_new" }
  await handlers.handleTelegramCallback(makeCallback(removeButton.callback_data, { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Confirm", "Binding changed"])
  assert.deepEqual(unbindCalls, [])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 900 }])
  assert.match(sentMessages[1].text, /Binding changed for chat 100 \/ topic 7/)
})

test("createCallbackHandlers rebinds and creates replacement sessions for target bindings", async () => {
  const flushCalls = []
  const { runtime, callbackAnswers, bindCalls, sentMessages } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_old" } } },
    store: {
      flush: async () => {
        flushCalls.push(true)
      },
    },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "ses_new" }
        },
      },
    },
    getStartupSession: async (projectAlias, options) => {
      assert.equal(projectAlias, "demo")
      assert.deepEqual(options, { waitForStart: false, forceRefresh: true })
      return "ses_startup"
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|rebind|100:7", { chatType: "private", threadIdOr0: 0 }))
  await handlers.handleTelegramCallback(makeCallback("b|new|100:7", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Rebound", "Created"])
  assert.deepEqual(bindCalls, [
    {
      ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7", chatType: "private" },
      projectAlias: "demo",
      sessionId: "ses_startup",
    },
    {
      ctxMeta: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7", chatType: "private" },
      projectAlias: "demo",
      sessionId: "ses_new",
    },
  ])
  assert.deepEqual(flushCalls, [true, true])
  assert.match(sentMessages[0].text, /Rebound chat 100 \/ topic 7 to demo \/ ses_startup\./)
  assert.match(sentMessages[1].text, /Created and bound chat 100 \/ topic 7 to demo \/ ses_new\./)
})

test("createCallbackHandlers does not retry new-session callbacks after binding flush failure", async () => {
  const state = { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_old" } }, sessionIndex: {} }
  const createCalls = []
  const { runtime, callbackAnswers, sentMessages } = makeRuntime({
    storeState: state,
    store: {
      get: () => state,
      async flush() {
        throw new Error("state write failed")
      },
    },
    bindCtxToSession: async (ctxMeta, projectAlias, sessionId) => {
      state.bindings[ctxMeta.ctxKey] = { projectAlias, sessionId }
    },
    ocByAlias: {
      demo: {
        async createSession() {
          createCalls.push(true)
          return { id: "ses_new" }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|new|100:7", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(createCalls, [true])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Action failed"])
  assert.match(sentMessages.at(-1)?.text, /failed to persist the Telegram binding/)
  assert.deepEqual(state.bindings["100:7"], { projectAlias: "demo", sessionId: "ses_old" })
})

test("createCallbackHandlers refuses invalid replacement session ids", async () => {
  const flushCalls = []
  const { runtime, callbackAnswers, bindCalls, sentMessages } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_old" } } },
    store: {
      flush: async () => {
        flushCalls.push(true)
      },
    },
    ocByAlias: {
      demo: {
        async createSession() {
          return { id: "bad/id" }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|new|100:7", { chatType: "private", threadIdOr0: 0 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Unavailable"])
  assert.deepEqual(bindCalls, [])
  assert.deepEqual(flushCalls, [])
  assert.match(sentMessages[0].text, /Invalid session id/)
})

test("createCallbackHandlers scopes binding actions to current thread outside private chats", async () => {
  const unbindCalls = []
  const deletedMessages = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" }, "200:3": { projectAlias: "demo", sessionId: "ses_other" } } },
    store: {
      unbind: (ctxKey) => {
        unbindCalls.push(ctxKey)
        return true
      },
      flush: async () => {},
    },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("b|unbind|200:3|demo|ses_other", { chatType: "supergroup", threadIdOr0: 7 }))
  await handlers.handleTelegramCallback(makeCallback("b|unbind|100:7|demo|ses_current", { chatType: "supergroup", threadIdOr0: 7 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Private chat only", "Unbound"])
  assert.deepEqual(unbindCalls, ["100:7"])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 900 }])
})

test("createCallbackHandlers closes feed and sessions messages", async () => {
  const deletedMessages = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
        return true
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("feed|close"))
  await handlers.handleTelegramCallback(makeCallback("s|close"))
  await handlers.handleTelegramCallback(makeCallback("srv|close"))
  await handlers.handleTelegramCallback(makeCallback("b|close"))
  await handlers.handleTelegramCallback(makeCallback("cf|close"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Closed", "Closed", "Closed", "Closed", "Closed"])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 900 },
    { chatId: 100, messageId: 900 },
    { chatId: 100, messageId: 900 },
    { chatId: 100, messageId: 900 },
    { chatId: 100, messageId: 900 },
  ])
})

test("createCallbackHandlers deletes attachment confirmation after terminal button actions", async () => {
  const deletedMessages = []
  const attachmentCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    handleAttachmentConfirmation: async (ctxMeta, action, token, options) => {
      attachmentCalls.push({ ctxMeta, action, token, options })
      return { callbackText: action === "send" ? "Sent" : "Cancelled" }
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("att|cancel|tok_1", { messageId: 901 }))
  await handlers.handleTelegramCallback(makeCallback("att|send|tok_2", { id: "cb_2", messageId: 902 }))

  assert.deepEqual(callbackAnswers, [
    { callbackQueryId: "cb_1", text: "Cancelled" },
    { callbackQueryId: "cb_2", text: "Sending…" },
  ])
  assert.deepEqual(attachmentCalls.map((entry) => ({ action: entry.action, token: entry.token, editMessageId: entry.options.editMessageId })), [
    { action: "cancel", token: "tok_1", editMessageId: 901 },
    { action: "send", token: "tok_2", editMessageId: 902 },
  ])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 901 },
    { chatId: 100, messageId: 902 },
  ])
})

test("createCallbackHandlers answers invalid feed and changed-files callbacks", async () => {
  const { runtime, callbackAnswers } = makeRuntime()
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("feed|invalid"))
  await handlers.handleTelegramCallback(makeCallback("cf|demo|ses_1|msg_1|noop"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Invalid", "Invalid"])
})

test("createCallbackHandlers updates model preference and rerenders settings", async () => {
  const { runtime, callbackAnswers, modelCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("m|set|project-default"))
  await handlers.handleTelegramCallback(makeCallback("m|provider|openai"))
  await handlers.handleTelegramCallback(makeCallback("m|model|openai/gpt-5"))
  await handlers.handleTelegramCallback(makeCallback("m|apply|openai/gpt-5|xhigh"))
  await handlers.handleTelegramCallback(makeCallback("m|root"))
  await handlers.handleTelegramCallback(makeCallback("m|set|inherit"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), [
    "Model: project default",
    "Pick model",
    "Pick variant",
    "Model: openai/gpt-5 xhigh",
    "Back",
    "Model: inherit",
  ])
  assert.deepEqual(modelCalls, [
    { type: "set", ctxKey: "100:7", value: { mode: "project-default" } },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900 },
    },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900, selectedProviderId: "openai" },
    },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900, selectedProviderId: "openai", selectedModelKey: "openai/gpt-5" },
    },
    { type: "set", ctxKey: "100:7", value: { mode: "custom", model: "openai/gpt-5", variant: "xhigh" } },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900 },
    },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900 },
    },
    { type: "clear", ctxKey: "100:7" },
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900 },
    },
  ])
})

test("createCallbackHandlers closes model settings messages", async () => {
  const deletedMessages = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
        return true
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("m|close"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Closed"])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 900 }])
})

test("createCallbackHandlers keeps model settings unchanged when project default is unavailable", async () => {
  const { runtime, callbackAnswers, modelCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    setThreadModelPreference: async () => ({
      ok: false,
      callbackText: "No project default",
      message: "Project default model is not configured for this project.",
    }),
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("m|set|project-default"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["No project default"])
  assert.deepEqual(modelCalls, [
    {
      type: "render",
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      options: { binding: { projectAlias: "demo", sessionId: "ses_current" }, editMessageId: 900 },
    },
  ])
})

test("createCallbackHandlers rejects malformed model apply callbacks without changing state", async () => {
  const { runtime, callbackAnswers, modelCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("m|apply|not-a-model|xhigh"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Invalid"])
  assert.deepEqual(modelCalls, [])
})

test("createCallbackHandlers resolves permission callbacks including stale and reject-note flows", async () => {
  const deletedMessages = []
  const answered = []
  const { runtime, callbackAnswers, deletedPermissions, rejectStateCalls, rejectedNotes } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    recordPromptAnswered: (...args) => answered.push(args),
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    ocByAlias: {
      demo: {
        async replyPermission(permissionId) {
          if (permissionId === "perm_stale") {
            throw makeBoundaryError({
              source: "opencode",
              operation: `POST /permission/${permissionId}/reply`,
              method: "POST",
              pathname: `/permission/${permissionId}/reply`,
              status: 404,
              message: "missing",
            })
          }
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_ok|once", { messageId: 901 }))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_stale|reject", { messageId: 902 }))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_note|reject_note", { messageId: 903 }))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_note|cancel_note", { messageId: 904 }))

  assert.deepEqual(deletedPermissions, [
    { projectAlias: "demo", permissionId: "perm_ok" },
    { projectAlias: "demo", permissionId: "perm_stale" },
  ])
  assert.deepEqual(rejectStateCalls, [
    { ctxKey: "100:7", value: null },
    { ctxKey: "100:7", value: null },
    { ctxKey: "100:7", value: { projectAlias: "demo", permissionId: "perm_note" } },
    { ctxKey: "100:7", value: null },
  ])
  assert.deepEqual(rejectedNotes, [
    { ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, projectAlias: "demo", permissionId: "perm_note" },
  ])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["OK", "No longer active", "Send note", "Cancelled"])
  assert.deepEqual(answered, [["demo", "permission", "ok"]])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 901 },
    { chatId: 100, messageId: 902 },
    { chatId: 100, messageId: 903 },
    { chatId: 100, messageId: 904 },
  ])
})

test("createCallbackHandlers skips duplicate permission callbacks via idempotency ledger", async () => {
  const idempotencyKeys = new Set()
  const pendingPermissions = new Set(["demo:perm_dup"])
  const replyCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      getPendingPermission: (projectAlias, permissionId) => (pendingPermissions.has(`${projectAlias}:${permissionId}`) ? { projectAlias, permissionId } : null),
      deletePendingPermission: (projectAlias, permissionId) => pendingPermissions.delete(`${projectAlias}:${permissionId}`),
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey: (key) => {
        idempotencyKeys.add(key)
        return true
      },
      flush: async () => {},
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
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_dup|once", { id: "cb_a" }))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_dup|once", { id: "cb_b" }))

  assert.deepEqual(replyCalls, [{ permissionId: "perm_dup", payload: { reply: "once" } }])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["OK", "Already handled"])
})

test("createCallbackHandlers rethrows permission reply durability failures", async () => {
  const idempotencyKeys = new Set()
  const replyCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    store: {
      markIdempotencyKey: (key) => {
        idempotencyKeys.add(key)
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
  const handlers = createCallbackHandlers(runtime)

  await assert.rejects(() => handlers.handleTelegramCallback(makeCallback("p|demo||perm_durable|once")), (err) => {
    assert.equal(err.isBoundaryError, true)
    assert.equal(err.source, "state")
    assert.equal(err.outcome, "retryable")
    return true
  })

  assert.deepEqual(replyCalls, [{ permissionId: "perm_durable", payload: { reply: "once" } }])
  assert.equal(idempotencyKeys.size, 1)
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
})

test("createCallbackHandlers degrades transient permission callback failures without blocking the user", async () => {
  const deletedMessages = []
  const { runtime, callbackAnswers, sentMessages, loggerErrors } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    ocByAlias: {
      demo: {
        async replyPermission() {
          throw makeBoundaryError({
            source: "opencode",
            operation: "POST /permission/perm_retry/reply",
            method: "POST",
            pathname: "/permission/perm_retry/reply",
            kind: "network",
            outcome: "retryable",
            message: "temporary failure",
          })
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_retry|always"))

  assert.equal(callbackAnswers.at(-1)?.text, "Temporarily unavailable")
  assert.equal(sentMessages.at(-1)?.text, "Action is temporarily unavailable. Please try again.")
  assert.equal(loggerErrors.length, 0)
  assert.deepEqual(deletedMessages, [])
})

test("createCallbackHandlers treats permission callbacks for changed bindings as stale", async () => {
  const replyCalls = []
  let flushCount = 0
  const { runtime, callbackAnswers, deletedPermissions } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_other" } } },
    store: {
      getPendingPermission: (projectAlias, permissionId) =>
        permissionId === "perm_old" ? { projectAlias, permissionId, sessionID: "ses_prompt" } : null,
      async flush() {
        flushCount += 1
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
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo|ses_prompt|perm_scoped|once"))
  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_old|once"))

  assert.deepEqual(replyCalls, [])
  assert.deepEqual(deletedPermissions, [
    { projectAlias: "demo", permissionId: "perm_scoped", sessionID: "ses_prompt" },
    { projectAlias: "demo", permissionId: "perm_old", sessionID: "ses_prompt" },
  ])
  assert.equal(flushCount, 2)
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["No longer active", "No longer active"])
})

test("createCallbackHandlers handles permission guard branches and fatal callback failures", async () => {
  const { runtime, callbackAnswers, sentMessages, deletedPermissions, loggerErrors } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    ocByAlias: {
      demo: {
        async replyPermission() {
          throw new Error("boom")
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|missing||perm_1|once"))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_1|weird"))
  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_1|once"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Unknown project", "Invalid", "Action failed"])
  assert.deepEqual(deletedPermissions, [])
  assert.equal(sentMessages.at(-1)?.text, "Action failed. Please try again.")
  assert.match(loggerErrors.at(-1) || "", /Callback handler error: boom/)
})

test("createCallbackHandlers rejects stale and successful question callbacks", async () => {
  const wizard = makeWizard()
  const deletedMessages = []
  const { runtime, callbackAnswers, clearedQuestionIds, customStateCalls, questionWizards } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    questionWizards: new Map([["demo:q_1", wizard]]),
    getWizard: () => wizard,
    ocByAlias: {
      demo: {
        async rejectQuestion(questionId) {
          if (questionId === "q_stale") {
            throw makeBoundaryError({
              source: "opencode",
              operation: `POST /question/${questionId}/reject`,
              method: "POST",
              pathname: `/question/${questionId}/reject`,
              status: 404,
              message: "missing",
            })
          }
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_stale|reject", { messageId: 905 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_1|reject", { messageId: 906 }))

  assert.equal(questionWizards.has("demo:q_1"), false)
  assert.deepEqual(clearedQuestionIds, [
    { projectAlias: "demo", questionId: "q_stale" },
    { projectAlias: "demo", questionId: "q_1" },
  ])
  assert.deepEqual(customStateCalls, [
    { ctxKey: "100:7", value: null },
    { ctxKey: "100:7", value: null },
  ])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["No longer active", "Rejected"])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 905 },
    { chatId: 100, messageId: 906 },
  ])
})

test("createCallbackHandlers cleans scoped question wizards from old-shape reject callbacks", async () => {
  const scopedWizards = [
    { questionId: "q_success", sessionID: "ses_current" },
    { questionId: "q_stale", sessionID: "ses_current" },
    { questionId: "q_done", sessionID: "ses_current" },
  ].map(({ questionId, sessionID }) => ({ ...makeWizard({ id: questionId }), sessionID }))
  const questionWizards = new Map()
  for (const wizard of scopedWizards) {
    questionWizards.set(`demo:${wizard.sessionID}:${wizard.id}`, wizard)
    questionWizards.set(`demo:${wizard.id}`, wizard)
  }
  const rejectCalls = []
  const markedKeys = []
  const { runtime, callbackAnswers, clearedQuestionIds } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    questionWizards,
    getWizard: (projectAlias, questionId, sessionID = "") => {
      if (sessionID) return questionWizards.get(`${projectAlias}:${sessionID}:${questionId}`) || null
      return questionWizards.get(`${projectAlias}:${questionId}`) ||
        [...questionWizards.values()].find((wizard) => wizard?.projectAlias === projectAlias && (wizard?.id || wizard?.request?.id) === questionId) ||
        null
    },
    store: {
      hasIdempotencyKey: (key) => key.includes("q_done"),
      markIdempotencyKey: (key) => {
        markedKeys.push(key)
        return true
      },
      flush: async () => {},
    },
    ocByAlias: {
      demo: {
        async rejectQuestion(questionId) {
          rejectCalls.push(questionId)
          if (questionId === "q_stale") {
            throw makeBoundaryError({
              source: "opencode",
              operation: `POST /question/${questionId}/reject`,
              method: "POST",
              pathname: `/question/${questionId}/reject`,
              status: 404,
              message: "missing",
            })
          }
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|q_success|reject"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_stale|reject"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_done|reject"))

  assert.deepEqual(rejectCalls, ["q_success", "q_stale"])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Rejected", "No longer active", "Already handled"])
  for (const wizard of scopedWizards) {
    assert.equal(questionWizards.has(`demo:${wizard.sessionID}:${wizard.id}`), false)
    assert.equal(questionWizards.has(`demo:${wizard.id}`), false)
  }
  assert.deepEqual(clearedQuestionIds, [
    { projectAlias: "demo", questionId: "q_success", sessionID: "ses_current" },
    { projectAlias: "demo", questionId: "q_success" },
    { projectAlias: "demo", questionId: "q_stale", sessionID: "ses_current" },
    { projectAlias: "demo", questionId: "q_stale" },
    { projectAlias: "demo", questionId: "q_done", sessionID: "ses_current" },
    { projectAlias: "demo", questionId: "q_done" },
  ])
  assert.equal(markedKeys.length, 2)
  assert.ok(markedKeys.every((key) => key.includes("ses_")))
})

test("createCallbackHandlers treats question callbacks for changed bindings as stale", async () => {
  const oldWizard = { ...makeWizard({ id: "q_old" }), sessionID: "ses_prompt" }
  const questionWizards = new Map([["demo:ses_prompt:q_old", oldWizard], ["demo:q_old", oldWizard]])
  const rejectCalls = []
  let flushCount = 0
  const { runtime, callbackAnswers, clearedQuestionIds } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_other" } } },
    questionWizards,
    getWizard: (projectAlias, questionId, sessionID = "") => {
      if (questionId !== "q_old") return null
      if (sessionID) return questionWizards.get(`${projectAlias}:${sessionID}:${questionId}`) || null
      return questionWizards.get(`${projectAlias}:${questionId}`) || null
    },
    store: {
      async flush() {
        flushCount += 1
      },
    },
    ocByAlias: {
      demo: {
        async rejectQuestion(questionId) {
          rejectCalls.push(questionId)
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|ses_prompt|q_scoped|reject"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_old|reject"))

  assert.deepEqual(rejectCalls, [])
  assert.deepEqual(clearedQuestionIds, [
    { projectAlias: "demo", questionId: "q_scoped", sessionID: "ses_prompt" },
    { projectAlias: "demo", questionId: "q_scoped" },
    { projectAlias: "demo", questionId: "q_old", sessionID: "ses_prompt" },
    { projectAlias: "demo", questionId: "q_old" },
  ])
  assert.equal(flushCount, 2)
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["No longer active", "No longer active"])
})

test("createCallbackHandlers skips duplicate question reject callbacks via idempotency ledger", async () => {
  const wizard = makeWizard({ id: "q_dup" })
  const idempotencyKeys = new Set()
  const rejectCalls = []
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    questionWizards: new Map([["demo:q_dup", wizard]]),
    getWizard: () => wizard,
    store: {
      hasIdempotencyKey: (key) => idempotencyKeys.has(key),
      markIdempotencyKey: (key) => {
        idempotencyKeys.add(key)
        return true
      },
      flush: async () => {},
    },
    ocByAlias: {
      demo: {
        async rejectQuestion(questionId) {
          rejectCalls.push({ questionId })
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_dup|reject", { id: "cb_a" }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_dup|reject", { id: "cb_b" }))

  assert.deepEqual(rejectCalls, [{ questionId: "q_dup" }])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Rejected", "Already handled"])
})

test("createCallbackHandlers clears persisted question state even without an in-memory wizard", async () => {
  const { runtime, callbackAnswers, clearedQuestionIds } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    getWizard: () => null,
    ocByAlias: {
      demo: {
        async rejectQuestion() {
          return { ok: true }
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_missing_mem|reject"))

  assert.deepEqual(clearedQuestionIds, [{ projectAlias: "demo", questionId: "q_missing_mem" }])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Rejected"])
})

test("createCallbackHandlers starts and cancels custom-answer question flows", async () => {
  const wizard = makeWizard({ questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const deletedMessages = []
  const { runtime, callbackAnswers, customPrompts, customStateCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    getWizard: () => wizard,
    ocByAlias: { demo: {} },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_1|0|custom", { messageId: 907 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_1|0|cancel_custom", { messageId: 908 }))

  assert.deepEqual(customPrompts, [
    {
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      projectAlias: "demo",
      questionId: "q_1",
      qIndex: 0,
      label: "Reason",
    },
  ])
  assert.deepEqual(customStateCalls, [
    { ctxKey: "100:7", value: { projectAlias: "demo", requestId: "q_1", qIndex: 0 } },
    { ctxKey: "100:7", value: null },
  ])
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Send answer", "Cancelled"])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 907 },
    { chatId: 100, messageId: 908 },
  ])
})

test("createCallbackHandlers parses session-scoped question callbacks with numeric question ids", async () => {
  const wizard = makeWizard({ id: "123", questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const deletedMessages = []
  const getWizardCalls = []
  const promptCalls = []
  const { runtime, callbackAnswers, customStateCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_123" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    getWizard: (projectAlias, questionId, sessionID) => {
      getWizardCalls.push({ projectAlias, questionId, sessionID })
      return projectAlias === "demo" && questionId === "123" && sessionID === "ses_123" ? wizard : null
    },
    ocByAlias: { demo: {} },
    sendQuestionCustomAnswerPrompt: async (...args) => {
      promptCalls.push(args)
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|ses_123|123|0|custom", { messageId: 909 }))

  assert.deepEqual(getWizardCalls, [{ projectAlias: "demo", questionId: "123", sessionID: "ses_123" }])
  assert.deepEqual(customStateCalls, [{ ctxKey: "100:7", value: { projectAlias: "demo", requestId: "123", sessionID: "ses_123", qIndex: 0 } }])
  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0][1], "demo")
  assert.equal(promptCalls[0][2], "123")
  assert.deepEqual(promptCalls[0][5], { sessionID: "ses_123" })
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Send answer"])
  assert.deepEqual(deletedMessages, [{ chatId: 100, messageId: 909 }])
})

test("createCallbackHandlers reports prompt bootstrap failures for reject-note and custom-answer flows", async () => {
  const wizard = makeWizard({ questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const { runtime, callbackAnswers } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    getWizard: () => wizard,
    ocByAlias: { demo: {} },
    sendRejectNotePrompt: async () => {
      throw new Error("send failed")
    },
    sendQuestionCustomAnswerPrompt: async () => {
      throw new Error("send failed")
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo||perm_note|reject_note"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_1|0|custom"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Unavailable", "Unavailable"])
})

test("createCallbackHandlers handles single-choice and multi-choice question steps", async () => {
  const singleWizard = makeWizard({ questions: [{ header: "Pick one", question: "Pick", options: [{ label: "lint" }] }] })
  const multiWizard = makeWizard({
    questions: [
      { header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] },
      { header: "Reason", question: "Why?", custom: true, options: [] },
    ],
    selectedByIndex: { 0: ["test"] },
  })
  const getWizard = (projectAlias, questionId) => (questionId === "q_single" ? singleWizard : questionId === "q_multi" ? multiWizard : null)
  const deletedMessages = []
  const { runtime, callbackAnswers, persistedWizards, finishCalls, sendQuestionStepCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      deleteMessage: async (chatId, messageId) => {
        deletedMessages.push({ chatId, messageId })
      },
    },
    getWizard,
    ocByAlias: { demo: {} },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_single|0|o|0", { messageId: 909 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi|0|t|0", { messageId: 910 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi|0|done", { messageId: 910 }))

  assert.deepEqual(finishCalls, [
    {
      ...singleWizard,
      answers: [["lint"]],
      selectedByIndex: {},
      messageIdByIndex: {},
    },
  ])
  assert.equal(sendQuestionStepCalls[0].options.editMessageId, 910)
  assert.equal(sendQuestionStepCalls[0].wizard.selectedByIndex[0].sort().join(","), "lint,test")
  assert.equal(sendQuestionStepCalls[1].wizard.index, 1)
  assert.equal(persistedWizards.length, 3)
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Selected", undefined, "Done"])
  assert.deepEqual(deletedMessages, [
    { chatId: 100, messageId: 909 },
    { chatId: 100, messageId: 910 },
  ])
})

test("createCallbackHandlers flushes question wizard progression state before deleting or answering", async () => {
  const order = []
  let flushCount = 0
  const singleWizard = makeWizard({
    id: "q_single_next",
    questions: [
      { header: "Pick one", question: "Pick", options: [{ label: "lint" }] },
      { header: "Reason", question: "Why?", custom: true, options: [] },
    ],
  })
  const toggleWizard = makeWizard({
    id: "q_multi_toggle",
    questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] }],
    selectedByIndex: { 0: ["test"] },
  })
  const doneWizard = makeWizard({
    id: "q_multi_done_next",
    questions: [
      { header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] },
      { header: "Reason", question: "Why?", custom: true, options: [] },
    ],
    selectedByIndex: { 0: ["lint", "test"] },
  })
  const getWizard = (_projectAlias, questionId) => {
    if (questionId === "q_single_next") return singleWizard
    if (questionId === "q_multi_toggle") return toggleWizard
    if (questionId === "q_multi_done_next") return doneWizard
    return null
  }
  const { runtime } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    tg: {
      answerCallbackQuery: async (_callbackQueryId, text) => {
        order.push(`answer:${text ?? ""}`)
        return true
      },
      deleteMessage: async (_chatId, messageId) => {
        order.push(`delete:${messageId}`)
        return true
      },
    },
    store: {
      flush: async () => {
        flushCount += 1
        order.push(`flush:${flushCount}`)
      },
    },
    getWizard,
    ocByAlias: { demo: {} },
    persistQuestionWizard: (wizard) => {
      order.push(`persist:${wizard.id}:${wizard.index}`)
    },
    sendCurrentQuestionStep: async (wizard, options) => {
      order.push(`send:${wizard.id}:${wizard.index}:${options?.editMessageId ?? "new"}`)
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_single_next|0|o|0", { messageId: 911 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi_toggle|0|t|0", { id: "cb_2", messageId: 912 }))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi_done_next|0|done", { id: "cb_3", messageId: 913 }))

  assert.deepEqual(order, [
    "send:q_single_next:1:new",
    "persist:q_single_next:1",
    "flush:1",
    "delete:911",
    "answer:Selected",
    "send:q_multi_toggle:0:912",
    "persist:q_multi_toggle:0",
    "flush:2",
    "answer:",
    "send:q_multi_done_next:1:new",
    "persist:q_multi_done_next:1",
    "flush:3",
    "delete:913",
    "answer:Done",
  ])
})

test("createCallbackHandlers rolls back and rethrows durability failures during question wizard progression flushes", async () => {
  const cases = [
    {
      callbackData: "q|demo||q_single_flush_fail|0|o|0",
      messageId: 914,
      wizard: makeWizard({
        id: "q_single_flush_fail",
        questions: [
          { header: "Pick one", question: "Pick", options: [{ label: "lint" }] },
          { header: "Reason", question: "Why?", custom: true, options: [] },
        ],
      }),
      assertProgress: ({ sendQuestionStepCalls, persistedWizards }) => {
        assert.equal(sendQuestionStepCalls[0]?.wizard.index, 1)
        assert.equal(persistedWizards[0]?.index, 1)
      },
    },
    {
      callbackData: "q|demo||q_multi_toggle_flush_fail|0|t|0",
      messageId: 915,
      wizard: makeWizard({
        id: "q_multi_toggle_flush_fail",
        questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] }],
        selectedByIndex: { 0: ["test"] },
      }),
      assertProgress: ({ sendQuestionStepCalls, persistedWizards }) => {
        assert.equal(sendQuestionStepCalls[0]?.options.editMessageId, 915)
        assert.equal(sendQuestionStepCalls[0]?.wizard.selectedByIndex[0].slice().sort().join(","), "lint,test")
        assert.equal(persistedWizards[0]?.selectedByIndex[0].slice().sort().join(","), "lint,test")
      },
    },
    {
      callbackData: "q|demo||q_multi_done_flush_fail|0|done",
      messageId: 916,
      wizard: makeWizard({
        id: "q_multi_done_flush_fail",
        questions: [
          { header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] },
          { header: "Reason", question: "Why?", custom: true, options: [] },
        ],
        selectedByIndex: { 0: ["lint", "test"] },
      }),
      assertProgress: ({ sendQuestionStepCalls, persistedWizards }) => {
        assert.equal(sendQuestionStepCalls[0]?.wizard.index, 1)
        assert.equal(persistedWizards[0]?.index, 1)
        assert.equal(persistedWizards[0]?.answers[0].join(","), "lint,test")
      },
    },
  ]

  for (const { callbackData, messageId, wizard, assertProgress } of cases) {
    const initialWizard = cloneWizardState(wizard)
    const deletedMessages = []
    const flushCalls = []
    const { runtime, callbackAnswers, persistedWizards, sendQuestionStepCalls } = makeRuntime({
      storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
      tg: {
        deleteMessage: async (chatId, currentMessageId) => {
          deletedMessages.push({ chatId, messageId: currentMessageId })
        },
      },
      store: {
        async flush() {
          flushCalls.push(true)
          throw new Error("state write failed")
        },
      },
      getWizard: () => wizard,
      ocByAlias: { demo: {} },
    })
    const handlers = createCallbackHandlers(runtime)

    await assert.rejects(() => handlers.handleTelegramCallback(makeCallback(callbackData, { messageId })), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "state")
      assert.equal(err.outcome, "retryable")
      return true
    })

    assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
    assert.deepEqual(flushCalls, [true])
    assert.equal(sendQuestionStepCalls.length, 1)
    assert.equal(persistedWizards.length, 2)
    assert.deepEqual(deletedMessages, [])
    assertProgress({ sendQuestionStepCalls, persistedWizards })
    assert.deepEqual(persistedWizards[1], initialWizard)
    assert.deepEqual(cloneWizardState(wizard), initialWizard)
  }
})

test("createCallbackHandlers does not persist multi-choice toggles when step edit fails", async () => {
  const wizard = makeWizard({
    id: "q_multi_edit_fail",
    questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] }],
    selectedByIndex: { 0: ["test"] },
  })
  const { runtime, callbackAnswers, persistedWizards } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    getWizard: () => wizard,
    ocByAlias: { demo: {} },
    sendCurrentQuestionStep: async () => {
      throw new Error("edit failed")
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi_edit_fail|0|t|0", { messageId: 910 }))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Action failed"])
  assert.deepEqual(persistedWizards, [])
  assert.deepEqual(wizard.selectedByIndex, { 0: ["test"] })
})

test("createCallbackHandlers rejects invalid question callback shapes and options", async () => {
  const singleWizard = makeWizard({ id: "q_single", questions: [{ header: "Pick one", question: "Pick", options: [{ label: "lint" }] }] })
  const multiWizard = makeWizard({
    id: "q_multi",
    questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] }],
  })
  const { runtime, callbackAnswers, persistedWizards, finishCalls, sendQuestionStepCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    getWizard: (_projectAlias, questionId) => {
      if (questionId === "q_single") return singleWizard
      if (questionId === "q_multi") return multiWizard
      return null
    },
    ocByAlias: { demo: {} },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|missing||q_1|reject"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_single"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_single|0|t|0"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi|0|t|99"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_single|0|done"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Unknown project", "No longer active", "Invalid", "Invalid", "Invalid"])
  assert.deepEqual(persistedWizards, [])
  assert.deepEqual(finishCalls, [])
  assert.deepEqual(sendQuestionStepCalls, [])
})

test("createCallbackHandlers reports retryable completion for multi-choice questions", async () => {
  const wizard = makeWizard({
    id: "q_multi_retry",
    questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }, { label: "test" }] }],
    selectedByIndex: { 0: ["lint", "test"] },
  })
  const { runtime, callbackAnswers, sentMessages, persistedWizards, finishCalls } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    getWizard: () => wizard,
    ocByAlias: { demo: {} },
    finishQuestionWizard: async (currentWizard) => {
      finishCalls.push(cloneWizardState(currentWizard))
      return { outcome: "retryable" }
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_multi_retry|0|done"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Temporarily unavailable"])
  assert.equal(sentMessages.at(-1)?.text, "Action is temporarily unavailable. Please try again.")
  assert.equal(persistedWizards.length, 1)
  assert.deepEqual(finishCalls, [
    {
      ...wizard,
      answers: [["lint", "test"]],
      selectedByIndex: { 0: ["lint", "test"] },
      messageIdByIndex: {},
    },
  ])
})

test("createCallbackHandlers maps stale, retryable, and fatal outer callback errors", async () => {
  const { runtime, callbackAnswers, sentMessages, loggerErrors } = makeRuntime({
    storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } },
    setThreadModelPreference: async (_ctxMeta, _binding, value) => {
      if (!value) {
        throw makeBoundaryError({
          source: "opencode",
          operation: "POST /model",
          method: "POST",
          pathname: "/session/ses_current",
          kind: "stale",
          outcome: "stale",
          status: 404,
          message: "stale",
        })
      }
      if (value.mode === "custom") {
        throw makeBoundaryError({
          source: "opencode",
          operation: "POST /model",
          method: "POST",
          pathname: "/model",
          kind: "network",
          outcome: "retryable",
          message: "retry later",
        })
      }
      throw new Error("unexpected")
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("m|set|inherit"))
  await handlers.handleTelegramCallback(makeCallback("m|apply|openai/gpt-5|xhigh"))
  await handlers.handleTelegramCallback(makeCallback("m|set|project-default"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["No longer active", "Temporarily unavailable", "Action failed"])
  assert.deepEqual(sentMessages.map((entry) => entry.text), [
    "Action is temporarily unavailable. Please try again.",
    "Action failed. Please try again.",
  ])
  assert.equal(loggerErrors.length, 3)
})

test("createCallbackHandlers answers not-found, out-of-date, and unsupported question callbacks", async () => {
  const disabledWizard = makeWizard({ questions: [{ header: "Locked", question: "Nope", custom: false, options: [] }] })
  const mismatchWizard = makeWizard({ index: 1 })
  const unsupportedWizard = makeWizard({ questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const getWizard = (projectAlias, questionId) => {
    if (questionId === "q_disabled") return disabledWizard
    if (questionId === "q_mismatch") return mismatchWizard
    if (questionId === "q_unsupported") return unsupportedWizard
    return null
  }
  const { runtime, callbackAnswers } = makeRuntime({ storeState: { bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_current" } } }, getWizard, ocByAlias: { demo: {} } })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo||q_missing|0|custom"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_disabled|0|custom"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_mismatch|0|o|0"))
  await handlers.handleTelegramCallback(makeCallback("q|demo||q_unsupported|0|weird"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Not found", "Custom disabled", "Out of date", "No longer active"])
})
