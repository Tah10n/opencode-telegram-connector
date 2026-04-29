import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import process from "node:process"
import { createRequire, syncBuiltinESMExports } from "node:module"
import {
  ensureOpenCodeRunning,
  getLaunchSupport,
  killProcessWindows,
  openAttachContinueWindow,
  openAttachContinueWindowWindows,
  openAttachWindow,
  openAttachWindowWindows,
  startOpenCodeInNewWindowWindows,
  startOpenCodeServeDetached,
  startOpenCodeServeInNewWindowWindows,
  stopOpenCodeServeOnPort,
  stopOpenCodeUiOnPort,
  waitForHealth,
} from "../src/opencode/launcher.js"

const require = createRequire(import.meta.url)
const childProcess = require("node:child_process")
const fsSync = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const timersPromises = require("node:timers/promises")

const WINDOWS_CMD_METACHARS = ["&", "|", ">", "<", "^", "%", '"']

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
      if (plan.spawn !== false) {
        child.emit("spawn")
        plan.onSpawn?.({ command, args, options, child })
      }
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

function makeFakeLauncherDir(t, ...names) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "telegram-connector-launcher-"))
  for (const name of names) {
    fsSync.writeFileSync(path.join(dir, name), "")
  }
  t.after(() => {
    fsSync.rmSync(dir, { recursive: true, force: true })
  })
  return dir
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

test("waitForHealth aborts promptly when abortSignal is triggered", async () => {
  const abortController = new AbortController()
  let calls = 0

  const promise = waitForHealth(
    {
      async health() {
        calls += 1
        throw new Error("still starting")
      },
    },
    { timeoutMs: 10_000, abortSignal: abortController.signal },
  )

  abortController.abort()

  await assert.rejects(promise, (err) => {
    assert.equal(err?.name, "AbortError")
    assert.match(err?.message || "", /Aborted waiting for health/)
    return true
  })
  assert.ok(calls >= 1)
})

test("stopOpenCodeServeOnPort kills only matching Windows opencode serve processes", async (t) => {
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify([
        { ProcessId: 111, Name: "opencode.exe", CommandLine: "opencode.exe serve --port 4100" },
        { ProcessId: 222, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4100/ --continue" },
        { ProcessId: 333, Name: "opencode.exe", CommandLine: "opencode.exe serve --port 4101" },
      ]),
    },
    {},
  ])
  const logger = makeLogger()

  const result = await stopOpenCodeServeOnPort({ projectAlias: "demo", port: 4100, platform: "win32", logger })

  assert.equal(result.stopped, true)
  assert.equal(result.count, 1)
  assert.deepEqual(result.pids, [111])
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "taskkill")
  assert.deepEqual(calls[1].args, ["/PID", "111", "/T", "/F"])
  assert.match(logger.logs.warn[0], /stopping hung opencode serve pid=111 port=4100/)
})

test("stopOpenCodeUiOnPort kills only matching Windows opencode attach UI processes", async (t) => {
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify([
        { ProcessId: 111, Name: "opencode.exe", CommandLine: "opencode.exe serve --port 4100" },
        { ProcessId: 222, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4100/ --continue" },
        { ProcessId: 333, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4101/ --continue" },
      ]),
    },
    {},
  ])
  const logger = makeLogger()

  const result = await stopOpenCodeUiOnPort({ projectAlias: "demo", port: 4100, platform: "win32", logger })

  assert.equal(result.stopped, true)
  assert.equal(result.count, 1)
  assert.deepEqual(result.pids, [222])
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "taskkill")
  assert.deepEqual(calls[1].args, ["/PID", "222", "/T", "/F"])
  assert.match(logger.logs.warn[0], /stopping stale opencode UI pid=222 port=4100/)
})

test("stopOpenCodeUiOnPort preserves same-port non-attach opencode processes", async (t) => {
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify([
        { ProcessId: 111, Name: "opencode.exe", CommandLine: "opencode.exe serve --port 4100" },
        { ProcessId: 222, Name: "opencode.exe", CommandLine: "opencode.exe run --port 4100" },
        { ProcessId: 333, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4101/ --continue" },
      ]),
    },
  ])
  const logger = makeLogger()

  const result = await stopOpenCodeUiOnPort({ projectAlias: "demo", port: 4100, platform: "win32", logger })

  assert.equal(result.stopped, false)
  assert.equal(result.count, 0)
  assert.deepEqual(result.pids, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "powershell")
  assert.deepEqual(logger.logs.warn, [])
})

