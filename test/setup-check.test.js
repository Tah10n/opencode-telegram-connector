import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { checkCheckJsReferences } from "../scripts/verify-checkjs-references.mjs"
import { checkRelativeImports } from "../scripts/verify-imports.mjs"
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

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function writeCheckJsReferenceProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "tsconfig.check.json"),
    JSON.stringify(
      {
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: false,
          target: "ES2022",
          types: [],
          skipLibCheck: true,
        },
        include: ["src/**/*.js"],
      },
      null,
      2,
    ),
    "utf8",
  )
}

async function writeImportGuardProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await fs.writeFile(path.join(dir, "src", "existing.js"), "export const value = 1\n", "utf8")
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
  assert.equal(report.findings.some((finding) => finding.item === "Permission config demo"), false)
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

test("runSetupCheck fails invalid explicit permission config paths", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const invalidPath = path.join(repoDir, "opencode.remote.json")
  const missingParentPath = path.join(repoDir, "missing", "opencode.json")
  const output = []
  await fs.mkdir(repoDir, { recursive: true })

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        invalidName: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionConfigPath: invalidPath,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
        missingParent: {
          baseUrl: "http://127.0.0.1:4313",
          directory: repoDir,
          permissionConfigPath: missingParentPath,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 1)
  assert.equal(report.findings.find((finding) => finding.item === "Permission config invalidName")?.status, "fail")
  assert.match(report.findings.find((finding) => finding.item === "Permission config invalidName")?.message || "", /opencode\.jsonc/)
  assert.equal(report.findings.find((finding) => finding.item === "Permission config missingParent")?.status, "fail")
  const permissionConfigOutput = output.join("\n")
  assert.doesNotMatch(permissionConfigOutput, new RegExp(invalidPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.doesNotMatch(permissionConfigOutput, new RegExp(missingParentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("runSetupCheck passes a valid explicit permission config path", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const permissionConfigPath = path.join(repoDir, "opencode.jsonc")
  const output = []
  await fs.mkdir(repoDir, { recursive: true })
  await fs.writeFile(permissionConfigPath, "{}\n", "utf8")

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionConfigPath,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 0)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "pass")
  assert.match(permissionConfigFinding?.message || "", /valid/)
  assert.doesNotMatch(output.join("\n"), new RegExp(permissionConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("runSetupCheck fails invalid default opencode.json without leaking parser details", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const permissionConfigPath = path.join(repoDir, "opencode.json")
  const output = []
  await fs.mkdir(repoDir, { recursive: true })
  await fs.writeFile(permissionConfigPath, "{ invalid json\n", "utf8")

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /invalid opencode permission config/)
  const setupOutput = output.join("\n")
  assert.doesNotMatch(setupOutput, new RegExp(regexEscape(permissionConfigPath)))
  assert.doesNotMatch(setupOutput, /Unexpected|position|parse/i)
})

test("runSetupCheck prefers and validates default opencode.jsonc", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const jsonPath = path.join(repoDir, "opencode.json")
  const jsoncPath = path.join(repoDir, "opencode.jsonc")
  const output = []
  await fs.mkdir(repoDir, { recursive: true })
  await fs.writeFile(jsonPath, "{}\n", "utf8")
  await fs.writeFile(jsoncPath, "{ invalid jsonc\n", "utf8")

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /invalid opencode permission config/)
  assert.doesNotMatch(output.join("\n"), new RegExp(regexEscape(jsoncPath)))
})

test("runSetupCheck passes missing default permission config target", async () => {
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
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 0)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "pass")
  assert.match(permissionConfigFinding?.message || "", /can be created/)
})

test("runSetupCheck skips implicit permission config validation without opt-in", async () => {
  const dir = await makeTempDir()
  const remoteDirectory = process.platform === "win32" ? "/srv/workspaces/team-project" : "C:/remote/team-project"
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
          directory: remoteDirectory,
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 0)
  assert.equal(report.findings.some((finding) => finding.item === "Permission config demo"), false)
})

test("runSetupCheck fails missing project directory when permission control needs default config target", async () => {
  const dir = await makeTempDir()
  const missingProjectDir = path.join(dir, "remote-repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const output = []

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: missingProjectDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /project directory is missing/)
  assert.match(permissionConfigFinding?.message || "", /explicit local permissionConfigPath/)
  assert.match(permissionConfigFinding?.message || "", /remoteDirectory: true/)
  assert.match(permissionConfigFinding?.message || "", /disable permissionControl/)
  assert.match(output.join("\n"), /\[FAIL\] Permission config demo:/)
})

test("runSetupCheck fails unsafe default permission config directory target", async () => {
  const dir = await makeTempDir()
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const permissionConfigPath = path.join(repoDir, "opencode.json")
  const output = []
  await fs.mkdir(permissionConfigPath, { recursive: true })

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /unsafe/)
  assert.doesNotMatch(output.join("\n"), new RegExp(regexEscape(permissionConfigPath)))
})

