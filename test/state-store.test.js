import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { StateStore, resolveDefaultStatePath } from "../src/state/store.js"

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

  assert.equal(loaded.schemaVersion, 1)
  assert.equal(loaded.updateOffset, 123)
  assert.deepEqual(loaded.bindings, {})
  assert.deepEqual(loaded.sessionIndex, {})

  store.scheduleSave = () => {}
  store.setBinding("42:0", { projectAlias: "demo", sessionId: "ses_9" }, { chatId: 42, threadIdOr0: 0 })
  store.setUpdateOffset(456)
  await store.flush()

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
  assert.equal(persisted.schemaVersion, 1)
  assert.equal(persisted.updateOffset, 456)
  assert.deepEqual(persisted.bindings, {
    "42:0": { projectAlias: "demo", sessionId: "ses_9" },
  })
  assert.deepEqual(persisted.sessionIndex, {
    "demo:ses_9": { chatId: 42, threadIdOr0: 0 },
  })
})

test("resolveDefaultStatePath appends .data/state.json to the cwd", () => {
  const cwd = path.join("workspace", "demo")
  assert.equal(resolveDefaultStatePath({ cwd }), path.resolve(cwd, ".data", "state.json"))
})