test("getLaunchSupport reports cross-platform TUI and attach support", (t) => {
  const fakeBin = makeFakeLauncherDir(t, "x-terminal-emulator")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: undefined })

  assert.deepEqual(
    getLaunchSupport({
      project: { autoStart: true, openTuiOnAutoStart: true, directory: "/repo", port: 4312 },
      platform: "linux",
    }),
    {
      serverLaunchMode: "background",
      openTuiOnAutoStart: true,
      autoStartConfigured: true,
      canAutoStart: true,
      canOpenAttachWindow: true,
      canAutoOpenTui: true,
      canLaunchServerWindow: true,
    },
  )

  assert.equal(
    getLaunchSupport({
      project: { autoStart: true, openTuiOnAutoStart: true, directory: "/repo", port: 4312 },
      platform: "freebsd",
    }).canAutoStart,
    false,
  )

  const configured = getLaunchSupport({
    project: {
      autoStart: true,
      directory: "/repo",
      port: 4312,
      serverLaunchMode: "window",
      openTuiOnAutoStart: false,
    },
    platform: "linux",
  })
  assert.equal(configured.serverLaunchMode, "window")
  assert.equal(configured.openTuiOnAutoStart, false)
})

test("getLaunchSupport disables Linux TUI/window auto-start without GUI launcher support", (t) => {
  swapEnv(t, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, PATH: "", OPENCODE_TERMINAL: undefined })

  const tui = getLaunchSupport({
    project: { autoStart: true, openTuiOnAutoStart: true, directory: "/repo", port: 4312 },
    platform: "linux",
  })
  assert.equal(tui.canOpenAttachWindow, false)
  assert.equal(tui.canAutoStart, false)

  const backgroundOnly = getLaunchSupport({
    project: { autoStart: true, openTuiOnAutoStart: false, serverLaunchMode: "background", directory: "/repo", port: 4312 },
    platform: "linux",
  })
  assert.equal(backgroundOnly.canLaunchServerWindow, true)
  assert.equal(backgroundOnly.canAutoStart, true)
})

test("getLaunchSupport honors OPENCODE_TERMINAL on Linux when the preferred launcher exists", (t) => {
  const fakeBin = makeFakeLauncherDir(t, "custom-term")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: "custom-term" })

  const support = getLaunchSupport({
    project: { autoStart: true, openTuiOnAutoStart: true, directory: "/repo", port: 4312 },
    platform: "linux",
  })

  assert.equal(support.canOpenAttachWindow, true)
  assert.equal(support.canAutoStart, true)
})