test("runSetupCheck fails unsafe default permission config symlink target", async () => {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const jsonPath = path.join(repoDir, "opencode.json")
  const jsoncPath = path.join(repoDir, "opencode.jsonc")
  const output = []
  const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" })
  const directoryStat = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
  const symlinkStat = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    fsImpl: {
      stat: async (target) => {
        if ([dir, repoDir, path.dirname(stateFile)].includes(target)) return directoryStat
        if (target === stateFile) throw enoent()
        throw enoent()
      },
      lstat: async (target) => {
        if (target === jsoncPath) throw enoent()
        if (target === jsonPath) return symlinkStat
        throw enoent()
      },
      readFile: async () => {
        throw new Error("unsafe permission config target should not be read")
      },
      mkdir: async () => {},
      writeFile: async () => {},
      unlink: async () => {},
      rmdir: async () => {},
    },
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /unsafe/)
  assert.doesNotMatch(output.join("\n"), new RegExp(regexEscape(jsonPath)))
})

test("runSetupCheck fails access-denied default permission config", async () => {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const jsonPath = path.join(repoDir, "opencode.json")
  const jsoncPath = path.join(repoDir, "opencode.jsonc")
  const output = []
  const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" })
  const directoryStat = { isDirectory: () => true, isFile: () => false }
  const fileStat = { isFile: () => true, isSymbolicLink: () => false }

  const report = await runSetupCheck({
    stdout: (line) => output.push(line),
    skipTelegramProbe: true,
    skipOpenCodeProbe: true,
    buildRuntimeConfigImpl: async () => makeRuntime({
      dir,
      stateFile,
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          directory: repoDir,
          permissionControl: { enabled: true },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    fsImpl: {
      stat: async (target) => {
        if ([dir, repoDir, path.dirname(stateFile)].includes(target)) return directoryStat
        if (target === stateFile) throw enoent()
        throw enoent()
      },
      lstat: async (target) => {
        if (target === jsoncPath) throw enoent()
        if (target === jsonPath) return fileStat
        throw enoent()
      },
      readFile: async (target) => {
        if (target === jsonPath) throw Object.assign(new Error("denied"), { code: "EACCES" })
        throw enoent()
      },
      mkdir: async () => {},
      writeFile: async () => {},
      unlink: async () => {},
      rmdir: async () => {},
    },
  })

  assert.equal(report.exitCode, 1)
  const permissionConfigFinding = report.findings.find((finding) => finding.item === "Permission config demo")
  assert.equal(permissionConfigFinding?.status, "fail")
  assert.match(permissionConfigFinding?.message || "", /access-denied/)
  assert.doesNotMatch(output.join("\n"), new RegExp(regexEscape(jsonPath)))
})

test("runSetupCheck skips permission config files when permission control is disabled", async () => {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  const repoDir = path.join(dir, "repo")
  const stateFile = path.join(dir, ".data", "state.json")
  const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" })
  const directoryStat = { isDirectory: () => true, isFile: () => false }

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
          permissionControl: { enabled: false },
          autoStart: false,
          serverLaunchMode: "background",
          openTuiOnAutoStart: true,
          openAttachOnNewMode: "same-window",
          username: "",
          password: "",
        },
      },
    }),
    fsImpl: {
      stat: async (target) => {
        assert.doesNotMatch(target, /opencode\.jsonc?$/)
        if ([dir, repoDir, path.dirname(stateFile)].includes(target)) return directoryStat
        if (target === stateFile) throw enoent()
        throw enoent()
      },
      lstat: async (target) => {
        assert.fail(`permission config path should not be probed: ${target}`)
      },
      readFile: async (target) => {
        assert.fail(`permission config file should not be read: ${target}`)
      },
      mkdir: async () => {},
      writeFile: async () => {},
      unlink: async () => {},
      rmdir: async () => {},
    },
  })

  assert.equal(report.exitCode, 0)
  assert.equal(report.findings.some((finding) => finding.item === "Permission config demo"), false)
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
  const importGuardScript = await fs.readFile(new URL("../scripts/verify-imports.mjs", import.meta.url), "utf8")
  const checkJsReferenceGuardScript = await fs.readFile(new URL("../scripts/verify-checkjs-references.mjs", import.meta.url), "utf8")
  const callbackGuardScript = await fs.readFile(new URL("../scripts/verify-callback-data.mjs", import.meta.url), "utf8")
  const architectureGuardScript = await fs.readFile(new URL("../scripts/verify-architecture.mjs", import.meta.url), "utf8")

  assert.equal(pkg.private, true)
  assert.equal(pkg.scripts.check, "node scripts/check-syntax.mjs && node scripts/verify-imports.mjs && npm run check:references && node scripts/verify-callback-data.mjs && npm run check:architecture && npm run check:module-graph && npm run check:typed-contracts")
  assert.equal(pkg.scripts["check:references"], "node scripts/verify-checkjs-references.mjs")
  assert.equal(pkg.scripts["check:architecture"], "node scripts/verify-architecture.mjs")
  assert.equal(pkg.scripts["check:module-graph"], "tsc -p tsconfig.check.json")
  assert.equal(pkg.scripts["check:typed-contracts"], "tsc -p tsconfig.typed-contracts.json")
  assert.ok(pkg.files.includes("scripts/verify-imports.mjs"))
  assert.ok(pkg.files.includes("scripts/verify-checkjs-references.mjs"))
  assert.ok(pkg.files.includes("scripts/verify-callback-data.mjs"))
  assert.ok(pkg.files.includes("scripts/verify-architecture.mjs"))
  assert.ok(pkg.files.includes("test"))
  assert.ok(pkg.files.includes("tsconfig.check.json"))
  assert.ok(pkg.files.includes("tsconfig.typed-contracts.json"))
  assert.match(syntaxCheckScript, /connector\.config\.example\.mjs/)
  assert.match(importGuardScript, /Import guard failed/)
  assert.match(checkJsReferenceGuardScript, /CheckJS reference guard failed/)
  assert.match(callbackGuardScript, /raw callback payload literal/)
  assert.match(architectureGuardScript, /Architecture guard failed/)
  assert.equal(pkg.scripts["setup:check"], "node src/cli.js check")
})

