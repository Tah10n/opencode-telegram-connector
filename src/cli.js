#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { buildRuntimeConfig, parseCliArgs } from "./config/runtime.js"
import { startConnector } from "./index.js"
import { runSetupCheck } from "./setup/check.js"
import { redactSensitiveText } from "./url-utils.js"

const supervisorGuidance = "Run the connector under a supervisor (systemd, Docker restart policy, pm2, launchd, etc.) so fatal crashes restart automatically."

export function safeErrorText(err) {
  return redactSensitiveText(err?.stack || err?.message || String(err))
}

function normalizeCliLogFormat(format) {
  return String(format || "").trim().toLowerCase() === "json" ? "json" : "text"
}

function envForProcess(processImpl) {
  return processImpl?.env || (processImpl === process ? process.env : {})
}

function markCliLogged(err) {
  if (err && typeof err === "object") err.cliLogged = true
  return err
}

function registerProcessHandler(processImpl, event, handler) {
  if (!processImpl || typeof processImpl.on !== "function") return () => {}
  processImpl.on(event, handler)
  return () => {
    if (typeof processImpl.off === "function") {
      processImpl.off(event, handler)
    } else if (typeof processImpl.removeListener === "function") {
      processImpl.removeListener(event, handler)
    }
  }
}

function registerCliProcessHandlers(processImpl, handlers) {
  const cleanupHandlers = handlers.map(([event, handler]) => registerProcessHandler(processImpl, event, handler))
  let cleaned = false
  return function cleanupProcessHandlers() {
    if (cleaned) return
    cleaned = true
    for (const cleanup of cleanupHandlers.toReversed()) cleanup()
  }
}

function createCliReporter({ stderr, getLogFormat, now = () => new Date().toISOString() }) {
  return {
    error(message, err) {
      const msg = String(message || "")
      if (normalizeCliLogFormat(getLogFormat?.()) === "json") {
        stderr(JSON.stringify({
          ts: now(),
          level: "error",
          msg: msg.replace(/:\s*$/, ""),
          ...(err == null ? {} : { error: safeErrorText(err) }),
        }))
        return
      }
      if (err == null) stderr(msg)
      else stderr(msg, safeErrorText(err))
    },
  }
}

export function createShutdownHandler({ stopConnectorRef, exit, stderr, reporter }) {
  let shutdownPromise = null
  const report = reporter || createCliReporter({ stderr, getLogFormat: () => "text" })

  return async function shutdown(exitCode = 0, { reason = "shutdown", fatal = false } = {}) {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      let finalExitCode = exitCode
      if (fatal) {
        report.error(`Fatal runtime failure (${reason}). ${supervisorGuidance}`)
      }
      try {
        await stopConnectorRef.current()
      } catch (err) {
        report.error("Failed to stop connector cleanly:", err)
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
  runSetupCheckImpl = runSetupCheck,
  registerProcessHandlers = true,
} = {}) {
  const stopConnectorRef = { current: async () => {} }
  let cliLogFormat = normalizeCliLogFormat(envForProcess(processImpl).CONNECTOR_LOG_FORMAT)
  const reporter = createCliReporter({ stderr, getLogFormat: () => cliLogFormat })
  let cleanupProcessHandlers = () => {}
  const shutdown = createShutdownHandler({
    stopConnectorRef,
    exit: (code) => {
      cleanupProcessHandlers()
      exit(code)
    },
    stderr,
    reporter,
  })

  if (registerProcessHandlers) {
    cleanupProcessHandlers = registerCliProcessHandlers(processImpl, [
      ["SIGINT", () => {
        void shutdown(0, { reason: "SIGINT" })
      }],
      ["SIGTERM", () => {
        void shutdown(0, { reason: "SIGTERM" })
      }],
      ["unhandledRejection", (reason) => {
        reporter.error("Unhandled promise rejection:", reason)
        void shutdown(1, { reason: "unhandledRejection", fatal: true })
      }],
      ["uncaughtException", (err) => {
        reporter.error("Uncaught exception:", err)
        void shutdown(1, { reason: "uncaughtException", fatal: true })
      }],
    ])
  }

  let args
  try {
    args = parseCliArgs(argv)
  } catch (err) {
    cleanupProcessHandlers()
    throw err
  }
  if (args.help) {
    stdout(
      [
        "telegram-opencode-connector",
        "\nModes:",
        "  check, --check        run guided setup checks without starting connector",
        "\nOptions:",
        "  --env-file <path>",
        "  --config-file <path>",
        "  --projects-file <path>",
        "  --projects-json <json>",
        "  --state-file <path>",
      ].join("\n"),
    )
    cleanupProcessHandlers()
    exit(0)
    return
  }

  if (args.check) {
    let report
    try {
      report = await runSetupCheckImpl({
        args,
        stdout,
        buildRuntimeConfigImpl,
        platform: processImpl?.platform || process.platform,
      })
    } catch (err) {
      cleanupProcessHandlers()
      throw err
    }
    cleanupProcessHandlers()
    exit(report?.exitCode === 0 ? 0 : 1)
    return
  }

  let config
  let stop
  let stateFile
  try {
    ;({ config } = await buildRuntimeConfigImpl({ args }))
    cliLogFormat = normalizeCliLogFormat(config?.logFormat)

    ;({ stop, stateFile } = await startConnectorImpl({
      config,
      deps: {
        requestRuntimeShutdown: ({ action } = {}) => shutdown(action === "restart" ? 1 : 0, { reason: `runtime ${action || "stop"}` }),
      },
    }))
  } catch (err) {
    cleanupProcessHandlers()
    reporter.error("Connector startup failed:", err)
    throw markCliLogged(err)
  }
  stopConnectorRef.current = stop
  const stateFileDisplay = redactSensitiveText(stateFile, { sensitivePaths: [{ path: stateFile, label: "state-file" }] })
  if (config?.logFormat === "json") {
    stdout(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "State file configured", stateFile: stateFileDisplay }))
  } else {
    stdout("State:", stateFileDisplay)
  }
  return { cleanupProcessHandlers }
}

export function isModuleEntrypoint(importMetaUrl, { argv = process.argv, env = process.env } = {}) {
  const candidates = [argv?.[1], env?.pm_exec_path]
  return candidates.some((entrypoint) => entrypoint && importMetaUrl === pathToFileURL(entrypoint).href)
}

export function isCliEntrypoint(options) {
  return isModuleEntrypoint(import.meta.url, options)
}

export function runCliEntrypoint(options = {}) {
  return runCli(options).catch((err) => {
    if (!err?.cliLogged) {
      const reporter = createCliReporter({
        stderr: options.stderr || console.error,
        getLogFormat: () => envForProcess(options.processImpl || process).CONNECTOR_LOG_FORMAT,
      })
      reporter.error("Connector startup failed:", err)
    }
    ;(options.exit || ((code) => process.exit(code)))(1)
  })
}

if (isCliEntrypoint()) {
  void runCliEntrypoint()
}
