import { setTimeout as delay } from "node:timers/promises"
import crypto from "node:crypto"
import { createCallbackHandlers } from "./connector/callbacks.js"
import { createCommandHandlers } from "./connector/commands.js"
import { createMirroringHandlers } from "./connector/mirroring.js"
import { createOverviewHelpers } from "./connector/overview.js"
import { createPromptHandlers } from "./connector/prompts.js"
import { TelegramClient, makeInlineKeyboard } from "./telegram/client.js"
import { formatMarkdownToTelegramHtmlBlocks, escapeHtml } from "./telegram/formatter.js"
import { ctxKeyFrom, threadIdOr0FromMessage } from "./telegram/routing.js"
import { OpenCodeClient } from "./opencode/client.js"
import { startOpenCodeSseLoop } from "./opencode/sse.js"
import { ensureStartupSession } from "./opencode/startup-session.js"
import { ensureOpenCodeRunning, openAttachWindowWindows } from "./opencode/launcher.js"
import { extractPatchDiffText, extractPatchFiles, formatChangedFilesText } from "./message-display.js"
import { findSessionByShareUrl, parseSessionReference } from "./session-ref.js"
import { resolveSessionRoute } from "./session-route.js"
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
  const openAttachWindowWindowsFn = deps?.openAttachWindowWindows || openAttachWindowWindows
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
      { command: "feed", description: "Настроить Telegram feed для треда" },
      { command: "status", description: "Показать текущую привязку" },
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

  // Auto-start opencode servers (best-effort) and pick a startup session per project.
  // Important: do not block connector startup on auto-start (Telegram should stay responsive).
  const autoStarted = new Map() // alias -> {stop}
  const startInProgress = new Map() // alias -> Promise
  const startupSessionByProject = {} // alias -> sessionId
  const startupSessionInProgress = new Map() // alias -> Promise<sessionId|null>

  async function getStartupSession(alias, options) {
    return ensureStartupSessionFn({
      alias,
      startInProgress,
      startupSessionByProject,
      startupSessionInProgress,
      ocByAlias,
      logger,
      ...(options || {}),
    })
  }

  function startProjectInBackground(alias, { notifyOnFailure = false } = {}) {
    if (startInProgress.has(alias)) return startInProgress.get(alias)

    const p = projects[alias]
    const oc = ocByAlias[alias]
    const promise = (async () => {
      try {
        logger.info(`[${alias}] autoStart check...`)
        const handle = await ensureOpenCodeRunningFn({ projectAlias: alias, project: p, ocClient: oc, logger })
        if (handle?.stop) autoStarted.set(alias, handle)
        markProjectUp(alias)
        await getStartupSession(alias, { waitForStart: false })
        return handle
      } catch (err) {
        logger.error("Auto-start failed:", alias, err?.message || String(err))
        if (notifyOnFailure) {
          await notifyProjectUnavailable(alias, err, { force: true, platform }).catch(() => {})
        }
        return null
      } finally {
        startInProgress.delete(alias)
      }
    })()

    startInProgress.set(alias, promise)
    return promise
  }

  void (async () => {
    try {
      const aliases = Object.keys(projects).filter((a) => projects?.[a]?.autoStart)
      if (aliases.length) logger.info("Auto-start projects:", aliases.join(", "))
      await Promise.allSettled(aliases.map((alias) => startProjectInBackground(alias, { notifyOnFailure: true })))
    } catch (err) {
      logger.error("Auto-start loop failed:", err?.message || String(err))
    }
  })()

  async function ensureProjectStarted(alias, ctxMeta) {
    if (!canAutoStartProject(alias, { platform })) {
      await sendToThread(
        ctxMeta,
        `Project '${alias}' cannot be auto-started. Set {autoStart:true, directory, port} in projects.json.`,
      ).catch(() => {})
      return
    }

    if (startInProgress.has(alias)) {
      await sendToThread(ctxMeta, `Starting '${alias}'…`).catch(() => {})
      return
    }

    const p = projects[alias]
    void (async () => {
      try {
        await sendToThread(ctxMeta, `Starting opencode for '${alias}'…`).catch(() => {})
        const handle = await startProjectInBackground(alias)
        if (!handle) throw new Error(`Project '${alias}' failed to start`)
        await sendToThread(ctxMeta, `Project '${alias}' is up: ${sanitizeBaseUrlForDisplay(p.baseUrl)}`).catch(() => {})
      } catch (err) {
        await sendToThread(ctxMeta, formatProjectUnavailable(alias, err)).catch(() => {})
      }
    })()
  }

  for (const alias of Object.keys(projects)) {
    void getStartupSession(alias, { waitForStart: false }).catch(() => {})
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
    isLikelyConnectError,
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
    restorePendingPromptState,
    finishQuestionWizard,
    ensureBaselineLoaded,
    handlePermissionAsked,
    handleQuestionAsked,
  } = promptHandlers

  const abortController = new AbortController()

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
        prompted[w?.projectAlias]?.question.delete(w?.request?.id)
        questionWizards.delete(k)
        clearPersistedQuestionWizard(w?.projectAlias, w?.request?.id)
      }
    }
  }, wizardGcIntervalMs)
  wizardGcTimer.unref?.()

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
    await tg.sendMessage(ctxMeta.chatId, text, replyMarkup, {
      ...options,
      message_thread_id: ctxMeta.threadIdOr0 || undefined,
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

  async function sendBlocksToThread(ctxMeta, blocks, replyMarkup) {
    if (!ctxMeta?.chatId) return
    await tg.sendHtmlBlocks(ctxMeta.chatId, blocks, replyMarkup, {
      message_thread_id: ctxMeta.threadIdOr0 || undefined,
    })
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
    openAttachWindowWindowsFn,
    validateProject,
    bindCtxToSession,
    sendToThread,
    parseCtxKey,
    formatThreadLabel,
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
    questionWizards,
    ctxMetaFromMessage,
    isAllowedUser,
    bindCtxToSession,
    sendToThread,
    ensureProjectStarted,
  })
  const { handleTelegramCallback } = callbackHandlers

  async function onSseEvent({ projectAlias, evt }) {
    const type = evt?.type
    const props = evt?.properties || {}

    if (type === "message.updated") {
      await handleMessageUpdated({ projectAlias, props })
      return
    }

    if (type === "permission.asked") {
      await handlePermissionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug })
      return
    }

    if (type === "question.asked") {
      await handleQuestionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug })
    }
  }

  async function drainTelegramBacklogIfNeeded() {
    if (store.get().updateOffset != null) return
    logger.info("Draining Telegram backlog (first run)…")
    let offset = 0
    let backoff = 1000
    while (true) {
      if (abortController.signal.aborted) return
      const updates = await tg
        .getUpdates({ offset, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"], signal: abortController.signal })
        .catch((err) => {
          if (abortController.signal.aborted) return null
          logger.error("Backlog drain error:", err?.message || String(err))
          return null
        })

      if (abortController.signal.aborted) return
      if (!Array.isArray(updates)) {
        await sleepWithAbort(backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

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
          logger.error("getUpdates error:", err?.message || String(err))
          return null
        })
      if (abortController.signal.aborted) break
      if (!Array.isArray(updates)) {
        // Avoid a tight loop on network/API errors.
        await sleepWithAbort(backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }
      if (updates.length === 0) {
        backoff = 1000
        continue
      }
      backoff = 1000
      for (const u of updates) {
        let ok = false
        try {
          if (u.message) await handleTelegramMessage(u.message)
          if (u.callback_query) await handleTelegramCallback(u.callback_query)
          ok = true
        } catch (err) {
          logger.error("Update handler error:", err?.message || String(err))
        }

        // Only advance offset if we handled this update successfully.
        // Otherwise we'd drop it permanently.
        if (ok) {
          store.setUpdateOffset(u.update_id + 1)
        } else {
          await sleepWithAbort(1000)
          break
        }
      }
    }
  }

  if (recoverPendingPromptsOnStartup) {
    await restorePendingPromptState().catch((err) => {
      logger.error("Failed to restore pending prompts:", err?.message || String(err))
    })
  }

  const sseLoops = []
  for (const alias of Object.keys(projects)) {
    sseLoops.push(
      startSseLoop({
        projectAlias: alias,
        ocClient: ocByAlias[alias],
        logger,
        onConnect: ({ projectAlias }) => markProjectSseConnected(projectAlias),
        onEvent: onSseEvent,
        onError: ({ projectAlias, err }) => {
          markProjectSseDown(projectAlias)
          return notifyProjectUnavailable(projectAlias, err, { platform })
        },
        abortSignal: abortController.signal,
      }),
    )
  }

  // Periodic prompt poll (helps when SSE is down).
  const promptPollPromise = (async () => {
    while (!abortController.signal.aborted) {
      for (const alias of Object.keys(projects)) {
        await ensureBaselineLoaded(alias)
        if (!promptBaseline[alias]?.loaded) continue
        const oc = ocByAlias[alias]
        const [perms, questions] = await Promise.all([oc.listPermissions().catch(() => null), oc.listQuestions().catch(() => null)])
        if (Array.isArray(perms) || Array.isArray(questions)) markProjectUp(alias)
        if (Array.isArray(perms)) {
          for (const p of perms) {
            if (promptBaseline[alias].permission.has(p.id)) continue
            // send via SSE handler shape
            await onSseEvent({ projectAlias: alias, evt: { type: "permission.asked", properties: p } })
          }
        }
        if (Array.isArray(questions)) {
          for (const q of questions) {
            if (promptBaseline[alias].question.has(q.id)) continue
            await onSseEvent({ projectAlias: alias, evt: { type: "question.asked", properties: q } })
          }
        }
      }
      await sleepWithAbort(15_000)
    }
  })()

  const telegramLoopPromise = telegramLoop()

  const stop = async () => {
    abortController.abort()
    clearInterval(wizardGcTimer)
    for (const timer of assistantDebounce.values()) clearTimeout(timer)
    assistantDebounce.clear()
    for (const s of sseLoops) s.stop?.()
    for (const h of autoStarted.values()) {
      await Promise.resolve(h.stop?.()).catch(() => {})
    }
    await Promise.allSettled([telegramLoopPromise, promptPollPromise])
    await store.flush().catch(() => {})
  }

  return { stop, stateFile }
}
