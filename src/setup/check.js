import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { buildRuntimeConfig } from "../config/runtime.js"
import { OpenCodeClient } from "../opencode/client.js"
import { commandExistsOnPath, getLaunchSupport } from "../opencode/launcher.js"
import { resolveDefaultStatePath } from "../state/store.js"
import { TelegramClient } from "../telegram/client.js"
import { redactSensitiveText, sanitizeBaseUrlForDisplay } from "../url-utils.js"

const STATUS_LABELS = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
}

const TELEGRAM_TOKEN_PLACEHOLDER = "123456789:replace_me"
const TELEGRAM_USER_ID_PLACEHOLDER = 123456789

function countFindings(findings) {
  return findings.reduce((counts, finding) => {
    counts[finding.status] += 1
    return counts
  }, { pass: 0, warn: 0, fail: 0 })
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function addFinding(findings, status, item, message) {
  findings.push({ status, item, message: String(message || "") })
}

function collectKnownSecrets(config) {
  const secrets = []
  if (config?.telegram?.botToken) secrets.push(config.telegram.botToken)
  for (const project of Object.values(config?.projects || {})) {
    if (project?.password) secrets.push(project.password)
  }
  return secrets
}

function collectSensitivePaths({ envFile, configFile, stateFile } = {}) {
  return [
    envFile ? { path: envFile, label: "env-file" } : null,
    configFile ? { path: configFile, label: "config-file" } : null,
    stateFile ? { path: stateFile, label: "state-file" } : null,
  ].filter(Boolean)
}

function safeSetupText(value, { config, envFile, configFile, stateFile } = {}) {
  const text = value?.message || value?.stack || String(value || "")
  return redactSensitiveText(text, {
    knownSecrets: collectKnownSecrets(config),
    sensitivePaths: collectSensitivePaths({ envFile, configFile, stateFile }),
  })
}

function createTelegramClientDefault({ config }) {
  return new TelegramClient(config.telegram.botToken)
}

function createOpenCodeClientDefault({ project, config }) {
  return new OpenCodeClient({
    baseUrl: project.baseUrl,
    username: project.username,
    password: project.password,
    allowInsecureHttp: config.allowInsecureHttp,
  })
}

async function probeTelegramIdentity(telegramClient, timeoutMs) {
  if (typeof telegramClient?.call === "function") {
    return telegramClient.call("getMe", null, { timeoutMs })
  }
  if (typeof telegramClient?.getMe === "function") return telegramClient.getMe()
  throw new Error("Telegram probe client does not support getMe")
}

function describeTelegramIdentity(me) {
  const parts = []
  if (typeof me?.username === "string" && me.username.trim()) parts.push(`@${me.username.trim()}`)
  if (me?.id != null) parts.push(`id ${me.id}`)
  if (typeof me?.first_name === "string" && me.first_name.trim()) parts.push(me.first_name.trim())
  return parts.length ? parts.join(", ") : "bot responded"
}

function describeProject(project) {
  const details = [sanitizeBaseUrlForDisplay(project.baseUrl)]
  details.push(project.autoStart ? "autoStart on" : "autoStart off")
  if (project.directory) details.push(`directory ${project.directory}`)
  if (project.port) details.push(`port ${project.port}`)
  return details.join(", ")
}

function createHealthSignal(timeoutMs) {
  if (!timeoutMs || typeof AbortSignal?.timeout !== "function") return undefined
  return AbortSignal.timeout(timeoutMs)
}

function describeHealth(health) {
  const details = []
  if (typeof health?.status === "string" && health.status.trim()) details.push(`status ${health.status.trim()}`)
  if (typeof health?.version === "string" && health.version.trim()) details.push(`version ${health.version.trim()}`)
  return details.length ? `reachable (${details.join(", ")})` : "reachable"
}

function autoStartReason(support) {
  if (support.autoStartConfigured !== true) return "configuration is incomplete"
  if (support.canLaunchServerWindow !== true) {
    return `serverLaunchMode '${support.serverLaunchMode}' is not supported on this platform`
  }
  return "manual start may still be required on this platform"
}

async function inspectDirectory(directory, { fsImpl, config, envFile, configFile, stateFile } = {}) {
  if (!directory) return { ok: false, label: "not configured" }
  try {
    const stat = await fsImpl.stat(directory)
    return stat.isDirectory() ? { ok: true, label: "exists" } : { ok: false, label: "not a directory" }
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, label: "missing" }
    return {
      ok: false,
      label: `unreadable (${safeSetupText(err, { config, envFile, configFile, stateFile })})`,
    }
  }
}

