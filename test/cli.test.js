import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createShutdownHandler, isCliEntrypoint, runCli } from "../src/cli.js"

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
