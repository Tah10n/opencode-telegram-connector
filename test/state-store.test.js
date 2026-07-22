import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import {
  DEFAULT_CALLBACK_PAYLOAD_MAX_ENTRIES,
  DEFAULT_FEED_MODE,
  DEFAULT_OUTBOX_MAX_AGE_MS,
  DEFAULT_OUTBOX_MAX_ENTRIES,
  DEFAULT_PROMPT_DELIVERY_MAX_AGE_MS,
  DEFAULT_PROMPT_DELIVERY_MAX_ENTRIES,
  DEFAULT_STATE_FILE_MODE,
  STATE_SCHEMA_VERSION,
  StateStore,
  defaultState,
  resolveDefaultStatePath,
} from "../src/state/store.js"

function makeLogger() {
  return { info() {}, warn() {}, error() {} }
}

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function makeOutboxItem(index, { createdAt = Date.now(), routeCtxKey = "100:7" } = {}) {
  const id = `out_${Number(index).toString(16).padStart(40, "0")}`
  return {
    id,
    type: "assistant-final",
    projectAlias: "demo",
    sessionId: "ses_1",
    boundSessionId: "ses_1",
    messageId: `msg_${index}`,
    route: { chatId: 100, threadIdOr0: 7, ctxKey: routeCtxKey },
    progress: {},
    attemptCount: 0,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }
}

function makePromptDelivery(index, { state = "outcome_unknown", updatedAt = Date.now(), lastError } = {}) {
  const openCodeMessageId = `msg_tgc_${Number(index).toString(16).padStart(48, "0")}`
  return {
    openCodeMessageId,
    promptHash: "a".repeat(64),
    state,
    kind: "text",
    projectAlias: "demo",
    sessionId: "ses_1",
    chatId: 100,
    threadIdOr0: 7,
    messageId: index + 1,
    updateId: index + 1,
    attemptCount: 1,
    ...(state === "outcome_unknown" ? { outcomeUnknownSince: updatedAt, reconcileNotFoundCount: 0 } : {}),
    createdAt: updatedAt,
    updatedAt,
    ...(lastError ? { lastError } : {}),
  }
}

test("StateStore exposes load and flush health", async () => {
  const dir = await makeTempDir()
  const store = new StateStore({ filePath: path.join(dir, "state.json"), logger: makeLogger() })

  assert.equal(store.healthSnapshot().loaded, false)

  await store.load()
  assert.equal(store.healthSnapshot().loaded, true)
  assert.equal(store.healthSnapshot().lastLoadError, "")

  store.setUpdateOffset(123)
  assert.equal(store.healthSnapshot().pendingSave, true)
  await store.flush()

  const healthy = store.healthSnapshot()
  assert.equal(healthy.pendingSave, false)
  assert.equal(healthy.flushInFlight, false)
  assert.equal(healthy.lastFlushOk, true)
  assert.equal(healthy.lastFlushError, "")
  assert.ok(healthy.lastFlushAt > 0)
})

test("StateStore reports in-flight flush health", async () => {
  const dir = await makeTempDir()
  let writeStarted
  let finishWrite
  const started = new Promise((resolve) => {
    writeStarted = resolve
  })
  const finish = new Promise((resolve) => {
    finishWrite = resolve
  })
  const store = new StateStore({
    filePath: path.join(dir, "state.json"),
    logger: makeLogger(),
    writeJsonFileAtomicImpl: async () => {
      writeStarted()
      await finish
    },
  })

  await store.load()
  store.setUpdateOffset(123)
  const flush = store.flush()
  await started

  assert.equal(store.healthSnapshot().pendingSave, false)
  assert.equal(store.healthSnapshot().flushInFlight, true)

  finishWrite()
  await flush
  assert.equal(store.healthSnapshot().flushInFlight, false)
  assert.equal(store.healthSnapshot().lastFlushOk, true)
})

test("StateStore marks failed flushes unhealthy", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const store = new StateStore({
    filePath,
    logger: makeLogger(),
    writeJsonFileAtomicImpl: async () => {
      throw new Error(`disk full at ${filePath}.tmp.secret`)
    },
  })

  await store.load()
  await assert.rejects(() => store.flush(), /disk full/)

  const health = store.healthSnapshot()
  assert.equal(health.loaded, true)
  assert.equal(health.lastFlushOk, false)
  assert.match(health.lastFlushError, /disk full/)
  assert.doesNotMatch(health.lastFlushError, /telegram-connector-|state\.json/)
  assert.match(health.lastFlushError, /<state-file>/)
  assert.ok(health.lastFlushErrorAt > 0)
})

test("StateStore writes state with a restrictive default mode", async () => {
  const dir = await makeTempDir()
  let writeOptions = null
  const store = new StateStore({
    filePath: path.join(dir, "state.json"),
    logger: makeLogger(),
    writeJsonFileAtomicImpl: async (_filePath, _snapshot, options = {}) => {
      writeOptions = options
    },
  })

  await store.load()
  store.setUpdateOffset(123)
  await store.flush()

  assert.equal(writeOptions?.mode, DEFAULT_STATE_FILE_MODE)
})

test("StateStore preserves invalid state backups with a restrictive default mode", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, "null\n", "utf8")
  let backupOptions = null
  const store = new StateStore({
    filePath,
    logger: makeLogger(),
    createStateFileBackupImpl: async (_filePath, options = {}) => {
      backupOptions = options
      return path.join(dir, "backup.json")
    },
  })

  await assert.rejects(() => store.load(), /state must be an object/)

  assert.equal(backupOptions?.mode, DEFAULT_STATE_FILE_MODE)
})

