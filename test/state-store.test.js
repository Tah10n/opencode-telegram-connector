import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { DEFAULT_FEED_MODE, StateStore, resolveDefaultStatePath } from "../src/state/store.js"

function makeLogger() {
  return { info() {}, warn() {}, error() {} }
}

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("StateStore moves an existing session binding to the new context", () => {
  const store = new StateStore({ filePath: path.join(os.tmpdir(), "unused-state.json"), logger: makeLogger() })
  store.scheduleSave = () => {}

  store.setBinding("1:0", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 1, threadIdOr0: 0 })
  store.setBinding("2:7", { projectAlias: "demo", sessionId: "ses_1" }, { chatId: 2, threadIdOr0: 7 })

  assert.equal(store.getBinding("1:0"), null)
  assert.deepEqual(store.getBinding("2:7"), { projectAlias: "demo", sessionId: "ses_1" })
  assert.deepEqual(store.get().sessionIndex["demo:ses_1"], { chatId: 2, threadIdOr0: 7 })
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
  store.setRejectNoteAwaiting("100:7", { projectAlias: "demo", permissionId: "perm_1" })
  store.setAwaitingCustomAnswer("100:7", { projectAlias: "demo", requestId: "q_1", qIndex: 0 })
  store.setQuestionWizard("demo:q_1", {
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
    "demo:perm_1": {
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
    "100:7": { projectAlias: "demo", permissionId: "perm_1" },
  })
  assert.deepEqual(store.getPendingPrompts().customAnswers, {
    "100:7": { projectAlias: "demo", requestId: "q_1", qIndex: 0 },
  })
  assert.deepEqual(store.getPendingPrompts().questionWizards, {
    "demo:q_1": {
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

  assert.equal(store.deletePendingPermission("demo", "perm_1"), true)
  assert.equal(store.deleteRejectNoteAwaiting("100:7"), true)
  assert.equal(store.deleteAwaitingCustomAnswer("100:7"), true)
  assert.equal(store.deleteQuestionWizard("demo:q_1"), true)
  assert.deepEqual(store.getPendingPrompts(), {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
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

test("StateStore migrates schema version 1 state to version 4", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 1, updateOffset: 77, bindings: { "1:0": { projectAlias: "demo", sessionId: "ses_1" } }, sessionIndex: { "demo:ses_1": { chatId: 1, threadIdOr0: 0 } } }, null, 2),
    "utf8",
  )

  const store = new StateStore({ filePath, logger: makeLogger() })
  const loaded = await store.load()

  assert.equal(loaded.schemaVersion, 4)
  assert.equal(loaded.updateOffset, 77)
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
})

test("StateStore migrates schema version 2 state to version 4", async () => {
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

  assert.equal(loaded.schemaVersion, 4)
  assert.equal(loaded.updateOffset, 88)
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.bindings, { "100:7": { projectAlias: "demo", sessionId: "ses_1" } })
})

test("StateStore migrates schema version 3 state to version 4", async () => {
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

  assert.equal(loaded.schemaVersion, 4)
  assert.equal(loaded.updateOffset, 99)
  assert.deepEqual(loaded.feedByContext, { "100:7": { mode: "verbose" } })
  assert.deepEqual(loaded.modelPrefsByContext, {})
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

  assert.equal(loaded.schemaVersion, 4)
  assert.equal(loaded.updateOffset, 123)
  assert.deepEqual(loaded.bindings, {})
  assert.deepEqual(loaded.sessionIndex, {})
  assert.deepEqual(loaded.feedByContext, {})
  assert.deepEqual(loaded.modelPrefsByContext, {})
  assert.deepEqual(loaded.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })

  store.scheduleSave = () => {}
  store.setBinding("42:0", { projectAlias: "demo", sessionId: "ses_9" }, { chatId: 42, threadIdOr0: 0 })
  store.setUpdateOffset(456)
  await store.flush()

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.equal(persisted.schemaVersion, 4)
  assert.equal(persisted.updateOffset, 456)
  assert.deepEqual(persisted.bindings, {
    "42:0": { projectAlias: "demo", sessionId: "ses_9" },
  })
  assert.deepEqual(persisted.sessionIndex, {
    "demo:ses_9": { chatId: 42, threadIdOr0: 0 },
  })
  assert.deepEqual(persisted.feedByContext, {})
  assert.deepEqual(persisted.modelPrefsByContext, {})
  assert.deepEqual(persisted.pendingPrompts, {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  })
})

test("resolveDefaultStatePath appends .data/state.json to the cwd", () => {
  const cwd = path.join("workspace", "demo")
  assert.equal(resolveDefaultStatePath({ cwd }), path.resolve(cwd, ".data", "state.json"))
})
