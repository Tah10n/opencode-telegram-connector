import test from "node:test"
import assert from "node:assert/strict"
import { createPromptHandlers } from "../src/connector/prompts.js"
import { createPromptRecovery } from "../src/connector/prompt-recovery.js"

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

function makePromptRuntime(overrides = {}) {
  const calls = {
    sendBlocksToThread: [],
    sendToThread: [],
    sendMessage: [],
    setPendingPermission: [],
    setQuestionWizard: [],
  }
  const promptBaseline = {
    demo: { loaded: true, permission: new Set(), question: new Set() },
  }
  const prompted = {
    demo: { permission: new FakeLruSet(), question: new FakeLruSet() },
  }
  const questionWizards = new Map()
  const rejectNoteAwaiting = new Map()
  const awaitingCustomAnswer = new Map()
  const store = {
    setPendingPermission(record) {
      calls.setPendingPermission.push(record)
    },
    setQuestionWizard(key, wizard) {
      calls.setQuestionWizard.push({ key, wizard })
    },
    deleteQuestionWizard() {},
    setRejectNoteAwaiting() {},
    deleteRejectNoteAwaiting() {},
    setAwaitingCustomAnswer() {},
    deleteAwaitingCustomAnswer() {},
  }

  const runtime = {
    store,
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        return { message_id: calls.sendMessage.length }
      },
    },
    cb: { pack: (value) => value },
    ocByAlias: { demo: {} },
    promptBaseline,
    prompted,
    questionWizards,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    async sendToThread(...args) {
      calls.sendToThread.push(args)
      return { message_id: calls.sendToThread.length }
    },
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      return [{ message_id: calls.sendBlocksToThread.length }]
    },
    parseCtxKey: (ctxKey) => {
      const [chatId, threadIdOr0] = String(ctxKey).split(":").map(Number)
      return { chatId, threadIdOr0, ctxKey }
    },
    clampString: (value, max) => String(value ?? "").slice(0, max),
    recoverPendingPromptsOnStartup: false,
    markProjectUp() {},
  }

  const merged = {
    ...runtime,
    ...overrides,
    store: { ...runtime.store, ...(overrides.store || {}) },
    tg: { ...runtime.tg, ...(overrides.tg || {}) },
    promptBaseline: overrides.promptBaseline || promptBaseline,
    prompted: overrides.prompted || prompted,
    questionWizards: overrides.questionWizards || questionWizards,
  }
  return { calls, runtime: merged, handlers: createPromptHandlers(merged) }
}

const routeResolver = async () => ({ route: { chatId: 100, threadIdOr0: 7 } })
const logSseDebug = () => {}

test("handlePermissionAsked retries after Telegram prompt delivery fails", async () => {
  let fail = true
  const delivered = []
  const { calls, runtime, handlers } = makePromptRuntime({
    recordPromptDelivered: (...args) => delivered.push(args),
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      if (fail) {
        fail = false
        throw new Error("telegram down")
      }
      return [{ message_id: 10 }]
    },
  })

  const input = {
    projectAlias: "demo",
    props: { id: "perm_1", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] },
    resolveBoundRoute: routeResolver,
    logSseDebug,
  }

  await assert.rejects(() => handlers.handlePermissionAsked(input), /telegram down/)
  assert.equal(runtime.prompted.demo.permission.has("ses_1:perm_1"), false)

  await handlers.handlePermissionAsked(input)
  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.equal(runtime.prompted.demo.permission.has("ses_1:perm_1"), true)
  assert.equal(calls.setPendingPermission.length, 2)
  assert.deepEqual(delivered, [["demo", "permission"]])
})

test("handlePermissionAsked does not baseline-suppress a first SSE prompt after Telegram delivery fails", async () => {
  let fail = true
  const permission = { id: "perm_self_baseline", sessionID: "ses_1", permission: "shell", patterns: ["npm test"] }
  const promptBaseline = { demo: { loaded: false, permission: new Set(), question: new Set() } }
  const { calls, runtime, handlers } = makePromptRuntime({
    promptBaseline,
    ocByAlias: {
      demo: {
        async listPermissions() {
          return [permission]
        },
        async listQuestions() {
          return []
        },
      },
    },
    async sendBlocksToThread(...args) {
      calls.sendBlocksToThread.push(args)
      if (fail) {
        fail = false
        throw new Error("telegram down")
      }
      return [{ message_id: 10 }]
    },
  })

  const input = { projectAlias: "demo", props: permission, resolveBoundRoute: routeResolver, logSseDebug }

  await assert.rejects(() => handlers.handlePermissionAsked(input), /telegram down/)
  assert.equal(runtime.promptBaseline.demo.permission.has("ses_1:perm_self_baseline"), false)
  assert.equal(runtime.prompted.demo.permission.has("ses_1:perm_self_baseline"), false)

  await handlers.handlePermissionAsked(input)
  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.equal(runtime.prompted.demo.permission.has("ses_1:perm_self_baseline"), true)
})