test("StateStore redacts load health errors", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "bad\u0000state.json")
  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load())

  const health = store.healthSnapshot()
  assert.equal(health.loaded, false)
  assert.doesNotMatch(health.lastLoadError, /telegram-connector-|state\.json/)
})

test("StateStore moves an existing session binding to the new context", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("1:0", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 1, threadIdOr0: 0 })
  const result = store.setBinding("2:7", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 2, threadIdOr0: 7 })

  assert.equal(store.getBinding("1:0"), null)
  assert.deepEqual(store.getBinding("2:7"), { projectAlias: "demo", sessionId: "ses_1" })
  assert.deepEqual(store.get().sessionIndex["demo:ses_1"], { chatId: 2, threadIdOr0: 7 })
  assert.deepEqual(result, { movedFromCtxKey: "1:0", movedFromRoute: { chatId: 1, threadIdOr0: 0 } })
})

test("StateStore ignores stale session index routes when moving bindings", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.state.bindings = {
    "1:0": { projectAlias: "demo", sessionId: "ses_other" },
  }
  store.state.sessionIndex = {
    "demo:ses_1": { chatId: 1, threadIdOr0: 0 },
    "demo:ses_other": { chatId: 1, threadIdOr0: 0 },
  }

  const result = store.setBinding("2:7", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 2, threadIdOr0: 7 })

  assert.deepEqual(result, { movedFromCtxKey: "", movedFromRoute: null })
  assert.deepEqual(store.getBinding("1:0"), { projectAlias: "demo", sessionId: "ses_other" })
  assert.deepEqual(store.getBinding("2:7"), { projectAlias: "demo", sessionId: "ses_1" })
  assert.deepEqual(store.get().sessionIndex["demo:ses_1"], { chatId: 2, threadIdOr0: 7 })
})

test("StateStore repairBindingIndex supports dry-run previews and repairs stale indexes", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  let saves = 0
  store.scheduleSave = () => {
    saves += 1
  }
  store.state.bindings = {
    "100:0": { projectAlias: "demo", sessionId: "ses_main" },
    "100:7": { projectAlias: "demo", sessionId: "ses_topic" },
  }
  store.state.sessionIndex = {
    "demo:ses_main": { chatId: 999, threadIdOr0: 0 },
    "demo:ghost": { chatId: 1, threadIdOr0: 1 },
  }

  const preview = store.repairBindingIndex({ dryRun: true })

  assert.equal(preview.changed, true)
  assert.equal(preview.rebuiltIndexEntries, 2)
  assert.deepEqual(preview.removedIndexEntries, ["demo:ghost"])
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_main": { chatId: 999, threadIdOr0: 0 },
    "demo:ghost": { chatId: 1, threadIdOr0: 1 },
  })
  assert.equal(saves, 0)

  const repaired = store.repairBindingIndex()

  assert.equal(repaired.changed, true)
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_main": { chatId: 100, threadIdOr0: 0 },
    "demo:ses_topic": { chatId: 100, threadIdOr0: 7 },
  })
  assert.equal(saves, 1)
})

test("StateStore repairBindingIndex removes duplicate and malformed bindings", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}
  store.state.bindings = {
    "bad-key": { projectAlias: "demo", sessionId: "ses_bad" },
    "100:0": { projectAlias: "demo", sessionId: "ses_1" },
    "100:7": { projectAlias: "demo", sessionId: "ses_1" },
  }
  store.state.modelPrefsByContext = {
    "bad-key": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" } },
    "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-4" } },
  }

  const summary = store.repairBindingIndex()

  assert.equal(summary.changed, true)
  assert.deepEqual([...summary.removedBindings].sort(), ["100:7", "bad-key"].sort())
  assert.deepEqual(summary.conflicts, [{ sessionKey: "demo:ses_1", keptCtxKey: "100:0", removedCtxKey: "100:7" }])
  assert.deepEqual(store.get().bindings, {
    "100:0": { projectAlias: "demo", sessionId: "ses_1" },
  })
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_1": { chatId: 100, threadIdOr0: 0 },
  })
  assert.equal(store.get().modelPrefsByContext["bad-key"], undefined)
  assert.equal(store.get().modelPrefsByContext["100:7"], undefined)
})

test("StateStore repairBindingIndex preserves the indexed route when duplicate bindings exist", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}
  store.state.bindings = {
    "100:0": { projectAlias: "demo", sessionId: "ses_1" },
    "100:7": { projectAlias: "demo", sessionId: "ses_1" },
  }
  store.state.sessionIndex = {
    "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
  }

  const summary = store.repairBindingIndex()

  assert.equal(summary.changed, true)
  assert.deepEqual(summary.removedBindings, ["100:0"])
  assert.deepEqual(summary.conflicts, [{ sessionKey: "demo:ses_1", keptCtxKey: "100:7", removedCtxKey: "100:0" }])
  assert.deepEqual(store.get().bindings, {
    "100:7": { projectAlias: "demo", sessionId: "ses_1" },
  })
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
  })
})

test("StateStore replaces previous context binding and unbind clears the session index", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("1:0", { projectAlias: "demo", sessionId: "ses_old" }, { chatId: 1, threadIdOr0: 0 })
  store.setBinding("1:0", { projectAlias: "demo", sessionId: "ses_new" }, { chatId: 1, threadIdOr0: 0 })

  assert.equal(store.get().sessionIndex["demo:ses_old"], undefined)
  assert.deepEqual(store.get().sessionIndex["demo:ses_new"], { chatId: 1, threadIdOr0: 0 })
  assert.equal(store.unbind("1:0"), true)
  assert.equal(store.unbind("1:0"), false)
  assert.deepEqual(store.get().bindings, {})
  assert.deepEqual(store.get().sessionIndex, {})
})

