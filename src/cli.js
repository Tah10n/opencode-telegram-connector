#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { buildRuntimeConfig, parseCliArgs } from "./config/runtime.js"
import { startConnector } from "./index.js"

const supervisorGuidance = "Run the connector under a supervisor (systemd, Docker restart policy, pm2, launchd, etc.) so fatal crashes restart automatically."

export function createShutdownHandler({ stopConnectorRef, exit, stderr }) {
  let shutdownPromise = null

  return async function shutdown(exitCode = 0, { reason = "shutdown", fatal = false } = {}) {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      let finalExitCode = exitCode
      if (fatal) {
        stderr(`Fatal runtime failure (${reason}). ${supervisorGuidance}`)
      }
      try {
        await stopConnectorRef.current()
      } catch (err) {
        stderr("Failed to stop connector cleanly:", err?.stack || err?.message || String(err))
        if (finalExitCode === 0) finalExitCode = 1
      }
      exit(finalExitCode)
    })()
    return shutdownPromise
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  processImpl = process,
  stdout = (...args) => console.log(...args),
  stderr = (...args) => console.error(...args),
  exit = (code) => process.exit(code),
  buildRuntimeConfigImpl = buildRuntimeConfig,
  startConnectorImpl = startConnector,
} = {}) {
  const stopConnectorRef = { current: async () => {} }
  const shutdown = createShutdownHandler({ stopConnectorRef, exit, stderr })

  processImpl.on("SIGINT", () => {
    void shutdown(0, { reason: "SIGINT" })
  })
  processImpl.on("SIGTERM", () => {
    void shutdown(0, { reason: "SIGTERM" })
  })
  processImpl.on("unhandledRejection", (reason) => {
    stderr("Unhandled promise rejection:", reason?.stack || reason?.message || String(reason))
    void shutdown(1, { reason: "unhandledRejection", fatal: true })
  })
  processImpl.on("uncaughtException", (err) => {
    stderr("Uncaught exception:", err?.stack || err?.message || String(err))
    void shutdown(1, { reason: "uncaughtException", fatal: true })
  })

  const args = parseCliArgs(argv)
  if (args.help) {
    stdout(
      [
        "telegram-opencode-connector",
        "\nOptions:",
        "  --env-file <path>",
        "  --config-file <path>",
        "  --projects-file <path>",
        "  --projects-json <json>",
        "  --state-file <path>",
      ].join("\n"),
    )
    exit(0)
    return
  }

  const { config } = await buildRuntimeConfigImpl({ args })

  const { stop, stateFile } = await startConnectorImpl({ config })
  stopConnectorRef.current = stop
  stdout("State:", stateFile)
}

function isCliEntrypoint() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isCliEntrypoint()) {
  runCli().catch((err) => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
