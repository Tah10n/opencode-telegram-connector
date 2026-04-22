import test from "node:test"
import assert from "node:assert/strict"
import { createCallbackHandlers } from "../src/connector/callbacks.js"

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
  const callbackAnswers = []
  const sentMessages = []
  const bindCalls = []
  const sessionListCalls = []
  const startCalls = []
  const feedCalls = []
  const changedFilesCalls = []
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
    deletePendingPermission: (projectAlias, permissionId) => {
      deletedPermissions.push({ projectAlias, permissionId })
      return true
    },
    ...(overrides.store || {}),
  }

  const runtime = {
    tg: {
      answerCallbackQuery: async (callbackQueryId, text) => {
        callbackAnswers.push({ callbackQueryId, text })
        return true
      },
      ...(overrides.tg || {}),
    },
    cb: { unpack: (value) => value, ...(overrides.cb || {}) },
    store,
    projects: overrides.projects || { demo: { baseUrl: "http://127.0.0.1:4312" } },
    ocByAlias: overrides.ocByAlias || {},
    ctxMetaFromMessage: (msg) => ({
      chatId: msg?.chat?.id,
      chatType: msg?.chat?.type,
      threadIdOr0: msg?.message_thread_id || 0,
      ctxKey: `${msg?.chat?.id}:${msg?.message_thread_id || 0}`,
    }),
    isAllowedUser: overrides.isAllowedUser || (() => true),
    bindCtxToSession: async (ctxMeta, projectAlias, sessionId) => {
      bindCalls.push({ ctxMeta, projectAlias, sessionId })
    },
    sendToThread: async (ctxMeta, text) => {
      sentMessages.push({ ctxMeta, text })
    },
    ensureProjectStarted: async (projectAlias, ctxMeta) => {
      startCalls.push({ projectAlias, ctxMeta })
    },
    renderFeedSettings: async (ctxMeta, options) => {
      feedCalls.push({ type: "render", ctxMeta, options })
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
    getWizard: overrides.getWizard || (() => null),
    clearPersistedQuestionWizard: (projectAlias, questionId) => {
      clearedQuestionIds.push({ projectAlias, questionId })
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
    isMissingPromptError: overrides.isMissingPromptError || (() => false),
    formatProjectUnavailable: (alias, err) => `Project '${alias}' is unavailable: ${err?.message || String(err)}`,
    logger: { error: (...args) => loggerErrors.push(args.map((arg) => String(arg)).join(" ")) },
    questionWizards,
    ...overrides,
  }

  return {
    runtime,
    callbackAnswers,
    sentMessages,
    bindCalls,
    sessionListCalls,
    startCalls,
    feedCalls,
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

  await handlers.handleTelegramCallback(makeCallback("srv|demo|start"))
  await handlers.handleTelegramCallback(makeCallback("feed|verbose"))
  await handlers.handleTelegramCallback(makeCallback("cf|demo|ses_1|msg_1|show"))

  assert.equal(callbackAnswers[0].text, "Starting…")
  assert.deepEqual(startCalls, [{ projectAlias: "demo", ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" } }])
  assert.deepEqual(feedCalls, [
    { type: "set", ctxKey: "100:7", mode: "verbose" },
    { type: "render", ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" }, options: { editMessageId: 900 } },
  ])
  assert.deepEqual(changedFilesCalls, [
    {
      ctxMeta: { chatId: 100, chatType: "supergroup", threadIdOr0: 7, ctxKey: "100:7" },
      projectAlias: "demo",
      sessionId: "ses_1",
      opencodeMessageId: "msg_1",
      action: "show",
      options: { editMessageId: 900 },
    },
  ])
})

test("createCallbackHandlers answers invalid feed and changed-files callbacks", async () => {
  const { runtime, callbackAnswers } = makeRuntime()
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("feed|invalid"))
  await handlers.handleTelegramCallback(makeCallback("cf|demo|ses_1|msg_1|noop"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Invalid", "Invalid"])
})

test("createCallbackHandlers resolves permission callbacks including stale and reject-note flows", async () => {
  const { runtime, callbackAnswers, deletedPermissions, rejectStateCalls, rejectedNotes } = makeRuntime({
    ocByAlias: {
      demo: {
        async replyPermission(permissionId) {
          if (permissionId === "perm_stale") throw new Error("missing")
          return { ok: true }
        },
      },
    },
    isMissingPromptError: (err) => String(err?.message) === "missing",
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_ok|once"))
  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_stale|reject"))
  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_note|reject_note"))
  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_note|cancel_note"))

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
})

test("createCallbackHandlers degrades transient permission callback failures without blocking the user", async () => {
  const { runtime, callbackAnswers, sentMessages, loggerErrors } = makeRuntime({
    ocByAlias: {
      demo: {
        async replyPermission() {
          throw new Error("temporary failure")
        },
      },
    },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_retry|always"))

  assert.equal(callbackAnswers.at(-1)?.text, "Action failed")
  assert.equal(sentMessages.at(-1)?.text, "Action failed. Please try again.")
  assert.ok(loggerErrors.some((entry) => /Callback handler error: temporary failure/.test(entry)))
})

test("createCallbackHandlers rejects stale and successful question callbacks", async () => {
  const wizard = makeWizard()
  const { runtime, callbackAnswers, clearedQuestionIds, customStateCalls, questionWizards } = makeRuntime({
    questionWizards: new Map([["demo:q_1", wizard]]),
    getWizard: () => wizard,
    ocByAlias: {
      demo: {
        async rejectQuestion(questionId) {
          if (questionId === "q_stale") throw new Error("missing")
          return { ok: true }
        },
      },
    },
    isMissingPromptError: (err) => String(err?.message) === "missing",
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|q_stale|reject"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_1|reject"))

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
})

test("createCallbackHandlers starts and cancels custom-answer question flows", async () => {
  const wizard = makeWizard({ questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const { runtime, callbackAnswers, customPrompts, customStateCalls } = makeRuntime({
    getWizard: () => wizard,
    ocByAlias: { demo: {} },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|q_1|0|custom"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_1|0|cancel_custom"))

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
})

test("createCallbackHandlers reports prompt bootstrap failures for reject-note and custom-answer flows", async () => {
  const wizard = makeWizard({ questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }] })
  const { runtime, callbackAnswers } = makeRuntime({
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

  await handlers.handleTelegramCallback(makeCallback("p|demo|perm_note|reject_note"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_1|0|custom"))

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
  const { runtime, callbackAnswers, persistedWizards, finishCalls, sendQuestionStepCalls } = makeRuntime({
    getWizard,
    ocByAlias: { demo: {} },
  })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|q_single|0|o|0"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_multi|0|t|0"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_multi|0|done"))

  assert.deepEqual(finishCalls, [
    {
      ...singleWizard,
      answers: [["lint"]],
      selectedByIndex: {},
      messageIdByIndex: {},
    },
  ])
  assert.equal(sendQuestionStepCalls[0].options.editMessageId, 900)
  assert.equal(sendQuestionStepCalls[0].wizard.selectedByIndex[0].sort().join(","), "lint,test")
  assert.equal(sendQuestionStepCalls[1].wizard.index, 1)
  assert.equal(persistedWizards.length, 3)
  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Selected", undefined, "Done"])
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
  const { runtime, callbackAnswers } = makeRuntime({ getWizard, ocByAlias: { demo: {} } })
  const handlers = createCallbackHandlers(runtime)

  await handlers.handleTelegramCallback(makeCallback("q|demo|q_missing|0|custom"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_disabled|0|custom"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_mismatch|0|o|0"))
  await handlers.handleTelegramCallback(makeCallback("q|demo|q_unsupported|0|weird"))

  assert.deepEqual(callbackAnswers.map((entry) => entry.text), ["Not found", "Custom disabled", "Out of date", "Unsupported"])
})
