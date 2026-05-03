import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { normalizeProjectsConfig } from "./projects.js"

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function parseConfigBool(name, value) {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false
  }
  throw new Error(`Config field '${name}' must be a boolean`)
}

function parseConfigInteger(name, value, { min = 1 } = {}) {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : NaN
  const expected = min > 0 ? "a positive integer" : "a non-negative integer"
  if (!Number.isInteger(n) || n < min) throw new Error(`Config field '${name}' must be ${expected}`)
  return n
}

function normalizeOpenCodeWatchdog(value) {
  if (!isPlainObject(value)) throw new Error("Config field 'opencodeWatchdog' must be an object")
  const out = {}
  if (value.failureThreshold != null && value.failureThreshold !== "") {
    out.failureThreshold = parseConfigInteger("opencodeWatchdog.failureThreshold", value.failureThreshold)
  }
  if (value.windowMs != null && value.windowMs !== "") {
    out.windowMs = parseConfigInteger("opencodeWatchdog.windowMs", value.windowMs)
  }
  if (value.cooldownMs != null && value.cooldownMs !== "") {
    out.cooldownMs = parseConfigInteger("opencodeWatchdog.cooldownMs", value.cooldownMs, { min: 0 })
  }
  return out
}

function normalizeEchoFilterMode(value, { fieldName = "echoFilterMode" } = {}) {
  const mode = String(value ?? "").trim()
  if (!mode) return undefined
  if (mode !== "recent" && mode !== "prefix") throw new Error(`Config field '${fieldName}' must be 'recent' or 'prefix'`)
  return mode
}

function normalizePathValue(filePath, baseDir) {
  if (filePath == null || filePath === "") return undefined
  return path.resolve(baseDir, String(filePath))
}

export async function loadConnectorConfigFile(configFilePath, { required = false } = {}) {
  if (!configFilePath) return null
  try {
    await fs.access(configFilePath)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT" && !required) return null
    throw err
  }
  try {
    const mod = await import(`${pathToFileURL(configFilePath).href}?ts=${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return normalizeConnectorConfig(mod?.default, { configFilePath })
  } catch (err) {
    throw err
  }
}

export function normalizeConnectorConfig(raw, { configFilePath } = {}) {
  const baseDir = configFilePath ? path.dirname(configFilePath) : process.cwd()
  if (!isPlainObject(raw)) {
    throw new Error(`Config file '${configFilePath || "(unknown)"}' must export a default object`)
  }

  const out = { cwd: baseDir }
  if (raw.cwd != null && raw.cwd !== "") out.cwd = path.resolve(baseDir, String(raw.cwd))
  const runtimeBaseDir = out.cwd
  if (raw.stateFile != null && raw.stateFile !== "") out.stateFile = normalizePathValue(raw.stateFile, runtimeBaseDir)
  if (raw.defaultProject != null && raw.defaultProject !== "") out.defaultProject = String(raw.defaultProject)
  if (raw.tgPrefix != null) out.tgPrefix = String(raw.tgPrefix)
  if (raw.echoFilterMode != null && raw.echoFilterMode !== "") out.echoFilterMode = normalizeEchoFilterMode(raw.echoFilterMode)
  if (raw.mirrorTuiUserMessages != null) out.mirrorTuiUserMessages = parseConfigBool("mirrorTuiUserMessages", raw.mirrorTuiUserMessages)
  if (raw.logFormat != null && raw.logFormat !== "") out.logFormat = String(raw.logFormat)
  if (raw.allowInsecureHttp != null) out.allowInsecureHttp = parseConfigBool("allowInsecureHttp", raw.allowInsecureHttp)
  if (raw.activeTurnStaleMs != null && raw.activeTurnStaleMs !== "") {
    out.activeTurnStaleMs = parseConfigInteger("activeTurnStaleMs", raw.activeTurnStaleMs)
  }
  if (raw.opencodeWatchdog != null) out.opencodeWatchdog = normalizeOpenCodeWatchdog(raw.opencodeWatchdog)
  if (raw.limits != null) {
    if (!isPlainObject(raw.limits)) throw new Error("Config field 'limits' must be an object")
    out.limits = { ...raw.limits }
  }

  if (raw.telegram != null) {
    if (!isPlainObject(raw.telegram)) throw new Error("Config field 'telegram' must be an object")
    const telegram = {}
    if (raw.telegram.botToken != null && raw.telegram.botToken !== "") telegram.botToken = String(raw.telegram.botToken)
    if (raw.telegram.allowedUserId != null && raw.telegram.allowedUserId !== "") {
      const n = Number(raw.telegram.allowedUserId)
      if (!Number.isInteger(n)) throw new Error("Config field 'telegram.allowedUserId' must be an integer")
      telegram.allowedUserId = n
    }
    out.telegram = telegram
  }

  if (raw.projects != null) {
    out.projects = normalizeProjectsConfig(raw.projects, {
      baseDir: runtimeBaseDir,
      sourceLabel: `config file (${configFilePath || "inline"})`,
    })
  }

  return {
    config: out,
    baseDir,
    configFilePath,
  }
}