test("getLaunchSupport disables macOS attach auto-start in SSH sessions", (t) => {
  const fakeBin = makeFakeLauncherDir(t, "osascript")
  swapEnv(t, { PATH: fakeBin, SSH_CONNECTION: "ci-session", SSH_TTY: "/dev/ttys001" })

  const support = getLaunchSupport({
    project: { autoStart: true, openTuiOnAutoStart: true, directory: "/repo", port: 4312 },
    platform: "darwin",
  })

  assert.equal(support.canOpenAttachWindow, false)
  assert.equal(support.canAutoStart, false)
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
  assert.match(calls[0].args[3], /-WindowStyle Normal/)
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

test("openAttachWindowWindows rejects cmd.exe metacharacters in sessionId", async (t) => {
  const calls = useSpawnPlans(t, [])

  for (const char of WINDOWS_CMD_METACHARS) {
    await assert.rejects(
      openAttachWindowWindows({
        directory: "C:\\repo",
        baseUrl: "http://127.0.0.1:4312",
        sessionId: `ses${char}1`,
      }),
      /sessionId contains cmd\.exe metacharacters/,
    )
  }

  assert.equal(calls.length, 0)
})

test("openAttachWindowWindows rejects cmd.exe metacharacters in baseUrl", async (t) => {
  const calls = useSpawnPlans(t, [])

  for (const char of WINDOWS_CMD_METACHARS) {
    await assert.rejects(
      openAttachWindowWindows({
        directory: "C:\\repo",
        baseUrl: `http://127.0.0.1:4312/unsafe${char}value`,
        sessionId: "ses_1",
      }),
      /baseUrl contains cmd\.exe metacharacters/,
    )
  }

  assert.equal(calls.length, 0)
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

test("openAttachContinueWindowWindows rejects cmd.exe metacharacters in baseUrl", async (t) => {
  const calls = useSpawnPlans(t, [])

  for (const char of WINDOWS_CMD_METACHARS) {
    await assert.rejects(
      openAttachContinueWindowWindows({
        directory: "C:\\repo",
        baseUrl: `http://127.0.0.1:4312/unsafe${char}value`,
      }),
      /baseUrl contains cmd\.exe metacharacters/,
    )
  }

  assert.equal(calls.length, 0)
})

test("openAttachContinueWindowWindows rejects cmd.exe metacharacters in directory arg", async (t) => {
  const calls = useSpawnPlans(t, [])

  for (const char of WINDOWS_CMD_METACHARS) {
    await assert.rejects(
      openAttachContinueWindowWindows({
        directory: `C:\\repo${char}unsafe`,
        baseUrl: "http://127.0.0.1:4312",
      }),
      /directory contains cmd\.exe metacharacters/,
    )
  }

  assert.equal(calls.length, 0)
})

test("openAttachContinueWindowWindows closes the console with opencode and passes --dir", async (t) => {
  const calls = useSpawnPlans(t, [{ code: 0 }])

  await openAttachContinueWindowWindows({
    directory: "C:\\repo",
    baseUrl: "http://127.0.0.1:4312",
  })

  assert.equal(calls[0].command, "powershell")
  assert.match(calls[0].args[3], /Start-Process -WindowStyle Normal/)
  assert.match(calls[0].args[3], /'\/c'/)
  assert.match(calls[0].args[3], /--continue/)
  assert.match(calls[0].args[3], /--dir/)
  assert.match(calls[0].args[3], /'C:\\repo'/)
})

test("openAttachWindow launches a Linux terminal for attach sessions", async (t) => {
  usePatchedPlatform(t, "linux")
  const calls = useSpawnPlans(t, [{ code: 0 }])

  await openAttachWindow({
    directory: "/repo",
    baseUrl: "http://127.0.0.1:4312",
    sessionId: "ses_linux",
  })

  assert.equal(calls[0].command, "x-terminal-emulator")
  assert.deepEqual(calls[0].args.slice(0, 3), ["-e", "sh", "-lc"])
  assert.match(calls[0].args[3], /opencode'/)
  assert.match(calls[0].args[3], /--session'/)
  assert.match(calls[0].args[3], /ses_linux/)
})

test("openAttachContinueWindow launches macOS Terminal via osascript", async (t) => {
  usePatchedPlatform(t, "darwin")
  const calls = useSpawnPlans(t, [{ code: 0 }])

  await openAttachContinueWindow({
    directory: "/repo",
    baseUrl: "http://127.0.0.1:4312",
  })

  assert.equal(calls[0].command, "osascript")
  assert.match(calls[0].args.join(" "), /Terminal/)
  assert.match(calls[0].args.join(" "), /--continue/)
  assert.match(calls[0].args.join(" "), /--dir/)
})

test("killProcessWindows shells out to taskkill and ignores launcher errors", async (t) => {
  const calls = useSpawnPlans(t, [{ error: new Error("taskkill missing") }])

  await killProcessWindows(123)

  assert.equal(calls[0].command, "taskkill")
  assert.deepEqual(calls[0].args, ["/PID", "123", "/T", "/F"])
})

test("stopOpenCodeUiOnPort stops legacy Windows TUI commands only", async (t) => {
  const calls = useSpawnPlans(t, [
    {
      stdout: JSON.stringify([
        { ProcessId: 111, Name: "cmd.exe", CommandLine: "cmd.exe /c opencode . --port 4312 --continue" },
        { ProcessId: 222, Name: "cmd.exe", CommandLine: "cmd.exe /c opencode serve --port 4312" },
        { ProcessId: 333, Name: "cmd.exe", CommandLine: "cmd.exe /c opencode run --port 4312" },
        { ProcessId: 444, Name: "cmd.exe", CommandLine: "cmd.exe /c opencode . --port 4313 --continue" },
      ]),
    },
    {},
  ])

  const result = await stopOpenCodeUiOnPort({ port: 4312, projectAlias: "demo", logger: makeLogger(), platform: "win32" })

  assert.deepEqual(result, { stopped: true, count: 1, pids: [111] })
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "taskkill")
  assert.deepEqual(calls[1].args, ["/PID", "111", "/T", "/F"])
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

test("ensureOpenCodeRunning reports detached spawn failures without an unhandled child error", async (t) => {
  const calls = useSpawnPlans(t, [{ spawn: false, error: new Error("opencode missing") }])

  await assert.rejects(
    ensureOpenCodeRunning({
      projectAlias: "demo",
      platform: "linux",
      project: {
        autoStart: true,
        openTuiOnAutoStart: false,
        directory: "/repo",
        port: 4312,
        baseUrl: "http://127.0.0.1:4312",
      },
      ocClient: {
        async health() {
          throw new Error("down")
        },
      },
      logger: makeLogger(),
    }),
    /Failed to start opencode serve: opencode missing/,
  )

  assert.equal(calls[0].command, "opencode")
  assert.equal(calls[0].child.unrefCalled, true)
})

test("ensureOpenCodeRunning returns early when the project is already healthy", async () => {
  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: { openTuiOnAutoStart: false },
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
      project: { autoStart: false, openTuiOnAutoStart: false },
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
      project: { autoStart: true, openTuiOnAutoStart: false, port: 4312 },
      ocClient: { health: async () => Promise.reject(new Error("down")) },
      logger: makeLogger(),
    }),
    /Project 'demo' missing directory\/port for autoStart/,
  )
})

test("ensureOpenCodeRunning does not auto-open attach UI when the server is already healthy", async (t) => {
  const calls = useSpawnPlans(t, [])
  const logger = makeLogger()

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      openTuiOnAutoStart: true,
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient: { health: async () => ({ healthy: true }) },
    logger,
  })

  assert.equal(result.started, false)
  assert.equal(calls.length, 0)
  assert.equal(logger.logs.info.length, 0)
  assert.equal(logger.logs.debug.length, 0)
})

test("ensureOpenCodeRunning skips auto-open after start when the baseUrl is sensitive", async (t) => {
  usePatchedDelay(t, async () => {})
  const calls = useSpawnPlans(t, [{ stdout: "[]" }, { stdout: "[]" }, { pid: 900, close: false }, { stdout: "[]" }])
  const logger = makeLogger()
  let healthCalls = 0

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      openTuiOnAutoStart: true,
      directory: "C:\\repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312?token=abc",
    },
    ocClient: {
      async health() {
        healthCalls += 1
        if (healthCalls === 1) throw new Error("down")
        return { healthy: true }
      },
    },
    logger,
  })

  assert.equal(result.started, true)
  assert.equal(calls.length, 4)
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "powershell")
  assert.equal(calls[2].command, "cmd.exe")
  assert.equal(calls[3].command, "powershell")
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
      openTuiOnAutoStart: true,
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

