import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"
import { redactCmdlineSecrets, sanitizeBaseUrlForCli } from "../url-utils.js"

const ATTACH_WINDOW_PLATFORMS = new Set(["win32", "linux", "darwin"])
const WINDOWS_CMD_UNSAFE_ATTACH_ARG_RE = /[\u0000-\u001f\u007f"%&|<>^]/

function normalizeServerLaunchMode(value) {
  return String(value || "background").trim().toLowerCase() === "window" ? "window" : "background"
}

function resolveOpenTuiOnAutoStart(project) {
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
  const canAutoStart = autoStartConfigured && canLaunchServerWindow && (!openTuiOnAutoStart || canOpenAttachWindow)
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

async function listOpenCodeProcessesWindows({ timeoutMs = 2500 } = {}) {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    "$procs = Get-CimInstance Win32_Process | Where-Object {",
    // Match opencode/opencode.cmd/opencode.exe but avoid obvious false positives like `opencode-cli`.
    "  $_.CommandLine -and ($_.CommandLine -match '(?i)(?<![\\w-])opencode(\\.cmd|\\.exe)?(?![\\w-])')",
    "} | Select-Object ProcessId, Name, CommandLine;",
    "$procs | ConvertTo-Json -Compress",
  ].join(" ")

  return new Promise((resolve, reject) => {
    let done = false
    const finish = (value, isErr = false) => {
      if (done) return
      done = true
      clearTimeout(t)
      if (isErr) reject(value)
      else resolve(value)
    }

    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    const t = setTimeout(() => {
      // Best-effort: don't let WMI/CIM hangs block autoStart.
      try {
        child.kill()
      } catch {}
      finish([])
    }, Math.max(1, Number(timeoutMs) || 2500))

    let out = ""
    // Drain stderr (avoid pipe backpressure). Content is ignored (best-effort).
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    child.stderr.on("data", () => {})
    child.on("error", (err) => finish(err, true))
    child.on("close", (code) => {
      // Even if CIM query fails, treat as "no procs" (best-effort).
      if (code !== 0) {
        finish([])
        return
      }
      const text = String(out || "").trim()
      if (!text) {
        finish([])
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed == null) {
          finish([])
          return
        }
        finish(Array.isArray(parsed) ? parsed : [parsed])
      } catch {
        // Unexpected output; best-effort fallback.
        finish([])
      }
    })
  })
}

function tokenizeCmdline(cmdline) {
  const s = String(cmdline || "")
  if (!s) return []
  const tokens = []
  // Extremely small tokenizer: extracts whitespace-delimited tokens, respecting simple quotes.
  // This is best-effort; Windows command lines can be tricky, but this reduces false positives.
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of s.matchAll(re)) {
    const tok = (m[1] ?? m[2] ?? m[3] ?? "").trim()
    if (tok) tokens.push(tok)
  }
  return tokens
}

function isOpenCodeServeCommandLine(cmdline) {
  const tokens = tokenizeCmdline(cmdline).map((t) => t.toLowerCase())
  if (!tokens.length) return false

  // Find the opencode executable token (may be a path).
  const openIdx = tokens.findIndex((t) => {
    const base = t.split(/[\\/]/).pop() || t
    return base === "opencode" || base === "opencode.exe" || base === "opencode.cmd"
  })
  if (openIdx === -1) return false

  // UI / interactive processes are typically `opencode attach ...`.
  const attachIdx = tokens.indexOf("attach")
  if (attachIdx !== -1 && attachIdx > openIdx) return false

  const serveIdx = tokens.indexOf("serve")
  return serveIdx !== -1 && serveIdx > openIdx
}

