import fs from "node:fs/promises"
import path from "node:path"

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
  if (!isPlainObject(raw)) throw new Error("Projects config must be a JSON object")

  const projects = {}
  for (const [alias, cfg] of Object.entries(raw)) {
    if (!alias || typeof alias !== "string") continue
    if (!isPlainObject(cfg)) throw new Error(`Project '${alias}' must be an object`)
    const directoryRaw = cfg.directory != null ? String(cfg.directory).trim() : ""
    const directory = directoryRaw ? path.resolve(resolvedBaseDir, directoryRaw) : undefined

    const port = cfg.port != null && cfg.port !== "" ? Number(cfg.port) : undefined
    if (port != null && !Number.isInteger(port)) throw new Error(`Project '${alias}' invalid port`)
    if (port != null && (port < 1 || port > 65535)) throw new Error(`Project '${alias}' invalid port range`)

    const baseUrlRaw = String(cfg.baseUrl ?? "").trim()
    const baseUrl = baseUrlRaw || (port ? `http://127.0.0.1:${port}` : "")
    if (!baseUrl) throw new Error(`Project '${alias}' missing baseUrl (or port)`)
    try {
      // Validate early to fail fast.
      new URL(baseUrl)
    } catch {
      throw new Error(`Project '${alias}' invalid baseUrl: ${baseUrl}`)
    }

    const autoStart = cfg.autoStart === true
    const startMode = cfg.startMode ? String(cfg.startMode) : "tui"
    if (startMode !== "tui" && startMode !== "serve") {
      throw new Error(`Project '${alias}' invalid startMode (expected 'tui' or 'serve')`)
    }

    const openAttachOnNew = cfg.openAttachOnNew === true

    if (autoStart && !directory) throw new Error(`Project '${alias}' autoStart requires 'directory'`)
    if (autoStart && !port) throw new Error(`Project '${alias}' autoStart requires 'port'`)
    const username = resolveAuthValue(cfg.username ?? "", cfg.usernameEnv)
    const password = resolveAuthValue(cfg.password ?? "", cfg.passwordEnv)
    projects[alias] = {
      baseUrl,
      directory,
      port,
      autoStart,
      startMode,
      openAttachOnNew,
      username: username ? String(username) : "",
      password: password ? String(password) : "",
      displayName: cfg.displayName ? String(cfg.displayName) : undefined,
    }
  }
  if (Object.keys(projects).length === 0) throw new Error("Projects config is empty")
  return projects
}
