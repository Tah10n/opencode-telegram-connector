import { setTimeout as delay } from "node:timers/promises"
import crypto from "node:crypto"
import { createCallbackHandlers } from "./connector/callbacks.js"
import { createCommandHandlers } from "./connector/commands.js"
import { promptIdentity, telegramUpdateIdempotencyKey } from "./connector/idempotency.js"
import { createMirroringHandlers } from "./connector/mirroring.js"
import { createOverviewHelpers } from "./connector/overview.js"
import { createPromptHandlers } from "./connector/prompts.js"
import { createPromptRecovery } from "./connector/prompt-recovery.js"
import { classifyBoundaryError, makeBoundaryError, normalizeBoundaryError } from "./boundary-errors.js"
import { TelegramClient, makeInlineKeyboard } from "./telegram/client.js"
import { formatMarkdownToTelegramHtmlBlocks, escapeHtml } from "./telegram/formatter.js"
import { ctxKeyFrom, threadIdOr0FromMessage } from "./telegram/routing.js"
import { OpenCodeClient } from "./opencode/client.js"
import { startOpenCodeSseLoop } from "./opencode/sse.js"
import { ensureStartupSession } from "./opencode/startup-session.js"
import { ensureOpenCodeRunning, openAttachWindow, stopOpenCodeServeOnPort, stopOpenCodeUiOnPort } from "./opencode/launcher.js"
import { extractPatchDiffText, extractPatchFiles, formatChangedFilesText } from "./message-display.js"
import { findSessionByShareUrl, parseSessionReference } from "./session-ref.js"
import { resolveSessionRoute } from "./session-route.js"
import { createLifecycleManager } from "./runtime/lifecycle.js"
import { startHealthServer } from "./runtime/health-server.js"
import { collectLoggerRedactionOptions, createConnectorLogger } from "./runtime/logger.js"
import { createRuntimeObservability } from "./runtime/observability.js"
import { createCorrelationId, getRequestContext, runWithRequestContext, withRequestContextFields } from "./runtime/request-context.js"
import { DEFAULT_FEED_MODE, StateStore, normalizeFeedMode, resolveDefaultStatePath, sessionKey } from "./state/store.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "./session-list.js"
import { sanitizeBaseUrlForDisplay } from "./url-utils.js"
import { normalizeLimits } from "./limits.js"
import { createParentSessionCache, LruMap, LruSet } from "./util/lru.js"
import { botCommandsForLocale, matchSupportedLocale, normalizeI18nConfig, normalizeLocale, t } from "./i18n/index.js"

function parseSseDebugFilter(rawValue) {
  const raw = String(rawValue || "").trim()
  if (!raw) return null
  const [projectAlias, sessionId] = raw.split(":", 2)
  return {
    projectAlias: projectAlias ? projectAlias.trim() : "",
    sessionId: sessionId ? sessionId.trim() : "",
  }
}

function makeCallbackStore() {
  const store = new LruMap(4000)
  const token = () => crypto.randomBytes(8).toString("base64url")
  const pack = (data) => {
    if (Buffer.byteLength(data, "utf8") <= 64) return data
    let t = ""
    for (let i = 0; i < 10; i++) {
      t = token()
      if (store.get(t) == null) break
    }
    store.set(t, data)
    return `cb|${t}`
  }
  const unpack = (data) => {
    if (typeof data !== "string") return null
    if (!data.startsWith("cb|")) return data
    const t = data.slice(3)
    return store.get(t) ?? null
  }
  return { pack, unpack }
}

function clampString(s, max) {
  const str = String(s ?? "")
  if (str.length <= max) return str
  return str.slice(0, Math.max(0, max - 1)) + "…"
}

function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

function isCommand(text) {
  return typeof text === "string" && text.trim().startsWith("/")
}

function parseCommand(text, { botUsername } = {}) {
  const trimmed = text.trim()
  const [cmd, ...rest] = trimmed.split(/\s+/)
  // Telegram may send commands as /cmd@BotName in groups.
  const [commandName, targetBot] = String(cmd || "").split("@", 2)
  const normalizedTargetBot = String(targetBot || "").trim().toLowerCase()
  const normalizedBotUsername = String(botUsername || "").trim().toLowerCase()
  if (normalizedTargetBot && normalizedBotUsername && normalizedTargetBot !== normalizedBotUsername) {
    return { cmd: null, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: false }
  }
  if (normalizedTargetBot && !normalizedBotUsername) {
    return { cmd: null, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: false }
  }
  const normalizedCmd = String(commandName || "")
    .toLowerCase()
  return { cmd: normalizedCmd, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: true }
}

function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function readPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readNonNegativeNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function normalizeOpenCodeWatchdogOptions(options = {}) {
  return {
    failureThreshold: Math.max(1, Math.floor(readPositiveNumber(options.failureThreshold ?? process.env.OPENCODE_WATCHDOG_FAILURE_THRESHOLD, 6))),
    windowMs: Math.max(1, Math.floor(readPositiveNumber(options.windowMs ?? process.env.OPENCODE_WATCHDOG_WINDOW_MS, 120_000))),
    cooldownMs: Math.max(0, Math.floor(readNonNegativeNumber(options.cooldownMs ?? process.env.OPENCODE_WATCHDOG_COOLDOWN_MS, 60_000))),
  }
}

function extractTextParts(message) {
  if (!message || !Array.isArray(message.parts)) return ""
  const parts = message.parts.filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
  return parts.map((p) => p.text).join("")
}