function isOpenCodeUiCommandLine(cmdline) {
  const tokens = tokenizeCmdline(cmdline).map((t) => t.toLowerCase())
  if (!tokens.length) return false

  const openIdx = tokens.findIndex((t) => {
    const base = t.split(/[\\/]/).pop() || t
    return base === "opencode" || base === "opencode.exe" || base === "opencode.cmd"
  })
  if (openIdx === -1) return false

  const attachIdx = tokens.indexOf("attach")
  if (attachIdx !== -1 && attachIdx > openIdx) return true

  // Older Windows TUI launches used `opencode . --port <port> --continue`.
  // Treat that shape as UI too, but avoid matching server/non-interactive commands.
  const serveIdx = tokens.indexOf("serve")
  if (serveIdx !== -1 && serveIdx > openIdx) return false
  const runIdx = tokens.indexOf("run")
  if (runIdx !== -1 && runIdx > openIdx) return false

  const dotIdx = tokens.findIndex((t, idx) => idx > openIdx && (t === "." || t === "./"))
  if (dotIdx === -1) return false
  const continueIdx = tokens.indexOf("--continue")
  if (continueIdx === -1 || continueIdx < dotIdx) return false
  return tokens.some((t, idx) => idx > openIdx && (t === "--port" || t.startsWith("--port=")))
}

