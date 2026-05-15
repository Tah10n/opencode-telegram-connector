import { spawn } from "node:child_process"
import {
  psQuote,
  safeAttachBaseUrl,
} from "./shared.js"

const WINDOWS_CMD_UNSAFE_ATTACH_ARG_RE = /[\u0000-\u001f\u007f"%&|<>^]/

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