test("ensureOpenCodeRunning closes stale Windows attach UI before reopening it", async (t) => {
  usePatchedPlatform(t, "win32")
  usePatchedDelay(t, async () => {})
  const ticks = [0, 1, 20_000]
  usePatchedDateNow(t, () => ticks.shift() ?? 20_000)
  usePatchedProcessKill(t, () => {})
  const calls = useSpawnPlans(t, [
    { stdout: JSON.stringify([{ ProcessId: 555, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4312/ --continue" }]) },
    { stdout: JSON.stringify([{ ProcessId: 555, Name: "cmd.exe", CommandLine: "cmd.exe /k opencode attach http://127.0.0.1:4312/ --continue" }]) },
    {},
    { stdout: "[]" },
    { pid: 900, close: false },
    { stdout: "[]" },
    {},
  ])
  const logger = makeLogger()
  let healthCalls = 0

  const result = await ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      openTuiOnAutoStart: true,
      directory: "C:/repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient: {
      async health() {
        healthCalls += 1
        if (healthCalls <= 3) throw new Error("stale UI did not recover server")
        return { ok: true }
      },
    },
    logger,
    platform: "win32",
  })

  assert.equal(result.started, true)
  assert.equal(result.pid, 900)
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "powershell")
  assert.equal(calls[2].command, "taskkill")
  assert.deepEqual(calls[2].args, ["/PID", "555", "/T", "/F"])
  assert.equal(calls[3].command, "powershell")
  assert.equal(calls[4].command, "cmd.exe")
  assert.equal(calls[5].command, "powershell")
  assert.equal(calls[6].command, "powershell")
  assert.match(logger.logs.warn[0], /stopping stale opencode UI pid=555 port=4312/)
  assert.match(logger.logs.info.at(-1), /opening opencode TUI/)
})

test("ensureOpenCodeRunning starts background serve mode on Windows and returns a stop handle", async (t) => {
  usePatchedDelay(t, async () => {})
  usePatchedProcessKill(t, () => {
    throw new Error("missing pid")
  })
  const calls = useSpawnPlans(t, [{ stdout: "[]" }, { pid: 900, close: false }, { code: 0 }])
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
      serverLaunchMode: "background",
      openTuiOnAutoStart: false,
      openTuiOnAutoStart: false,
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
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, "powershell")
  assert.equal(calls[1].command, "cmd.exe")
  assert.deepEqual(calls[1].args.slice(0, 3), ["/c", "opencode", "serve"])
  assert.equal(logger.logs.error.length, 1)
  assert.match(logger.logs.error[0], /opencode serve exited immediately/)
  assert.match(logger.logs.info.at(-1), /started opencode \(background\+serve\) pid=900 port=4312/)

  await result.stop()
  assert.equal(calls.length, 3)
  assert.equal(calls[2].command, "taskkill")
  assert.deepEqual(calls[2].args, ["/PID", "900", "/T", "/F"])
})

