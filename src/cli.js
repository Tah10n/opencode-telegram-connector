#!/usr/bin/env node
import { buildRuntimeConfig, parseCliArgs } from "./config/runtime.js"
import { startConnector } from "./index.js"

async function main() {
  const supervisorGuidance = "Run the connector under a supervisor (systemd, Docker restart policy, pm2, launchd, etc.) so fatal crashes restart automatically."
  let shutdownPromise = null
  let stopConnector = async () => {}

  const shutdown = async (exitCode = 0, { reason = "shutdown", fatal = false } = {}) => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      if (fatal) {
        console.error(`Fatal runtime failure (${reason}). ${supervisorGuidance}`)
      }
      try {
        await stopConnector()
      } catch (err) {
        console.error("Failed to stop connector cleanly:", err?.stack || err?.message || String(err))
      }
      process.exit(exitCode)
    })()
    return shutdownPromise
  }

  process.on("SIGINT", () => {
    void shutdown(0, { reason: "SIGINT" })
  })
  process.on("SIGTERM", () => {
    void shutdown(0, { reason: "SIGTERM" })
  })
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason?.stack || reason?.message || String(reason))
    void shutdown(1, { reason: "unhandledRejection", fatal: true })
  })
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err?.stack || err?.message || String(err))
    void shutdown(1, { reason: "uncaughtException", fatal: true })
  })

  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
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
    process.exit(0)
  }

  const { config } = await buildRuntimeConfig({ args })

  const { stop, stateFile } = await startConnector({ config })
  stopConnector = stop
  console.log("State:", stateFile)
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