function isTrueEnv(name) {
  const v = String(process.env?.[name] || "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on"
}

function extractPortsFromCommandLine(cmdline) {
  const s = String(cmdline || "")
  const ports = new Set()
  if (!s) return ports

  for (const m of s.matchAll(/\-\-port(?:\s+|=)(\d{2,5})\b/gi)) {
    const p = String(m?.[1] || "")
    if (p) ports.add(p)
  }

  // Also parse URL args like: `attach http://localhost:4100`.
  for (const m of s.matchAll(/\bhttps?:\/\/[^\s"']+/gi)) {
    try {
      const u = new URL(m[0])
      if (u.port) ports.add(String(u.port))
    } catch {
      // ignore
    }
  }

  return ports
}

async function isAnyOpenCodeUiRunningWindows({ port } = {}) {
  const wantPort = port == null ? null : String(port)
  const procs = await listOpenCodeProcessesWindows()
  for (const p of procs) {
    const cmd = String(p?.CommandLine || "")
    if (!cmd) continue
    if (!isOpenCodeUiCommandLine(cmd)) continue
    if (!wantPort) return true
    const ports = extractPortsFromCommandLine(cmd)
    if (ports.has(wantPort)) return true
  }
  return false
}

async function findOpenCodeUiProcessesWindows({ port } = {}) {
  const wantPort = port == null ? null : String(port)
  const procs = await listOpenCodeProcessesWindows()
  const matches = []
  for (const p of procs) {
    const cmd = String(p?.CommandLine || "")
    if (!cmd) continue
    if (!isOpenCodeUiCommandLine(cmd)) continue
    if (!wantPort) {
      matches.push({ pid: p?.ProcessId ?? null, cmd })
      continue
    }
    const ports = extractPortsFromCommandLine(cmd)
    if (ports.has(wantPort)) matches.push({ pid: p?.ProcessId ?? null, cmd })
  }
  return matches
}

async function findOpenCodeUiProcessWindows({ port } = {}) {
  return (await findOpenCodeUiProcessesWindows({ port }))[0] || null
}

async function findOpenCodeServeProcessesWindows({ port } = {}) {
  const wantPort = port == null ? null : String(port)
  if (!wantPort) return []
  const matches = []
  const procs = await listOpenCodeProcessesWindows()
  for (const p of procs) {
    const cmd = String(p?.CommandLine || "")
    if (!cmd || !isOpenCodeServeCommandLine(cmd)) continue
    const ports = extractPortsFromCommandLine(cmd)
    if (!ports.has(wantPort)) continue
    matches.push({ pid: p?.ProcessId ?? null, cmd })
  }
  return matches
}

export async function stopOpenCodeServeOnPort({ port, projectAlias, logger, platform = process.platform } = {}) {
  if (!port) return { stopped: false, count: 0, reason: "missing-port" }
  if (platform !== "win32") return { stopped: false, count: 0, reason: "unsupported-platform" }

  let matches = []
  try {
    matches = await findOpenCodeServeProcessesWindows({ port })
  } catch (err) {
    logger?.warn?.(`[${projectAlias || "opencode"}] failed to inspect opencode serve processes on port=${port}: ${err?.message || String(err)}`)
    return { stopped: false, count: 0, reason: "inspect-failed" }
  }
  let stopped = 0
  for (const match of matches) {
    if (!match?.pid) continue
    const cmd = redactCmdlineSecrets(String(match.cmd || ""))
    const shortCmd = cmd.length > 180 ? cmd.slice(0, 179) + "…" : cmd
    logger?.warn?.(`[${projectAlias || "opencode"}] stopping hung opencode serve pid=${match.pid} port=${port}`)
    logger?.debug?.(`[${projectAlias || "opencode"}] opencode serve cmdline: ${shortCmd}`)
    await killProcessWindows(match.pid)
    stopped += 1
  }
  return { stopped: stopped > 0, count: stopped, pids: matches.map((m) => m.pid).filter(Boolean) }
}

export async function stopOpenCodeUiOnPort({ port, projectAlias, logger, platform = process.platform } = {}) {
  if (!port) return { stopped: false, count: 0, reason: "missing-port" }
  if (platform !== "win32") return { stopped: false, count: 0, reason: "unsupported-platform" }

  let matches = []
  try {
    matches = await findOpenCodeUiProcessesWindows({ port })
  } catch (err) {
    logger?.warn?.(`[${projectAlias || "opencode"}] failed to inspect opencode UI processes on port=${port}: ${err?.message || String(err)}`)
    return { stopped: false, count: 0, reason: "inspect-failed" }
  }
  let stopped = 0
  for (const match of matches) {
    if (!match?.pid) continue
    const cmd = redactCmdlineSecrets(String(match.cmd || ""))
    const shortCmd = cmd.length > 180 ? cmd.slice(0, 179) + "…" : cmd
    logger?.warn?.(`[${projectAlias || "opencode"}] stopping stale opencode UI pid=${match.pid} port=${port}`)
    logger?.debug?.(`[${projectAlias || "opencode"}] opencode UI cmdline: ${shortCmd}`)
    await killProcessWindows(match.pid)
    stopped += 1
  }
  return { stopped: stopped > 0, count: stopped, pids: matches.map((m) => m.pid).filter(Boolean) }
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

function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function psQuote(s) {
  // single-quote for PowerShell, escape single quote by doubling
  return `'${String(s).replaceAll("'", "''")}'`
}

function shQuote(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`
}

function appleScriptQuote(s) {
  return `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function safeAttachBaseUrl(baseUrl) {
  const safe = sanitizeBaseUrlForCli(baseUrl)
  if (safe.seemsSensitive && !isTrueEnv("OPENCODE_ALLOW_SENSITIVE_BASEURL")) {
    throw new Error(
      "Refusing to open opencode attach window with URL credentials or sensitive query params. " +
        "Set OPENCODE_ALLOW_SENSITIVE_BASEURL=1 to override.",
    )
  }
  return safe
}

function requireWindowsCmdSafeAttachArg(value, label) {
  const text = String(value ?? "")
  if (WINDOWS_CMD_UNSAFE_ATTACH_ARG_RE.test(text)) {
    throw new Error(`Refusing to open opencode attach window via cmd.exe because ${label} contains cmd.exe metacharacters`)
  }
  return text
}

function quoteWindowsCmdArgument(value) {
  const text = String(value ?? "")
  return /\s/.test(text) ? `"${text}"` : text
}

function buildPosixShellCommand(argv, { directory } = {}) {
  const steps = []
  if (directory) steps.push(`cd ${shQuote(directory)}`)
  steps.push(argv.map((part) => shQuote(part)).join(" "))
  return [
    steps.join(" && "),
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    `  printf '\nOpenCode command failed (exit %s). Press Enter to close...' "$status"`,
    "  read _",
    "fi",
  ].join("; ")
}

function buildServeArgs(port) {
  const args = ["serve", "--port", String(port)]
  const debug = String(process.env.OPENCODE_SERVER_DEBUG || "").toLowerCase()
  const debugEnabled = debug === "1" || debug === "true" || debug === "yes" || debug === "y" || debug === "on"
  if (debugEnabled) args.push("--print-logs", "--log-level", "DEBUG")
  return args
}

function makeTempPidFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}.pid`)
}

function buildPosixServeWindowCommand({ directory, port, pidFile }) {
  const steps = []
  const serveCmd = ["opencode", ...buildServeArgs(port)].map((part) => shQuote(part)).join(" ")
  if (directory) steps.push(`cd ${shQuote(directory)}`)
  steps.push(`${serveCmd} & pid=$!; printf '%s' "$pid" > ${shQuote(pidFile)}; wait "$pid"`)
  return [
    steps.join(" && "),
    'status=$?',
    'rm -f ' + shQuote(pidFile),
    'if [ "$status" -ne 0 ]; then',
    `  printf '\nOpenCode server exited (status %s). Press Enter to close...' "$status"`,
    "  read _",
    "fi",
  ].join("; ")
}

async function waitForPidFile(pidFile, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 3000)
  while (Date.now() < deadline) {
    try {
      const text = String(await fs.readFile(pidFile, "utf8")).trim()
      const pid = Number(text)
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {}
    await delay(50)
  }
  return null
}

function launchDetachedProcess(command, args, { cwd, errorPrefix, successDelayMs = 40 } = {}) {
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

function observeSpawnError(child) {
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

async function openTerminalWindowMac({ shellCommand }) {
  const script = [
    'tell application "Terminal"',
    "activate",
    `do script ${appleScriptQuote(shellCommand)}`,
    "end tell",
  ]
  await new Promise((resolve, reject) => {
    const child = spawn("osascript", script.flatMap((line) => ["-e", line]), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", (spawnErr) => reject(new Error(`Failed to open macOS Terminal window: ${spawnErr?.message || String(spawnErr)}`)))
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to open macOS Terminal window (code=${code}): ${err || out}`))
        return
      }
      resolve()
    })
  })
}