test("handleQuestionAsked retries after Telegram question step delivery fails", async () => {
  let fail = true
  const delivered = []
  const { calls, runtime, handlers } = makePromptRuntime({
    recordPromptDelivered: (...args) => delivered.push(args),
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        if (fail) {
          fail = false
          throw new Error("telegram step down")
        }
        return { message_id: 20 }
      },
    },
  })
  const request = {
    id: "q_1",
    sessionID: "ses_1",
    questions: [{ header: "Reason", question: "Why?", options: [{ label: "A" }] }],
  }
  const input = { projectAlias: "demo", props: request, resolveBoundRoute: routeResolver, logSseDebug }

  await assert.rejects(() => handlers.handleQuestionAsked(input), /telegram step down/)
  assert.equal(runtime.prompted.demo.question.has("ses_1:q_1"), false)

  await handlers.handleQuestionAsked(input)
  assert.equal(calls.sendBlocksToThread.length, 2)
  assert.equal(calls.sendMessage.length, 2)
  assert.equal(runtime.prompted.demo.question.has("ses_1:q_1"), true)
  assert.equal(runtime.questionWizards.has("demo:ses_1:q_1"), true)
  assert.deepEqual(delivered, [["demo", "question"]])
})

test("sendCurrentQuestionStep surfaces edit failures without recording message id", async () => {
  const { handlers } = makePromptRuntime({
    tg: {
      async editMessageText() {
        throw new Error("telegram edit down")
      },
    },
  })
  const wizard = {
    projectAlias: "demo",
    request: {
      id: "q_edit_fail",
      sessionID: "ses_1",
      questions: [{ header: "Checks", question: "Pick", multiple: true, options: [{ label: "lint" }] }],
    },
    index: 0,
    selectedByIndex: { 0: ["lint"] },
    messageIdByIndex: {},
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  }

  await assert.rejects(() => handlers.sendCurrentQuestionStep(wizard, { editMessageId: 55 }), /telegram edit down/)
  assert.deepEqual(wizard.messageIdByIndex, {})
})

test("finishQuestionWizard rethrows durability failures after accepted replies", async () => {
  const replyCalls = []
  const marked = []
  const deletedIdempotencyKeys = []
  const questionWizards = new Map()
  const awaitingCustomAnswer = new Map()
  const wizard = {
    projectAlias: "demo",
    sessionID: "ses_1",
    request: { id: "q_durable", questions: [{ header: "Reason", question: "Why?" }] },
    answers: [["because"]],
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  }
  const awaitingState = { projectAlias: "demo", requestId: "q_durable", qIndex: 0, sessionID: "ses_1" }
  questionWizards.set("demo:ses_1:q_durable", wizard)
  awaitingCustomAnswer.set("100:7", awaitingState)
  const { handlers } = makePromptRuntime({
    questionWizards,
    awaitingCustomAnswer,
    store: {
      markIdempotencyKey(key, metadata) {
        marked.push({ key, metadata })
        return true
      },
      deleteIdempotencyKey(key) {
        deletedIdempotencyKeys.push(key)
        return true
      },
      setQuestionWizard(key, currentWizard) {
        questionWizards.set(key, currentWizard)
      },
      deleteQuestionWizard() {},
      setAwaitingCustomAnswer(ctxKey, value) {
        awaitingCustomAnswer.set(ctxKey, value)
      },
      deleteAwaitingCustomAnswer(ctxKey) {
        awaitingCustomAnswer.delete(ctxKey)
      },
      async flush() {
        throw new Error("state write failed")
      },
    },
    ocByAlias: {
      demo: {
        async replyQuestion(questionId, answers) {
          replyCalls.push({ questionId, answers })
          return { ok: true }
        },
      },
    },
  })

  await assert.rejects(() => handlers.finishQuestionWizard(wizard, {
    idempotencyEntries: [{ key: "telegram-message:100:7:77", metadata: { kind: "telegram-message", operation: "replyQuestion" } }],
  }), (err) => {
    assert.equal(err.isBoundaryError, true)
    assert.equal(err.source, "state")
    assert.equal(err.outcome, "retryable")
    return true
  })

  assert.deepEqual(replyCalls, [{ questionId: "q_durable", answers: [["because"]] }])
  assert.equal(marked.length, 2)
  assert.equal(marked[1].key, "telegram-message:100:7:77")
  assert.deepEqual(deletedIdempotencyKeys, ["telegram-message:100:7:77"])
  assert.equal(questionWizards.get("demo:ses_1:q_durable"), wizard)
  assert.deepEqual(awaitingCustomAnswer.get("100:7"), awaitingState)
})

