import { setTimeout as delay } from "node:timers/promises"
import crypto from "node:crypto"
import { createCallbackHandlers } from "./connector/callbacks.js"
import { createCommandHandlers } from "./connector/commands.js"
import { promptIdentity, telegramUpdateIdempotencyKey } from "./connector/idempotency.js"
import { createMirroringHandlers } from "./connector/mirroring.js"
import { createOverviewHelpers } from "./connector/overview.js"
import { createPromptHandlers } from "./connector/prompts.js"
import { createPromptRecovery } from "./connector/prompt-recovery.js"
import { classifyBoundaryError, normalizeBoundaryError } from "./boundary-errors.js"
import { TelegramClient, makeInlineKeyboard } from "./telegram/client.js"
import { formatMarkdownToTelegramHtmlBlocks, escapeHtml } from "./telegram/formatter.js"
import { ctxKeyFrom, threadIdOr0FromMessage } from "./telegram/routing.js"
import { OpenCodeClient } from "./opencode/client.js"
import { startOpenCodeSseLoop } from "./opencode/sse.js"
import { ensureStartupSession } from "./opencode/startup-session.js"
import { ensureOpenCodeRunning, openAttachWindow } from "./opencode/launcher.js"
import { extractPatchDiffText, extractPatchFiles, formatChangedFilesText } from "./message-display.js"
import { findSessionByShareUrl, parseSessionReference } from "./session-ref.js"
import { resolveSessionRoute } from "./session-route.js"
import { createLifecycleManager } from "./runtime/lifecycle.js"
import { createRuntimeObservability } from "./runtime/observability.js"
import { DEFAULT_FEED_MODE, StateStore, normalizeFeedMode, resolveDefaultStatePath, sessionKey } from "./state/store.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "./session-list.js"
import { sanitizeBaseUrlForDisplay } from "./url-utils.js"

function now() {
  return new Date().toISOString()
}

function defaultLogger() {
  return {
    info: (...args) => console.log(now(), ...args),
    warn: (...args) => console.warn(now(), ...args),
    error: (...args) => console.error(now(), ...args),
    debug: (...args) => console.debug(now(), ...args),
  }
}

function parseSseDebugFilter(rawValue) {
  const raw = String(rawValue || "").trim()
  if (!raw) return null
  const [projectAlias, sessionId] = raw.split(":", 2)
  return {
    projectAlias: projectAlias ? projectAlias.trim() : "",
    sessionId: sessionId ? sessionId.trim() : "",
  }
}

