import { spawn } from "node:child_process"
import {
  buildServeArgs,
  observeSpawnError,
  psQuote,
} from "./shared.js"

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
