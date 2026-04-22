import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import process from "node:process"
import { createRequire, syncBuiltinESMExports } from "node:module"
import {
  ensureOpenCodeRunning,
  killProcessWindows,
  openAttachContinueWindowWindows,
  openAttachWindowWindows,
  startOpenCodeInNewWindowWindows,
  startOpenCodeServeDetached,
  startOpenCodeServeInNewWindowWindows,
  waitForHealth,
} from "../src/opencode/launcher.js"

const require = createRequire(import.meta.url)
const childProcess = require("node:child_process")
const timersPromises = require("node:timers/promises")

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function usePatchedDelay(t, impl) {
  const previous = timersPromises.setTimeout
  timersPromises.setTimeout = impl
  syncBuiltinESMExports()
  t.after(() => {
    timersPromises.setTimeout = previous
    syncBuiltinESMExports()
  })
}

function usePatchedDateNow(t, impl) {
  const previous = Date.now
  Date.now = impl
  t.after(() => {
    Date.now = previous
  })
}

function usePatchedProcessKill(t, impl) {
  const previous = process.kill
  process.kill = impl
  t.after(() => {
    process.kill = previous
  })
}

function usePatchedPlatform(t, value) {
  const previous = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", {
    value,
    enumerable: previous?.enumerable ?? true,
    configurable: true,
    writable: false,
  })
  t.after(() => {
    Object.defineProperty(process, "platform", previous)
  })
}

function useSpawnPlans(t, plans) {
  const previous = childProcess.spawn
  const calls = []
  childProcess.spawn = (command, args = [], options = {}) => {
    const plan = plans.shift() || {}
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = plan.pid ?? null
    child.killCalls = 0
    child.kill = () => {
      child.killCalls += 1
      plan.onKill?.(child)
    }
    child.unrefCalled = false
    child.unref = () => {
      child.unrefCalled = true
    }

    calls.push({ command, args, options, child })

    queueMicrotask(() => {
      for (const chunk of [].concat(plan.stdout ?? [])) {
        child.stdout.emit("data", Buffer.from(String(chunk)))
      }
      for (const chunk of [].concat(plan.stderr ?? [])) {
        child.stderr.emit("data", Buffer.from(String(chunk)))
      }
      if (plan.error) {
        child.emit("error", plan.error)
        return
      }
      if (plan.close !== false) child.emit("close", plan.code ?? 0)
    })

    return child
  }
  syncBuiltinESMExports()
  t.after(() => {
    childProcess.spawn = previous
    syncBuiltinESMExports()
  })
  return calls
}

function makeLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] }
  return {
    logs,
    info(message) {
      logs.info.push(String(message))
    },
    warn(message) {
      logs.warn.push(String(message))
    },
    error(message) {
      logs.error.push(String(message))
    },
    debug(message) {
      logs.debug.push(String(message))
    },
  }
}

function sequenceHealth(steps) {
  const queue = [...steps]
  return {
    async health() {
      const step = queue.length > 1 ? queue.shift() : queue[0]
      if (step instanceof Error) throw step
      return step
    },
  }
}

test("waitForHealth retries until health becomes available", async (t) => {
  usePatchedDelay(t, async () => {})

  let calls = 0
  const ocClient = {
    async health() {
      calls += 1
      if (calls < 3) throw new Error("not ready")
      return { version: "0.1.0" }
    },
  }

  const result = await waitForHealth(ocClient, { timeoutMs: 1000 })
  assert.deepEqual(result, { version: "0.1.0" })
  assert.equal(calls, 3)
})

test("waitForHealth times out with the last error in the message", async (t) => {
  usePatchedDelay(t, async () => {})

  const ticks = [0, 1, 1000, 2000]
  usePatchedDateNow(t, () => ticks.shift() ?? 2000)

  const logger = makeLogger()
  await assert.rejects(
    waitForHealth(
      {
        async health() {
          throw new Error("connection refused")
        },
      },
      { timeoutMs: 1200, logger, projectAlias: "demo" },
    ),
    (err) => {
      assert.match(err.message, /Timed out waiting for health \(1s\)\./)
      assert.match(err.message, /Last error: connection refused/)
      return true
    },
  )
  assert.equal(logger.logs.error.length, 1)
  assert.match(logger.logs.error[0], /^\[demo\] Timed out waiting for health/)
})

test("startOpenCodeServeInNewWindowWindows normalizes style and enables debug flags", async (t) => {
  swapEnv(t, { OPENCODE_SERVER_DEBUG: "yes" })
  const calls = useSpawnPlans(t, [{ stdout: "321\n" }])

  const result = await startOpenCodeServeInNewWindowWindows({
    directory: "C:\\repo",
    port: 4312,
    windowStyle: "Bogus",
  })

  assert.equal(result.pid, 321)
  assert.equal(calls[0].command, "powershell")
  assert.match(calls[0].args[3], /-WindowStyle Minimized/)
  assert.match(calls[0].args[3], /--print-logs/)
  assert.match(calls[0].args[3], /--log-level/)
  assert.match(calls[0].args[3], /DEBUG/)
})

