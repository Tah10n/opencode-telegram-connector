import test from "node:test"
import assert from "node:assert/strict"
import { createConnectorLogger } from "../src/runtime/logger.js"

test("createConnectorLogger emits redacted structured JSON logs", () => {
  const stdout = []
  const stderr = []
  const logger = createConnectorLogger({
    format: "json",
    knownSecrets: ["123456789:replace_me", "supersecret"],
    sensitivePaths: [{ path: "C:\\tmp\\connector\\.data\\state.json", label: "state-file" }],
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.warn("Delivery failed", {
    projectAlias: "demo",
    sessionId: "ses_1",
    url: "https://user:pass@example.test/path?token=abc#frag",
    botToken: "123456789:replace_me",
    stateFile: "C:\\tmp\\connector\\.data\\state.json",
    error: new Error("Authorization: Basic abc supersecret"),
  })

  assert.equal(stdout.length, 0)
  assert.equal(stderr.length, 1)
  const entry = JSON.parse(stderr[0])
  assert.equal(entry.ts, "2026-04-25T00:00:00.000Z")
  assert.equal(entry.level, "warn")
  assert.equal(entry.msg, "Delivery failed")
  assert.equal(entry.projectAlias, "demo")
  assert.equal(entry.sessionId, "ses_1")
  const serialized = JSON.stringify(entry)
  assert.match(serialized, /token=\*\*\*/)
  assert.match(serialized, /<state-file>/)
  assert.doesNotMatch(serialized, /user|pass|abc supersecret|123456789:replace_me|C:\\tmp|frag/)
})

test("createConnectorLogger keeps legacy text logs redacted", () => {
  const stdout = []
  const logger = createConnectorLogger({
    format: "text",
    knownSecrets: ["123456789:replace_me"],
    stdout: (line) => stdout.push(line),
    stderr: (line) => stdout.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.info("State:", "C:\\work\\.data\\state.json", "token", "123456789:replace_me")

  assert.equal(stdout.length, 1)
  assert.match(stdout[0], /^2026-04-25T00:00:00\.000Z INFO State:/)
  assert.match(stdout[0], /<state-file>/)
  assert.doesNotMatch(stdout[0], /123456789:replace_me|C:\\work/)
})

test("createConnectorLogger preserves field names while redacting only values", () => {
  const output = []
  const logger = createConnectorLogger({
    format: "json",
    knownSecrets: ["123456789:replace_me"],
    sensitivePaths: [{ path: "C:\\tmp\\connector\\.data\\state.json", label: "state-file" }],
    stderr: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.warn("Event", {
    botToken: "123456789:replace_me",
    stateFile: "C:\\tmp\\connector\\.data\\state.json",
    info: "safe-value",
  })

  const entry = JSON.parse(output[0])
  assert.equal(entry.botToken, "***")
  assert.equal(entry.info, "safe-value")
  assert.match(output[0], /"stateFile":"<state-file>"/)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "botToken"), true)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "stateFile"), true)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "info"), true)
  assert.match(output[0], /"botToken":"\*\*\*"/)
})

test("createConnectorLogger marks omitted error stacks", () => {
  const output = []
  const logger = createConnectorLogger({
    format: "json",
    stderr: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })
  const err = new Error("boom")
  err.stack = "Error: boom\n    at C:\\work\\project\\.data\\state.json:1:1"

  logger.error("Failed", { error: err })

  const entry = JSON.parse(output[0])
  assert.equal(entry.error.message, "boom")
  assert.equal(entry.error.stack_redacted, true)
  assert.equal(Object.prototype.hasOwnProperty.call(entry.error, "stack"), false)
})