test("checkJs reference guard fails unresolved runtime references", async () => {
  const dir = await makeTempDir()
  await writeCheckJsReferenceProject(dir)
  await fs.writeFile(path.join(dir, "src", "bad.js"), "console.log(missingRuntimeValue)\n", "utf8")

  const result = checkCheckJsReferences({ rootDir: dir })

  assert.equal(result.ok, false)
  assert.equal(result.fileCount, 1)
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.includes("TS2304") && diagnostic.includes("missingRuntimeValue")),
    result.diagnostics.join("\n"),
  )
})

test("checkJs reference guard fails missing named imports from existing modules", async () => {
  const dir = await makeTempDir()
  await writeCheckJsReferenceProject(dir)
  await fs.writeFile(path.join(dir, "src", "existing.js"), "export const present = 1\n", "utf8")
  const existingSpecifier = "." + "/existing.js"
  await fs.writeFile(path.join(dir, "src", "bad-import.js"), `import { missing } from ${JSON.stringify(existingSpecifier)}\nconsole.log(missing)\n`, "utf8")

  const result = checkCheckJsReferences({ rootDir: dir })

  assert.equal(result.ok, false)
  assert.equal(result.fileCount, 2)
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.includes("TS2305") && diagnostic.includes("missing")),
    result.diagnostics.join("\n"),
  )
})

test("checkJs reference guard fails missing default imports from existing modules", async () => {
  const dir = await makeTempDir()
  await writeCheckJsReferenceProject(dir)
  await fs.writeFile(path.join(dir, "src", "existing.js"), "export const present = 1\n", "utf8")
  const existingSpecifier = "." + "/existing.js"
  await fs.writeFile(path.join(dir, "src", "bad-default.js"), `import missingDefault from ${JSON.stringify(existingSpecifier)}\nconsole.log(missingDefault)\n`, "utf8")

  const result = checkCheckJsReferences({ rootDir: dir })

  assert.equal(result.ok, false)
  assert.equal(result.fileCount, 2)
  assert.ok(
    result.diagnostics.some((diagnostic) => (diagnostic.includes("TS1192") || diagnostic.includes("TS2613")) && diagnostic.includes("default")),
    result.diagnostics.join("\n"),
  )
})

test("relative import guard ignores comments and string literals", async () => {
  const dir = await makeTempDir()
  await writeImportGuardProject(dir)
  await fs.writeFile(
    path.join(dir, "src", "good.js"),
    `
// copied from "./missing-comment.js"
/*
import "./missing-block.js"
export { value } from "./missing-export.js"
*/
const text = "dynamic import(\"./missing-string.js\") should stay a string"
import "./existing.js"
export { value } from "./existing.js"
export const loaded = () => import("./existing.js")
console.log(text, loaded)
`,
    "utf8",
  )

  const result = await checkRelativeImports({ rootDir: dir })

  assert.equal(result.ok, true)
  assert.equal(result.fileCount, 2)
  assert.deepEqual(result.violations, [])
})

test("relative import guard fails real missing static, export, and dynamic imports", async () => {
  const dir = await makeTempDir()
  await writeImportGuardProject(dir)
  await fs.writeFile(
    path.join(dir, "src", "bad.js"),
    `
import "./missing-static.js"
export { value } from "./missing-export.js"
export const loaded = () => import("./missing-dynamic.js")
`,
    "utf8",
  )

  const result = await checkRelativeImports({ rootDir: dir })

  assert.equal(result.ok, false)
  assert.equal(result.fileCount, 2)
  assert.ok(result.violations.some((violation) => violation.includes('bad.js: missing relative import target "./missing-static.js"')), result.violations.join("\n"))
  assert.ok(result.violations.some((violation) => violation.includes('bad.js: missing relative import target "./missing-export.js"')), result.violations.join("\n"))
  assert.ok(result.violations.some((violation) => violation.includes('bad.js: missing relative import target "./missing-dynamic.js"')), result.violations.join("\n"))
})