test("startOpenCodeServeInNewWindowWindows includes stderr in launch failures", async (t) => {
  useSpawnPlans(t, [{ stderr: "boom", code: 9 }])

  await assert.rejects(
    startOpenCodeServeInNewWindowWindows({ directory: "C:\\repo", port: 4312 }),
    /Failed to Start-Process opencode serve \(code=9\): boom/,
  )
})

test("startOpenCodeInNewWindowWindows launches attach mode and returns the spawned pid", async (t) => {
  const calls = useSpawnPlans(t, [{ stdout: "55\n" }])

  const result = await startOpenCodeInNewWindowWindows({ directory: "C:\\repo", port: 4312 })

  assert.equal(result.pid, 55)
  assert.equal(calls[0].command, "powershell")
  assert.match(calls[0].args[3], /Start-Process -PassThru/)
  assert.match(calls[0].args[3], /--continue/)
  assert.match(calls[0].args[3], /'C:\\repo'/)
})

test("openAttachWindowWindows rejects sensitive base URLs unless explicitly allowed", async () => {
  await assert.rejects(
    openAttachWindowWindows({
      directory: "C:\\repo",
      baseUrl: "http://127.0.0.1:4312?token=abc",
      sessionId: "ses_1",
    }),
    /Refusing to open opencode attach window/,
  )
})

test("openAttachWindowWindows allows sensitive base URLs with an override", async (t) => {
  swapEnv(t, { OPENCODE_ALLOW_SENSITIVE_BASEURL: "1" })
  const calls = useSpawnPlans(t, [{ code: 0 }])

  await openAttachWindowWindows({
    directory: "C:\\repo",
    baseUrl: "http://127.0.0.1:4312?token=abc",
    sessionId: "ses_1",
  })

  assert.equal(calls[0].command, "powershell")
  assert.match(calls[0].args[3], /attach/)
  assert.match(calls[0].args[3], /--session/)
  assert.match(calls[0].args[3], /ses_1/)
})

test("openAttachContinueWindowWindows rejects sensitive base URLs unless explicitly allowed", async () => {
  await assert.rejects(
    openAttachContinueWindowWindows({
      directory: "C:\\repo",
      baseUrl: "http://127.0.0.1:4312?token=abc",
    }),
    /Refusing to open opencode attach window/,
  )
})

test("openAttachContinueWindowWindows keeps the console open and passes --dir", async (t) => {
  const calls = useSpawnPlans(t, [{ code: 0 }])

  await openAttachContinueWindowWindows({
    directory: "C:\\repo",
    baseUrl: "http://127.0.0.1:4312",
  })

  assert.equal(calls[0].command, "powershell")
  assert.match(calls[0].args[3], /Start-Process -WindowStyle Normal/)
  assert.match(calls[0].args[3], /'\/k'/)
  assert.match(calls[0].args[3], /--continue/)
  assert.match(calls[0].args[3], /--dir/)
  assert.match(calls[0].args[3], /'C:\\repo'/)
})

test("killProcessWindows shells out to taskkill and ignores launcher errors", async (t) => {
  const calls = useSpawnPlans(t, [{ error: new Error("taskkill missing") }])

  await killProcessWindows(123)

  assert.equal(calls[0].command, "taskkill")
  assert.deepEqual(calls[0].args, ["/PID", "123", "/T", "/F"])
})

test("startOpenCodeServeDetached spawns a detached server process and unreferences it", (t) => {
  const calls = useSpawnPlans(t, [{ pid: 222, close: false }])

  const { child } = startOpenCodeServeDetached({ directory: "C:\\repo", port: 4312 })

  assert.equal(child.pid, 222)
  assert.equal(calls[0].command, "opencode")
  assert.deepEqual(calls[0].args, ["serve", "--port", "4312"])
  assert.equal(calls[0].options.cwd, "C:\\repo")
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].child.unrefCalled, true)
})

test("ensureOpenCodeRunning returns early when the project is already healthy", async () => {
  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: { startMode: "serve" },
    ocClient: { health: async () => ({ ok: true }) },
    logger: makeLogger(),
  })

  assert.equal(result.started, false)
  assert.equal(result.pid, null)
  assert.equal(typeof result.stop, "function")
})

test("ensureOpenCodeRunning reports disabled auto-start clearly", async () => {
  await assert.rejects(
    ensureOpenCodeRunning({
      projectAlias: "demo",
      project: { autoStart: false, startMode: "serve" },
      ocClient: { health: async () => Promise.reject(new Error("down")) },
      logger: makeLogger(),
    }),
    /Project 'demo' is down and autoStart=false/,
  )
})