test("handleQuestionAsked does not baseline-suppress a first SSE prompt after Telegram delivery fails", async () => {
  let fail = true
  const request = {
    id: "q_self_baseline",
    sessionID: "ses_1",
    questions: [{ header: "Reason", question: "Why?", options: [{ label: "A" }] }],
  }
  const promptBaseline = { demo: { loaded: false, permission: new Set(), question: new Set() } }
  const { calls, runtime, handlers } = makePromptRuntime({
    promptBaseline,
    ocByAlias: {
      demo: {
        async listPermissions() {
          return []
        },
        async listQuestions() {
          return [request]
        },
      },
    },
    tg: {
      async sendMessage(...args) {
        calls.sendMessage.push(args)
        if (fail) {
          fail = false
          throw new Error("telegram step down")
        }
        return { message_id: 20 }
      },
    },
  })

  const input = { projectAlias: "demo", props: request, resolveBoundRoute: routeResolver, logSseDebug }

  await assert.rejects(() => handlers.handleQuestionAsked(input), /telegram step down/)
  assert.equal(runtime.promptBaseline.demo.question.has("ses_1:q_self_baseline"), false)
  assert.equal(runtime.prompted.demo.question.has("ses_1:q_self_baseline"), false)

  await handlers.handleQuestionAsked(input)
  assert.equal(calls.sendMessage.length, 2)
  assert.equal(runtime.prompted.demo.question.has("ses_1:q_self_baseline"), true)
})

test("restorePendingPromptState leaves permission recovery retryable when Telegram delivery fails", async () => {
  const prompted = {
    demo: { permission: new FakeLruSet(), question: new FakeLruSet() },
  }
  const pendingPrompts = {
    permissions: {
      "demo:perm_restore": {
        projectAlias: "demo",
        permissionId: "perm_restore",
        sessionID: "ses_1",
        permission: "shell",
        patterns: ["npm test"],
        ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      },
    },
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  }
  const recovery = createPromptRecovery({
    store: {
      getPendingPrompts: () => pendingPrompts,
      deletePendingPermission() {
        throw new Error("should not delete")
      },
    },
    ocByAlias: {
      demo: {
        async listPermissions() {
          return [{ id: "perm_restore", sessionID: "ses_1" }]
        },
        async listQuestions() {
          return []
        },
      },
    },
    prompted,
    questionWizards: new Map(),
    wizardKey: (projectAlias, requestId) => `${projectAlias}:${requestId}`,
    parseCtxKey: () => null,
    async sendPermissionPrompt() {
      throw new Error("telegram down")
    },
    async sendBlocksToThread() {},
    async sendCurrentQuestionStep() {},
    async sendRejectNotePrompt() {},
    async sendQuestionCustomAnswerPrompt() {},
    clearPersistedQuestionWizard() {},
    setRejectNoteAwaitingState() {},
    setAwaitingCustomAnswerState() {},
    markProjectUp() {},
  })

  const summary = await recovery.restorePendingPromptState()

  assert.equal(summary.permissions.restored, 0)
  assert.equal(summary.permissions.retryable, 1)
  assert.equal(prompted.demo.permission.has("perm_restore"), false)
  assert.deepEqual(pendingPrompts.permissions["demo:perm_restore"].permissionId, "perm_restore")
})

