import test from "node:test"
import assert from "node:assert/strict"
import { collectLoggerRedactionOptions, createConnectorLogger } from "../src/runtime/logger.js"
import { runWithRequestContext } from "../src/runtime/request-context.js"

test("collectLoggerRedactionOptions returns empty options for missing config", () => {
  assert.deepEqual(collectLoggerRedactionOptions(), { knownSecrets: [], sensitivePaths: [] })
  assert.deepEqual(collectLoggerRedactionOptions(null), { knownSecrets: [], sensitivePaths: [] })
})

test("collectLoggerRedactionOptions collects configured secrets and sensitive paths", () => {
  assert.deepEqual(
    collectLoggerRedactionOptions({
      telegram: { botToken: "123456789:replace_me" },
      stateFile: "C:\\tmp\\connector\\.data\\state.json",
      projects: {
        demo: { password: "basic-auth-secret" },
        emptyPassword: { password: "" },
        missingPassword: {},
        disabled: null,
      },
    }),
    {
      knownSecrets: ["123456789:replace_me", "basic-auth-secret"],
      sensitivePaths: [{ path: "C:\\tmp\\connector\\.data\\state.json", label: "state-file" }],
    },
  )
})

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

test("createConnectorLogger treats trailing non-plain objects as legacy message args", () => {
  class LegacyDetails {
    constructor() {
      this.safe = "ok"
      this.secret = "supersecret"
    }
  }

  const output = []
  const logger = createConnectorLogger({
    format: "json",
    knownSecrets: ["supersecret"],
    stdout: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.info("Legacy", new LegacyDetails())

  const entry = JSON.parse(output[0])
  assert.equal(entry.msg, 'Legacy {"safe":"ok","secret":"***"}')
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "safe"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "secret"), false)
  assert.doesNotMatch(output[0], /supersecret/)
})

test("createConnectorLogger serializes text fields and skips empty values", () => {
  const output = []
  const logger = createConnectorLogger({
    format: "text",
    stdout: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.info("Fields", {
    empty: "",
    none: null,
    zero: 0,
    disabled: false,
    nested: { ok: true },
  })

  assert.equal(output[0], '2026-04-25T00:00:00.000Z INFO Fields zero=0 disabled=false nested={"ok":true}')
})

test("createConnectorLogger handles empty messages and falls back to text format", () => {
  const output = []
  const logger = createConnectorLogger({
    format: "yaml",
    stdout: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  logger.debug()

  assert.equal(output[0], "2026-04-25T00:00:00.000Z DEBUG")
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

test("createConnectorLogger recursively sanitizes circular values, bigint, and boundary errors", () => {
  const output = []
  const logger = createConnectorLogger({
    format: "json",
    knownSecrets: ["123456789:replace_me", "basic-auth-secret"],
    sensitivePaths: [{ path: "C:\\tmp\\connector\\.data\\state.json", label: "state-file" }],
    stderr: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })
  const circular = {
    name: "root",
    botToken: "123456789:replace_me",
  }
  circular.self = circular
  circular.children = [
    {
      parent: circular,
      stateFile: "C:\\tmp\\connector\\.data\\state.json",
    },
  ]
  const boundaryError = {
    isBoundaryError: true,
    name: "BoundaryError",
    message: "failed with basic-auth-secret at C:\\tmp\\connector\\.data\\state.json",
    code: "E_basic-auth-secret",
    status: 429,
    kind: "retryable",
    outcome: "blocked",
    source: "123456789:replace_me",
    operation: "sendMessage",
    pathname: "C:\\tmp\\connector\\.data\\state.json",
    stack: "BoundaryError: failed\n    at C:\\tmp\\connector\\.data\\state.json:1:1",
  }

  logger.warn("Recursive", {
    circular,
    count: 42n,
    values: ["basic-auth-secret", 7n, { boundaryError }],
  })

  const entry = JSON.parse(output[0])
  assert.equal(entry.circular.botToken, "***")
  assert.equal(entry.circular.self, "[Circular]")
  assert.equal(entry.circular.children[0].parent, "[Circular]")
  assert.equal(entry.circular.children[0].stateFile, "<state-file>")
  assert.equal(entry.count, "42")
  assert.deepEqual(entry.values.slice(0, 2), ["***", "7"])
  assert.deepEqual(entry.values[2].boundaryError, {
    name: "BoundaryError",
    message: "failed with *** at <state-file>",
    code: "E_***",
    status: 429,
    kind: "retryable",
    outcome: "blocked",
    source: "***",
    operation: "sendMessage",
    pathname: "<state-file>",
    stack_redacted: true,
  })
  assert.doesNotMatch(output[0], /123456789:replace_me|basic-auth-secret|C:\\tmp/)
})

test("createConnectorLogger includes request context and child fields", async () => {
  const output = []
  const logger = createConnectorLogger({
    format: "json",
    stdout: (line) => output.push(line),
    now: () => "2026-04-25T00:00:00.000Z",
  })

  await runWithRequestContext({ correlationId: "corr_1", ctxKey: "10:0" }, async () => {
    const child = logger.child({ projectAlias: "demo", sessionId: "ses_1" })
    child.info("Scoped", { operation: "promptAsync", sessionId: "ses_override" })
  })

  const entry = JSON.parse(output[0])
  assert.equal(entry.msg, "Scoped")
  assert.equal(entry.correlationId, "corr_1")
  assert.equal(entry.ctxKey, "10:0")
  assert.equal(entry.projectAlias, "demo")
  assert.equal(entry.sessionId, "ses_override")
  assert.equal(entry.operation, "promptAsync")
})
