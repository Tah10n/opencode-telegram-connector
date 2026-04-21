#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnvFromFile, envOptional, envRequired, envInt, envBool } from "./config/env.js"
import { loadProjectsConfig } from "./config/projects.js"
import { startConnector } from "./index.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function resolveCliPath(filePath) {
  return filePath ? path.resolve(process.cwd(), filePath) : undefined
}

function resolveRuntimePath(filePath, runtimeBaseDir) {
  return filePath ? path.resolve(runtimeBaseDir, filePath) : undefined
}

function parseArgs(argv) {
  const out = {}
  const takeValue = (flag, i) => {
    const v = argv[i + 1]
    if (!v || v.startsWith("-")) throw new Error(`Missing value for ${flag}`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--env-file") out.envFile = takeValue(a, i++)
    else if (a === "--projects-file") out.projectsFile = takeValue(a, i++)
    else if (a === "--projects-json") out.projectsJson = takeValue(a, i++)
    else if (a === "--state-file") out.stateFile = takeValue(a, i++)
    else if (a === "--help" || a === "-h") out.help = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      [
        "telegram-opencode-connector",
        "\nOptions:",
        "  --env-file <path>",
        "  --projects-file <path>",
        "  --projects-json <json>",
        "  --state-file <path>",
      ].join("\n"),
    )
    process.exit(0)
  }

  const envFile = args.envFile ? resolveCliPath(args.envFile) : path.resolve(projectRoot, ".env")
  await loadEnvFromFile(envFile)
  const runtimeBaseDir = path.dirname(envFile)

  const telegram = {
    botToken: envRequired("TELEGRAM_BOT_TOKEN"),
    allowedUserId: envInt("TELEGRAM_ALLOWED_USER_ID"),
  }
  if (!Number.isInteger(telegram.allowedUserId)) throw new Error("Missing/invalid TELEGRAM_ALLOWED_USER_ID")

  const projectsFile = args.projectsFile
    ? resolveCliPath(args.projectsFile)
    : resolveRuntimePath(envOptional("PROJECTS_FILE"), runtimeBaseDir)
  const projectsJson = args.projectsJson || envOptional("PROJECTS_JSON")
  const projects = await loadProjectsConfig({ projectsFile, projectsJson, baseDir: runtimeBaseDir })

  const config = {
    telegram,
    projects,
    defaultProject: envOptional("DEFAULT_PROJECT"),
    stateFile: args.stateFile
      ? resolveCliPath(args.stateFile)
      : resolveRuntimePath(envOptional("STATE_FILE"), runtimeBaseDir),
    tgPrefix: envOptional("TG_PREFIX", ""),
    echoFilterMode: envOptional("ECHO_FILTER_MODE", "recent"),
    allowInsecureHttp: envBool("OPENCODE_ALLOW_INSECURE_HTTP", false),
    cwd: runtimeBaseDir,
  }

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
