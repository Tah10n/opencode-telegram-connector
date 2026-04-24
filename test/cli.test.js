import test from "node:test"
import assert from "node:assert/strict"
import { createShutdownHandler, runCli } from "../src/cli.js"

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