function linuxTerminalCandidate(command, shellCommand) {
  switch (command) {
    case "gnome-terminal":
      return { command, args: ["--", "sh", "-lc", shellCommand] }
    case "konsole":
      return { command, args: ["-e", "sh", "-lc", shellCommand] }
    case "xfce4-terminal":
      return { command, args: ["--command", `sh -lc ${shQuote(shellCommand)}`] }
    case "kitty":
      return { command, args: ["--detach", "sh", "-lc", shellCommand] }
    case "wezterm":
      return { command, args: ["start", "--", "sh", "-lc", shellCommand] }
    case "alacritty":
      return { command, args: ["-e", "sh", "-lc", shellCommand] }
    case "xterm":
      return { command, args: ["-e", "sh", "-lc", shellCommand] }
    case "x-terminal-emulator":
    default:
      return { command, args: ["-e", "sh", "-lc", shellCommand] }
  }
}

async function openTerminalWindowLinux({ shellCommand, cwd }) {
  const preferred = String(process.env.OPENCODE_TERMINAL || "").trim()
  const candidates = [...new Set([preferred, "x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "wezterm", "alacritty", "xterm"].filter(Boolean))]
  let lastErr = null
  for (const name of candidates) {
    const candidate = linuxTerminalCandidate(name, shellCommand)
    try {
      await launchDetachedProcess(candidate.command, candidate.args, {
        cwd,
        errorPrefix: `Failed to launch terminal '${candidate.command}'`,
      })
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(lastErr ? `Failed to open Linux terminal window: ${lastErr.message}` : "Failed to open Linux terminal window")
}

async function openAttachWindowPosix({ directory, baseUrl, sessionId, platform }) {
  const safe = safeAttachBaseUrl(baseUrl)
  const shellCommand = buildPosixShellCommand(["opencode", "attach", String(safe.url), "--session", String(sessionId)], { directory })
  if (platform === "darwin") {
    await openTerminalWindowMac({ shellCommand })
    return
  }
  if (platform === "linux") {
    await openTerminalWindowLinux({ shellCommand, cwd: directory })
    return
  }
  throw new Error(`Opening an attach window is not supported on platform '${platform}'`)
}

async function openAttachContinueWindowPosix({ directory, baseUrl, platform }) {
  const safe = safeAttachBaseUrl(baseUrl)
  const shellCommand = buildPosixShellCommand(
    ["opencode", "attach", String(safe.url), "--continue", ...(directory ? ["--dir", String(directory)] : [])],
    { directory },
  )
  if (platform === "darwin") {
    await openTerminalWindowMac({ shellCommand })
    return
  }
  if (platform === "linux") {
    await openTerminalWindowLinux({ shellCommand, cwd: directory })
    return
  }
  throw new Error(`Opening an attach window is not supported on platform '${platform}'`)
}

async function startOpenCodeServeInWindowPosix({ directory, port, platform }) {
  const pidFile = makeTempPidFile("telegram-connector-opencode")
  const shellCommand = buildPosixServeWindowCommand({ directory, port, pidFile })
  try {
    if (platform === "darwin") {
      await openTerminalWindowMac({ shellCommand })
    } else if (platform === "linux") {
      await openTerminalWindowLinux({ shellCommand, cwd: directory })
    } else {
      throw new Error(`Opening a server window is not supported on platform '${platform}'`)
    }
    const pid = await waitForPidFile(pidFile)
    return { pid: Number.isInteger(pid) ? pid : null }
  } finally {
    await fs.rm(pidFile, { force: true }).catch(() => {})
  }
}

export async function startOpenCodeInNewWindowWindows({ directory, port, mode = "tui" }) {
  const args =
    mode === "serve"
      ? ["serve", "--port", String(port)]
      : [".", "--port", String(port), "--continue"]

  // Start-Process returns a process object with Id when -PassThru is used.
  // Use cmd.exe to reliably resolve `opencode` on PATH (works for .cmd shims too).
  const ps = [
    "$p = Start-Process -PassThru -FilePath cmd.exe -ArgumentList @(",
    psQuote("/c"),
    ",",
    psQuote("opencode"),
    args.length ? "," + args.map((a) => psQuote(a)).join(",") : "",
    ") -WorkingDirectory ",
    psQuote(directory),
    ";",
    "$p.Id",
  ].join("")

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to Start-Process opencode (code=${code}): ${err || out}`))
        return
      }
      const pid = Number(String(out).trim())
      resolve({ pid: Number.isFinite(pid) ? pid : null })
    })
  })
}

export async function startOpenCodeServeInNewWindowWindows({ directory, port, windowStyle = "Normal" }) {
  const allowedStyles = new Set(["Normal", "Hidden", "Minimized", "Maximized"])
  const style = allowedStyles.has(String(windowStyle)) ? String(windowStyle) : "Normal"

  const args = buildServeArgs(port)

  // Use cmd.exe so `.cmd` shims resolve correctly.
  const ps = [
    `$p = Start-Process -PassThru -WindowStyle ${style} -FilePath cmd.exe -ArgumentList @(`,
    psQuote("/c"),
    ",",
    psQuote("opencode"),
    args.length ? "," + args.map((a) => psQuote(a)).join(",") : "",
    ") -WorkingDirectory ",
    psQuote(directory),
    ";",
    "$p.Id",
  ].join("")

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString("utf8")))
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to Start-Process opencode serve (code=${code}): ${err || out}`))
        return
      }
      const pid = Number(String(out).trim())
      resolve({ pid: Number.isFinite(pid) ? pid : null })
    })
  })
}

