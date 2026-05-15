import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  appleScriptQuote,
  buildServeArgs,
  launchDetachedProcess,
  safeAttachBaseUrl,
  shQuote,
} from "./shared.js"
import { spawn } from "node:child_process"

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

export async function openAttachWindowPosix({ directory, baseUrl, sessionId, platform }) {
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

export async function openAttachContinueWindowPosix({ directory, baseUrl, platform }) {
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

export async function startOpenCodeServeInWindowPosix({ directory, port, platform }) {
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