test("StateStore keeps multiple topics in the same chat isolated", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("100:0", { projectAlias: "demo", sessionId: "ses_main" }, { chatId: 100, threadIdOr0: 0 })
  store.setBinding("100:11", { projectAlias: "demo", sessionId: "ses_topic" }, { chatId: 100, threadIdOr0: 11 })

  assert.deepEqual(store.getBinding("100:0"), { projectAlias: "demo", sessionId: "ses_main" })
  assert.deepEqual(store.getBinding("100:11"), { projectAlias: "demo", sessionId: "ses_topic" })
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_main": { chatId: 100, threadIdOr0: 0 },
    "demo:ses_topic": { chatId: 100, threadIdOr0: 11 },
  })
})

test("StateStore unbind removes only the targeted topic binding", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("100:7", { projectAlias: "demo", sessionId: "ses_alpha" }, { chatId: 100, threadIdOr0: 7 })
  store.setBinding("100:9", { projectAlias: "demo", sessionId: "ses_beta" }, { chatId: 100, threadIdOr0: 9 })

  assert.equal(store.unbind("100:7"), true)
  assert.equal(store.getBinding("100:7"), null)
  assert.deepEqual(store.getBinding("100:9"), { projectAlias: "demo", sessionId: "ses_beta" })
  assert.deepEqual(store.get().sessionIndex, {
    "demo:ses_beta": { chatId: 100, threadIdOr0: 9 },
  })
})

test("StateStore persists pending prompt recovery state", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setPendingPermission({
    projectAlias: "demo",
    permissionId: "perm_1",
    sessionID: "ses_1",
    permission: "shell",
    patterns: ["npm test"],
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    createdAt: 1,
  })
  store.setRejectNoteAwaiting("100:7", { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1" })
  store.setAwaitingCustomAnswer("100:7", { projectAlias: "demo", requestId: "q_1", sessionID: "ses_1", qIndex: 0 })
  store.setQuestionWizard("demo:ses_1:q_1", {
    projectAlias: "demo",
    id: "q_1",
    request: {
      id: "q_1",
      questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }],
    },
    sessionID: "ses_1",
    index: 0,
    answers: [[]],
    selectedByIndex: {},
    createdAt: 2,
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  })

  assert.deepEqual(store.getPendingPrompts().permissions, {
    "demo:ses_1:perm_1": {
      projectAlias: "demo",
      permissionId: "perm_1",
      sessionID: "ses_1",
      permission: "shell",
      patterns: ["npm test"],
      ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
      createdAt: 1,
    },
  })
  assert.deepEqual(store.getPendingPrompts().rejectNotes, {
    "100:7": { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1" },
  })
  assert.deepEqual(store.getPendingPrompts().customAnswers, {
    "100:7": { projectAlias: "demo", requestId: "q_1", sessionID: "ses_1", qIndex: 0 },
  })
  assert.deepEqual(store.getPendingPrompts().questionWizards, {
    "demo:ses_1:q_1": {
      projectAlias: "demo",
      id: "q_1",
      sessionID: "ses_1",
      request: {
        id: "q_1",
        questions: [{ header: "Reason", question: "Why?", custom: true, options: [] }],
      },
      index: 0,
      answers: [[]],
      selectedByIndex: {},
      createdAt: 2,
      ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
    },
  })

  assert.equal(store.deletePendingPermission("demo", "perm_1", "ses_1"), true)
  assert.equal(store.deleteRejectNoteAwaiting("100:7"), true)
  assert.equal(store.deleteAwaitingCustomAnswer("100:7"), true)
  assert.equal(store.deleteQuestionWizard("demo:ses_1:q_1"), true)
  assert.deepEqual(store.getPendingPrompts(), {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
})

test("StateStore keeps sessionless pending permission lookup and cleanup exact", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setPendingPermission({
    projectAlias: "demo",
    permissionId: "perm_same",
    sessionID: "ses_1",
    permission: "shell",
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  })

  assert.equal(store.getPendingPermission("demo", "perm_same"), null)
  assert.equal(store.deletePendingPermission("demo", "perm_same"), false)
  assert.equal(store.getPendingPermission("demo", "perm_same", "ses_1")?.sessionID, "ses_1")

  store.setPendingPermission({
    projectAlias: "demo",
    permissionId: "perm_same",
    permission: "shell",
    ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" },
  })

  assert.equal(store.getPendingPermission("demo", "perm_same")?.sessionID, "")
  assert.equal(store.deletePendingPermission("demo", "perm_same"), true)
  assert.equal(store.getPendingPermission("demo", "perm_same"), null)
  assert.equal(store.getPendingPermission("demo", "perm_same", "ses_1")?.sessionID, "ses_1")
})

test("StateStore keeps feed mode per context and defaults to main+changes", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  assert.equal(store.getFeedMode("100:7"), DEFAULT_FEED_MODE)
  store.setFeedMode("100:7", "main")
  store.setFeedMode("100:9", "verbose")

  assert.equal(store.getFeedMode("100:7"), "main")
  assert.equal(store.getFeedMode("100:9"), "verbose")
  assert.deepEqual(store.get().feedByContext, {
    "100:7": { mode: "main" },
    "100:9": { mode: "verbose" },
  })
})

