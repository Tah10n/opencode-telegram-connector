import path from "node:path"
import { loadEnvFromFile, envOptional, envRequired, envInt, envBool } from "./env.js"
import { loadConnectorConfigFile } from "./file.js"
import { loadProjectsConfig } from "./projects.js"
import { normalizeLimits } from "../limits.js"

function resolveCliPath(filePath) {
  return filePath ? path.resolve(process.cwd(), filePath) : undefined
}

function resolveRuntimePath(filePath, runtimeBaseDir) {
  return filePath ? path.resolve(runtimeBaseDir, filePath) : undefined
}

function normalizeLogFormat(value) {
  const raw = String(value ?? "text").trim().toLowerCase()
  const format = raw || "text"
  if (format !== "text" && format !== "json") throw new Error("Invalid logFormat / CONNECTOR_LOG_FORMAT (expected 'text' or 'json')")
  return format
}

export function parseCliArgs(argv) {
  const out = {}
  const takeValue = (flag, i) => {
    const v = argv[i + 1]
    if (!v || v.startsWith("-")) throw new Error(`Missing value for ${flag}`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--env-file") out.envFile = takeValue(a, i++)
    else if (a === "--config-file") out.configFile = takeValue(a, i++)
    else if (a === "--projects-file") out.projectsFile = takeValue(a, i++)
    else if (a === "--projects-json") out.projectsJson = takeValue(a, i++)
    else if (a === "--state-file") out.stateFile = takeValue(a, i++)
    else if (a === "--help" || a === "-h") out.help = true
  }
  return out
}

export async function buildRuntimeConfig({ args = {}, cwd = process.cwd() } = {}) {
  const explicitConfigFile = args.configFile ? resolveCliPath(args.configFile) : undefined
  const defaultEnvBaseDir = explicitConfigFile ? path.dirname(explicitConfigFile) : path.resolve(cwd)
  const envFile = args.envFile ? resolveCliPath(args.envFile) : path.resolve(defaultEnvBaseDir, ".env")
  await loadEnvFromFile(envFile)
  const envBaseDir = path.dirname(envFile)

  const configFile = explicitConfigFile || path.resolve(envBaseDir, "connector.config.mjs")
  const fileConfig = await loadConnectorConfigFile(configFile)
  const configFromFile = fileConfig?.config || {}
  const configBaseDir = fileConfig?.baseDir || envBaseDir

  const telegram = {
    botToken: configFromFile.telegram?.botToken ?? envRequired("TELEGRAM_BOT_TOKEN"),
    allowedUserId: configFromFile.telegram?.allowedUserId ?? envInt("TELEGRAM_ALLOWED_USER_ID"),
  }
  if (!Number.isInteger(telegram.allowedUserId)) throw new Error("Missing/invalid TELEGRAM_ALLOWED_USER_ID")

  const cliProjectsFile = args.projectsFile ? resolveCliPath(args.projectsFile) : undefined
  const cliProjectsJson = args.projectsJson
  const legacyProjectsFile = resolveRuntimePath(envOptional("PROJECTS_FILE"), envBaseDir)
  const legacyProjectsJson = envOptional("PROJECTS_JSON")

  const projects = args.projectsFile || args.projectsJson
    ? await loadProjectsConfig({ projectsFile: cliProjectsFile, projectsJson: cliProjectsJson, baseDir: envBaseDir })
    : configFromFile.projects || (await loadProjectsConfig({ projectsFile: legacyProjectsFile, projectsJson: legacyProjectsJson, baseDir: envBaseDir }))

  const config = {
    telegram,
    projects,
    defaultProject: configFromFile.defaultProject ?? envOptional("DEFAULT_PROJECT"),
    stateFile: args.stateFile
      ? resolveCliPath(args.stateFile)
      : configFromFile.stateFile ?? resolveRuntimePath(envOptional("STATE_FILE"), envBaseDir),
    tgPrefix: configFromFile.tgPrefix ?? envOptional("TG_PREFIX", ""),
    echoFilterMode: configFromFile.echoFilterMode ?? envOptional("ECHO_FILTER_MODE", "recent"),
    allowInsecureHttp: configFromFile.allowInsecureHttp ?? envBool("OPENCODE_ALLOW_INSECURE_HTTP", false),
    logFormat: normalizeLogFormat(configFromFile.logFormat ?? envOptional("CONNECTOR_LOG_FORMAT", "text")),
    limits: normalizeLimits(configFromFile.limits || {}),
    cwd: configFromFile.cwd || configBaseDir,
  }

  return {
    config,
    envFile,
    configFile,
    loadedConfigFile: !!fileConfig,
  }
}
