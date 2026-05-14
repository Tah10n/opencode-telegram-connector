import { spawn } from "node:child_process"
import { redactCmdlineSecrets } from "../../url-utils.js"
import {
  buildServeArgs,
  observeSpawnError,
  psQuote,
  safeAttachBaseUrl,
} from "./shared.js"

const WINDOWS_CMD_UNSAFE_ATTACH_ARG_RE = /[\u0000-\u001f\u007f"%&|<>^]/

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

export async function isAnyOpenCodeUiRunningWindows({ port } = {}) {
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

export async function findOpenCodeUiProcessWindows({ port } = {}) {
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

export async function stopOpenCodeServeOnPort({ port, projectAlias, logger, platform = "win32" } = {}) {
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

export async function stopOpenCodeUiOnPort({ port, projectAlias, logger, platform = "win32" } = {}) {
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
