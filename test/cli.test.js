import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createShutdownHandler, isCliEntrypoint, runCli, safeErrorText } from "../src/cli.js"

const indexPath = fileURLToPath(new URL("../index.mjs", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url))

function makeProcessStub() {
  const handlers = []
  return {
    handlers,
    on(event, handler) {
      handlers.push({ event, handler })
    },
  }
}

test("createShutdownHandler exits non-zero when connector stop fails during normal shutdown", async () => {
  const exits = []
  const errors = []
  const shutdown = createShutdownHandler({
    stopConnectorRef: {
      async current() {
        throw new Error("shutdown write failed")
      },
    },
    exit: (code) => exits.push(code),
    stderr: (...args) => errors.push(args.join(" ")),
  })

  await shutdown(0, { reason: "SIGTERM" })

  assert.deepEqual(exits, [1])
  assert.match(errors.join("\n"), /Failed to stop connector cleanly:/)
  assert.match(errors.join("\n"), /shutdown write failed/)
})

test("isCliEntrypoint recognizes direct and PM2 fork entrypoints", () => {
  assert.equal(isCliEntrypoint({ argv: ["node", cliPath], env: {} }), true)
  assert.equal(isCliEntrypoint({ argv: ["node", "ProcessContainerFork.js"], env: { pm_exec_path: cliPath } }), true)
  assert.equal(isCliEntrypoint({ argv: ["node", "ProcessContainerFork.js"], env: { pm_exec_path: "C:\\other\\app.js" } }), false)
})

test("index.mjs reuses the CLI entrypoint behavior", () => {
  const cliRun = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" })
  const indexRun = spawnSync(process.execPath, [indexPath, "--help"], { encoding: "utf8" })

  assert.equal(cliRun.status, 0)
  assert.equal(indexRun.status, 0)
  assert.equal(indexRun.stdout, cliRun.stdout)
  assert.equal(indexRun.stderr, cliRun.stderr)
})

test("runCli wires signal handlers and preserves fatal exit codes", async () => {
  const exits = []
  const errors = []
  const processStub = makeProcessStub()
  await runCli({
    argv: [],
    processImpl: processStub,
    stdout: () => {},
    stderr: (...args) => errors.push(args.join(" ")),
    exit: (code) => exits.push(code),
    buildRuntimeConfigImpl: async () => ({ config: { stateFile: "state.json" } }),
    startConnectorImpl: async () => ({
      stateFile: "state.json",
      async stop() {
        throw new Error("fatal stop failed")
      },
    }),
  })

  const rejectionHandler = processStub.handlers.find((entry) => entry.event === "unhandledRejection")?.handler
  assert.equal(typeof rejectionHandler, "function")
  rejectionHandler(new Error("boom"))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(exits, [1])
  assert.match(errors.join("\n"), /Unhandled promise rejection:/)
  assert.match(errors.join("\n"), /Fatal runtime failure \(unhandledRejection\)/)
  assert.match(errors.join("\n"), /fatal stop failed/)
})

test("runCli emits JSON fatal logs in JSON log mode", async () => {
  const exits = []
  const errors = []
  const processStub = makeProcessStub()
  await runCli({
    argv: [],
    processImpl: processStub,
    stdout: () => {},
    stderr: (line) => errors.push(line),
    exit: (code) => exits.push(code),
    buildRuntimeConfigImpl: async () => ({ config: { stateFile: "state.json", logFormat: "json" } }),
    startConnectorImpl: async () => ({
      stateFile: "state.json",
      async stop() {},
    }),
  })

  const exceptionHandler = processStub.handlers.find((entry) => entry.event === "uncaughtException")?.handler
  exceptionHandler(new Error("boom"))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(exits, [1])
  assert.ok(errors.length >= 2)
  const entries = errors.map((line) => JSON.parse(line))
  assert.equal(entries[0].level, "error")
  assert.equal(entries[0].msg, "Uncaught exception")
  assert.match(entries[0].error, /boom/)
  assert.equal(entries[1].msg, "Fatal runtime failure (uncaughtException). Run the connector under a supervisor (systemd, Docker restart policy, pm2, launchd, etc.) so fatal crashes restart automatically.")
})

test("runCli emits JSON startup failures after config is loaded", async () => {
  const errors = []
  const token = "5555555555:AABBCCDDEEFFaabbccddeeff12345678"
  await assert.rejects(
    () => runCli({
      argv: [],
      processImpl: makeProcessStub(),
      stdout: () => {},
      stderr: (line) => errors.push(line),
      exit: () => {},
      buildRuntimeConfigImpl: async () => ({ config: { stateFile: "state.json", logFormat: "json" } }),
      startConnectorImpl: async () => {
        const err = new Error(`failed with /bot${token}`)
        err.stack = `Error: failed with /bot${token}`
        throw err
      },
    }),
    /failed/,
  )

  assert.equal(errors.length, 1)
  const entry = JSON.parse(errors[0])
  assert.equal(entry.msg, "Connector startup failed")
  assert.match(entry.error, /\/bot\*\*\*/)
  assert.doesNotMatch(entry.error, new RegExp(token))
})

test("safeErrorText redacts bot tokens and sensitive paths from error stacks", () => {
  const token = "5555555555:AABBCCDDEEFFaabbccddeeff12345678"
  const err = new Error("connect failed")
  err.stack = `Error: connect failed at /bot${token}\n    at fake:1:1`
  const result = safeErrorText(err)
  assert.ok(!result.includes(token), "token must be redacted from stack")
  assert.match(result, /\/bot\*\*\*/)

  const pathErr = { message: "could not read C:\\Users\\user\\.data\\state.json" }
  const pathResult = safeErrorText(pathErr)
  assert.match(pathResult, /<state-file>/)
  assert.ok(!pathResult.includes("state.json"), "state path must be redacted")
})

test("safeErrorText falls back to message when stack is unavailable", () => {
  const token = "1111111111:TESTTOKENABCD"
  const result = safeErrorText({ message: `failed with /bot${token}` })
  assert.ok(!result.includes(token), "token must be redacted from message")
  assert.match(result, /\/bot\*\*\*/)
})

test("runCli exposes runtime stop and restart shutdown requests", async () => {
  async function runAction(action) {
    const exits = []
    let stopCalls = 0
    let requestRuntimeShutdown

    await runCli({
      argv: [],
      processImpl: makeProcessStub(),
      stdout: () => {},
      stderr: () => {},
      exit: (code) => exits.push(code),
      buildRuntimeConfigImpl: async () => ({ config: { stateFile: "state.json" } }),
      startConnectorImpl: async ({ deps }) => {
        requestRuntimeShutdown = deps.requestRuntimeShutdown
        return {
          stateFile: "state.json",
          async stop() {
            stopCalls += 1
          },
        }
      },
    })

    assert.equal(typeof requestRuntimeShutdown, "function")
    await requestRuntimeShutdown({ action })
    return { exits, stopCalls }
  }

  assert.deepEqual(await runAction("stop"), { exits: [0], stopCalls: 1 })
  assert.deepEqual(await runAction("restart"), { exits: [1], stopCalls: 1 })
})