function describeAutoStart({ project, support, directoryStatus, commandAvailable }) {
  const details = []
  details.push(commandAvailable ? "opencode command on PATH" : "opencode command missing from PATH")
  if (project.directory) {
    const suffix = directoryStatus?.label ? ` (${directoryStatus.label})` : ""
    details.push(`directory ${project.directory}${suffix}`)
  }
  if (project.port) details.push(`port ${project.port}`)
  if (support.openTuiOnAutoStart === true) {
    details.push(support.canAutoOpenTui === true ? "TUI auto-open supported" : "TUI auto-open unavailable")
  }

  const summary = support.canAutoStart === true ? "supported" : autoStartReason(support)
  return `${summary}${details.length ? `; ${details.join(", ")}` : ""}`
}

async function pathExists(fsImpl, targetPath) {
  try {
    await fsImpl.stat(targetPath)
    return true
  } catch (err) {
    if (err?.code === "ENOENT") return false
    throw err
  }
}

async function unlinkIfExists(fsImpl, targetPath) {
  try {
    await fsImpl.unlink(targetPath)
  } catch (err) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

async function assertStateFileTargetIsUsable({ stateFile, fsImpl }) {
  try {
    const stat = await fsImpl.stat(stateFile)
    if (typeof stat?.isDirectory === "function" && stat.isDirectory()) {
      throw new Error("Configured state file path points to a directory")
    }
    if (typeof stat?.isFile === "function" && !stat.isFile()) {
      throw new Error("Configured state file path is not a regular file")
    }
  } catch (err) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

async function removeDirectoryIfEmpty(fsImpl, targetPath) {
  try {
    if (typeof fsImpl.rmdir === "function") await fsImpl.rmdir(targetPath)
    else if (typeof fsImpl.rm === "function") await fsImpl.rm(targetPath)
  } catch (err) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(err?.code)) return
    throw err
  }
}

