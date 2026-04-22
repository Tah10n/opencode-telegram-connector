#!/usr/bin/env node
import { buildRuntimeConfig, parseCliArgs } from "./config/runtime.js"
import { startConnector } from "./index.js"

async function main() {
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
  console.log("State:", stateFile)

  const shutdown = async () => {
    await stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