class LruSet {
  constructor(limit) {
    this.limit = limit
    this.map = new Map()
  }
  has(k) {
    return this.map.has(k)
  }
  add(k) {
    if (this.map.has(k)) this.map.delete(k)
    this.map.set(k, true)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
  delete(k) {
    return this.map.delete(k)
  }
}

class LruMap {
  constructor(limit) {
    this.limit = limit
    this.map = new Map()
  }
  get(k) {
    if (!this.map.has(k)) return undefined
    const v = this.map.get(k)
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k)
    this.map.set(k, v)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
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

function parseCommand(text) {
  const trimmed = text.trim()
  const [cmd, ...rest] = trimmed.split(/\s+/)
  // Telegram may send commands as /cmd@BotName in groups.
  const normalizedCmd = String(cmd || "")
    .toLowerCase()
    .split("@")[0]
  return { cmd: normalizedCmd, args: rest.join(" ").trim(), argv: rest }
}

function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function extractTextParts(message) {
  if (!message || !Array.isArray(message.parts)) return ""
  const parts = message.parts.filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
  return parts.map((p) => p.text).join("")
}

export async function startConnector({ config, logger: loggerIn, deps } = {}) {
  const logger = loggerIn || defaultLogger()
  const createStateStore = deps?.createStateStore || ((options) => new StateStore(options))
  const createTelegramClient = deps?.createTelegramClient || ((token) => new TelegramClient(token))
  const createOpenCodeClient = deps?.createOpenCodeClient || ((options) => new OpenCodeClient(options))
  const startSseLoop = deps?.startSseLoop || startOpenCodeSseLoop
  const ensureStartupSessionFn = deps?.ensureStartupSession || ensureStartupSession
  const ensureOpenCodeRunningFn = deps?.ensureOpenCodeRunning || ensureOpenCodeRunning
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
  const startedAt = Date.now()
  const sseDebugFilter = parseSseDebugFilter(process.env.DEBUG_SSE_ROUTING)
  if (sseDebugFilter?.projectAlias) {
    logger.info("SSE debug routing enabled:", process.env.DEBUG_SSE_ROUTING)
  }
  const mirrorCompaction = (() => {
    const raw = String(process.env.MIRROR_COMPACTION || "").trim().toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
  })()

  const stateFile = config?.stateFile || resolveDefaultStatePath({ cwd: config?.cwd })
  const store = createStateStore({ filePath: stateFile, logger })
  await store.load()
  const recoverPendingPromptsOnStartup = Number.isInteger(store.get().updateOffset)

  // Log only aggregate persisted-state info; bindings themselves are sensitive.
  try {
    const st = store.get()
    const entries = Object.entries(st?.bindings || {})
    logger.info("State bindings:", entries.length)
  } catch {
    // ignore
  }

  const tg = createTelegramClient(config.telegram.botToken)
  const me = await tg.getMe().catch(() => null)
  const hasTopicsEnabled = !!me?.has_topics_enabled
  logger.info("Telegram bot:", me?.username ? `@${me.username}` : "(unknown)", "topics:", hasTopicsEnabled)

  // Best-effort: publish Telegram built-in command menu.
  // Note: Telegram expects command names WITHOUT the leading '/'.
  await tg
    .setMyCommands([
      { command: "help", description: "Справка по командам" },
      { command: "projects", description: "Список проектов" },
      { command: "bind", description: "Привязать чат к проекту (спросит alias)" },
      { command: "new", description: "Создать новую сессию" },
      { command: "use", description: "Переключиться на сессию" },
      { command: "sessions", description: "Недавние сессии проекта" },
      { command: "model", description: "Настроить модель для текущего треда" },
      { command: "feed", description: "Настроить Telegram feed для треда" },
      { command: "status", description: "Показать текущую привязку" },
      { command: "runtime", description: "Показать состояние коннектора в личке" },
      { command: "bindings", description: "Показать все активные привязки в личке" },
      { command: "abort", description: "Прервать текущую сессию" },
      { command: "sendlast", description: "Отправить последнее сообщение модели" },
      { command: "unbind", description: "Убрать привязку" },
      { command: "cancel", description: "Отменить текущий ввод" },
    ])
    .catch((err) => logger.error("Failed to set bot commands:", err?.message || String(err)))

  const projects = config.projects
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
  const runtimeObservability = createRuntimeObservability({ projectAliases: Object.keys(projects) })
  const abortController = new AbortController()

  // Auto-start opencode servers (best-effort) and pick a startup session per project.
  // Important: do not block connector startup on auto-start (Telegram should stay responsive).
  const startInProgress = new Map() // alias -> Promise
  const startupSessionByProject = {} // alias -> sessionId
  const startupSessionInProgress = new Map() // alias -> Promise<sessionId|null>

  async function getStartupSession(alias, options) {
    try {
      const sessionId = await ensureStartupSessionFn({
        alias,
        startInProgress,
        startupSessionByProject,
        startupSessionInProgress,
        ocByAlias,
        logger,
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
          trackManagedHandle(`autoStart-handle:${alias}`, handle, { kind: "task", metadata: { projectAlias: alias } })
        }
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
  const CHANGED_FILES_LIMIT = 10
  const INLINE_DIFF_TEXT_MAX_CHARS = 2500
  const STREAM_PREVIEW_MAX_CHARS = 3500
  const TEXT_ATTACHMENT_THRESHOLD = 12_000
  // Bound the amount of per-session state we keep.
  const forwardedBySession = new LruMap(2000) // sessionKey -> {user:LruSet, assistant:LruSet, changes:LruSet}
  const assistantDebounce = new Map() // `${projectAlias}:${sessionId}:${msgId}` -> timeout
  const assistantPreviewBySession = new Map() // bound sessionKey -> { messageId, telegramMessageId, lastPreviewHtml, lastPreviewAt }
  const recentTgPromptsBySession = new LruMap(2000) // sessionKey -> LruSet(hash)
  const lastAssistantBySession = new LruMap(2000) // sessionKey -> { messageId, sessionId, text }
  const parentSessionBySession = new Map() // key `${projectAlias}:${sessionId}` -> parent session id or null
  const tuiActiveSessionStateByProject = new Map() // alias -> { currentSessionId, followCtxKey }
  const tuiActiveSessionUnsupportedProjects = new Set() // alias values where /tui/active-session is unavailable
  lifecycle.registerStopHook("assistantDebounce-cleanup", () => {
    for (const timer of assistantDebounce.values()) clearTimeout(timer)
    assistantDebounce.clear()
  })

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
  })

  let fatalRuntimeErrorReported = false

  function trackManagedPromise(name, promise, { kind = "task", metadata, stop } = {}) {
    lifecycle.registerPromise(name, promise, { kind, metadata, stop })
    return promise
  }

  function trackManagedHandle(name, handle, { kind = "task", metadata } = {}) {
    lifecycle.registerHandle(name, handle, { kind, metadata })
    return handle
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
      logger.warn(`${loopName} retryable${projectAlias ? ` [${projectAlias}]` : ""}:`, normalized.message)
    } else {
      runtimeObservability.recordLoopError(loopName, { projectAlias, err: normalized })
      logger.error(`${loopName} error${projectAlias ? ` [${projectAlias}]` : ""}:`, normalized.message)
    }
    return normalized
  }

  function recordLoopAbort(loopName, { projectAlias, reason } = {}) {
    runtimeObservability.recordLoopAbort(loopName, { projectAlias, reason })
    logger.info(`${loopName} aborted${projectAlias ? ` [${projectAlias}]` : ""}:`, reason || "stopped")
  }

  function reportFatalRuntimeError(err, { name, projectAlias } = {}) {
    if (fatalRuntimeErrorReported || abortController.signal.aborted) return
    fatalRuntimeErrorReported = true
    abortController.abort()
    logger.error(`Fatal runtime error${name ? ` in ${name}` : ""}${projectAlias ? ` [${projectAlias}]` : ""}:`, err.message)
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
    handleMessageUpdated,
  } = mirroringHandlers

  function ctxMetaFromMessage(msg) {
    const chatId = msg?.chat?.id
    const chatType = msg?.chat?.type
    const threadIdOr0 = threadIdOr0FromMessage(msg)
    return { chatId, chatType, threadIdOr0, ctxKey: ctxKeyFrom(chatId, threadIdOr0) }
  }

  function isAllowedUser(from) {
    const allowedUserId = config.telegram.allowedUserId
    return from && typeof from.id === "number" && from.id === allowedUserId
  }

  async function sendToThread(ctxMeta, text, replyMarkup, options = {}) {
    if (!ctxMeta?.chatId) return
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
  }

  function parseCtxKey(key) {
    const m = String(key).match(/^(-?\d+):(\d+)$/)
    if (!m) return null
    return { chatId: Number(m[1]), threadIdOr0: Number(m[2]), ctxKey: key }
  }

  function formatThreadLabel(threadIdOr0) {
    return threadIdOr0 ? `topic ${threadIdOr0}` : "main"
  }

  async function sendBlocksToThread(ctxMeta, blocks, replyMarkup) {
    if (!ctxMeta?.chatId) return
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
  }

  async function validateProject(alias) {
    const oc = ocByAlias[alias]
    if (!oc) throw new Error(`Unknown project: ${alias}`)
    await oc.health()
    markProjectUp(alias)
    return oc
  }

  async function bindCtxToSession(ctxMeta, projectAlias, sessionId) {
    store.setBinding(ctxMeta.ctxKey, { projectAlias, sessionId }, { chatId: ctxMeta.chatId, threadIdOr0: ctxMeta.threadIdOr0 })
    logger.info("Bound", ctxMeta.ctxKey, "->", projectAlias, sessionId)
  }

  function getBoundCtxForSession(projectAlias, sessionId) {
    if (!projectAlias || !sessionId) return null
    const route = store.get().sessionIndex?.[sessionKey(projectAlias, sessionId)]
    if (!route) return null
    const ctxKey = ctxKeyFrom(route.chatId, route.threadIdOr0)
    const binding = store.getBinding(ctxKey)
    if (binding?.projectAlias !== projectAlias || binding?.sessionId !== sessionId) return null
    return { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey }
  }

  function parseBoundCtxKey(ctxKey) {
    const match = String(ctxKey || "").match(/^(-?\d+):(\d+)$/)
    if (!match) return null
    return { chatId: Number(match[1]), threadIdOr0: Number(match[2]), ctxKey: String(ctxKey) }
  }

  function primeTuiActiveSessionFollow(projectAlias, ctxMeta, sessionId) {
    if (!projectAlias || !ctxMeta?.ctxKey || !sessionId) return
    tuiActiveSessionStateByProject.set(projectAlias, {
      currentSessionId: sessionId,
      followCtxKey: ctxMeta.ctxKey,
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
    const previous = tuiActiveSessionStateByProject.get(projectAlias)
    if (!previous) {
      const activeCtx = activeSessionId ? getBoundCtxForSession(projectAlias, activeSessionId) : null
      tuiActiveSessionStateByProject.set(projectAlias, {
        currentSessionId: activeSessionId,
        followCtxKey: activeCtx?.ctxKey || null,
      })
      return
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

    await bindCtxToSession(sourceCtx, projectAlias, activeSessionId)
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
    parseCommand,
    compareNumbers,
    lastAssistantBySession,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    bindAliasAwaiting,
    isAllowedUser,
    ctxMetaFromMessage,
    mirrorCompaction,
  })
  const { handleTelegramMessage, renderSessionsList, handleFeed } = commandHandlers

  const callbackHandlers = createCallbackHandlers({
    ...overviewHelpers,
    ...promptHandlers,
    ...mirroringHandlers,
    ...commandHandlers,
    store,
    projects,
    ocByAlias,
    tg,
    cb,
    logger,
    recordCallbackOutcome: runtimeObservability.recordCallbackOutcome,
    questionWizards,
    ctxMetaFromMessage,
    isAllowedUser,
    bindCtxToSession,
    sendToThread,
    ensureProjectStarted,
    validateProject,
    platform,
  })
  const { handleTelegramCallback } = callbackHandlers

  async function onSseEvent({ projectAlias, evt }) {
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
        await sleepWithAbort(backoff)
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
    logger.info("Telegram backlog drained. Starting from offset:", offset)
  }

  async function telegramLoop() {
    await drainTelegramBacklogIfNeeded()
    let backoff = 1000
    while (!abortController.signal.aborted) {
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
        await sleepWithAbort(backoff)
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
        const updateKey = telegramUpdateIdempotencyKey(u?.update_id)
        if (updateKey && store.hasIdempotencyKey?.(updateKey)) {
          store.setUpdateOffset(u.update_id + 1)
          continue
        }
        try {
          if (u.message) await handleTelegramMessage(u.message, { updateId: u.update_id })
          if (u.callback_query) await handleTelegramCallback(u.callback_query)
          shouldAdvanceOffset = true
        } catch (err) {
          const classification = classifyBoundaryError(err)
          if (classification.retryable) {
            runtimeObservability.recordUpdateRetry()
            logger.warn(
              "Retryable update handler error:",
              `update=${u.update_id}`,
              `kind=${classification.kind}`,
              classification.error.message,
            )
          } else {
            runtimeObservability.recordUpdateSkip()
            logger.error(
              "Skipping non-retryable update:",
              `update=${u.update_id}`,
              `outcome=${classification.outcome}`,
              `kind=${classification.kind}`,
              classification.error.message,
            )
            shouldAdvanceOffset = true
          }
        }

        if (shouldAdvanceOffset) {
          store.markIdempotencyKey?.(updateKey, {
            kind: "telegram-update",
            updateId: u.update_id,
            operation: u.message ? "message" : u.callback_query ? "callback" : "unknown",
          })
          store.setUpdateOffset(u.update_id + 1)
        } else {
          await sleepWithAbort(1000)
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
          }

          if (Array.isArray(perms) || Array.isArray(questions)) {
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
      runtimeObservability.recordLoopSuccess("shutdown")
      await lifecycle.stopAll()
      await Promise.allSettled([telegramLoopPromise, promptPollPromise, tuiActiveSessionSyncPromise])
      await store.flush().catch(() => {})
    })()
    return stopPromise
  }

  return { stop, stateFile }
}