test("StateStore keeps locale per context and preserves manual choices", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  assert.equal(store.getLocale("100:7"), "")
  assert.equal(store.noteTelegramLocale("100:7", "ru-RU"), true)
  assert.deepEqual(store.getLocaleRecord("100:7"), { locale: "ru", source: "telegram" })

  assert.equal(store.setLocale("100:7", "en", { source: "manual" }), true)
  assert.deepEqual(store.getLocaleRecord("100:7"), { locale: "en", source: "manual" })
  assert.equal(store.noteTelegramLocale("100:7", "ru"), false)
  assert.deepEqual(store.getLocaleRecord("100:7"), { locale: "en", source: "manual" })

  assert.equal(store.clearLocale("100:7"), true)
  assert.equal(store.getLocale("100:7"), "")
})

test("StateStore keeps model preference per context and clears it on project rebind/unbind", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("100:7", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 100, threadIdOr0: 7 })
  store.setBinding("100:9", { projectAlias: "demo", sessionId: "ses_2" }, { chatId: 100, threadIdOr0: 9 })
  store.setModelPreference("100:7", { mode: "custom", model: "openai/gpt-5", variant: "xhigh" })
  store.setModelPreference("100:9", { mode: "project-default" })

  assert.deepEqual(store.getModelPreference("100:7"), {
    mode: "custom",
    model: { providerID: "openai", modelID: "gpt-5" },
    variant: "xhigh",
  })
  assert.deepEqual(store.getModelPreference("100:9"), { mode: "project-default" })

  store.setBinding("100:7", { projectAlias: "demo", sessionId: "ses_3" }, { chatId: 100, threadIdOr0: 7 })
  assert.equal(store.getModelPreference("100:7").mode, "custom")

  store.setBinding("100:7", { projectAlias: "other", sessionId: "ses_4" }, { chatId: 100, threadIdOr0: 7 })
  assert.deepEqual(store.getModelPreference("100:7"), { mode: "inherit" })

  assert.equal(store.unbind("100:9"), true)
  assert.deepEqual(store.getModelPreference("100:9"), { mode: "inherit" })
})

test("StateStore persists and prunes idempotency ledger entries", async () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  assert.equal(store.hasIdempotencyKey("permission-reply:demo:perm_1:once"), false)
  assert.equal(store.markIdempotencyKey("permission-reply:demo:perm_1:once", {
    kind: "permission-reply",
    projectAlias: "demo",
    ctxKey: "100:7",
    operation: "replyPermission",
    action: "once",
    createdAt: 10,
  }), true)
  assert.equal(store.hasIdempotencyKey("permission-reply:demo:perm_1:once"), true)
  assert.equal(store.deleteIdempotencyKey("permission-reply:demo:perm_1:once"), true)
  assert.equal(store.hasIdempotencyKey("permission-reply:demo:perm_1:once"), false)
  assert.equal(store.deleteIdempotencyKey("permission-reply:demo:perm_1:once"), false)
  assert.equal(store.markIdempotencyKey("permission-reply:demo:perm_1:once", {
    kind: "permission-reply",
    projectAlias: "demo",
    ctxKey: "100:7",
    operation: "replyPermission",
    action: "once",
    createdAt: 10,
  }), true)
  assert.equal(store.pruneIdempotency({ now: 20, maxAgeMs: 5 }), 1)
  assert.equal(store.hasIdempotencyKey("permission-reply:demo:perm_1:once"), false)
})

test("StateStore persists and prunes callback payload entries", async () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  assert.equal(store.setCallbackPayload("token_a", "payload-a", { createdAt: 10, expiresAt: 100 }), true)
  assert.equal(store.getCallbackPayload("token_a", { now: 20 }), "payload-a")
  assert.deepEqual(store.getCallbackPayloadRecord("token_a", { now: 20 }), {
    data: "payload-a",
    createdAt: 10,
    expiresAt: 100,
  })
  assert.equal(store.deleteCallbackPayload("token_a"), true)
  assert.equal(store.getCallbackPayload("token_a", { now: 20 }), null)
  assert.equal(store.deleteCallbackPayload("token_a"), false)

  store.setCallbackPayload("token_a", "payload-a", { createdAt: 10, expiresAt: 100 })
  store.setCallbackPayload("token_b", "payload-b", { createdAt: 20, expiresAt: 30 })
  assert.equal(store.pruneCallbackPayloads({ now: 40 }), 1)
  assert.equal(store.getCallbackPayload("token_a", { now: 40 }), "payload-a")
  assert.equal(store.getCallbackPayload("token_b", { now: 40 }), null)

  store.setCallbackPayload("token_b", "payload-b", { createdAt: 20, expiresAt: 100 })
  store.setCallbackPayload("token_c", "payload-c", { createdAt: 30, expiresAt: 100 })
  assert.equal(store.pruneCallbackPayloads({ now: 40, maxEntries: 2 }), 1)
  assert.deepEqual(Object.keys(store.get().callbackPayloads).sort(), ["token_b", "token_c"])
})

test("StateStore keeps callback payloads within the cap when inserting at the limit", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}
  for (let i = 0; i < DEFAULT_CALLBACK_PAYLOAD_MAX_ENTRIES; i += 1) {
    store.get().callbackPayloads[`token_${i}`] = {
      data: `payload-${i}`,
      createdAt: i + 1,
      expiresAt: 100_000,
    }
  }

  assert.equal(store.setCallbackPayload("token_new", "payload-new", { createdAt: 50_000, expiresAt: 100_000 }), true)

  assert.equal(Object.keys(store.get().callbackPayloads).length, DEFAULT_CALLBACK_PAYLOAD_MAX_ENTRIES)
  assert.equal(store.getCallbackPayload("token_new", { now: 50_001 }), "payload-new")
  assert.equal(store.getCallbackPayload("token_0", { now: 50_001 }), null)
})

