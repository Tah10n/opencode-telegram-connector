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

function normalizePathValue(filePath, baseDir) {
  if (filePath == null || filePath === "") return undefined
  return path.resolve(baseDir, String(filePath))
}

export async function loadConnectorConfigFile(configFilePath) {
  if (!configFilePath) return null
  try {
    await fs.access(configFilePath)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null
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
  if (raw.stateFile != null && raw.stateFile !== "") out.stateFile = normalizePathValue(raw.stateFile, baseDir)
  if (raw.defaultProject != null && raw.defaultProject !== "") out.defaultProject = String(raw.defaultProject)
  if (raw.tgPrefix != null) out.tgPrefix = String(raw.tgPrefix)
  if (raw.echoFilterMode != null && raw.echoFilterMode !== "") out.echoFilterMode = String(raw.echoFilterMode)
  if (raw.logFormat != null && raw.logFormat !== "") out.logFormat = String(raw.logFormat)
  if (raw.allowInsecureHttp != null) out.allowInsecureHttp = parseConfigBool("allowInsecureHttp", raw.allowInsecureHttp)
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
      baseDir,
      sourceLabel: `config file (${configFilePath || "inline"})`,
    })
  }

  return {
    config: out,
    baseDir,
    configFilePath,
  }
}
