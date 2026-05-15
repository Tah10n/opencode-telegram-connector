import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { runSetupCheck } from "../src/setup/check.js"

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function makeRuntime({ dir, stateFile, projects, allowInsecureHttp = false, loadedConfigFile = true } = {}) {
  return {
    config: {
      telegram: {
        botToken: "5555555555:AABBCCDDEEFFaabbccddeeff12345678",
        allowedUserId: 42,
      },
      projects,
      allowInsecureHttp,
      cwd: dir,
      stateFile,
    },
    envFile: path.join(dir, ".env"),
    configFile: path.join(dir, "connector.config.mjs"),
    loadedConfigFile,
  }
}

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

test("runSetupCheck reports successful probes and cleans temp state files", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  await fs.mkdir(repoDir, { recursive: true })

  const lines = []
  const report = await runSetupCheck({
    stdout: (line) => lines.push(line),
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          port: 4312,
          autoStart: true,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createTelegramClientImpl: () => ({
      getMe: async () => ({ id: 7, username: "demo_bot" }),
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ status: "ok", version: "1.2.3" }),
    }),
    getLaunchSupportImpl: () => ({
      serverLaunchMode: "background",
      openTuiOnAutoStart: true,
      autoStartConfigured: true,
      canAutoStart: true,
      canOpenAttachWindow: true,
      canAutoOpenTui: true,
      canLaunchServerWindow: true,
    }),
    commandExistsImpl: () => true,
  })

  assert.equal(report.exitCode, 0)
  assert.deepEqual(report.counts, { pass: 10, warn: 0, fail: 0 })
  assert.match(lines.join("\n"), /\[PASS\] Telegram API: getMe ok \(@demo_bot, id 7\)/)
  assert.doesNotMatch(lines.join("\n"), /5555555555:AABBCCDDEEFFaabbccddeeff12345678/)

  await assert.rejects(fs.stat(stateFile), /ENOENT/)
  const stateDir = path.dirname(stateFile)
  let entries = []
  try {
    entries = await fs.readdir(stateDir)
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
  }
  assert.deepEqual(entries, [])
})

test("runSetupCheck returns warnings for skipped probes and unsupported autoStart", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  await fs.mkdir(repoDir, { recursive: true })

  const lines = []
  const report = await runSetupCheck({
    stdout: (line) => lines.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          port: 4312,
          autoStart: true,
          serverLaunchMode: "window",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ ok: true }),
    }),
    getLaunchSupportImpl: () => ({
      serverLaunchMode: "window",
      openTuiOnAutoStart: true,
      autoStartConfigured: true,
      canAutoStart: false,
      canOpenAttachWindow: false,
      canAutoOpenTui: false,
      canLaunchServerWindow: false,
    }),
    commandExistsImpl: () => true,
  })

  assert.equal(report.exitCode, 0)
  assert.equal(report.counts.fail, 0)
  assert.ok(report.counts.warn >= 3)
  assert.match(lines.join("\n"), /\[WARN\] Telegram API: getMe probe skipped/)
  assert.match(lines.join("\n"), /\[WARN\] Auto-start demo: .*port 4312/)
  assert.match(lines.join("\n"), /Summary: .*0 failures/)
})

test("runSetupCheck warns when local autoStart can recover failed OpenCode health", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  await fs.mkdir(repoDir, { recursive: true })

  const report = await runSetupCheck({
    stdout: () => {},
    skipTelegramProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          port: 4312,
          autoStart: true,
          serverLaunchMode: "background",
          openTuiOnAutoStart: false,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => {
        throw new Error("connection refused")
      },
    }),
    getLaunchSupportImpl: () => ({
      serverLaunchMode: "background",
      openTuiOnAutoStart: false,
      autoStartConfigured: true,
      canAutoStart: true,
      canOpenAttachWindow: false,
      canAutoOpenTui: false,
      canLaunchServerWindow: true,
    }),
    commandExistsImpl: () => true,
  })

  assert.equal(report.exitCode, 0)
  assert.equal(report.findings.find((finding) => finding.item === "OpenCode demo health")?.status, "warn")
  assert.equal(report.findings.find((finding) => finding.item === "Auto-start demo")?.status, "pass")
})

test("runSetupCheck fails when autoStart needs opencode but command is missing", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  await fs.mkdir(repoDir, { recursive: true })

  const report = await runSetupCheck({
    stdout: () => {},
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          port: 4312,
          autoStart: true,
          serverLaunchMode: "background",
          openTuiOnAutoStart: false,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ status: "ok" }),
    }),
    getLaunchSupportImpl: () => ({
      serverLaunchMode: "background",
      openTuiOnAutoStart: false,
      autoStartConfigured: true,
      canAutoStart: true,
      canOpenAttachWindow: false,
      canAutoOpenTui: false,
      canLaunchServerWindow: true,
    }),
    commandExistsImpl: () => false,
  })

  assert.equal(report.exitCode, 1)
  assert.equal(report.findings.find((finding) => finding.item === "Auto-start demo")?.status, "fail")
})