test("restorePendingPromptState treats same prompt ids in other sessions as stale", async () => {
  const deletedPermissions = []
  const deletedQuestions = []
  const pendingPrompts = {
    permissions: {
      "demo:ses_1:perm_same": {
        projectAlias: "demo",
        permissionId: "perm_same",
        sessionID: "ses_1",
        permission: "shell",
        patterns: [],
        ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      },
    },
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {
      "demo:ses_1:q_same": {
        projectAlias: "demo",
        id: "q_same",
        sessionID: "ses_1",
        request: { id: "q_same", sessionID: "ses_1", questions: [{ header: "Reason", question: "Why?", options: [] }] },
        index: 0,
        answers: [[]],
        selectedByIndex: {},
        ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      },
    },
  }
  const recovery = createPromptRecovery({
    store: {
      getPendingPrompts: () => pendingPrompts,
      deletePendingPermission(projectAlias, permissionId, sessionID) {
        deletedPermissions.push({ projectAlias, permissionId, sessionID })
        delete pendingPrompts.permissions["demo:ses_1:perm_same"]
      },
    },
    ocByAlias: {
      demo: {
        async listPermissions() {
          return [{ id: "perm_same", sessionID: "ses_2" }]
        },
        async listQuestions() {
          return [{ id: "q_same", sessionID: "ses_2", questions: [{ header: "Other", question: "Other?", options: [] }] }]
        },
      },
    },
    prompted: { demo: { permission: new FakeLruSet(), question: new FakeLruSet() } },
    questionWizards: new Map(),
    wizardKey: (projectAlias, requestId, sessionID = "") => (sessionID ? `${projectAlias}:${sessionID}:${requestId}` : `${projectAlias}:${requestId}`),
    parseCtxKey: () => ({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }),
    async sendPermissionPrompt() {
      throw new Error("should not restore permission")
    },
    async sendBlocksToThread() {
      throw new Error("should not restore question")
    },
    async sendCurrentQuestionStep() {},
    async sendRejectNotePrompt() {},
    async sendQuestionCustomAnswerPrompt() {},
    clearPersistedQuestionWizard(projectAlias, questionId, sessionID) {
      deletedQuestions.push({ projectAlias, questionId, sessionID })
      delete pendingPrompts.questionWizards["demo:ses_1:q_same"]
    },
    setRejectNoteAwaitingState() {},
    setAwaitingCustomAnswerState() {},
    markProjectUp() {},
  })

  const summary = await recovery.restorePendingPromptState()

  assert.deepEqual(deletedPermissions, [{ projectAlias: "demo", permissionId: "perm_same", sessionID: "ses_1" }])
  assert.deepEqual(deletedQuestions, [{ projectAlias: "demo", questionId: "q_same", sessionID: "ses_1" }])
  assert.equal(summary.permissions.stale, 1)
  assert.equal(summary.questionWizards.stale, 1)
})

test("restorePendingPromptState does not recover scoped custom answers from another session wizard", async () => {
  const awaitingChanges = []
  const questionWizards = new Map([
    [
      "demo:ses_2:q_same",
      {
        projectAlias: "demo",
        id: "q_same",
        sessionID: "ses_2",
        request: { id: "q_same", sessionID: "ses_2", questions: [{ header: "Other", question: "Other?", custom: true, options: [] }] },
      },
    ],
  ])
  const pendingPrompts = {
    permissions: {},
    rejectNotes: {},
    customAnswers: {
      "100:7": { projectAlias: "demo", requestId: "q_same", sessionID: "ses_1", qIndex: 0 },
    },
    questionWizards: {},
  }

  const recovery = createPromptRecovery({
    store: { getPendingPrompts: () => pendingPrompts },
    ocByAlias: {
      demo: {
        async listPermissions() {
          return []
        },
        async listQuestions() {
          return [{ id: "q_same", sessionID: "ses_1", questions: [{ header: "Expected", question: "Expected?", custom: true, options: [] }] }]
        },
      },
    },
    prompted: { demo: { permission: new FakeLruSet(), question: new FakeLruSet() } },
    questionWizards,
    wizardKey: (projectAlias, requestId, sessionID = "") => (sessionID ? `${projectAlias}:${sessionID}:${requestId}` : `${projectAlias}:${requestId}`),
    parseCtxKey: () => ({ chatId: 100, threadIdOr0: 7, ctxKey: "100:7" }),
    async sendPermissionPrompt() {},
    async sendBlocksToThread() {},
    async sendCurrentQuestionStep() {},
    async sendRejectNotePrompt() {},
    async sendQuestionCustomAnswerPrompt() {
      throw new Error("should not resume with a wizard from another session")
    },
    clearPersistedQuestionWizard() {},
    setRejectNoteAwaitingState() {},
    setAwaitingCustomAnswerState(ctxKey, value) {
      awaitingChanges.push({ ctxKey, value })
      if (value == null) delete pendingPrompts.customAnswers[ctxKey]
    },
    markProjectUp() {},
  })

  const summary = await recovery.restorePendingPromptState()

  assert.deepEqual(awaitingChanges, [{ ctxKey: "100:7", value: null }])
  assert.equal(summary.customAnswers.stale, 1)
})