test("ensureOpenCodeRunning validates auto-start configuration before launching", async () => {
  await assert.rejects(
    ensureOpenCodeRunning({
      projectAlias: "demo",
      project: { autoStart: true, startMode: "serve", port: 4312 },
      ocClient: { health: async () => Promise.reject(new Error("down")) },
      logger: makeLogger(),
    }),
    /Project 'demo' missing directory\/port for autoStart/,
  )
})

test("ensureOpenCodeRunning detects an existing TUI and does not open another one", async (t) => {
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify({
        ProcessId: 42,
        CommandLine: 'C:\\\\tools\\\\opencode.cmd attach "http://127.0.0.1:4312" --continue',
      }),
    },
  ])
  const logger = makeLogger()

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      startMode: "tui",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient: { health: async () => ({ healthy: true }) },
    logger,
  })

  assert.equal(result.started, false)
  assert.equal(calls.length, 1)
  assert.equal(logger.logs.info.length, 1)
  assert.match(logger.logs.info[0], /opencode UI already running for port=4312/)
  assert.equal(logger.logs.debug.length, 1)
  assert.match(logger.logs.debug[0], /opencode UI cmdline:/)
})

test("ensureOpenCodeRunning skips auto-open when process detection falls back and the baseUrl is sensitive", async (t) => {
  const calls = useSpawnPlans(t, [{ stdout: "not-json" }])
  const logger = makeLogger()

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      startMode: "tui",
      directory: "C:\\repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312?token=abc",
    },
    ocClient: { health: async () => ({ healthy: true }) },
    logger,
  })

  assert.equal(result.started, false)
  assert.equal(calls.length, 1)
  assert.equal(logger.logs.warn.length, 1)
  assert.match(logger.logs.warn[0], /baseUrl contains sensitive URL parts/)
})

test("ensureOpenCodeRunning waits for a running TUI to bring the server back", async (t) => {
  usePatchedDelay(t, async () => {})
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify([
        {
          ProcessId: 24,
          CommandLine: "opencode attach http://127.0.0.1:4312 --continue",
        },
      ]),
    },
  ])

  let healthCalls = 0
  const ocClient = {
    async health() {
      healthCalls += 1
      if (healthCalls === 1) throw new Error("down")
      return { healthy: true }
    },
  }

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      startMode: "tui",
      directory: "C:\\repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient,
    logger: makeLogger(),
  })

  assert.equal(result.started, false)
  assert.equal(calls.length, 1)
  assert.equal(healthCalls, 3)
})

test("ensureOpenCodeRunning starts headless serve mode on Windows and returns a stop handle", async (t) => {
  usePatchedDelay(t, async () => {})
  usePatchedProcessKill(t, () => {
    throw new Error("missing pid")
  })
  const calls = useSpawnPlans(t, [{ stdout: "900\n" }, { code: 0 }])
  const logger = makeLogger()

  let healthCalls = 0
  const ocClient = {
    async health() {
      healthCalls += 1
      if (healthCalls === 1) throw new Error("down")
      return { version: "1.2.3" }
    },
  }

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      startMode: "serve",
      directory: "C:\\repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient,
    logger,
  })

  assert.equal(result.started, true)
  assert.equal(result.pid, 900)
  assert.equal(healthCalls, 2)
  assert.equal(calls.length, 1)
  assert.equal(logger.logs.error.length, 1)
  assert.match(logger.logs.error[0], /opencode serve exited immediately/)
  assert.match(logger.logs.info.at(-1), /started opencode \(serve\) pid=900 port=4312/)

  await result.stop()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, "taskkill")
  assert.deepEqual(calls[1].args, ["/PID", "900", "/T", "/F"])
})

test("ensureOpenCodeRunning refuses TUI auto-start on non-Windows platforms", async (t) => {
  usePatchedPlatform(t, "linux")

  await assert.rejects(
    ensureOpenCodeRunning({
      projectAlias: "demo",
      project: {
        autoStart: true,
        startMode: "tui",
        directory: "/repo",
        port: 4312,
      },
      ocClient: { health: async () => Promise.reject(new Error("down")) },
      logger: makeLogger(),
    }),
    /autoStart startMode=tui is currently supported only on Windows/,
  )
})

test("ensureOpenCodeRunning starts detached serve mode on non-Windows platforms", async (t) => {
  usePatchedPlatform(t, "linux")
  const calls = useSpawnPlans(t, [{ pid: 777, close: false }])
  const killCalls = []
  usePatchedProcessKill(t, (...args) => {
    killCalls.push(args)
  })

  let healthCalls = 0
  const ocClient = {
    async health() {
      healthCalls += 1
      if (healthCalls === 1) throw new Error("down")
      return { ok: true }
    },
  }

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      startMode: "serve",
      directory: "/repo",
      port: 4312,
    },
    ocClient,
    logger: makeLogger(),
  })

  assert.equal(result.started, true)
  assert.equal(result.pid, 777)
  assert.equal(calls[0].command, "opencode")
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].child.unrefCalled, true)

  await result.stop()
  assert.deepEqual(killCalls, [[777, "SIGTERM"]])
})