test("StateStore keeps current-schema expired callback payloads visible for prune and flush", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        ...defaultState(),
        updateOffset: 1,
        callbackPayloads: {
          expired_token: { data: "expired", createdAt: 1, expiresAt: 2 },
          live_token: { data: "live", createdAt: 10, expiresAt: Date.now() + 60_000 },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.deepEqual(Object.keys(loaded.callbackPayloads).sort(), ["expired_token", "live_token"])
  assert.equal(store.pruneCallbackPayloads({ now: Date.now() }), 1)
  await store.flush()

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.deepEqual(Object.keys(persisted.callbackPayloads), ["live_token"])
})

test("StateStore persists and clears pending runtime online notices", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const store = new StateStore({ filePath, logger: makeLogger() })

  assert.equal(store.getPendingRuntimeOnlineNotice(), null)
  assert.equal(store.setPendingRuntimeOnlineNotice({ kind: "restart", chatId: 42, createdAt: 123 }), true)
  await store.flush()

  const reloaded = new StateStore({ filePath, logger: makeLogger() })
  await reloaded.load()
  assert.deepEqual(reloaded.getPendingRuntimeOnlineNotice(), { kind: "restart", chatId: 42, createdAt: 123 })

  assert.equal(reloaded.clearPendingRuntimeOnlineNotice(), true)
  await reloaded.flush()

  const cleared = new StateStore({ filePath, logger: makeLogger() })
  await cleared.load()
  assert.equal(cleared.getPendingRuntimeOnlineNotice(), null)
})

test("StateStore bounds and deterministically expires durable outbox entries", () => {
  const now = Date.now()
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-outbox-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  assert.equal(store.setOutboxItem(makeOutboxItem(1, { createdAt: now - 2000 }), { maxEntries: 2 }), true)
  assert.equal(store.setOutboxItem(makeOutboxItem(2, { createdAt: now }), { maxEntries: 2 }), true)
  assert.equal(store.setOutboxItem(makeOutboxItem(3, { createdAt: now }), { maxEntries: 2 }), false)
  assert.equal(Object.keys(store.getOutboxItems()).length, 2)

  assert.equal(store.pruneOutbox({ now, maxAgeMs: 1000 }), 1)
  assert.deepEqual(Object.keys(store.getOutboxItems()), [makeOutboxItem(2).id])
  assert.equal(DEFAULT_OUTBOX_MAX_ENTRIES, 2000)
  assert.equal(DEFAULT_OUTBOX_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000)
})

test("StateStore never evicts unresolved prompt markers and applies backpressure at the cap", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-prompt-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}
  const records = store.get().promptDeliveries.records
  for (let index = 0; index < DEFAULT_PROMPT_DELIVERY_MAX_ENTRIES; index += 1) {
    const entry = makePromptDelivery(index, { updatedAt: index + 1 })
    records[entry.openCodeMessageId] = entry
  }

  const extra = makePromptDelivery(DEFAULT_PROMPT_DELIVERY_MAX_ENTRIES, { updatedAt: Date.now() })
  assert.equal(store.setPromptDelivery(extra.openCodeMessageId, extra), false)
  assert.equal(Object.keys(records).length, DEFAULT_PROMPT_DELIVERY_MAX_ENTRIES)
  assert.equal(records[extra.openCodeMessageId], undefined)

  assert.equal(store.prunePromptDeliveries({ now: Date.now(), maxAgeMs: 1, maxEntries: 1 }), 0)
  assert.equal(Object.keys(records).length, DEFAULT_PROMPT_DELIVERY_MAX_ENTRIES)
})

test("StateStore expires accepted prompt markers on load but retains unresolved markers", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const updatedAt = Date.now() - DEFAULT_PROMPT_DELIVERY_MAX_AGE_MS - 1
  const accepted = makePromptDelivery(1, { state: "accepted", updatedAt })
  const unknown = makePromptDelivery(2, { state: "outcome_unknown", updatedAt })
  await fs.writeFile(filePath, JSON.stringify({
    ...defaultState(),
    promptDeliveries: { records: { [accepted.openCodeMessageId]: accepted, [unknown.openCodeMessageId]: unknown } },
  }), "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.promptDeliveries.records[accepted.openCodeMessageId], undefined)
  assert.deepEqual(loaded.promptDeliveries.records[unknown.openCodeMessageId], unknown)
})

test("StateStore migrates schema version 1 state to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 1, updateOffset: 77, bindings: { "1:0": { projectAlias: "demo", sessionId: "ses_1" } }, sessionIndex: { "demo:ses_1": { chatId: 1, threadIdOr0: 0 } } }, null, 2),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 77)
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
  assert.equal(loaded.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(loaded.idempotency, { keys: {} })
  assert.deepEqual(loaded.callbackPayloads, {})
  assert.deepEqual(loaded.promptDeliveries, { records: {} })
  assert.deepEqual(loaded.outbox, { items: {} })
})

test("StateStore migrates schema version 2 state to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 2,
        updateOffset: 88,
        bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
        sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 88)
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.bindings, { "100:7": { projectAlias: "demo", sessionId: "ses_1" } })
  assert.equal(loaded.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(loaded.idempotency, { keys: {} })
  assert.deepEqual(loaded.callbackPayloads, {})
})

test("StateStore migrates schema version 3 state to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 3,
        updateOffset: 99,
        bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
        sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
        feedByContext: { "100:7": { mode: "verbose" } },
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 99)
  assert.deepEqual(loaded.feedByContext, { "100:7": { mode: "verbose" } })
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.equal(loaded.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(loaded.idempotency, { keys: {} })
  assert.deepEqual(loaded.callbackPayloads, {})
})