export async function startConnector({ config, logger: loggerIn, deps } = {}) {
  if (!config?.telegram?.botToken) throw new Error("config.telegram.botToken is required")
  config = { ...config, i18n: normalizeI18nConfig(config?.i18n || {}) }
  const logger = loggerIn || createConnectorLogger({ format: config?.logFormat, ...collectLoggerRedactionOptions(config) })
  const createStateStore = deps?.createStateStore || ((options) => new StateStore(options))
  const createTelegramClient = deps?.createTelegramClient || ((token, options) => new TelegramClient(token, options))
  const createOpenCodeClient = deps?.createOpenCodeClient || ((options) => new OpenCodeClient(options))
  const startSseLoop = deps?.startSseLoop || startOpenCodeSseLoop
  const startHealthServerFn = deps?.startHealthServer || startHealthServer
  const ensureStartupSessionFn = deps?.ensureStartupSession || ensureStartupSession
  const ensureOpenCodeRunningFn = deps?.ensureOpenCodeRunning || ensureOpenCodeRunning
  const stopOpenCodeServeOnPortFn = deps?.stopOpenCodeServeOnPort || stopOpenCodeServeOnPort
  const stopOpenCodeUiOnPortFn = deps?.stopOpenCodeUiOnPort || stopOpenCodeUiOnPort
  const openAttachWindowFn = deps?.openAttachWindow || deps?.openAttachWindowWindows || openAttachWindow
  const onFatalError =
    deps?.onFatalError ||
    ((err) => {
      queueMicrotask(() => {
        throw err
      })
    })
  const platform = deps?.platform || process.platform
  const sleep = deps?.delay || delay
  const wizardTtlMs = Number.isFinite(deps?.wizardTtlMs) ? Math.max(0, Number(deps.wizardTtlMs)) : 2 * 60 * 60 * 1000
  const wizardGcIntervalMs = Number.isFinite(deps?.wizardGcIntervalMs) ? Math.max(1, Number(deps.wizardGcIntervalMs)) : 10 * 60 * 1000
  const assistantDrainTimeoutMs = Number.isFinite(deps?.assistantDrainTimeoutMs) ? Math.max(1, Number(deps.assistantDrainTimeoutMs)) : 5000
  const openCodeWatchdog = normalizeOpenCodeWatchdogOptions(deps?.opencodeWatchdog ?? config?.opencodeWatchdog ?? {})
  const startedAt = Date.now()
  const sseDebugFilter = parseSseDebugFilter(process.env.DEBUG_SSE_ROUTING)
  if (sseDebugFilter?.projectAlias) {
    logger.info("SSE debug routing enabled:", process.env.DEBUG_SSE_ROUTING)
  }
  const mirrorCompaction = (() => {
    const raw = String(process.env.MIRROR_COMPACTION || "").trim().toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
  })()
  const limits = normalizeLimits(config?.limits ?? {}, { env: {} })
  const projects = config.projects
  const runtimeObservability = createRuntimeObservability({ projectAliases: Object.keys(projects) })

  const stateFile = config?.stateFile || resolveDefaultStatePath({ cwd: config?.cwd })
  const store = createStateStore({ filePath: stateFile, logger })
  await store.load()
  const recoverPendingPromptsOnStartup = Number.isInteger(store.get().updateOffset)

  async function flushCriticalState(operation) {
    if (typeof store?.flush !== "function") return
    try {
      await store.flush()
    } catch (err) {
      throw makeBoundaryError({
        source: "state",
        operation,
        kind: "durability",
        outcome: "fatal",
        message: `${operation} failed: ${err?.message || String(err)}`,
        cause: err,
      })
    }
  }

  // Log only aggregate persisted-state info; bindings themselves are sensitive.
  try {
    const st = store.get()
    const entries = Object.entries(st?.bindings || {})
    logger.info("State bindings:", entries.length)
  } catch {
    // ignore
  }

  function projectAliasFromTelegramParams(params) {
    const readParam = (name) => typeof params?.get === "function" ? params.get(name) : params?.[name]
    const chatId = Number(readParam("chat_id"))
    if (!Number.isFinite(chatId)) return undefined
    const threadIdOr0 = Number(readParam("message_thread_id") || 0)
    const binding = store.getBinding?.(ctxKeyFrom(chatId, Number.isFinite(threadIdOr0) ? threadIdOr0 : 0))
    return binding?.projectAlias
  }

  const tg = createTelegramClient(config.telegram.botToken, {
    logger,
    onApiFailure: ({ method, params, requestContext }) => {
      runtimeObservability.recordTelegramFailure({ projectAlias: projectAliasFromTelegramParams(params), operation: method })
      logger.debug?.("Telegram API delivery failure recorded", {
        source: "telegram",
        operation: method,
        correlationId: requestContext?.correlationId,
        ctxKey: requestContext?.ctxKey,
        projectAlias: requestContext?.projectAlias,
        sessionId: requestContext?.sessionId,
      })
    },
  })
  const me = await tg.getMe().catch(() => null)
  const hasTopicsEnabled = !!me?.has_topics_enabled
  const botUsername = typeof me?.username === "string" ? me.username : ""
  logger.info("Telegram bot:", me?.username ? `@${me.username}` : "(unknown)", "topics:", hasTopicsEnabled)

  // Best-effort: publish Telegram built-in command menus.
  // Note: Telegram expects command names WITHOUT the leading '/'.
  async function publishBotCommandMenus() {
    const i18nConfig = config.i18n
    const defaultLocale = i18nConfig.defaultLocale
    await tg.setMyCommands(botCommandsForLocale(defaultLocale))
    for (const locale of i18nConfig.botCommandLocales || []) {
      if (locale === defaultLocale) continue
      await tg.setMyCommands(botCommandsForLocale(locale), { language_code: locale })
    }
  }

  await publishBotCommandMenus().catch((err) => logger.error("Failed to set bot commands:", err?.message || String(err)))

  const ocByAlias = {}
  for (const [alias, p] of Object.entries(projects)) {
    ocByAlias[alias] = createOpenCodeClient({
      baseUrl: p.baseUrl,
      username: p.username,
      password: p.password,
      allowInsecureHttp: config.allowInsecureHttp === true,
    })
  }
  const lifecycle = createLifecycleManager()
  const abortController = new AbortController()

  function runtimeHealthSnapshot() {
    return runtimeObservability.buildHealthSnapshot({
      managedTasks: lifecycle.snapshot(),
      shutdownState: abortController.signal.aborted ? "stopping" : "running",
      state: typeof store.healthSnapshot === "function" ? store.healthSnapshot() : { loaded: true },
    })
  }

  if (config?.healthServer?.enabled === true) {
    const healthHandle = await startHealthServerFn({
      host: config.healthServer.host || "127.0.0.1",
      port: Number.isInteger(config.healthServer.port) ? config.healthServer.port : 8787,
      logger,
      getSnapshot: runtimeHealthSnapshot,
    })
    lifecycle.registerHandle("healthServer", healthHandle, {
      kind: "server",
      metadata: {
        source: "health",
        operation: "listen",
        host: config.healthServer.host || "127.0.0.1",
        port: typeof healthHandle?.address === "object" && healthHandle.address ? healthHandle.address.port : config.healthServer.port,
      },
    })
  }

  // Auto-start opencode servers (best-effort) and pick a startup session per project.
  // Important: do not block connector startup on auto-start (Telegram should stay responsive).
  const startInProgress = new Map() // alias -> Promise
  const autoStartHandleByProject = new Map() // alias -> latest auto-start handle
  const watchdogStateByProject = new Map() // alias -> { count, firstFailureAt, lastFailureAt, lastRestartAt }
  const watchdogRestartInProgress = new Map() // alias -> Promise
  const startupSessionByProject = {} // alias -> sessionId
  const startupSessionInProgress = new Map() // alias -> Promise<sessionId|null>

  function resetProjectHealthFailures(projectAlias) {
    if (!projectAlias) return
    const previous = watchdogStateByProject.get(projectAlias)
    if (!previous) return
    watchdogStateByProject.set(projectAlias, {
      count: 0,
      firstFailureAt: 0,
      lastFailureAt: 0,
      lastRestartAt: previous.lastRestartAt || 0,
    })
  }

  function shouldWatchProjectHealth(projectAlias) {
    const project = projects?.[projectAlias]
    return !!(project?.autoStart && project?.directory && project?.port)
  }

  async function stopTrackedAutoStartHandle(projectAlias, reason) {
    const previousHandle = autoStartHandleByProject.get(projectAlias)
    autoStartHandleByProject.delete(projectAlias)
    if (!previousHandle?.stop) return null
    try {
      await Promise.resolve(previousHandle.stop())
      return { stopped: true }
    } catch (err) {
      logger.warn(`[${projectAlias}] ${reason || "cleanup"} failed to stop managed opencode handle: ${err?.message || String(err)}`)
      return { stopped: false, reason: "stop-failed" }
    }
  }

  function logArtifactCleanupResult(projectAlias, artifact, result) {
    if (!result) return
    const details = [`stopped=${result.stopped === true}`, `count=${Number(result.count || 0)}`]
    if (result.reason) details.push(`reason=${result.reason}`)
    if (Array.isArray(result.pids) && result.pids.length) details.push(`pids=${result.pids.join(",")}`)
    const message = `[${projectAlias}] opencode ${artifact} cleanup: ${details.join(" ")}`
    if (result.stopped) logger.warn(message)
    else logger.info(message)
  }

  async function cleanupProjectOpenCodeArtifacts(projectAlias, { reason, stopTrackedHandle = false, stopUi = false, stopServe = false } = {}) {
    const project = projects?.[projectAlias]
    const summary = { projectAlias, port: project?.port ?? null, handle: null, ui: null, serve: null }
    if (!project) return summary

    logger.info(`[${projectAlias}] cleaning opencode runtime artifacts: ${reason || "cleanup"}`)

    if (stopTrackedHandle) {
      summary.handle = await stopTrackedAutoStartHandle(projectAlias, reason)
    }

    if (abortController.signal.aborted) return summary
    if (stopUi) {
      try {
        summary.ui = await Promise.resolve(
          stopOpenCodeUiOnPortFn({
            projectAlias,
            project,
            port: project?.port,
            logger,
            platform,
          }),
        )
        logArtifactCleanupResult(projectAlias, "UI", summary.ui)
      } catch (err) {
        summary.ui = { stopped: false, count: 0, reason: "stop-failed" }
        logger.warn(`[${projectAlias}] failed to stop opencode UI on port ${project?.port}: ${err?.message || String(err)}`)
      }
    }

    if (abortController.signal.aborted) return summary
    if (stopServe) {
      try {
        summary.serve = await Promise.resolve(
          stopOpenCodeServeOnPortFn({
            projectAlias,
            project,
            port: project?.port,
            logger,
            platform,
          }),
        )
        logArtifactCleanupResult(projectAlias, "serve", summary.serve)
      } catch (err) {
        summary.serve = { stopped: false, count: 0, reason: "stop-failed" }
        logger.warn(`[${projectAlias}] failed to stop opencode serve on port ${project?.port}: ${err?.message || String(err)}`)
      }
    }

    return summary
  }

  function scheduleProjectWatchdogRestart(projectAlias, reason) {
    if (!shouldWatchProjectHealth(projectAlias) || abortController.signal.aborted) return
    if (startInProgress.has(projectAlias) || watchdogRestartInProgress.has(projectAlias)) return

    const state = watchdogStateByProject.get(projectAlias) || {}
    const elapsedSinceRestart = Date.now() - (state.lastRestartAt || 0)
    if (state.lastRestartAt && elapsedSinceRestart < openCodeWatchdog.cooldownMs) return

    watchdogStateByProject.set(projectAlias, {
      count: 0,
      firstFailureAt: 0,
      lastFailureAt: 0,
      lastRestartAt: Date.now(),
    })

    const task = (async () => {
      logger.warn(`[${projectAlias}] watchdog restarting opencode after repeated retryable failures: ${reason || "unhealthy"}`)
      await cleanupProjectOpenCodeArtifacts(projectAlias, {
        reason: "watchdog restart",
        stopTrackedHandle: true,
        stopUi: true,
        stopServe: true,
      })

      if (abortController.signal.aborted) return null
      return startProjectInBackground(projectAlias, { notifyOnFailure: true })
    })().finally(() => {
      watchdogRestartInProgress.delete(projectAlias)
    })

    watchdogRestartInProgress.set(projectAlias, task)
    trackManagedPromise(`opencodeWatchdogRestart:${projectAlias}:${Date.now()}`, task, {
      kind: "task",
      metadata: { projectAlias, source: "opencode", operation: "watchdog restart" },
    })
  }

  function recordProjectHealthFailure(projectAlias, err, context = {}) {
    if (!shouldWatchProjectHealth(projectAlias) || abortController.signal.aborted) return
    const classification = classifyBoundaryError(err, {
      source: "opencode",
      operation: context.operation,
      method: context.method,
      pathname: context.pathname,
    })
    if (!classification.retryable) return
    if (startInProgress.has(projectAlias) || watchdogRestartInProgress.has(projectAlias)) return

    const nowMs = Date.now()
    const previous = watchdogStateByProject.get(projectAlias) || {}
    const firstFailureAt = previous.firstFailureAt && nowMs - previous.firstFailureAt <= openCodeWatchdog.windowMs ? previous.firstFailureAt : nowMs
    const count = firstFailureAt === previous.firstFailureAt ? (previous.count || 0) + 1 : 1
    const next = {
      count,
      firstFailureAt,
      lastFailureAt: nowMs,
      lastRestartAt: previous.lastRestartAt || 0,
    }
    watchdogStateByProject.set(projectAlias, next)

    if (count >= openCodeWatchdog.failureThreshold) {
      const where = [context.operation || classification.error?.operation, classification.kind].filter(Boolean).join(" / ")
      scheduleProjectWatchdogRestart(projectAlias, `${count} failures within ${Math.round(openCodeWatchdog.windowMs / 1000)}s${where ? ` (${where})` : ""}`)
    }
  }

  async function getStartupSession(alias, options) {
    try {
      const sessionId = await ensureStartupSessionFn({
        alias,
        startInProgress,
        startupSessionByProject,
        startupSessionInProgress,
        ocByAlias,
        logger,
        directory: projects?.[alias]?.directory,
        abortSignal: abortController.signal,
        ...(options || {}),
      })
      if (sessionId) runtimeObservability.recordLoopSuccess("startupSession", { projectAlias: alias })
      return sessionId
    } catch (err) {
      if (abortController.signal.aborted) return null
      const classification = classifyBoundaryError(err, {
        source: "opencode",
        operation: "startup session",
      })
      if (classification.retryable) {
        logLoopIssue("startupSession", classification.error, {
          projectAlias: alias,
          retryable: true,
          source: "opencode",
          operation: "startup session",
        })
      } else {
        logLoopIssue("startupSession", classification.error, {
          projectAlias: alias,
          source: "opencode",
          operation: "startup session",
        })
      }
      throw err
    }
  }

  function startProjectInBackground(alias, { notifyOnFailure = false } = {}) {
    if (startInProgress.has(alias)) return startInProgress.get(alias)

    const p = projects[alias]
    const oc = ocByAlias[alias]
    const promise = (async () => {
      try {
        logger.info(`[${alias}] autoStart check...`)
        const handle = await ensureOpenCodeRunningFn({
          projectAlias: alias,
          project: p,
          ocClient: oc,
          logger,
          platform,
          abortSignal: abortController.signal,
        })
        if (handle?.stop) {
          const managedHandle = trackManagedHandle(`autoStart-handle:${alias}`, handle, { kind: "task", metadata: { projectAlias: alias } })
          autoStartHandleByProject.set(alias, managedHandle)
        }
        resetProjectHealthFailures(alias)
        runtimeObservability.recordLoopSuccess("autoStart", { projectAlias: alias })
        markProjectUp(alias)
        await getStartupSession(alias, { waitForStart: false })
        return handle
      } catch (err) {
        if (abortController.signal.aborted) return null
        const classification = classifyBoundaryError(err, { source: "opencode", operation: "autoStart" })
        if (classification.retryable) {
          logLoopIssue("autoStart", classification.error, {
            projectAlias: alias,
            retryable: true,
            source: "opencode",
            operation: "autoStart",
          })
        } else {
          logLoopIssue("autoStart", classification.error, {
            projectAlias: alias,
            source: "opencode",
            operation: "autoStart",
          })
        }
        if (notifyOnFailure) {
          await notifyProjectUnavailable(alias, err, { force: true, platform }).catch(() => {})
        }
        return null
      } finally {
        startInProgress.delete(alias)
      }
    })()

    startInProgress.set(alias, promise)
    trackManagedPromise(`autoStart:${alias}`, promise, { kind: "task", metadata: { projectAlias: alias } })
    return promise
  }

  startManagedTask(
    "autoStart-kickoff",
    async () => {
      const aliases = Object.keys(projects).filter((a) => projects?.[a]?.autoStart)
      if (aliases.length) logger.info("Auto-start projects:", aliases.join(", "))
      await Promise.allSettled(aliases.map((alias) => startProjectInBackground(alias, { notifyOnFailure: true })))
    },
    { kind: "task", metadata: { source: "runtime", operation: "autoStart kickoff" } },
  )

  async function ensureProjectStarted(alias, ctxMeta) {
    if (!canAutoStartProject(alias, { platform })) {
      await sendToThread(
        ctxMeta,
        `Project '${alias}' cannot be auto-started. Check {autoStart:true, directory, port} and the project's launch settings (serverLaunchMode/openTuiOnAutoStart) in projects.json.`,
      ).catch(() => {})
      return
    }

    if (startInProgress.has(alias)) {
      await sendToThread(ctxMeta, `Starting '${alias}'…`).catch(() => {})
      return
    }

    const p = projects[alias]
    const task = (async () => {
      try {
        await sendToThread(ctxMeta, `Starting opencode for '${alias}'…`).catch(() => {})
        const handle = await startProjectInBackground(alias)
        if (!handle) throw new Error(`Project '${alias}' failed to start`)
        await sendToThread(ctxMeta, `Project '${alias}' is up: ${sanitizeBaseUrlForDisplay(p.baseUrl)}`).catch(() => {})
      } catch (err) {
        await sendToThread(ctxMeta, formatProjectUnavailable(alias, err)).catch(() => {})
      }
    })()
    trackManagedPromise(`manualStart:${alias}:${ctxMeta?.ctxKey || "unknown"}:${Date.now()}`, task, {
      kind: "task",
      metadata: { projectAlias: alias },
    })
    return task
  }

  for (const alias of Object.keys(projects)) {
    trackManagedPromise(`startupSession-prefetch:${alias}`, getStartupSession(alias, { waitForStart: false }).catch(() => null), {
      kind: "task",
      metadata: { projectAlias: alias },
    })
  }

  const cb = makeCallbackStore()
  const CHANGED_FILES_LIMIT = limits.changedFilesLimit
  const INLINE_DIFF_TEXT_MAX_CHARS = limits.inlineDiffTextMaxChars
  const STREAM_PREVIEW_MAX_CHARS = limits.streamPreviewMaxChars
  const TEXT_ATTACHMENT_THRESHOLD = limits.textAttachmentThreshold
  // Bound the amount of per-session state we keep.
  const forwardedBySession = new LruMap(2000) // sessionKey -> {user:LruSet, assistant:LruSet, changes:LruSet}
  const assistantDebounce = new Map() // `${projectAlias}:${sessionId}:${msgId}` -> { timer, run }
  const assistantPreviewBySession = new Map() // bound sessionKey -> { messageId, telegramMessageId, lastPreviewHtml, lastPreviewAt }
  const recentTgPromptsBySession = new LruMap(2000) // sessionKey -> LruSet(hash)
  const lastAssistantBySession = new LruMap(2000) // sessionKey -> { messageId, sessionId, text }
  const parentSessionBySession = createParentSessionCache(5000) // key `${projectAlias}:${sessionId}` -> parent session id or null
  const tuiActiveSessionStateByProject = new Map() // alias -> { currentSessionId, followCtxKey }
  const tuiActiveSessionUnsupportedProjects = new Set() // alias values where /tui/active-session is unavailable
  let flushPendingAssistantDeliveries = async () => {
    for (const entry of assistantDebounce.values()) clearTimeout(entry?.timer || entry)
    assistantDebounce.clear()
  }
  lifecycle.registerStopHook("assistantDebounce-cleanup", () => flushPendingAssistantDeliveries())

  const promptBaseline = {}
  const prompted = {}
  for (const alias of Object.keys(projects)) {
    promptBaseline[alias] = { loaded: false, permission: new Set(), question: new Set() }
    prompted[alias] = { permission: new LruSet(5000), question: new LruSet(5000) }
  }

  const rejectNoteAwaiting = new Map() // key ctxKey -> { projectAlias, permissionId }
  const awaitingCustomAnswer = new Map() // key ctxKey -> { projectAlias, requestId, qIndex }
  const questionWizards = new Map() // key `${projectAlias}:${requestId}` -> wizard

  const bindAliasAwaiting = new Map() // key ctxKey -> { startedAt }
  const overviewHelpers = createOverviewHelpers({
    projects,
    store,
    config,
    startInProgress,
    parseCtxKey,
    sendToThread,
    cb,
  })
  const {
    buildProjectsOverviewText,
    canAutoStartProject,
    isRetryableProjectError,
    formatProjectUnavailable,
    startServerKeyboard,
    notifyProjectUnavailable,
    markProjectUp,
    markProjectSseConnected,
    markProjectSseDown,
    getProjectSseStatus,
  } = overviewHelpers

  const promptHandlers = createPromptHandlers({
    store,
    tg,
    config,
    cb,
    ocByAlias,
    promptBaseline,
    prompted,
    questionWizards,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    sendToThread,
    sendBlocksToThread,
    parseCtxKey,
    clampString,
    recoverPendingPromptsOnStartup,
    markProjectUp,
    recordPromptDelivered: runtimeObservability.recordPromptDelivered,
    recordPromptAnswered: runtimeObservability.recordPromptAnswered,
  })
  const {
    getWizard,
    persistQuestionWizard,
    clearPersistedQuestionWizard,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    cloneWizardState,
    applyWizardState,
    sendCurrentQuestionStep,
    sendRejectNotePrompt,
    sendQuestionCustomAnswerPrompt,
    finishQuestionWizard,
    ensureBaselineLoaded,
    handlePermissionAsked,
    handleQuestionAsked,
  } = promptHandlers

  const { restorePendingPromptState } = createPromptRecovery({
    store,
    ocByAlias,
    prompted,
    questionWizards,
    wizardKey: promptHandlers.wizardKey,
    parseCtxKey,
    sendBlocksToThread,
    sendPermissionPrompt: promptHandlers.sendPermissionPrompt,
    sendCurrentQuestionStep,
    sendRejectNotePrompt,
    sendQuestionCustomAnswerPrompt,
    clearPersistedQuestionWizard,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    markProjectUp,
    recordPromptRecovery: runtimeObservability.recordPromptRecovery,
    recordPromptCleanup: runtimeObservability.recordPromptCleanup,
    resolveBoundRoute,
  })

  let fatalRuntimeErrorReported = false

  function trackManagedPromise(name, promise, { kind = "task", metadata, stop } = {}) {
    lifecycle.registerPromise(name, promise, { kind, metadata, stop })
    return promise
  }

  function trackManagedHandle(name, handle, { kind = "task", metadata } = {}) {
    return lifecycle.registerHandle(name, handle, { kind, metadata })
  }

  function recordLoopError(loopName, err, { projectAlias, source = projectAlias ? "opencode" : "runtime", operation, method, pathname } = {}) {
    const normalized = normalizeBoundaryError(err, {
      source,
      operation,
      method,
      pathname,
    })
    runtimeObservability.recordLoopError(loopName, { projectAlias, err: normalized })
    return normalized
  }

  function logLoopIssue(loopName, err, { projectAlias, retryable = false, source = projectAlias ? "opencode" : "runtime", operation, method, pathname } = {}) {
    const normalized = normalizeBoundaryError(err, {
      source,
      operation,
      method,
      pathname,
    })
    if (retryable) {
      runtimeObservability.recordLoopRetry(loopName, { projectAlias, err: normalized })
      logger.warn("Loop retryable error", {
        loop: loopName,
        projectAlias,
        source: normalized.source,
        operation: normalized.operation,
        method: normalized.method,
        pathname: normalized.pathname,
        outcome: normalized.outcome,
        kind: normalized.kind,
        status: normalized.status,
        code: normalized.code,
        retryable: true,
        error: normalized.message,
      })
    } else {
      runtimeObservability.recordLoopError(loopName, { projectAlias, err: normalized })
      logger.error("Loop error", {
        loop: loopName,
        projectAlias,
        source: normalized.source,
        operation: normalized.operation,
        method: normalized.method,
        pathname: normalized.pathname,
        outcome: normalized.outcome,
        kind: normalized.kind,
        status: normalized.status,
        code: normalized.code,
        retryable: false,
        error: normalized.message,
      })
    }
    return normalized
  }

  function recordLoopAbort(loopName, { projectAlias, reason } = {}) {
    runtimeObservability.recordLoopAbort(loopName, { projectAlias, reason })
    logger.info("Loop aborted", { loop: loopName, projectAlias, operation: "abort loop", reason: reason || "stopped" })
  }

  function reportFatalRuntimeError(err, { name, projectAlias } = {}) {
    if (fatalRuntimeErrorReported || abortController.signal.aborted) return
    fatalRuntimeErrorReported = true
    abortController.abort()
    logger.error("Fatal runtime error", { name, projectAlias, source: err?.source || "runtime", operation: err?.operation, kind: err?.kind, outcome: err?.outcome, error: err?.message || String(err) })
    onFatalError(err)
  }

  function startManagedTask(name, run, { kind = "task", metadata, fatalOnError = false } = {}) {
    const promise = (async () => {
      try {
        return await run()
      } catch (err) {
        if (abortController.signal.aborted) return null
        const normalized = logLoopIssue(name, err, {
          projectAlias: metadata?.projectAlias,
          source: metadata?.source || (metadata?.projectAlias ? "opencode" : "runtime"),
          operation: metadata?.operation,
          method: metadata?.method,
          pathname: metadata?.pathname,
        })
        if (fatalOnError) {
          reportFatalRuntimeError(normalized, {
            name,
            projectAlias: metadata?.projectAlias,
          })
          throw normalized
        }
        return null
      }
    })()
    trackManagedPromise(name, promise, { kind, metadata })
    return promise
  }

  async function sleepWithAbort(ms) {
    if (abortController.signal.aborted) return
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      abortController.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([sleep(ms), abortPromise])
    } finally {
      if (onAbort) abortController.signal.removeEventListener("abort", onAbort)
    }
  }

  async function waitForPromiseOrAbort(promise) {
    if (!promise || abortController.signal.aborted) return
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      abortController.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([Promise.resolve(promise).catch(() => {}), abortPromise])
    } finally {
      if (onAbort) abortController.signal.removeEventListener("abort", onAbort)
    }
  }

  const wizardGcTimer = setInterval(() => {
    const t = Date.now()
    for (const [k, w] of questionWizards.entries()) {
      const createdAt = typeof w?.createdAt === "number" ? w.createdAt : 0
      if (!createdAt || t - createdAt > wizardTtlMs) {
        const ctxKey = w?.ctx?.ctxKey
        const currentAwaiting = ctxKey ? awaitingCustomAnswer.get(ctxKey) : null
        if (currentAwaiting?.projectAlias === w?.projectAlias && currentAwaiting?.requestId === w?.request?.id) {
          setAwaitingCustomAnswerState(ctxKey, null)
        }
        prompted[w?.projectAlias]?.question.delete(promptIdentity(w?.request?.id || w?.id, w?.sessionID))
        prompted[w?.projectAlias]?.question.delete(w?.request?.id || w?.id)
        questionWizards.delete(k)
        clearPersistedQuestionWizard(w?.projectAlias, w?.request?.id || w?.id, w?.sessionID)
        runtimeObservability.recordPromptCleanup(w?.projectAlias, "stale")
        logger.info("Stale prompt wizard cleaned up:", w?.projectAlias || "unknown", w?.request?.id || w?.id || "unknown")
      }
    }
  }, wizardGcIntervalMs)
  wizardGcTimer.unref?.()
  lifecycle.registerTimer("questionWizard-gc", wizardGcTimer)

  const mirroringHandlers = createMirroringHandlers({
    ...promptHandlers,
    tg,
    store,
    config,
    projects,
    ocByAlias,
    cb,
    LruSet,
    CHANGED_FILES_LIMIT,
    INLINE_DIFF_TEXT_MAX_CHARS,
    STREAM_PREVIEW_MAX_CHARS,
    TEXT_ATTACHMENT_THRESHOLD,
    forwardedBySession,
    assistantDebounce,
    assistantPreviewBySession,
    recentTgPromptsBySession,
    lastAssistantBySession,
    sendToThread,
    sendBlocksToThread,
    resolveBoundRoute,
    logSseDebug,
    eventStartedAfterLaunch,
    clampString,
    mirrorCompaction,
    normalizeEpochMs,
    sleep,
    abortSignal: abortController.signal,
    recordAssistantMirrored: runtimeObservability.recordAssistantMirrored,
    recordNoisyEventSkipped: runtimeObservability.recordNoisyEventSkipped,
    recordAttachmentFallback: runtimeObservability.recordAttachmentFallback,
  })
  const {
    ensureRecentPromptSet,
    hashTextForEcho,
    getFeedMode,
    feedModeLabel,
    renderFeedSettings,
    renderChangedFilesView,
    extractAssistantDisplayText,
    deliverAssistantText,
    handleMessagePartUpdated,
    handleMessageUpdated,
    flushPendingAssistantDeliveries: drainPendingAssistantDeliveries,
  } = mirroringHandlers
  flushPendingAssistantDeliveries = drainPendingAssistantDeliveries

  function detectedLocaleFromTelegram(from) {
    if (config.i18n?.autoDetectTelegramLanguage === false) return ""
    return matchSupportedLocale(from?.language_code, config.i18n?.supportedLocales)
  }

  function effectiveLocaleForContext(ctxKey, detectedLocale = "") {
    const storedRecord = store.getLocaleRecord?.(ctxKey)
    if (storedRecord?.locale && (storedRecord.source === "manual" || config.i18n?.autoDetectTelegramLanguage !== false)) {
      return normalizeLocale(storedRecord.locale, config.i18n)
    }
    if (detectedLocale) return normalizeLocale(detectedLocale, config.i18n)
    return config.i18n?.defaultLocale || "en"
  }

  function ctxMetaWithLocale(ctxMeta) {
    if (!ctxMeta) return ctxMeta
    const chatId = ctxMeta.chatId
    const threadIdOr0 = ctxMeta.threadIdOr0 || 0
    const ctxKey = ctxMeta.ctxKey || ctxKeyFrom(chatId, threadIdOr0)
    return {
      ...ctxMeta,
      threadIdOr0,
      ctxKey,
      locale: effectiveLocaleForContext(ctxKey, ctxMeta.detectedLocale || ctxMeta.locale),
    }
  }

  function rememberTelegramLocale(ctxMeta) {
    if (!ctxMeta?.ctxKey || !ctxMeta.detectedLocale) return ctxMetaWithLocale(ctxMeta)
    store.noteTelegramLocale?.(ctxMeta.ctxKey, ctxMeta.detectedLocale)
    return ctxMetaWithLocale(ctxMeta)
  }

  function localize(ctxMetaOrLocale, key, params) {
    const locale = typeof ctxMetaOrLocale === "string" ? ctxMetaOrLocale : ctxMetaWithLocale(ctxMetaOrLocale)?.locale
    return t(locale || config.i18n?.defaultLocale || "en", key, params)
  }

  function ctxMetaFromMessage(msg, from = msg?.from) {
    const chatId = msg?.chat?.id
    const chatType = msg?.chat?.type
    const threadIdOr0 = threadIdOr0FromMessage(msg)
    const ctxKey = ctxKeyFrom(chatId, threadIdOr0)
    const detectedLocale = detectedLocaleFromTelegram(from || msg?.from)
    return ctxMetaWithLocale({ chatId, chatType, threadIdOr0, ctxKey, detectedLocale })
  }

  function requestContextForCtxMeta(ctxMeta, binding) {
    if (!ctxMeta) return {}
    return {
      chatId: ctxMeta.chatId,
      chatType: ctxMeta.chatType,
      threadIdOr0: ctxMeta.threadIdOr0,
      ctxKey: ctxMeta.ctxKey,
      ...(ctxMeta.locale ? { locale: ctxMeta.locale } : {}),
      ...(binding?.projectAlias ? { projectAlias: binding.projectAlias } : {}),
      ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
    }
  }

  function telegramUpdateContext(update) {
    const eventType = update?.message ? "message" : update?.callback_query ? "callback" : "unknown"
    const msg = update?.message || update?.callback_query?.message || null
    const from = update?.message?.from || update?.callback_query?.from || null
    const ctxMeta = msg ? ctxMetaFromMessage(msg, from) : null
    const binding = ctxMeta?.ctxKey ? store.getBinding(ctxMeta.ctxKey) : null
    return {
      correlationId: createCorrelationId("tg", [update?.update_id, eventType]),
      source: "telegram",
      operation: eventType,
      updateId: update?.update_id,
      eventType,
      ...requestContextForCtxMeta(ctxMeta, binding),
    }
  }

  function runTelegramUpdateContext(update, fn) {
    return runWithRequestContext(telegramUpdateContext(update), fn)
  }

  function isAllowedUser(from) {
    const allowedUserId = config.telegram.allowedUserId
    return from && typeof from.id === "number" && from.id === allowedUserId
  }

  async function sendToThread(ctxMeta, text, replyMarkup, options = {}) {
    ctxMeta = ctxMetaWithLocale(ctxMeta)
    if (!ctxMeta?.chatId) return
    return withRequestContextFields(requestContextForCtxMeta(ctxMeta, store.getBinding(ctxMeta.ctxKey)), async () => {
      try {
        await tg.sendMessage(ctxMeta.chatId, text, replyMarkup, {
          ...options,
          message_thread_id: ctxMeta.threadIdOr0 || undefined,
        })
      } catch (err) {
        throw normalizeBoundaryError(err, {
          source: "telegram",
          operation: "sendMessage",
          method: "POST",
          pathname: "/sendMessage",
          ...(err?.isBoundaryError === true ? {} : { outcome: "retryable" }),
        })
      }
    })
  }

  async function sendBlocksToThread(ctxMeta, blocks, replyMarkup) {
    ctxMeta = ctxMetaWithLocale(ctxMeta)
    if (!ctxMeta?.chatId) return
    return withRequestContextFields(requestContextForCtxMeta(ctxMeta, store.getBinding(ctxMeta.ctxKey)), async () => {
      try {
        await tg.sendHtmlBlocks(ctxMeta.chatId, blocks, replyMarkup, {
          message_thread_id: ctxMeta.threadIdOr0 || undefined,
        })
      } catch (err) {
        throw normalizeBoundaryError(err, {
          source: "telegram",
          operation: "sendHtmlBlocks",
          method: "POST",
          pathname: "/sendMessage",
          ...(err?.isBoundaryError === true ? {} : { outcome: "retryable" }),
        })
      }
    })
  }

  function parseCtxKey(key) {
    const m = String(key).match(/^(-?\d+):(\d+)$/)
    if (!m) return null
    return { chatId: Number(m[1]), threadIdOr0: Number(m[2]), ctxKey: key }
  }

  function formatThreadLabel(threadIdOr0) {
    return threadIdOr0 ? `topic ${threadIdOr0}` : "main"
  }

  async function deliverPendingRuntimeOnlineNotice() {
    const notice = store.getPendingRuntimeOnlineNotice?.()
    if (notice?.kind !== "restart" || !Number.isInteger(notice.chatId)) return

    try {
      await sendToThread(
        { chatId: notice.chatId, threadIdOr0: 0, ctxKey: ctxKeyFrom(notice.chatId, 0) },
        "Connector is online again after restart.",
      )
      store.clearPendingRuntimeOnlineNotice?.()
      await store.flush?.()
    } catch (err) {
      logger.error("Failed to send runtime restart online notice:", err?.message || String(err))
    }
  }

  async function validateProject(alias) {
    return withRequestContextFields({ projectAlias: alias }, async () => {
      const oc = ocByAlias[alias]
      if (!oc) throw new Error(`Unknown project: ${alias}`)
      await oc.health()
      resetProjectHealthFailures(alias)
      markProjectUp(alias)
      return oc
    })
  }

  async function bindCtxToSession(ctxMeta, projectAlias, sessionId) {
    return withRequestContextFields({ ...requestContextForCtxMeta(ctxMeta), projectAlias, sessionId }, async () => {
      const result = store.setBinding(ctxMeta.ctxKey, { projectAlias, sessionId }, { chatId: ctxMeta.chatId, threadIdOr0: ctxMeta.threadIdOr0 })
      logger.info("Telegram context bound to session", {
        source: "telegram",
        operation: "bind session",
        projectAlias,
        sessionId,
        ctxKey: ctxMeta.ctxKey,
        chatId: ctxMeta.chatId,
        threadIdOr0: ctxMeta.threadIdOr0,
      })
      return result
    })
  }

  function getBoundCtxForSession(projectAlias, sessionId) {
    if (!projectAlias || !sessionId) return null
    const route = store.get().sessionIndex?.[sessionKey(projectAlias, sessionId)]
    if (!route) return null
    const ctxKey = ctxKeyFrom(route.chatId, route.threadIdOr0)
    const binding = store.getBinding(ctxKey)
    if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
    return ctxMetaWithLocale({ chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey })
  }

  function parseBoundCtxKey(ctxKey) {
    const match = String(ctxKey || "").match(/^(-?\d+):(\d+)$/)
    if (!match) return null
    return ctxMetaWithLocale({ chatId: Number(match[1]), threadIdOr0: Number(match[2]), ctxKey: String(ctxKey) })
  }

  function primeTuiActiveSessionFollow(projectAlias, ctxMeta, sessionId, options = {}) {
    if (!projectAlias || !ctxMeta?.ctxKey || !sessionId) return
    const pendingTargetSessionId =
      typeof options?.pendingTargetSessionId === "string" && options.pendingTargetSessionId.trim() ? options.pendingTargetSessionId.trim() : null
    tuiActiveSessionStateByProject.set(projectAlias, {
      currentSessionId: sessionId,
      followCtxKey: ctxMeta.ctxKey,
      ...(pendingTargetSessionId ? { pendingTargetSessionId } : {}),
    })
  }

  async function syncProjectTuiActiveSession(projectAlias) {
    if (tuiActiveSessionUnsupportedProjects.has(projectAlias)) return
    const oc = ocByAlias[projectAlias]
    if (!oc?.getActiveTuiSession) return

    let activeSession = null
    try {
      activeSession = await oc.getActiveTuiSession({ timeoutMs: 2500, signal: abortController.signal })
    } catch (err) {
      const classification = classifyBoundaryError(err, {
        source: "opencode",
        operation: "GET /tui/active-session",
        method: "GET",
        pathname: "/tui/active-session",
      })
      if (classification.status === 404) {
        tuiActiveSessionUnsupportedProjects.add(projectAlias)
        logger.info(`[${projectAlias}] /tui/active-session is unavailable; disabling TUI session sync.`)
      }
      return
    }

    const activeSessionId = typeof activeSession?.id === "string" && activeSession.id.trim() ? activeSession.id.trim() : null
    let previous = tuiActiveSessionStateByProject.get(projectAlias)
    if (!previous) {
      const activeCtx = activeSessionId ? getBoundCtxForSession(projectAlias, activeSessionId) : null
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: activeCtx?.ctxKey || null,
      })
      return
    }

    const pendingTargetSessionId =
      typeof previous.pendingTargetSessionId === "string" && previous.pendingTargetSessionId.trim() ? previous.pendingTargetSessionId.trim() : null
    if (pendingTargetSessionId) {
      const followCtxKey = previous.followCtxKey || getBoundCtxForSession(projectAlias, pendingTargetSessionId)?.ctxKey || null
      const followBinding = followCtxKey ? store.getBinding(followCtxKey) : null
      if (followBinding?.projectAlias === projectAlias && followBinding.sessionId === pendingTargetSessionId) {
        if (activeSessionId === pendingTargetSessionId) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: activeSessionId,
            followCtxKey,
          })
          logger.info(`[${projectAlias}] confirmed pending TUI switch to session: ${activeSessionId}`)
          return
        }
        if (!activeSessionId || activeSessionId === previous.currentSessionId) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: previous.currentSessionId,
            followCtxKey,
            pendingTargetSessionId,
          })
          return
        }
      } else {
        tuiActiveSessionStateByProject.set(projectAlias, {
          currentSessionId: previous.currentSessionId,
          followCtxKey: previous.followCtxKey || null,
        })
        previous = tuiActiveSessionStateByProject.get(projectAlias)
      }
    }

    if (previous.currentSessionId === activeSessionId) {
      if (!previous.followCtxKey && activeSessionId) {
        const activeCtx = getBoundCtxForSession(projectAlias, activeSessionId)
        if (activeCtx?.ctxKey) {
          tuiActiveSessionStateByProject.set(projectAlias, {
            currentSessionId: activeSessionId,
            followCtxKey: activeCtx.ctxKey,
          })
        }
      }
      return
    }

    const followCtxKey = previous.followCtxKey || getBoundCtxForSession(projectAlias, previous.currentSessionId)?.ctxKey || null
    if (!activeSessionId) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: null,
        followCtxKey,
      })
      return
    }

    const targetCtx = getBoundCtxForSession(projectAlias, activeSessionId)
    if (!followCtxKey) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    const followBinding = store.getBinding(followCtxKey)
    if (followBinding?.projectAlias !== projectAlias) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    if (followBinding.sessionId === activeSessionId) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey,
      })
      return
    }

    const sourceCtx = parseBoundCtxKey(followCtxKey)
    if (!sourceCtx) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: targetCtx?.ctxKey || null,
      })
      return
    }

    if (targetCtx && targetCtx.ctxKey !== followCtxKey) {
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey,
      })
      logger.info(
        `[${projectAlias}] active TUI session ${activeSessionId} is already bound to another Telegram context; skipping auto-switch from ${followBinding.sessionId}.`,
      )
      return
    }

    try {
      await bindCtxToSession(sourceCtx, projectAlias, activeSessionId)
      await flushCriticalState("persist TUI active session binding")
    } catch (err) {
      try {
        store.setBinding(followCtxKey, followBinding, sourceCtx)
      } catch {}
      throw err
    }
    tuiActiveSessionStateByProject.set(projectAlias, {
      currentSessionId: activeSessionId,
      followCtxKey,
    })
    await sendToThread(sourceCtx, `TUI switched to session: ${activeSessionId}\nPrevious: ${followBinding.sessionId}`).catch(() => {})
    logger.info(`[${projectAlias}] synced Telegram binding to active TUI session: ${followBinding.sessionId} -> ${activeSessionId}`)
  }

  async function resolveBoundRoute(projectAlias, sessionId) {
    const oc = ocByAlias[projectAlias]
    if (!oc || !sessionId) return null
    return resolveSessionRoute({
      projectAlias,
      sessionId,
      sessionIndex: store.get().sessionIndex || {},
      getSession: (id) => oc.getSession(id),
      parentBySessionKey: parentSessionBySession,
      debug: shouldDebugSse(projectAlias, sessionId) ? (message) => logger.info(`[sse-debug] ${projectAlias} ${message}`) : undefined,
    })
  }

  function shouldDebugSse(projectAlias, sessionId) {
    if (!sseDebugFilter?.projectAlias) return false
    if (sseDebugFilter.projectAlias !== projectAlias) return false
    if (sseDebugFilter.sessionId && sseDebugFilter.sessionId !== sessionId) return false
    return true
  }

  function logSseDebug(projectAlias, sessionId, message) {
    if (!shouldDebugSse(projectAlias, sessionId)) return
    logger.info(`[sse-debug] ${projectAlias}${sessionId ? `:${sessionId}` : ""} ${message}`)
  }

  function eventStartedAfterLaunch(info, { allowCompletedAfterStart = false } = {}) {
    if (allowCompletedAfterStart) {
      const completedMs = normalizeEpochMs(info?.time?.completed)
      if (completedMs != null) return completedMs >= startedAt
      const updatedMs = normalizeEpochMs(info?.time?.updated)
      if (updatedMs != null) return updatedMs >= startedAt
    }
    const createdMs = normalizeEpochMs(info?.time?.created)
    if (createdMs != null) return createdMs >= startedAt
    return true
  }

  await deliverPendingRuntimeOnlineNotice()

  const commandHandlers = createCommandHandlers({
    ...overviewHelpers,
    ...promptHandlers,
    ...mirroringHandlers,
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    config,
    logger,
    platform,
    tg,
    cb,
    getStartupSession,
    openAttachWindowFn,
    validateProject,
    bindCtxToSession,
    primeTuiActiveSessionFollow,
    recordProjectHealthFailure,
    sendToThread,
    parseCtxKey,
    formatThreadLabel,
    buildRuntimeStatusLines: runtimeObservability.buildStatusLines,
    buildGlobalRuntimeStatusLines: () =>
      runtimeObservability.buildRuntimeStatusLines({
        managedTasks: lifecycle.snapshot(),
        shutdownState: abortController.signal.aborted ? "stopping" : "running",
      }),
    isCommand,
    parseCommand: (text) => parseCommand(text, { botUsername }),
    compareNumbers,
    lastAssistantBySession,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    bindAliasAwaiting,
    resolveBoundRoute,
    recordPromptAnswered: runtimeObservability.recordPromptAnswered,
    isAllowedUser,
    ctxMetaFromMessage,
    rememberTelegramLocale,
    ctxMetaWithLocale,
    t: localize,
    mirrorCompaction,
  })
  const { handleTelegramMessage, renderSessionsList, handleFeed } = commandHandlers

  const callbackHandlers = createCallbackHandlers({
    ...overviewHelpers,
    ...promptHandlers,
    ...mirroringHandlers,
    ...commandHandlers,
    store,
    config,
    projects,
    ocByAlias,
    tg,
    cb,
    logger,
    recordCallbackOutcome: runtimeObservability.recordCallbackOutcome,
    recordPromptAnswered: runtimeObservability.recordPromptAnswered,
    questionWizards,
    ctxMetaFromMessage,
    rememberTelegramLocale,
    ctxMetaWithLocale,
    t: localize,
    parseCtxKey,
    formatThreadLabel,
    isAllowedUser,
    bindCtxToSession,
    resolveBoundRoute,
    sendToThread,
    ensureProjectStarted,
    validateProject,
    getStartupSession,
    platform,
    requestRuntimeShutdown: deps?.requestRuntimeShutdown,
  })
  const { handleTelegramCallback } = callbackHandlers

  function sseRequestContextFields(projectAlias, evt) {
    const props = evt?.properties || {}
    const part = props?.part || {}
    const info = props?.info || {}
    const sessionId = props.sessionID || props.sessionId || part.sessionID || part.sessionId || ""
    const messageId = info.id || props.messageID || props.messageId || part.messageID || part.messageId || ""
    return {
      source: "opencode",
      operation: "handle SSE event",
      projectAlias,
      eventType: evt?.type || "unknown",
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(getRequestContext().correlationId ? {} : { correlationId: createCorrelationId("sse", [projectAlias, evt?.type || "event"]) }),
    }
  }

  async function onSseEvent({ projectAlias, evt }) {
    return runWithRequestContext(sseRequestContextFields(projectAlias, evt), async () => {
      const type = evt?.type
      const props = evt?.properties || {}

      function isInitialBaselinePrompt(kind) {
        const identity = promptIdentity(props?.id, props?.sessionID)
        const base = promptBaseline[projectAlias]
        return !!identity && !!base?.loaded && !!base[kind]?.has(identity)
      }

      if (type === "message.updated") {
        await handleMessageUpdated({ projectAlias, props })
        return false
      }

      if (type === "message.part.updated") {
        await handleMessagePartUpdated({ projectAlias, props })
        return false
      }

      if (type === "permission.asked") {
        if (isInitialBaselinePrompt("permission")) {
          logSseDebug(projectAlias, props.sessionID, `drop=permission_initial_baseline id=${props.id}`)
          return false
        }
        return handlePermissionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug })
      }

      if (type === "question.asked") {
        if (isInitialBaselinePrompt("question")) {
          logSseDebug(projectAlias, props.sessionID, `drop=question_initial_baseline id=${props.id}`)
          return false
        }
        return handleQuestionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug })
      }

      return false
    })
  }

  async function drainTelegramBacklogIfNeeded() {
    if (store.get().updateOffset != null) return
    logger.info("Draining Telegram backlog (first run)…")
    let offset = 0
    let backoff = 1000
    while (true) {
      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      let pollRetryAfterMs = null
      const updates = await tg
        .getUpdates({ offset, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
        .catch((err) => {
          if (abortController.signal.aborted) return null
          const classification = classifyBoundaryError(err, {
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          pollRetryAfterMs = classification.retryAfterMs
          logLoopIssue("backlogDrain", classification.error, {
            retryable: classification.retryable,
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          return null
        })

      if (abortController.signal.aborted) {
        recordLoopAbort("backlogDrain", { reason: "connector stop" })
        return
      }
      if (!Array.isArray(updates)) {
        await sleepWithAbort(pollRetryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

      runtimeObservability.recordLoopSuccess("backlogDrain")
      backoff = 1000
      if (updates.length === 0) break
      offset = updates[updates.length - 1].update_id + 1
      await sleepWithAbort(200)
    }
    store.setUpdateOffset(offset)
    await flushCriticalState("persist Telegram backlog offset")
    logger.info("Telegram backlog drained. Starting from offset:", offset)
  }

  async function telegramLoop() {
    await drainTelegramBacklogIfNeeded()
    let backoff = 1000
    while (!abortController.signal.aborted) {
      let pollRetryAfterMs = null
      const offset = store.get().updateOffset ?? 0
      const updates = await tg
        .getUpdates({ offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
        .catch((err) => {
          if (abortController.signal.aborted) return null
          const classification = classifyBoundaryError(err, {
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          pollRetryAfterMs = classification.retryAfterMs
          logLoopIssue("telegramPoll", classification.error, {
            retryable: classification.retryable,
            source: "telegram",
            operation: "getUpdates",
            method: "POST",
            pathname: "/getUpdates",
          })
          return null
        })
      if (abortController.signal.aborted) {
        recordLoopAbort("telegramPoll", { reason: "connector stop" })
        break
      }
      if (!Array.isArray(updates)) {
        // Avoid a tight loop on network/API errors.
        await sleepWithAbort(pollRetryAfterMs || backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }
      runtimeObservability.recordLoopSuccess("telegramPoll")
      if (updates.length === 0) {
        backoff = 1000
        continue
      }
      backoff = 1000
      for (const u of updates) {
        let shouldAdvanceOffset = false
        let retryDelayMs = 1000
        const updateKey = telegramUpdateIdempotencyKey(u?.update_id)
        if (updateKey && store.hasIdempotencyKey?.(updateKey)) {
          store.setUpdateOffset(u.update_id + 1)
          await flushCriticalState("persist replayed Telegram update offset")
          continue
        }
        await runTelegramUpdateContext(u, async () => {
          try {
            if (u.message) await handleTelegramMessage(u.message, { updateId: u.update_id })
            if (u.callback_query) await handleTelegramCallback(u.callback_query, { updateId: u.update_id })
            shouldAdvanceOffset = true
          } catch (err) {
            const classification = classifyBoundaryError(err)
            if (classification.retryable) {
              retryDelayMs = classification.retryAfterMs || retryDelayMs
              runtimeObservability.recordUpdateRetry()
              logger.warn("Retryable update handler error", {
                source: "telegram",
                operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
                updateId: u.update_id,
                outcome: classification.outcome,
                kind: classification.kind,
                status: classification.status,
                code: classification.code,
                retryable: true,
                error: classification.error.message,
              })
            } else {
              runtimeObservability.recordUpdateSkip()
              logger.error("Skipping non-retryable update", {
                source: "telegram",
                operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
                updateId: u.update_id,
                outcome: classification.outcome,
                kind: classification.kind,
                status: classification.status,
                code: classification.code,
                retryable: false,
                error: classification.error.message,
              })
              shouldAdvanceOffset = true
            }
          }
        })

        if (shouldAdvanceOffset) {
          store.markIdempotencyKey?.(updateKey, {
            kind: "telegram-update",
            updateId: u.update_id,
            operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
          })
          store.setUpdateOffset(u.update_id + 1)
          await flushCriticalState("persist Telegram update checkpoint")
        } else {
          await sleepWithAbort(retryDelayMs)
          break
        }
      }
    }
  }

  if (recoverPendingPromptsOnStartup) {
    try {
      const summary = await restorePendingPromptState()
      if (summary) {
        const totals = summary.totals || {}
        logger.info(
          "Pending prompt recovery:",
          `restored=${totals.restored || 0}`,
          `stale=${totals.stale || 0}`,
          `retryable=${totals.retryable || 0}`,
          `fatal=${totals.fatal || 0}`,
        )
        if ((totals.restored || 0) > 0 || (totals.stale || 0) > 0) await store.flush?.()
      }
    } catch (err) {
      logger.error("Failed to restore pending prompts:", err?.message || String(err))
    }
  }

  await Promise.all(Object.keys(projects).map((alias) => ensureBaselineLoaded(alias)))

  for (const alias of Object.keys(projects)) {
    startManagedTask(
      `sseStarter:${alias}`,
      async () => {
        await waitForPromiseOrAbort(startInProgress.get(alias))
        if (abortController.signal.aborted) return null
        const handle = startSseLoop({
          projectAlias: alias,
          ocClient: ocByAlias[alias],
          logger,
          onConnect: ({ projectAlias }) => {
            markProjectSseConnected(projectAlias)
            resetProjectHealthFailures(projectAlias)
            runtimeObservability.recordLoopSuccess("sse", { projectAlias, connected: true })
          },
          onEvent: onSseEvent,
          onError: ({ projectAlias, err }) => {
            markProjectSseDown(projectAlias)
            const classification = classifyBoundaryError(err, {
              source: "opencode",
              operation: "GET /event",
              method: "GET",
              pathname: "/event",
            })
            if (classification.retryable) {
              logLoopIssue("sse", classification.error, {
                projectAlias,
                retryable: true,
                source: "opencode",
                operation: "GET /event",
                method: "GET",
                pathname: "/event",
              })
              recordProjectHealthFailure(projectAlias, classification.error, {
                operation: "GET /event",
                method: "GET",
                pathname: "/event",
              })
            } else {
              logLoopIssue("sse", classification.error, {
                projectAlias,
                source: "opencode",
                operation: "GET /event",
                method: "GET",
                pathname: "/event",
              })
            }
            return notifyProjectUnavailable(projectAlias, err, { platform })
          },
          onAbort: ({ projectAlias, err }) => {
            recordLoopAbort("sse", { projectAlias, reason: err?.message || "aborted" })
          },
          abortSignal: abortController.signal,
        })
        trackManagedHandle(`sse:${alias}`, handle, { kind: "loop", metadata: { projectAlias: alias } })
        return handle
      },
      { kind: "task", metadata: { projectAlias: alias, source: "opencode", operation: "SSE start" }, fatalOnError: true },
    )
  }

  // Periodic prompt poll (helps when SSE is down).
  const promptPollPromise = startManagedTask(
    "promptPoll",
    async () => {
    while (!abortController.signal.aborted) {
      for (const alias of Object.keys(projects)) {
        try {
          await ensureBaselineLoaded(alias, { populateInitialSnapshot: false })
          if (!promptBaseline[alias]?.loaded) continue
          const oc = ocByAlias[alias]
          const [permsResult, questionsResult] = await Promise.allSettled([
            oc.listPermissions({ signal: abortController.signal }),
            oc.listQuestions({ signal: abortController.signal }),
          ])
          const perms = permsResult.status === "fulfilled" ? permsResult.value : null
          const questions = questionsResult.status === "fulfilled" ? questionsResult.value : null

          if (permsResult.status === "rejected") {
            const classification = classifyBoundaryError(permsResult.reason, {
              source: "opencode",
              operation: "GET /permission",
              method: "GET",
              pathname: "/permission",
            })
            logLoopIssue("promptPoll", classification.error, {
              projectAlias: alias,
              retryable: classification.retryable,
              source: "opencode",
              operation: "GET /permission",
              method: "GET",
              pathname: "/permission",
            })
            recordProjectHealthFailure(alias, classification.error, {
              operation: "GET /permission",
              method: "GET",
              pathname: "/permission",
            })
          }
          if (questionsResult.status === "rejected") {
            const classification = classifyBoundaryError(questionsResult.reason, {
              source: "opencode",
              operation: "GET /question",
              method: "GET",
              pathname: "/question",
            })
            logLoopIssue("promptPoll", classification.error, {
              projectAlias: alias,
              retryable: classification.retryable,
              source: "opencode",
              operation: "GET /question",
              method: "GET",
              pathname: "/question",
            })
            recordProjectHealthFailure(alias, classification.error, {
              operation: "GET /question",
              method: "GET",
              pathname: "/question",
            })
          }

          if (Array.isArray(perms) || Array.isArray(questions)) {
            resetProjectHealthFailures(alias)
            markProjectUp(alias)
            runtimeObservability.recordLoopSuccess("promptPoll", { projectAlias: alias })
          }
          if (Array.isArray(perms)) {
            for (const p of perms) {
              if (promptBaseline[alias].permission.has(promptIdentity(p?.id, p?.sessionID))) continue
              // send via SSE handler shape
              const delivered = await onSseEvent({ projectAlias: alias, evt: { type: "permission.asked", properties: p } })
              if (delivered) runtimeObservability.recordLoopFallbackHit("promptPoll", { projectAlias: alias })
            }
          }
          if (Array.isArray(questions)) {
            for (const q of questions) {
              if (promptBaseline[alias].question.has(promptIdentity(q?.id, q?.sessionID))) continue
              const delivered = await onSseEvent({ projectAlias: alias, evt: { type: "question.asked", properties: q } })
              if (delivered) runtimeObservability.recordLoopFallbackHit("promptPoll", { projectAlias: alias })
            }
          }
        } catch (err) {
          logLoopIssue("promptPoll", err, {
            projectAlias: alias,
            source: "opencode",
            operation: "prompt polling",
          })
        }
      }
      await sleepWithAbort(15_000)
    }
    for (const alias of Object.keys(projects)) {
      recordLoopAbort("promptPoll", { projectAlias: alias, reason: "connector stop" })
    }
  },
    { kind: "loop", metadata: { source: "opencode", operation: "prompt polling" }, fatalOnError: true },
  )

  const tuiActiveSessionSyncPromise = startManagedTask(
    "tuiActiveSessionSync",
    async () => {
      while (!abortController.signal.aborted) {
        for (const alias of Object.keys(projects)) {
          try {
            await syncProjectTuiActiveSession(alias)
          } catch (err) {
            logLoopIssue("tuiActiveSessionSync", err, {
              projectAlias: alias,
              retryable: true,
              source: "opencode",
              operation: "GET /tui/active-session",
              method: "GET",
              pathname: "/tui/active-session",
            })
          }
        }
        await sleepWithAbort(2_000)
      }
      for (const alias of Object.keys(projects)) {
        recordLoopAbort("tuiActiveSessionSync", { projectAlias: alias, reason: "connector stop" })
      }
    },
    { kind: "loop", metadata: { source: "opencode", operation: "GET /tui/active-session", pathname: "/tui/active-session" } },
  )

  const telegramLoopPromise = startManagedTask(
    "telegramLoop",
    telegramLoop,
    { kind: "loop", metadata: { source: "telegram", operation: "getUpdates", method: "POST", pathname: "/getUpdates" }, fatalOnError: true },
  )

  let stopPromise = null
  const stop = async () => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      logger.info("Stopping connector. Managed tasks:", lifecycle.snapshot().map((entry) => `${entry.kind}:${entry.name}`).join(", ") || "none")
      abortController.abort()
      await flushPendingAssistantDeliveries({ timeoutMs: assistantDrainTimeoutMs }).catch((err) => {
        logger.error("Failed to drain pending assistant deliveries during shutdown:", err?.message || String(err))
      })
      runtimeObservability.recordLoopSuccess("shutdown")
      await lifecycle.stopAll()
      await Promise.allSettled([telegramLoopPromise, promptPollPromise, tuiActiveSessionSyncPromise])
      try {
        await store.flush()
      } catch (err) {
        logger.error("Failed to flush state during shutdown:", err?.message || String(err))
        throw err
      }
    })()
    return stopPromise
  }

  return { stop, stateFile }
}
