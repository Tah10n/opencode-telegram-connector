import fs from "node:fs/promises"
import path from "node:path"
import { normalizeConfiguredDirectory } from "../directory-paths.js"
import { normalizeEndpointBaseUrl } from "../url-utils.js"

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function resolveAuthValue(value, envName) {
  if (value != null && value !== "") return value
  if (!envName) return value
  const v = process.env[envName]
  return v == null || v === "" ? value : v
}

function parseJsonWithWindowsPathHint(text, { sourceLabel } = {}) {
  try {
    return JSON.parse(text)
  } catch (err) {
    const msg = err?.message || String(err)
    const hint =
      "Common on Windows: JSON strings cannot contain unescaped backslashes. " +
      "Use forward slashes (C:/Users/...) or escape backslashes (C:\\\\Users\\\\...)."
    throw new Error(`${sourceLabel ? `${sourceLabel}: ` : ""}Failed to parse JSON (${msg}). ${hint}`)
  }
}

function readOptionalBoolean(value, { alias, fieldName, defaultValue }) {
  if (value == null) return defaultValue
  if (typeof value === "boolean") return value
  throw new Error(`Project '${alias}' ${fieldName} must be a boolean`)
}

function validateProjectAlias(alias) {
  const trimmed = alias.trim()
  if (!trimmed) throw new Error("Project alias must not be empty")
  if (alias !== trimmed) throw new Error(`Project alias '${alias}' must not have leading or trailing whitespace`)
  if (alias.includes(":") || alias.includes("|")) throw new Error(`Project alias '${alias}' must not contain ':' or '|'`)
}

export async function loadProjectsConfig({ projectsFile, projectsJson, baseDir } = {}) {
  let raw
  let resolvedBaseDir = baseDir || process.cwd()
  if (projectsJson) {
    raw = parseJsonWithWindowsPathHint(projectsJson, { sourceLabel: "PROJECTS_JSON" })
  } else if (projectsFile) {
    const resolvedProjectsFile = path.resolve(projectsFile)
    resolvedBaseDir = path.dirname(resolvedProjectsFile)
    const content = await fs.readFile(resolvedProjectsFile, "utf8")
    raw = parseJsonWithWindowsPathHint(content, { sourceLabel: `PROJECTS_FILE (${resolvedProjectsFile})` })
  } else {
    throw new Error("Missing PROJECTS_FILE or PROJECTS_JSON")
  }
  return normalizeProjectsConfig(raw, { baseDir: resolvedBaseDir, sourceLabel: projectsFile ? `PROJECTS_FILE (${projectsFile})` : "PROJECTS_JSON" })
}

export function normalizeProjectsConfig(raw, { baseDir, sourceLabel } = {}) {
  const resolvedBaseDir = baseDir || process.cwd()
  if (!isPlainObject(raw)) throw new Error("Projects config must be a JSON object")

  const projects = {}
  for (const [alias, cfg] of Object.entries(raw)) {
    validateProjectAlias(alias)
    if (!isPlainObject(cfg)) throw new Error(`Project '${alias}' must be an object`)
    const directory = normalizeConfiguredDirectory(cfg.directory, { baseDir: resolvedBaseDir })

    const port = cfg.port != null && cfg.port !== "" ? Number(cfg.port) : undefined
    if (port != null && !Number.isInteger(port)) throw new Error(`Project '${alias}' invalid port`)
    if (port != null && (port < 1 || port > 65535)) throw new Error(`Project '${alias}' invalid port range`)

    const baseUrlRaw = String(cfg.baseUrl ?? "").trim()
    const baseUrlCandidate = baseUrlRaw || (port ? `http://127.0.0.1:${port}` : "")
    if (!baseUrlCandidate) throw new Error(`Project '${alias}' missing baseUrl (or port)`)
    let baseUrl
    try {
      // Validate early to fail fast.
      baseUrl = normalizeEndpointBaseUrl(baseUrlCandidate, { label: `Project '${alias}' baseUrl` })
    } catch (err) {
      throw new Error(`Project '${alias}' invalid baseUrl: ${err?.message || baseUrlCandidate}`)
    }

    const autoStart = readOptionalBoolean(cfg.autoStart, { alias, fieldName: "autoStart", defaultValue: false })
    if (cfg.startMode != null) {
      throw new Error(`Project '${alias}' uses removed setting 'startMode'. Use 'openTuiOnAutoStart' instead.`)
    }
    const serverLaunchModeRaw = cfg.serverLaunchMode ? String(cfg.serverLaunchMode).trim().toLowerCase() : ""
    if (serverLaunchModeRaw && serverLaunchModeRaw !== "background" && serverLaunchModeRaw !== "window") {
      throw new Error(`Project '${alias}' invalid serverLaunchMode (expected 'background' or 'window')`)
    }
    const serverLaunchMode = serverLaunchModeRaw || "background"
    const openTuiOnAutoStart = readOptionalBoolean(cfg.openTuiOnAutoStart, { alias, fieldName: "openTuiOnAutoStart", defaultValue: true })
    const openAttachOnNewModeRaw = cfg.openAttachOnNewMode ? String(cfg.openAttachOnNewMode).trim().toLowerCase() : ""
    if (openAttachOnNewModeRaw && openAttachOnNewModeRaw !== "new-window" && openAttachOnNewModeRaw !== "same-window") {
      throw new Error(`Project '${alias}' invalid openAttachOnNewMode (expected 'new-window' or 'same-window')`)
    }
    if (cfg.openAttachOnNew != null) {
      throw new Error(`Project '${alias}' uses removed setting 'openAttachOnNew'. Use 'openAttachOnNewMode' instead.`)
    }
    const openAttachOnNewMode = openAttachOnNewModeRaw || "same-window"

    if (autoStart && !directory) throw new Error(`Project '${alias}' autoStart requires 'directory'`)
    if (autoStart && !port) throw new Error(`Project '${alias}' autoStart requires 'port'`)
    const username = resolveAuthValue(cfg.username ?? "", cfg.usernameEnv)
    const password = resolveAuthValue(cfg.password ?? "", cfg.passwordEnv)
    projects[alias] = {
      baseUrl,
      directory,
      port,
      autoStart,
      serverLaunchMode,
      openTuiOnAutoStart,
      openAttachOnNewMode,
      username: username ? String(username) : "",
      password: password ? String(password) : "",
      displayName: cfg.displayName ? String(cfg.displayName) : undefined,
    }
  }
  if (Object.keys(projects).length === 0) throw new Error(`${sourceLabel ? `${sourceLabel}: ` : ""}Projects config is empty`)
  return projects
}