test("runSetupCheck fails default global SSE when project directory is missing", async (t) => {
  swapEnv(t, { OPENCODE_SSE_EVENT_PATH: undefined })
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")
  const lines = []

  const report = await runSetupCheck({
    stdout: (line) => lines.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ status: "ok" }),
    }),
  })

  assert.equal(report.exitCode, 1)
  const sseFinding = report.findings.find((finding) => finding.item === "SSE routing demo")
  assert.equal(sseFinding?.status, "fail")
  assert.match(sseFinding?.message || "", /\/global\/event requires project 'directory'/)
  assert.match(sseFinding?.message || "", /OPENCODE_SSE_EVENT_PATH=\/event/)
  assert.match(lines.join("\n"), /\[FAIL\] SSE routing demo:/)
})

test("runSetupCheck allows legacy SSE /event when project directory is missing", async (t) => {
  swapEnv(t, { OPENCODE_SSE_EVENT_PATH: "/event" })
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")

  const report = await runSetupCheck({
    stdout: () => {},
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ status: "ok" }),
    }),
  })

  assert.equal(report.exitCode, 0)
  const sseFinding = report.findings.find((finding) => finding.item === "SSE routing demo")
  assert.equal(sseFinding?.status, "pass")
  assert.match(sseFinding?.message || "", /\/event does not require project directory routing/)
})

test("runSetupCheck reports Basic Auth safety failures without leaking credentials", async () => {
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")
  const secret = "shhh-secret"
  const lines = []

  const report = await runSetupCheck({
    stdout: (line) => lines.push(line),
    skipTelegramProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://example.com:4312",
          directory: dir,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "opencode",
          password: secret,
        },
      },
      allowInsecureHttp: false,
    }),
  })

  assert.equal(report.exitCode, 1)
  assert.equal(report.findings.find((finding) => finding.item === "OpenCode demo auth")?.status, "fail")
  assert.doesNotMatch(lines.join("\n"), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("runSetupCheck reports OpenCode and state probe failures", async () => {
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")

  const report = await runSetupCheck({
    stdout: () => {},
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: dir,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createTelegramClientImpl: () => ({
      getMe: async () => ({ id: 7, username: "demo_bot" }),
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => {
        throw new Error("connection refused")
      },
    }),
    fsImpl: {
      stat: async () => ({ isDirectory: () => true }),
      mkdir: async () => {},
      writeFile: async () => {
        throw new Error("state temp denied")
      },
      unlink: async () => {},
      rmdir: async () => {},
    },
  })

  assert.equal(report.exitCode, 1)
  assert.equal(report.findings.find((finding) => finding.item === "OpenCode demo health")?.status, "fail")
  assert.equal(report.findings.find((finding) => finding.item === "State file")?.status, "fail")
})

test("runSetupCheck fails when state file path is an existing directory", async () => {
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")
  await fs.mkdir(stateFile, { recursive: true })

  const report = await runSetupCheck({
    stdout: () => {},
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: dir,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    createOpenCodeClientImpl: () => ({
      health: async () => ({ status: "ok" }),
    }),
  })

  assert.equal(report.exitCode, 1)
  assert.match(report.findings.find((finding) => finding.item === "State file")?.message, /points to a directory/)
})

test("runSetupCheck fails on shipped Telegram placeholders", async () => {
  const dir = await makeTempDir()
  const stateFile = path.join(dir, ".data", "state.json")

  const report = await runSetupCheck({
    stdout: () => {},
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => {
      const runtime = makeRuntime({
        dir,
        stateFile,
        projects: {
          demo: {
            baseUrl: "http://127.0.0.1:4312",
            directory: dir,
            autoStart: false,
            serverLaunchMode: "background",
            openTuiOnAutoStart: true,
            openAttachOnNewMode: "same-window",
            username: "",
            password: "",
          },
        },
      })
      runtime.config.telegram.botToken = "123456789:replace_me"
      runtime.config.telegram.allowedUserId = 123456789
      return runtime
    },
  })

  assert.equal(report.exitCode, 1)
  assert.equal(report.findings.find((finding) => finding.item === "Telegram config")?.status, "fail")
})

test("package scripts keep syntax check, cover starter config, and add setup check", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"))
  const syntaxCheckScript = await fs.readFile(new URL("../scripts/check-syntax.mjs", import.meta.url), "utf8")
  const callbackGuardScript = await fs.readFile(new URL("../scripts/verify-callback-data.mjs", import.meta.url), "utf8")
  const architectureGuardScript = await fs.readFile(new URL("../scripts/verify-architecture.mjs", import.meta.url), "utf8")

  assert.equal(pkg.private, true)
  assert.equal(pkg.scripts.check, "node scripts/check-syntax.mjs && node scripts/verify-callback-data.mjs && npm run check:architecture && npm run check:types")
  assert.equal(pkg.scripts["check:architecture"], "node scripts/verify-architecture.mjs")
  assert.equal(pkg.scripts["check:types"], "tsc -p tsconfig.check.json")
  assert.ok(pkg.files.includes("scripts/verify-callback-data.mjs"))
  assert.ok(pkg.files.includes("scripts/verify-architecture.mjs"))
  assert.match(syntaxCheckScript, /connector\.config\.example\.mjs/)
  assert.match(callbackGuardScript, /raw callback payload literal/)
  assert.match(architectureGuardScript, /Architecture guard failed/)
  assert.equal(pkg.scripts["setup:check"], "node src/cli.js check")
})
