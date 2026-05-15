import { spawn } from "node:child_process"
import fsSync from "node:fs"
import path from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"
import { sanitizeBaseUrlForCli } from "../../url-utils.js"

const ATTACH_WINDOW_PLATFORMS = new Set(["win32", "linux", "darwin"])

export function normalizeServerLaunchMode(value) {
  return String(value || "background").trim().toLowerCase() === "window" ? "window" : "background"
}

export function resolveOpenTuiOnAutoStart(project) {
  return project?.openTuiOnAutoStart !== false
}

export function commandExistsOnPath(command, { platform = process.platform } = {}) {
  const raw = String(command || "").trim()
  if (!raw) return false

  const candidateNames = (() => {
    if (platform !== "win32") return [raw]
    const ext = path.extname(raw)
    if (ext) return [raw]
    const pathext = String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
    return [raw, ...pathext.map((value) => `${raw}${value.toLowerCase()}`), ...pathext.map((value) => `${raw}${value.toUpperCase()}`)]
  })()

  const looksLikePath = raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw)
  if (looksLikePath) {
    return candidateNames.some((candidate) => fsSync.existsSync(candidate))
  }

  const dirs = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return dirs.some((dir) => candidateNames.some((candidate) => fsSync.existsSync(path.join(dir, candidate))))
}

function hasLinuxGuiSession() {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

function hasLinuxTerminalLauncher() {
  const preferred = String(process.env.OPENCODE_TERMINAL || "").trim()
  const candidates = [...new Set([preferred, "x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "wezterm", "alacritty", "xterm"].filter(Boolean))]
  return candidates.some((candidate) => commandExistsOnPath(candidate, { platform: "linux" }))
}

function hasMacGuiSession() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false
  return true
}

function canOpenAttachWindowOnPlatform(platform) {
  if (!ATTACH_WINDOW_PLATFORMS.has(platform)) return false
  if (platform === "win32") return true
  if (platform === "linux") return hasLinuxGuiSession() && hasLinuxTerminalLauncher()
  if (platform === "darwin") return hasMacGuiSession() && commandExistsOnPath("osascript", { platform: "darwin" })
  return false
}

export function getLaunchSupport({ project, platform = process.platform } = {}) {
  const openTuiOnAutoStart = resolveOpenTuiOnAutoStart(project)
  const serverLaunchMode = normalizeServerLaunchMode(project?.serverLaunchMode)
  const autoStartConfigured = project?.autoStart === true && !!project?.directory && !!project?.port
  const canOpenAttachWindow = canOpenAttachWindowOnPlatform(platform)
  const canLaunchServerWindow = serverLaunchMode === "background" || canOpenAttachWindow
  const canAutoStart = autoStartConfigured && canLaunchServerWindow
  return {
    serverLaunchMode,
    openTuiOnAutoStart,
    autoStartConfigured,
    canAutoStart,
    canOpenAttachWindow,
    canAutoOpenTui: openTuiOnAutoStart && canOpenAttachWindow,
    canLaunchServerWindow,
  }
}

export function isTrueEnv(name) {
  const v = String(process.env?.[name] || "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on"
}

export function psQuote(s) {
  // single-quote for PowerShell, escape single quote by doubling
  return `'${String(s).replaceAll("'", "''")}'`
}

export function shQuote(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`
}

export function appleScriptQuote(s) {
  return `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function safeAttachBaseUrl(baseUrl) {
  const safe = sanitizeBaseUrlForCli(baseUrl)
  if (safe.seemsSensitive && !isTrueEnv("OPENCODE_ALLOW_SENSITIVE_BASEURL")) {
    throw new Error(
      "Refusing to open opencode attach window with URL credentials or sensitive query params. " +
        "Set OPENCODE_ALLOW_SENSITIVE_BASEURL=1 to override.",
    )
  }
  return safe
}

export function buildServeArgs(port) {
  const args = ["serve", "--port", String(port)]
  const debug = String(process.env.OPENCODE_SERVER_DEBUG || "").toLowerCase()
  const debugEnabled = debug === "1" || debug === "true" || debug === "yes" || debug === "y" || debug === "on"
  if (debugEnabled) args.push("--print-logs", "--log-level", "DEBUG")
  return args
}

export function launchDetachedProcess(command, args, { cwd, errorPrefix, successDelayMs = 40 } = {}) {
  return new Promise((resolve, reject) => {
    let child = null
    let settled = false
    let successTimer = null
    const finish = (err) => {
      if (settled) return
      settled = true
      if (successTimer) clearTimeout(successTimer)
      if (err) {
        reject(err)
        return
      }
      child?.unref?.()
      resolve()
    }

    try {
      child = spawn(command, args, {
        cwd,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      })
    } catch (err) {
      finish(new Error(`${errorPrefix}: ${err?.message || String(err)}`))
      return
    }

    child.on("spawn", () => {
      successTimer = setTimeout(() => finish(), Math.max(10, Number(successDelayMs) || 40))
      successTimer.unref?.()
    })
    child.on("error", (err) => finish(new Error(`${errorPrefix}: ${err?.message || String(err)}`)))
    child.on("close", (code) => {
      if (settled) return
      if (code === 0) {
        finish()
        return
      }
      finish(new Error(`${errorPrefix} (code=${code ?? "?"})`))
    })
  })
}

export function observeSpawnError(child) {
  if (!child) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (err = null) => {
      if (settled) return
      settled = true
      child.off?.("spawn", onSpawn)
      if (err) child.off?.("error", onError)
      resolve(err)
    }
    const onError = (err) => finish(err)
    const onSpawn = () => finish(null)
    child.once?.("error", onError)
    child.once?.("spawn", onSpawn)
  })
}

export async function waitForHealth(ocClient, { timeoutMs = 30_000, logger, projectAlias, abortSignal } = {}) {
  const started = Date.now()
  let backoff = 250
  let lastErr = null

  function throwAbortError() {
    const err = new Error("Aborted waiting for health")
    err.name = "AbortError"
    throw err
  }

  async function delayWithAbort(ms) {
    if (abortSignal?.aborted) throwAbortError()
    let onAbort = null
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(Object.assign(new Error("Aborted waiting for health"), { name: "AbortError" }))
      abortSignal?.addEventListener?.("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([delay(ms), abortPromise])
    } finally {
      if (onAbort) abortSignal?.removeEventListener?.("abort", onAbort)
    }
  }

  while (Date.now() - started < timeoutMs) {
    if (abortSignal?.aborted) throwAbortError()
    try {
      const h = await ocClient.health({ signal: abortSignal })
      if (h && (h.healthy === true || h.ok === true || h.version)) return h
    } catch (err) {
      if (err?.name === "AbortError") throw err
      lastErr = err
      // retry
      if (Date.now() - started > timeoutMs) throw err
    }
    await delayWithAbort(backoff)
    backoff = Math.min(2000, backoff * 2)
  }
  const detail = lastErr ? ` Last error: ${lastErr?.message || String(lastErr)}` : ""
  const msg = `Timed out waiting for health (${Math.round(timeoutMs / 1000)}s).${detail}`
  logger?.error?.(projectAlias ? `[${projectAlias}] ${msg}` : msg)
  throw new Error(msg)
}

export function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startOpenCodeServeDetached({ directory, port }) {
  const child = spawn("opencode", buildServeArgs(port), {
    cwd: directory,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  })
  const spawnError = observeSpawnError(child)
  child.unref()
  return { child, spawnError }
}
