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
  assert.deepEqual(report.counts, { pass: 9, warn: 0, fail: 0 })
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

  assert.equal(pkg.private, true)
  assert.equal(pkg.scripts.check, "node scripts/check-syntax.mjs")
  assert.match(syntaxCheckScript, /connector\.config\.example\.mjs/)
  assert.equal(pkg.scripts["setup:check"], "node src/cli.js check")
})