export function startOpenCodeServeDetachedWindows({ directory, port }) {
  const child = spawn("cmd.exe", ["/c", "opencode", ...buildServeArgs(port)], {
    cwd: directory,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  })
  const spawnError = observeSpawnError(child)
  child.unref()
  return { child, spawnError }
}

export async function openAttachWindowWindows({ directory, baseUrl, sessionId }) {
  const safe = safeAttachBaseUrl(baseUrl)
  const args = [
    "attach",
    requireWindowsCmdSafeAttachArg(safe.url, "baseUrl"),
    "--session",
    requireWindowsCmdSafeAttachArg(sessionId, "sessionId"),
  ]
  const ps = [
    "Start-Process -FilePath cmd.exe -ArgumentList @(",
    psQuote("/c"),
    ",",
    psQuote("opencode"),
    ",",
    args.map((a) => psQuote(a)).join(","),
    ")",
    directory ? ` -WorkingDirectory ${psQuote(directory)}` : "",
    ";",
  ].join("")

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    let err = ""
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to open opencode attach window (code=${code}): ${err}`))
        return
      }
      resolve()
    })
  })
}

export async function openAttachContinueWindowWindows({ directory, baseUrl }) {
  const safe = safeAttachBaseUrl(baseUrl)
  const safeDirectory = directory ? requireWindowsCmdSafeAttachArg(directory, "directory") : ""
  const args = [
    "attach",
    requireWindowsCmdSafeAttachArg(safe.url, "baseUrl"),
    "--continue",
    ...(safeDirectory ? ["--dir", quoteWindowsCmdArgument(safeDirectory)] : []),
  ]
  const ps = [
    "Start-Process -WindowStyle Normal -FilePath cmd.exe -ArgumentList @(",
    // Use /c so an auto-opened TUI window exits with opencode instead of
    // lingering at a shell prompt after watchdog cleanup/restart.
    psQuote("/c"),
    ",",
    psQuote("opencode"),
    ",",
    args.map((a) => psQuote(a)).join(","),
    ")",
    safeDirectory ? ` -WorkingDirectory ${psQuote(safeDirectory)}` : "",
    ";",
  ].join("")

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    let err = ""
    child.stderr.on("data", (d) => (err += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to open opencode attach window (code=${code}): ${err}`))
        return
      }
      resolve()
    })
  })
}

