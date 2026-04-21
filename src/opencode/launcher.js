import { spawn } from "node:child_process"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"
import { redactCmdlineSecrets, sanitizeBaseUrlForCli } from "../url-utils.js"

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
    // Treat anything that's not `opencode serve ...` as an interactive UI / attach.
    if (isOpenCodeServeCommandLine(cmd)) continue
    if (!wantPort) return true
    const ports = extractPortsFromCommandLine(cmd)
    if (ports.has(wantPort)) return true
  }
  return false
}

async function findOpenCodeUiProcessWindows({ port } = {}) {
  const wantPort = port == null ? null : String(port)
  const procs = await listOpenCodeProcessesWindows()
  for (const p of procs) {
    const cmd = String(p?.CommandLine || "")
    if (!cmd) continue
    if (isOpenCodeServeCommandLine(cmd)) continue
    if (!wantPort) return { pid: p?.ProcessId ?? null, cmd }
    const ports = extractPortsFromCommandLine(cmd)
    if (ports.has(wantPort)) return { pid: p?.ProcessId ?? null, cmd }
  }
  return null
}

export async function waitForHealth(ocClient, { timeoutMs = 30_000, logger, projectAlias } = {}) {
  const started = Date.now()
  let backoff = 250
  let lastErr = null
  while (Date.now() - started < timeoutMs) {
    try {
      const h = await ocClient.health()
      if (h && (h.healthy === true || h.ok === true || h.version)) return h
    } catch (err) {
      lastErr = err
      // retry
      if (Date.now() - started > timeoutMs) throw err
    }
    await delay(backoff)
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

export async function startOpenCodeServeInNewWindowWindows({ directory, port, windowStyle = "Minimized" }) {
  const allowedStyles = new Set(["Normal", "Hidden", "Minimized", "Maximized"])
  const style = allowedStyles.has(String(windowStyle)) ? String(windowStyle) : "Minimized"
  const debug = String(process.env.OPENCODE_SERVER_DEBUG || "").toLowerCase()
  const debugEnabled = debug === "1" || debug === "true" || debug === "yes" || debug === "y" || debug === "on"

  const args = ["serve", "--port", String(port)]
  if (debugEnabled) args.push("--print-logs", "--log-level", "DEBUG")

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

export async function openAttachWindowWindows({ directory, baseUrl, sessionId }) {
  const safe = sanitizeBaseUrlForCli(baseUrl)
  if (safe.seemsSensitive && !isTrueEnv("OPENCODE_ALLOW_SENSITIVE_BASEURL")) {
    throw new Error(
      "Refusing to open opencode attach window with URL credentials or sensitive query params. " +
        "Set OPENCODE_ALLOW_SENSITIVE_BASEURL=1 to override.",
    )
  }
  const args = ["attach", String(safe.url), "--session", String(sessionId)]
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
  const safe = sanitizeBaseUrlForCli(baseUrl)
  if (safe.seemsSensitive && !isTrueEnv("OPENCODE_ALLOW_SENSITIVE_BASEURL")) {
    throw new Error(
      "Refusing to open opencode attach window with URL credentials or sensitive query params. " +
        "Set OPENCODE_ALLOW_SENSITIVE_BASEURL=1 to override.",
    )
  }
  const args = [
    "attach",
    String(safe.url),
    "--continue",
    ...(directory ? ["--dir", String(directory)] : []),
  ]
  const ps = [
    "Start-Process -WindowStyle Normal -FilePath cmd.exe -ArgumentList @(",
    // Use /k to keep the window open if opencode exits with an error.
    psQuote("/k"),
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

export async function killProcessWindows(pid) {
  if (!pid) return
  await new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    child.on("close", () => resolve())
    child.on("error", () => resolve())
  })
}

export function startOpenCodeServeDetached({ directory, port }) {
  // Non-Windows: start as a detached background process.
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: directory,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  })
  child.unref()
  return { child }
}

export async function ensureOpenCodeRunning({ projectAlias, project, ocClient, logger }) {
  const requestedMode = project?.startMode ?? "tui"
  const platform = process.platform

  const maybeOpenAttachUi = async () => {
    if (platform !== "win32" || requestedMode !== "tui") return
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
    await openAttachContinueWindowWindows({
      directory: project?.directory,
      baseUrl: safe.url,
    }).catch((err) => {
      logger?.error?.(`[${projectAlias}] Failed to open attach UI window: ${err?.message || String(err)}`)
    })
  }

  // Already up?
  try {
    await ocClient.health()
    await maybeOpenAttachUi()
    return { started: false, pid: null, stop: async () => {} }
  } catch {}

  if (!project?.autoStart) {
    throw new Error(`Project '${projectAlias}' is down and autoStart=false`)
  }
  if (!project.directory || !project.port) {
    throw new Error(`Project '${projectAlias}' missing directory/port for autoStart`)
  }

  let pid = null
  let stop = async () => {}
  let startedMode = requestedMode

  if (platform === "win32") {
    // If a UI is already running for this port, it may be in the middle of bringing the server up.
    let uiAlreadyRunning = false
    if (requestedMode === "tui") {
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
        await waitForHealth(ocClient, { timeoutMs: 15_000, logger, projectAlias }).catch(() => {})
        try {
          await ocClient.health()
          return { started: false, pid: null, stop: async () => {} }
        } catch {}
      }
    }

    // Always start the server in headless mode (this is what the connector needs).
    const res = await startOpenCodeServeInNewWindowWindows({
      directory: project.directory,
      port: project.port,
      windowStyle: "Minimized",
    })
    pid = res.pid
    startedMode = requestedMode === "tui" ? "serve+tui" : "serve"

    // If it immediately exited (e.g. port conflict), don't block: health wait below will surface details.
    await delay(750)
    if (pid && !isPidAlive(pid)) {
      logger?.error?.(`[${projectAlias}] opencode serve exited immediately (port=${project.port})`)
    }

    stop = async () => {
      await killProcessWindows(pid)
    }
  } else {
    if (requestedMode === "tui") {
      throw new Error(
        `autoStart startMode=tui is currently supported only on Windows (need a terminal launcher). Start opencode manually for '${projectAlias}'.`,
      )
    }
    const { child } = startOpenCodeServeDetached({ directory: project.directory, port: project.port })
    pid = child.pid
    startedMode = "serve"
    stop = async () => {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }
  }

  logger?.info?.(`[${projectAlias}] started opencode (${startedMode}) pid=${pid || "?"} port=${project.port}`)
  await waitForHealth(ocClient, { timeoutMs: 180_000, logger, projectAlias })

  await maybeOpenAttachUi()
  return { started: true, pid, stop }
}