async function probeStateFileWritable({ stateFile, fsImpl }) {
  await assertStateFileTargetIsUsable({ stateFile, fsImpl })
  const dir = path.dirname(stateFile)
  const createdDirs = []
  for (let current = dir; current && current !== path.dirname(current); current = path.dirname(current)) {
    if (await pathExists(fsImpl, current)) break
    createdDirs.push(current)
  }

  await fsImpl.mkdir(dir, { recursive: true })
  const tempFile = path.join(dir, `${path.basename(stateFile)}.setup-check.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    await fsImpl.writeFile(tempFile, '{"setupCheck":true}\n', "utf8")
  } finally {
    await unlinkIfExists(fsImpl, tempFile).catch(() => {})
    for (const createdDir of createdDirs) {
      await removeDirectoryIfEmpty(fsImpl, createdDir).catch(() => {})
    }
  }
}

function printReport(findings, counts, { stdout }) {
  stdout("Setup check")
  for (const finding of findings) {
    stdout(`[${STATUS_LABELS[finding.status] || String(finding.status || "").toUpperCase()}] ${finding.item}: ${finding.message}`)
  }
  stdout(`Summary: ${pluralize(counts.pass, "pass")}, ${pluralize(counts.warn, "warning")}, ${pluralize(counts.fail, "failure")}`)
}

export async function runSetupCheck({
  args = {},
  stdout = (line) => console.log(line),
  buildRuntimeConfigImpl = buildRuntimeConfig,
  createTelegramClientImpl = createTelegramClientDefault,
  createOpenCodeClientImpl = createOpenCodeClientDefault,
  getLaunchSupportImpl = getLaunchSupport,
  commandExistsImpl = commandExistsOnPath,
  resolveDefaultStatePathImpl = resolveDefaultStatePath,
  fsImpl = fs,
  platform = process.platform,
  telegramProbeTimeoutMs = 15_000,
  openCodeProbeTimeoutMs = 10_000,
  skipTelegramProbe = false,
  skipOpenCodeProbe = false,
} = {}) {
  const findings = []

  let runtime
  try {
    runtime = await buildRuntimeConfigImpl({ args })
  } catch (err) {
    addFinding(findings, "fail", "Runtime config", safeSetupText(err))
    const counts = countFindings(findings)
    printReport(findings, counts, { stdout })
    return { ok: false, exitCode: 1, findings, counts }
  }

  const { config, envFile, configFile, loadedConfigFile } = runtime
  const stateFile = config.stateFile || resolveDefaultStatePathImpl({ cwd: config.cwd })
  const safeText = (value) => safeSetupText(value, { config, envFile, configFile, stateFile })

  addFinding(
    findings,
    "pass",
    "Runtime config",
    `${pluralize(Object.keys(config.projects || {}).length, "project")} loaded${loadedConfigFile ? " from config file" : ""}`,
  )
  if (config.telegram.botToken === TELEGRAM_TOKEN_PLACEHOLDER || String(config.telegram.botToken || "").includes("replace_me")) {
    addFinding(findings, "fail", "Telegram config", "bot token still uses the example placeholder")
  } else if (config.telegram.allowedUserId === TELEGRAM_USER_ID_PLACEHOLDER) {
    addFinding(findings, "fail", "Telegram config", "allowed user id still uses the example placeholder")
  } else {
    addFinding(findings, "pass", "Telegram config", `allowed user id ${config.telegram.allowedUserId} configured`)
  }

  if (skipTelegramProbe) {
    addFinding(findings, "warn", "Telegram API", "getMe probe skipped")
  } else {
    try {
      const tg = await createTelegramClientImpl({ config, envFile, configFile, stateFile })
      const me = await probeTelegramIdentity(tg, telegramProbeTimeoutMs)
      addFinding(findings, "pass", "Telegram API", `getMe ok (${describeTelegramIdentity(me)})`)
    } catch (err) {
      addFinding(findings, "fail", "Telegram API", safeText(err))
    }
  }

  addFinding(findings, "pass", "Projects", Object.keys(config.projects).join(", "))

  for (const [alias, project] of Object.entries(config.projects)) {
    addFinding(findings, "pass", `Project ${alias}`, describeProject(project))

    const autoStartSupport = project.autoStart === true
      ? getLaunchSupportImpl({ project, platform })
      : null
    const autoStartDirectoryStatus = project.autoStart === true
      ? await inspectDirectory(project.directory, { fsImpl, config, envFile, configFile, stateFile })
      : null
    const autoStartCommandAvailable = project.autoStart === true
      ? commandExistsImpl("opencode", { platform }) === true
      : false
    const autoStartCanRecoverHealth = project.autoStart === true
      && autoStartSupport?.canAutoStart === true
      && autoStartDirectoryStatus?.ok === true
      && autoStartCommandAvailable === true

    let ocClient = null
    try {
      ocClient = await createOpenCodeClientImpl({ alias, project, config, envFile, configFile, stateFile })
      const authConfigured = project.password ? "Basic Auth password configured" : "no Basic Auth password configured"
      addFinding(findings, "pass", `OpenCode ${alias} auth`, authConfigured)
    } catch (err) {
      addFinding(findings, "fail", `OpenCode ${alias} auth`, safeText(err))
      addFinding(findings, "warn", `OpenCode ${alias} health`, "probe skipped because client configuration failed")
    }

    if (ocClient) {
      if (skipOpenCodeProbe) {
        addFinding(findings, "warn", `OpenCode ${alias} health`, "health probe skipped")
      } else {
        try {
          const health = await ocClient.health({ signal: createHealthSignal(openCodeProbeTimeoutMs) })
          addFinding(findings, "pass", `OpenCode ${alias} health`, describeHealth(health))
        } catch (err) {
          addFinding(
            findings,
            autoStartCanRecoverHealth ? "warn" : "fail",
            `OpenCode ${alias} health`,
            autoStartCanRecoverHealth
              ? `not reachable now; auto-start is configured and supported (${safeText(err)})`
              : safeText(err),
          )
        }
      }
    }

    if (project.autoStart === true) {
      const status = !autoStartCommandAvailable
        ? "fail"
        : autoStartSupport.canAutoStart === true && autoStartDirectoryStatus.ok === true
          ? "pass"
          : "warn"
      addFinding(
        findings,
        status,
        `Auto-start ${alias}`,
        describeAutoStart({
          project,
          support: autoStartSupport,
          directoryStatus: autoStartDirectoryStatus,
          commandAvailable: autoStartCommandAvailable,
        }),
      )
    } else {
      addFinding(findings, "pass", `Auto-start ${alias}`, "disabled")
    }
  }

  try {
    await probeStateFileWritable({ stateFile, fsImpl })
    addFinding(findings, "pass", "State file", `temp write ok near ${safeText(stateFile)}`)
  } catch (err) {
    addFinding(findings, "fail", "State file", safeText(err))
  }

  const counts = countFindings(findings)
  printReport(findings, counts, { stdout })
  return {
    ok: counts.fail === 0,
    exitCode: counts.fail === 0 ? 0 : 1,
    findings,
    counts,
  }
}
