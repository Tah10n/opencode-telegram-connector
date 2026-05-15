import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"
import { redactCmdlineSecrets, sanitizeBaseUrlForCli } from "../url-utils.js"
import {
  getLaunchSupport,
  isPidAlive,
  startOpenCodeServeDetached,
  waitForHealth,
} from "./launcher/shared.js"
import {
  findOpenCodeUiProcessWindows,
  isAnyOpenCodeUiRunningWindows,
  killProcessWindows,
  openAttachContinueWindowWindows,
  openAttachWindowWindows,
  startOpenCodeInNewWindowWindows,
  startOpenCodeServeDetachedWindows,
  startOpenCodeServeInNewWindowWindows,
  stopOpenCodeServeOnPort,
  stopOpenCodeUiOnPort,
} from "./launcher/windows.js"
import {
  openAttachContinueWindowPosix,
  openAttachWindowPosix,
  startOpenCodeServeInWindowPosix,
} from "./launcher/posix.js"

export {
  commandExistsOnPath,
  getLaunchSupport,
  startOpenCodeServeDetached,
  waitForHealth,
} from "./launcher/shared.js"

export {
  killProcessWindows,
  openAttachContinueWindowWindows,
  openAttachWindowWindows,
  startOpenCodeInNewWindowWindows,
  startOpenCodeServeDetachedWindows,
  startOpenCodeServeInNewWindowWindows,
  stopOpenCodeServeOnPort,
  stopOpenCodeUiOnPort,
} from "./launcher/windows.js"

export async function openAttachWindow({ directory, baseUrl, sessionId, platform = process.platform }) {
  if (platform === "win32") return openAttachWindowWindows({ directory, baseUrl, sessionId })
  return openAttachWindowPosix({ directory, baseUrl, sessionId, platform })
}

export async function openAttachContinueWindow({ directory, baseUrl, platform = process.platform }) {
  if (platform === "win32") return openAttachContinueWindowWindows({ directory, baseUrl })
  return openAttachContinueWindowPosix({ directory, baseUrl, platform })
}

export async function ensureOpenCodeRunning({ projectAlias, project, ocClient, logger, platform = process.platform, abortSignal }) {
  const launchSupport = getLaunchSupport({ project, platform })
  const serverLaunchMode = launchSupport.serverLaunchMode

  const maybeOpenAttachUi = async () => {
    if (!launchSupport.openTuiOnAutoStart || !launchSupport.canOpenAttachWindow) return
    if (platform === "win32") {
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
    await openAttachContinueWindow({
      directory: project?.directory,
      baseUrl: safe.url,
      platform,
    }).catch((err) => {
      logger?.error?.(`[${projectAlias}] Failed to open attach UI window: ${err?.message || String(err)}`)
    })
  }

  // Already up?
  // Do not auto-open a new attach/TUI window here: `openTuiOnAutoStart`
  // should only apply when this connector actually had to start the server.
  try {
    await ocClient.health({ signal: abortSignal })
    return { started: false, pid: null, stop: async () => {} }
  } catch (err) {
    if (err?.name === "AbortError" || abortSignal?.aborted) throw err
  }

  if (!project?.autoStart) {
    throw new Error(`Project '${projectAlias}' is down and autoStart=false`)
  }
  if (!project.directory || !project.port) {
    throw new Error(`Project '${projectAlias}' missing directory/port for autoStart`)
  }
  if (!launchSupport.canAutoStart) {
    throw new Error(
      `Project '${projectAlias}' cannot auto-start on platform '${platform}' with serverLaunchMode=${serverLaunchMode} and openTuiOnAutoStart=${launchSupport.openTuiOnAutoStart}.`,
    )
  }

  let pid = null
  let stop = async () => {}
  let startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`

  if (platform === "win32") {
    // If a UI is already running for this port, it may be in the middle of bringing the server up.
    let uiAlreadyRunning = false
    if (launchSupport.openTuiOnAutoStart) {
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
        try {
          await waitForHealth(ocClient, { timeoutMs: 15_000, logger, projectAlias, abortSignal })
          await ocClient.health({ signal: abortSignal })
          return { started: false, pid: null, stop: async () => {} }
        } catch (err) {
          if (err?.name === "AbortError" || abortSignal?.aborted) throw err
          await stopOpenCodeUiOnPort({ port: project.port, projectAlias, logger, platform })
        }
      }
    }

    await stopOpenCodeServeOnPort({ port: project.port, projectAlias, logger, platform })

    const res =
      serverLaunchMode === "window"
        ? await startOpenCodeServeInNewWindowWindows({
            directory: project.directory,
            port: project.port,
            windowStyle: "Normal",
          })
        : startOpenCodeServeDetachedWindows({ directory: project.directory, port: project.port })
    const proc = res.child || null
    pid = res.pid
    if (!pid && proc?.pid) pid = proc.pid
    startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`

    const launchError = await Promise.race([res.spawnError || Promise.resolve(null), delay(750).then(() => null)])
    if (launchError) throw new Error(`Failed to start opencode serve: ${launchError?.message || String(launchError)}`)

    // If it immediately exited (e.g. port conflict), don't block: health wait below will surface details.
    await delay(750)
    if (pid && !isPidAlive(pid)) {
      logger?.error?.(`[${projectAlias}] opencode serve exited immediately (port=${project.port})`)
    }

    stop = async () => {
      await killProcessWindows(pid)
    }
  } else {
    const res =
      serverLaunchMode === "window"
        ? await startOpenCodeServeInWindowPosix({ directory: project.directory, port: project.port, platform })
        : startOpenCodeServeDetached({ directory: project.directory, port: project.port })
    const child = res.child || null
    pid = res.pid ?? child?.pid ?? null
    startedMode = `${serverLaunchMode}+${launchSupport.openTuiOnAutoStart ? "tui" : "serve"}`
    const launchError = await Promise.race([res.spawnError || Promise.resolve(null), delay(750).then(() => null)])
    if (launchError) throw new Error(`Failed to start opencode serve: ${launchError?.message || String(launchError)}`)
    stop = async () => {
      try {
        if (pid) process.kill(pid, "SIGTERM")
      } catch {}
    }
  }

  logger?.info?.(`[${projectAlias}] started opencode (${startedMode}) pid=${pid || "?"} port=${project.port}`)
  try {
    await waitForHealth(ocClient, { timeoutMs: 180_000, logger, projectAlias, abortSignal })

    if (abortSignal?.aborted) {
      const err = new Error("Auto-start aborted")
      err.name = "AbortError"
      throw err
    }

    await maybeOpenAttachUi()
    return { started: true, pid, stop }
  } catch (err) {
    await Promise.resolve(stop?.()).catch(() => {})
    throw err
  }
}