test("ensureOpenCodeRunning starts a visible server window on Linux when configured", async (t) => {
  usePatchedPlatform(t, "linux")
  usePatchedDelay(t, async () => {})
  const fakeBin = makeFakeLauncherDir(t, "x-terminal-emulator")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: undefined })
  const calls = useSpawnPlans(t, [
    {
      code: 0,
      onSpawn: ({ args }) => {
        const match = String(args?.[3] || "").match(/> '([^']+\.pid)'/)
        assert.ok(match)
        fsSync.writeFileSync(match[1], "812\n")
      },
    },
  ])
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
      serverLaunchMode: "window",
      openTuiOnAutoStart: false,
      directory: "/repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient,
    logger: makeLogger(),
  })

  assert.equal(result.started, true)
  assert.equal(result.pid, 812)
  assert.equal(calls[0].command, "x-terminal-emulator")
  assert.match(calls[0].args[3], /opencode' 'serve'/)
  await result.stop()
  assert.deepEqual(killCalls, [[812, "SIGTERM"]])
})

test("ensureOpenCodeRunning starts detached serve plus TUI attach on Linux", async (t) => {
  usePatchedPlatform(t, "linux")
  usePatchedDelay(t, async () => {})
  const fakeBin = makeFakeLauncherDir(t, "x-terminal-emulator")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: undefined })
  const calls = useSpawnPlans(t, [{ pid: 777, close: false }, { code: 0 }])
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
      openTuiOnAutoStart: true,
      directory: "/repo",
      port: 4312,
      baseUrl: "http://127.0.0.1:4312",
    },
    ocClient,
    logger: makeLogger(),
  })

  assert.equal(result.started, true)
  assert.equal(result.pid, 777)
  assert.equal(healthCalls, 2)
  assert.equal(calls[0].command, "opencode")
  assert.equal(calls[1].command, "x-terminal-emulator")

  await result.stop()
  assert.deepEqual(killCalls, [[777, "SIGTERM"]])
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
      openTuiOnAutoStart: false,
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

test("ensureOpenCodeRunning stops a spawned process when auto-start is aborted", async (t) => {
  usePatchedPlatform(t, "linux")
  useSpawnPlans(t, [{ pid: 4321, close: false }])

  const killCalls = []
  usePatchedProcessKill(t, (...args) => {
    killCalls.push(args)
  })

  let healthCalls = 0
  const abortController = new AbortController()
  const promise = ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      openTuiOnAutoStart: false,
      directory: "/repo",
      port: 4312,
    },
    ocClient: {
      async health({ signal } = {}) {
        healthCalls += 1
        if (healthCalls === 1) throw new Error("down")
        return new Promise((_resolve, reject) => {
          signal?.addEventListener?.(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          )
        })
      },
    },
    logger: makeLogger(),
    abortSignal: abortController.signal,
  })

  await new Promise((resolve) => setImmediate(resolve))
  abortController.abort()

  await assert.rejects(promise, (err) => {
    assert.equal(err?.name, "AbortError")
    return true
  })
  assert.deepEqual(killCalls, [[4321, "SIGTERM"]])
})

test("ensureOpenCodeRunning does not spawn a new Windows server after abort during existing-UI wait", async (t) => {
  usePatchedPlatform(t, "win32")
  const calls = useSpawnPlans(t, [
    {
      stdout: [JSON.stringify([{ ProcessId: 555, Name: "WindowsTerminal.exe", CommandLine: 'opencode attach http://127.0.0.1:4312' }])],
    },
  ])

  let healthCalls = 0
  const abortController = new AbortController()
  const promise = ensureOpenCodeRunning({
    projectAlias: "demo",
    project: {
      autoStart: true,
      openTuiOnAutoStart: true,
      directory: "C:/repo",
      port: 4312,
    },
    ocClient: {
      async health({ signal } = {}) {
        healthCalls += 1
        if (healthCalls === 1) throw new Error("down")
        return new Promise((_resolve, reject) => {
          signal?.addEventListener?.(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          )
        })
      },
    },
    logger: makeLogger(),
    abortSignal: abortController.signal,
    platform: "win32",
  })

  await new Promise((resolve) => setImmediate(resolve))
  abortController.abort()

  await assert.rejects(promise, (err) => {
    assert.equal(err?.name, "AbortError")
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "powershell")
})