test("StateStore migrates schema version 4 state to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 4,
        updateOffset: 100,
        bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
        sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
        feedByContext: { "100:7": { mode: "main" } },
        modelPrefsByContext: { "100:7": { mode: "project-default" } },
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 100)
  assert.deepEqual(loaded.feedByContext, { "100:7": { mode: "main" } })
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, { "100:7": { mode: "project-default" } })
  assert.equal(loaded.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(loaded.idempotency, { keys: {} })
  assert.deepEqual(loaded.callbackPayloads, {})
})

test("StateStore migrates schema version 5 state to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 5,
        updateOffset: 111,
        bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
        sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
        feedByContext: { "100:7": { mode: "main" } },
        modelPrefsByContext: { "100:7": { mode: "project-default" } },
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
        pendingRuntimeOnlineNotice: null,
        idempotency: { keys: {} },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.feedByContext, { "100:7": { mode: "main" } })
  assert.deepEqual(loaded.modelPrefsByContext, { "100:7": { mode: "project-default" } })
  assert.deepEqual(loaded.callbackPayloads, {})
})

test("StateStore migrates schema version 6 callback payloads to version 8", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const future = Date.now() + 60_000
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 6,
        updateOffset: 112,
        bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_1" } },
        sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 7 } },
        feedByContext: { "100:7": { mode: "main" } },
        localeByContext: { "100:7": { locale: "en", source: "manual" } },
        modelPrefsByContext: { "100:7": { mode: "project-default" } },
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
        pendingRuntimeOnlineNotice: null,
        idempotency: { keys: {} },
        callbackPayloads: {
          kept_token: { data: "[\"b\",\"confirm-unbind\",\"100:7\"]", createdAt: 10, expiresAt: future },
          expired_token: { data: "expired", createdAt: 10, expiresAt: 11 },
          "bad token": { data: "bad", createdAt: 10, expiresAt: future },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.deepEqual(loaded.callbackPayloads, {
    kept_token: { data: "[\"b\",\"confirm-unbind\",\"100:7\"]", createdAt: 10, expiresAt: future },
  })
})

test("StateStore migrates schema version 7 to version 8 with empty prompt delivery and outbox sections", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const previous = { ...defaultState(), schemaVersion: 7, updateOffset: 114 }
  delete previous.promptDeliveries
  delete previous.outbox
  await fs.writeFile(filePath, JSON.stringify(previous, null, 2), "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, 8)
  assert.equal(loaded.updateOffset, 114)
  assert.deepEqual(loaded.promptDeliveries, { records: {} })
  assert.deepEqual(loaded.outbox, { items: {} })
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.deepEqual(persisted.outbox, { items: {} })
})

test("StateStore fails closed on a corrupted current-schema outbox section", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const item = makeOutboxItem(9, { routeCtxKey: "999:0" })
  await fs.writeFile(filePath, JSON.stringify({ ...defaultState(), updateOffset: 115, outbox: { items: { [item.id]: item } } }, null, 2), "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })
  await assert.rejects(() => store.load(), (err) => {
    assert.equal(err.code, "STATE_SCHEMA_INVALID")
    assert.match(err.message, /state\.outbox\.items.*route\.ctxKey must match/)
    return true
  })

  assert.deepEqual(store.get().outbox, { items: {} })
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".invalid."))
  assert.equal(backups.length, 1)
})

test("StateStore migration rebuilds binding routes and drops context sections that fail current validation", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 4,
        updateOffset: 112,
        bindings: {
          "bad-key": { projectAlias: "demo", sessionId: "ses_bad" },
          "100:7": { projectAlias: "demo", sessionId: "ses_1" },
          "200:0": { projectAlias: "demo", sessionId: "ses_rebuild" },
        },
        sessionIndex: {
          "demo:ses_bad": { chatId: 999, threadIdOr0: 9 },
          "demo:ses_1": { chatId: 999, threadIdOr0: 9 },
          "demo:ses_rebuild": { chatId: 200, threadIdOr0: -1 },
          "demo:ses_orphan": { chatId: 300, threadIdOr0: 0 },
          "demo:ses_float": { chatId: 1.5, threadIdOr0: 0 },
          "demo:ses_negative": { chatId: 100, threadIdOr0: -1 },
        },
        feedByContext: {
          "bad-key": { mode: "verbose" },
          "100:7": { mode: "main" },
        },
        modelPrefsByContext: {
          "bad-key": { mode: "project-default" },
          "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
        },
        pendingPrompts: {
          permissions: {},
          rejectNotes: { "bad-key": { projectAlias: "demo", permissionId: "perm_1" } },
          customAnswers: { "bad-key": { projectAlias: "demo", requestId: "q_1", qIndex: 0 } },
          questionWizards: {},
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.deepEqual(loaded.bindings, {
    "100:7": { projectAlias: "demo", sessionId: "ses_1" },
    "200:0": { projectAlias: "demo", sessionId: "ses_rebuild" },
  })
  assert.deepEqual(loaded.sessionIndex, {
    "demo:ses_1": { chatId: 100, threadIdOr0: 7 },
    "demo:ses_rebuild": { chatId: 200, threadIdOr0: 0 },
  })
  assert.deepEqual(loaded.feedByContext, { "100:7": { mode: "main" } })
  assert.deepEqual(loaded.modelPrefsByContext, {
    "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
  })
  assert.deepEqual(loaded.pendingPrompts.rejectNotes, {})
  assert.deepEqual(loaded.pendingPrompts.customAnswers, {})
})