export async function killProcessWindows(pid) {
  if (!pid) return
  await new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    child.on("close", () => resolve())
    child.on("error", () => resolve())
  })
}

export async function openAttachWindow({ directory, baseUrl, sessionId, platform = process.platform }) {
  if (platform === "win32") return openAttachWindowWindows({ directory, baseUrl, sessionId })
  return openAttachWindowPosix({ directory, baseUrl, sessionId, platform })
}

export async function openAttachContinueWindow({ directory, baseUrl, platform = process.platform }) {
  if (platform === "win32") return openAttachContinueWindowWindows({ directory, baseUrl })
  return openAttachContinueWindowPosix({ directory, baseUrl, platform })
}

export function startOpenCodeServeDetached({ directory, port }) {
  // Non-Windows: start as a detached background process.
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

export async function ensureOpenCodeRunning({ projectAlias, project, ocClient, logger, platform = process.platform, abortSignal }) {
  const launchSupport = getLaunchSupport({ project, platform })
  const serverLaunchMode = launchSupport.serverLaunchMode

  const maybeOpenAttachUi = async () => {
    if (!launchSupport.openTuiOnAutoStart || !launchSupport.canOpenAttachWindow) return
    if (platform === "win32") {
      // Only open a UI if one is not already present for this port.
      let uiAlreadyRunning = false
      let match = null
      try {
        match = await findOpenCodeUiProcessWindows({ port: project?.port })
        uiAlreadyRunning = !!match
      } catch (err) {
        const warn = logger?.warn || logger?.info || logger?.error
        warn?.(
          `[${projectAlias}] failed to detect existing opencode UI during attach; opening UI anyway: ${err?.message || String(err)}`,
        )
        uiAlreadyRunning = false
      }
      if (uiAlreadyRunning) {
        logger?.info?.(`[${projectAlias}] opencode UI already running for port=${project?.port} (pid=${match?.pid || "?"})`)
        const cmd = redactCmdlineSecrets(String(match?.cmd || ""))
        const shortCmd = cmd.length > 180 ? cmd.slice(0, 179) + "…" : cmd
        logger?.debug?.(`[${projectAlias}] opencode UI cmdline: ${shortCmd}`)
        return
      }
    }

    logger?.info?.(`[${projectAlias}] opening opencode TUI (attach --continue)`)
    const safe = sanitizeBaseUrlForCli(project?.baseUrl)
    if (safe.seemsSensitive) {
      logger?.warn?.(`[${projectAlias}] baseUrl contains sensitive URL parts; skipping auto-open attach UI window`)
      return
    }
    if (safe.hadUserInfo) {
      logger?.warn?.(`[${projectAlias}] baseUrl contains URL credentials; skipping auto-open attach UI window`)
      return
    }
    await openAttachContinueWindow({
      directory: project?.directory,
      baseUrl: safe.url,
      platform,
    }).catch((err) => {
      logger?.error?.(`[${projectAlias}] Failed to open attach UI window: ${err?.message || String(err)}`)
    })
  }

  // Already up?
  // Do not auto-open a new attach/TUI window here: `openTuiOnAutoStart`
  // should only apply when this connector actually had to start the server.
  try {
    await ocClient.health({ signal: abortSignal })
    return { started: false, pid: null, stop: async () => {} }
  } catch (err) {
    if (err?.name === "AbortError" || abortSignal?.aborted) throw err
  }

  if (!project?.autoStart) {
    throw new Error(`Project '${projectAlias}' is down and autoStart=false`)
  }
  if (!project.directory || !project.port) {
    throw new Error(`Project '${projectAlias}' missing directory/port for autoStart`)
  }
  if (!launchSupport.canAutoStart) {
    throw new Error(
      `Project '${projectAlias}' cannot auto-start on platform '${platform}' with serverLaunchMode=${serverLaunchMode} and openTuiOnAutoStart=${launchSupport.openTuiOnAutoStart}.`,
    )
  }

  let pid = null
  let stop = async () => {}
  let startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`

  if (platform === "win32") {
    // If a UI is already running for this port, it may be in the middle of bringing the server up.
    let uiAlreadyRunning = false
    if (launchSupport.openTuiOnAutoStart) {
      try {
        uiAlreadyRunning = await isAnyOpenCodeUiRunningWindows({ port: project.port })
      } catch (err) {
        // Fail-safe: avoid spawning a second UI if we couldn't determine.
        uiAlreadyRunning = true
        const warn = logger?.warn || logger?.info || logger?.error
        warn?.(
          `[${projectAlias}] failed to detect existing opencode UI; assuming present: ${err?.message || String(err)}`,
        )
      }

      if (uiAlreadyRunning) {
        try {
          await waitForHealth(ocClient, { timeoutMs: 15_000, logger, projectAlias, abortSignal })
          await ocClient.health({ signal: abortSignal })
          return { started: false, pid: null, stop: async () => {} }
        } catch (err) {
          if (err?.name === "AbortError" || abortSignal?.aborted) throw err
          await stopOpenCodeUiOnPort({ port: project.port, projectAlias, logger, platform })
        }
      }
    }

    await stopOpenCodeServeOnPort({ port: project.port, projectAlias, logger, platform })

    const res =
      serverLaunchMode === "window"
        ? await startOpenCodeServeInNewWindowWindows({
            directory: project.directory,
            port: project.port,
            windowStyle: "Normal",
          })
        : startOpenCodeServeDetachedWindows({ directory: project.directory, port: project.port })
    const proc = res.child || null
    pid = res.pid
    if (!pid && proc?.pid) pid = proc.pid
    startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`

    const launchError = await Promise.race([res.spawnError || Promise.resolve(null), delay(750).then(() => null)])
    if (launchError) throw new Error(`Failed to start opencode serve: ${launchError?.message || String(launchError)}`)

    // If it immediately exited (e.g. port conflict), don't block: health wait below will surface details.
    await delay(750)
    if (pid && !isPidAlive(pid)) {
      logger?.error?.(`[${projectAlias}] opencode serve exited immediately (port=${project.port})`)
    }

    stop = async () => {
      await killProcessWindows(pid)
    }
  } else {
    const res =
      serverLaunchMode === "window"
        ? await startOpenCodeServeInWindowPosix({ directory: project.directory, port: project.port, platform })
        : startOpenCodeServeDetached({ directory: project.directory, port: project.port })
    const child = res.child || null
    pid = res.pid ?? child?.pid ?? null
    startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`
    const launchError = await Promise.race([res.spawnError || Promise.resolve(null), delay(750).then(() => null)])
    if (launchError) throw new Error(`Failed to start opencode serve: ${launchError?.message || String(launchError)}`)
    stop = async () => {
      try {
        if (pid) process.kill(pid, "SIGTERM")
      } catch {}
    }
  }

  logger?.info?.(`[${projectAlias}] started opencode (${startedMode}) pid=${pid || "?"} port=${project.port}`)
  try {
    await waitForHealth(ocClient, { timeoutMs: 180_000, logger, projectAlias, abortSignal })

    if (abortSignal?.aborted) {
      const err = new Error("Auto-start aborted")
      err.name = "AbortError"
      throw err
    }

    await maybeOpenAttachUi()
    return { started: true, pid, stop }
  } catch (err) {
    await Promise.resolve(stop?.()).catch(() => {})
    throw err
  }
}