test("StateStore rejects schema version 8 state with inconsistent binding routes", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        updateOffset: 113,
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_1" },
          "200:0": { projectAlias: "demo", sessionId: "ses_2" },
        },
        sessionIndex: {
          "demo:ses_1": { chatId: 100, threadIdOr0: 8 },
          "demo:ses_orphan": { chatId: 300, threadIdOr0: 0 },
        },
        feedByContext: {},
        localeByContext: {},
        modelPrefsByContext: {},
        pendingPrompts: { permissions: {}, rejectNotes: {}, customAnswers: {}, questionWizards: {} },
        pendingRuntimeOnlineNotice: null,
        idempotency: { keys: {} },
        callbackPayloads: {},
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), (err) => {
    assert.equal(err.code, "STATE_SCHEMA_INVALID")
    assert.ok(err.errors.some((entry) => entry.includes('state.sessionIndex["demo:ses_1"] must route to state.bindings["100:7"]')), err.errors.join("\n"))
    assert.ok(err.errors.some((entry) => entry.includes('state.sessionIndex["demo:ses_2"] is missing for state.bindings["200:0"]')), err.errors.join("\n"))
    assert.ok(err.errors.some((entry) => entry.includes('state.sessionIndex["demo:ses_orphan"] must reference a matching state.bindings["300:0"]')), err.errors.join("\n"))
    return true
  })
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".invalid."))
  assert.equal(backups.length, 1)
})

test("StateStore rejects malformed schema version 8 sections with actionable paths", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        updateOffset: 101,
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_1", extra: true },
          "bad:1": { projectAlias: "demo" },
          "bad:2": null,
        },
        sessionIndex: {
          "demo:ses_1": { chatId: 100, threadIdOr0: 7, extra: true },
          "demo:bad": { chatId: "100", threadIdOr0: 7 },
        },
        feedByContext: {
          "100:7": { mode: "verbose" },
          "100:9": { mode: "nonsense" },
          "": { mode: "main" },
        },
        localeByContext: {
          "100:7": { locale: "ru", source: "telegram" },
          "100:8": { locale: "de", source: "manual" },
        },
        modelPrefsByContext: {
          "100:7": { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "xhigh" },
          "100:9": { mode: "custom", model: null },
        },
        pendingPrompts: {
          permissions: {
            valid: { projectAlias: "demo", permissionId: "perm_1", sessionID: "ses_1", ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" } },
            invalid: { projectAlias: "demo" },
          },
          rejectNotes: { "100:7": { projectAlias: "demo", permissionId: "perm_1" }, bad: { projectAlias: "demo" } },
          customAnswers: { "100:7": { projectAlias: "demo", requestId: "q_1", qIndex: 0 }, bad: { projectAlias: "demo" } },
          questionWizards: {
            valid: { projectAlias: "demo", id: "q_1", sessionID: "ses_1", request: { id: "q_1", questions: [] }, ctx: { chatId: 100, threadIdOr0: 7, ctxKey: "100:7" } },
            invalid: { id: "missing_project" },
          },
        },
        idempotency: { keys: { "tg-update:1": { createdAt: 10 }, "": { createdAt: 11 } } },
        callbackPayloads: {
          valid_token: { data: "payload", createdAt: 10, expiresAt: 20 },
          "bad token": { data: "payload", createdAt: 10, expiresAt: 20 },
          " trimmed_token ": { data: "payload", createdAt: 10, expiresAt: 20 },
          missingData: { createdAt: 10, expiresAt: 20 },
        },
        promptDeliveries: { records: {} },
        outbox: { items: {} },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), (err) => {
    assert.equal(err.code, "STATE_SCHEMA_INVALID")
    assert.match(err.message, /state\.bindings\["bad:1"\]\.sessionId/)
    assert.match(err.message, /state\.sessionIndex\["demo:bad"\]\.chatId/)
    assert.match(err.message, /Restore a known-good state backup/)
    return true
  })
  assert.deepEqual(store.get(), defaultState())
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".invalid."))
  assert.equal(backups.length, 1)
  assert.match(await fs.readFile(path.join(dir, backups[0]), "utf8"), /bad:1/)
})

test("StateStore rejects callback payload tokens with surrounding whitespace", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        ...defaultState(),
        updateOffset: 101,
        callbackPayloads: {
          " trimmed_token ": { data: "payload", createdAt: 10, expiresAt: 20 },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), (err) => {
    assert.equal(err.code, "STATE_SCHEMA_INVALID")
    assert.match(err.message, /state\.callbackPayloads\[" trimmed_token "\] key/)
    return true
  })
})

test("StateStore rejects unsafe persisted session identities", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        updateOffset: 101,
        bindings: {
          "100:0": { projectAlias: "demo", sessionId: " ses_1 " },
          "100:1": { projectAlias: "demo:prod", sessionId: "ses_2" },
          "100:2": { projectAlias: "demo", sessionId: "bad/id" },
        },
        sessionIndex: {
          "demo:ses_1": { chatId: 100, threadIdOr0: 0 },
          "demo:prod:ses_2": { chatId: 100, threadIdOr0: 1 },
        },
        feedByContext: {},
        localeByContext: {},
        modelPrefsByContext: {},
        pendingPrompts: {
          permissions: {
            unsafe: { projectAlias: "demo", permissionId: "perm_1", sessionID: "bad id", ctx: { chatId: 100, threadIdOr0: 0, ctxKey: "100:0" } },
          },
          rejectNotes: {},
          customAnswers: {},
          questionWizards: {},
        },
        pendingRuntimeOnlineNotice: null,
        idempotency: { keys: {} },
        callbackPayloads: {},
      },
      null,
      2,
    ),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), (err) => {
    assert.equal(err.code, "STATE_SCHEMA_INVALID")
    assert.match(err.message, /state\.bindings\["100:0"\]\.sessionId/)
    assert.match(err.message, /state\.bindings\["100:1"\]\.projectAlias/)
    assert.match(err.message, /pipe/)
    assert.match(err.message, /state\.sessionIndex\["demo:prod:ses_2"\] key/)
    assert.ok(err.errors.some((entry) => /state\.pendingPrompts\.permissions\["unsafe"\]\.sessionID/.test(entry)), err.errors.join("\n"))
    return true
  })
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".invalid."))
  assert.equal(backups.length, 1)
})

test("StateStore migrates legacy state and flush persists the new schema", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify({ telegram: { updateOffset: 123 }, opencode: { directory: "C:/repo" } }, null, 2),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 123)
  assert.deepEqual(loaded.bindings, {})
  assert.deepEqual(loaded.sessionIndex, {})
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.localeByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
  assert.equal(loaded.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(loaded.idempotency, { keys: {} })

  store.scheduleSave = () => {}
  store.setBinding("42:0", { projectAlias: "demo", sessionId: "ses_9" }, { chatId: 42, threadIdOr0: 0 })
  store.setUpdateOffset(456)
  await store.flush()

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(persisted.updateOffset, 456)
  assert.deepEqual(persisted.bindings, {
    "42:0": { projectAlias: "demo", sessionId: "ses_9" },
  })
  assert.deepEqual(persisted.sessionIndex, {
    "demo:ses_9": { chatId: 42, threadIdOr0: 0 },
  })
  assert.deepEqual(persisted.feedByContext, {})
  assert.deepEqual(persisted.localeByContext, {})
  assert.deepEqual(persisted.modelPrefsByContext, {})
  assert.deepEqual(persisted.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
  assert.equal(persisted.pendingRuntimeOnlineNotice, null)
  assert.deepEqual(persisted.idempotency, { keys: {} })
})

test("StateStore creates a bounded backup before schema migration", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 4, updateOffset: 222, bindings: {}, sessionIndex: {}, feedByContext: {}, modelPrefsByContext: {}, pendingPrompts: {}, idempotency: {} }, null, 2),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger(), backupMaxFiles: 2 })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(loaded.updateOffset, 222)
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".migration."))
  assert.equal(backups.length, 1)
  const backup = JSON.parse(await fs.readFile(path.join(dir, backups[0]), "utf8"))
  assert.equal(backup.schemaVersion, 4)
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION)
})

test("StateStore rejects unknown schema versions and preserves the file", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 999, updateOffset: 1 }, null, 2), "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), /schemaVersion is unsupported \(999\)/)
  const current = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.equal(current.schemaVersion, 999)
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".invalid."))
  assert.equal(backups.length, 1)
})

test("StateStore migration rollback keeps the original file when migrated flush fails", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const original = { schemaVersion: 4, updateOffset: 333, bindings: {}, sessionIndex: {}, feedByContext: {}, modelPrefsByContext: {}, pendingPrompts: {}, idempotency: {} }
  await fs.writeFile(filePath, JSON.stringify(original, null, 2), "utf8")
  const writeErr = new Error("migration write failed")
  let writeCalls = 0

  const store = new StateStore({
    filePath,
    logger: makeLogger(),
    writeJsonFileAtomicImpl: async () => {
      writeCalls += 1
      throw writeErr
    },
  })

  await assert.rejects(() => store.load(), /migration write failed/)
  assert.equal(writeCalls, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), original)
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup.") && name.includes(".migration."))
  assert.equal(backups.length, 1)
  assert.equal(store.get().schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(store.get().updateOffset, null)
})

test("StateStore load fails closed on corrupt persisted state", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, "{not-json", "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })

  await assert.rejects(() => store.load(), /JSON/)
  assert.equal(store.get().updateOffset, null)
  assert.deepEqual(store.get().bindings, {})
})

test("StateStore recovers an emergency bak instead of silently resetting missing state", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const backupPath = `${filePath}.bak.123456.abcdef123456`
  const saved = {
    ...defaultState(),
    updateOffset: 777,
    bindings: { "100:0": { projectAlias: "demo", sessionId: "ses_1" } },
    sessionIndex: { "demo:ses_1": { chatId: 100, threadIdOr0: 0 } },
  }
  await fs.writeFile(backupPath, JSON.stringify(saved, null, 2), "utf8")

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.updateOffset, 777)
  assert.deepEqual(loaded.bindings, saved.bindings)
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), saved)
})

test("StateStore flush rejects write failures", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "bad\u0000state.json")
  const store = new StateStore({ filePath, logger: makeLogger() })
  store.setUpdateOffset(123)

  await assert.rejects(() => store.flush())
})

test("StateStore scheduled save logs write failures", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const writeErr = new Error("scheduled write failed")
  const errors = []
  let resolveLogged
  let logTimeout
  const logged = new Promise((resolve, reject) => {
    resolveLogged = resolve
    logTimeout = setTimeout(() => reject(new Error("timed out waiting for scheduled save error log")), 500)
  })
  const logger = {
    ...makeLogger(),
    error(...args) {
      errors.push(args)
      resolveLogged()
    },
  }
  let writeCalls = 0
  const store = new StateStore({
    filePath,
    logger,
    writeJsonFileAtomicImpl: async () => {
      writeCalls += 1
      throw writeErr
    },
  })

  store.state.updateOffset = 123
  store.scheduleSave(0)
  await logged
  clearTimeout(logTimeout)

  assert.equal(writeCalls, 1)
  assert.equal(errors.length, 1)
  assert.deepEqual(errors[0], ["Failed to write state:", "scheduled write failed"])
})

test("resolveDefaultStatePath appends .data/state.json to the cwd", () => {
  const cwd = path.join("workspace", "demo")
  assert.equal(resolveDefaultStatePath({ cwd }), path.resolve(cwd, ".data", "state.json"))
})
