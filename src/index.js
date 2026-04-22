import { setTimeout as delay } from "node:timers/promises"
import crypto from "node:crypto"
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
          await notifyProjectUnavailable(alias, err, { force: true }).catch(() => {})
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

  function canAutoStartProject(alias) {
    const p = projects?.[alias]
    if (!p?.autoStart) return false
    if (!p.directory || !p.port) return false
    if (platform === "win32") return true
    // Non-Windows: only headless serve can be started.
    return p.startMode === "serve"
  }

  function isLikelyConnectError(err) {
    const msg = (err?.message || String(err || "")).toLowerCase()
    return (
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("socket") ||
      msg.includes("network") ||
      msg.includes("timed out")
    )
  }

  async function ensureProjectStarted(alias, ctxMeta) {
    if (!canAutoStartProject(alias)) {
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
  const assistantDebounce = new Map() // msgId -> timeout
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

  // projectAlias -> boolean (used to suppress repeated Telegram notices while a project stays down)
  const projectIsDown = new Map()
  const projectSseState = new Map(Object.keys(projects).map((alias) => [alias, "unknown"]))

  function markProjectUp(projectAlias) {
    if (projectIsDown.get(projectAlias)) {
      projectIsDown.set(projectAlias, false)
      projectLastUnavailableNoticeAt.set(projectAlias, 0)
      void notifyProjectRecovered(projectAlias).catch(() => {})
    }
  }

  function markProjectSseConnected(projectAlias) {
    projectSseState.set(projectAlias, "connected")
    markProjectUp(projectAlias)
  }

  function markProjectSseDown(projectAlias) {
    projectSseState.set(projectAlias, "down")
  }

  function getProjectSseStatus(projectAlias) {
    return projectSseState.get(projectAlias) || "unknown"
  }


  const rejectNoteAwaiting = new Map() // key ctxKey -> { projectAlias, permissionId }
  const awaitingCustomAnswer = new Map() // key ctxKey -> { projectAlias, requestId, qIndex }
  const questionWizards = new Map() // key `${projectAlias}:${requestId}` -> wizard

  const bindAliasAwaiting = new Map() // key ctxKey -> { startedAt }

  const wizardKey = (projectAlias, requestId) => `${projectAlias}:${requestId}`
  const permissionPromptKey = (projectAlias, permissionId) => `${projectAlias}:${permissionId}`
  const getWizard = (projectAlias, requestId) => questionWizards.get(wizardKey(projectAlias, requestId)) || null

  function persistQuestionWizard(wizard) {
    store.setQuestionWizard(wizardKey(wizard.projectAlias, wizard.request.id), wizard)
  }

  function clearPersistedQuestionWizard(projectAlias, requestId) {
    store.deleteQuestionWizard(wizardKey(projectAlias, requestId))
  }

  function setRejectNoteAwaitingState(ctxKey, value) {
    if (value) {
      rejectNoteAwaiting.set(ctxKey, value)
      store.setRejectNoteAwaiting(ctxKey, value)
      return
    }
    rejectNoteAwaiting.delete(ctxKey)
    store.deleteRejectNoteAwaiting(ctxKey)
  }

  function setAwaitingCustomAnswerState(ctxKey, value) {
    if (value) {
      awaitingCustomAnswer.set(ctxKey, value)
      store.setAwaitingCustomAnswer(ctxKey, value)
      return
    }
    awaitingCustomAnswer.delete(ctxKey)
    store.deleteAwaitingCustomAnswer(ctxKey)
  }

  function cloneWizardState(wizard, overrides = {}) {
    return {
      ...wizard,
      answers: Array.isArray(wizard.answers) ? wizard.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
      selectedByIndex:
        wizard.selectedByIndex && typeof wizard.selectedByIndex === "object"
          ? Object.fromEntries(
              Object.entries(wizard.selectedByIndex).map(([idx, selected]) => [idx, Array.isArray(selected) ? [...selected] : []]),
            )
          : {},
      messageIdByIndex:
        wizard.messageIdByIndex && typeof wizard.messageIdByIndex === "object"
          ? { ...wizard.messageIdByIndex }
          : {},
      ...overrides,
    }
  }

  function applyWizardState(target, source) {
    target.index = source.index
    target.answers = source.answers
    target.selectedByIndex = source.selectedByIndex
    target.messageIdByIndex = source.messageIdByIndex
  }

  function renderQuestionStep(projectAlias, req, stepIndex, selectedLabels) {
    const q = req.questions[stepIndex]
    const total = req.questions.length
    const multiple = q.multiple === true
    const allowCustom = q.custom !== false

    const header = q.header ? `${q.header}` : `Question ${stepIndex + 1}/${total}`
    const lines = []
    lines.push(`${header} (${stepIndex + 1}/${total})`)
    lines.push(q.question)
    lines.push("")
    lines.push("Options:")
    q.options.forEach((opt, idx) => {
      const label = String(opt.label)
      const desc = String(opt.description || "").trim()
      const descPart = desc ? ` — ${clampString(desc, 160)}` : ""
      lines.push(`${idx + 1}) ${label}${descPart}`)
    })
    lines.push("")
    lines.push(multiple ? "Select any options, then press Done." : "Select one option.")
    if (allowCustom) lines.push("Or press Type answer.")

    const rows = []
    if (multiple) {
      for (let i = 0; i < q.options.length; i++) {
        const label = String(q.options[i].label)
        const checked = selectedLabels?.has(label)
        const text = `${checked ? "[x]" : "[ ]"} ${clampString(label, 50)}`
        rows.push([
          {
            text,
            callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|t|${i}`),
          },
        ])
      }
      rows.push([
        {
          text: "Done",
          callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|done`),
        },
      ])
    } else {
      for (let i = 0; i < q.options.length; i++) {
        const label = String(q.options[i].label)
        rows.push([
          {
            text: clampString(label, 60),
            callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|o|${i}`),
          },
        ])
      }
    }

    const bottomRow = []
    if (allowCustom) {
      bottomRow.push({
        text: "Type answer",
        callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|custom`),
      })
    }
    bottomRow.push({ text: "Reject", callback_data: cb.pack(`q|${projectAlias}|${req.id}|reject`) })
    rows.push(bottomRow)

    return {
      html: escapeHtml(lines.join("\n")),
      replyMarkup: makeInlineKeyboard(rows),
    }
  }

  async function sendCurrentQuestionStep(wizard, { editMessageId } = {}) {
    const idx = wizard.index
    const req = wizard.request
    if (!req?.questions?.[idx]) return
    const selectedSet = new Set(wizard.selectedByIndex?.[idx] || [])
    const rendered = renderQuestionStep(wizard.projectAlias, req, idx, selectedSet)
    const { chatId, threadIdOr0 } = wizard.ctx

    if (editMessageId) {
      await tg
        .editMessageText(chatId, editMessageId, rendered.html, rendered.replyMarkup, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => {})
      wizard.messageIdByIndex[idx] = editMessageId
      return
    }

    const msg = await tg.sendMessage(chatId, rendered.html, rendered.replyMarkup, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      message_thread_id: threadIdOr0 || undefined,
    })
    wizard.messageIdByIndex[idx] = msg?.message_id
  }

  function renderPermissionPrompt(projectAlias, props) {
    return {
      blocks: [
        {
          type: "text",
          html:
            `<b>Permission request</b>\n<code>${escapeHtml(props.id)}</code>\n\n` +
            escapeHtml(`Project: ${projectAlias}`) +
            "\n" +
            escapeHtml(`Permission: ${props.permission}`) +
            (Array.isArray(props.patterns) && props.patterns.length
              ? "\n\n" + escapeHtml("Patterns:\n" + props.patterns.map((p) => `- ${p}`).join("\n"))
              : ""),
        },
      ],
      replyMarkup: makeInlineKeyboard([
        [
          { text: "Allow once", callback_data: cb.pack(`p|${projectAlias}|${props.id}|once`) },
          { text: "Always allow", callback_data: cb.pack(`p|${projectAlias}|${props.id}|always`) },
        ],
        [
          { text: "Reject", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject`) },
          { text: "Reject with note", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject_note`) },
        ],
      ]),
    }
  }

  async function sendPermissionPrompt(projectAlias, props, ctxMeta) {
    const rendered = renderPermissionPrompt(projectAlias, props)
    await sendBlocksToThread(ctxMeta, rendered.blocks, rendered.replyMarkup)
  }

  async function sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { resumed = false } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send rejection note for ${permissionId} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`p|${projectAlias}|${permissionId}|cancel_note`) }]]),
    )
  }

  async function sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, label, { resumed = false } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send your answer for: ${label || "question"} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`q|${projectAlias}|${questionId}|${qIndex}|cancel_custom`) }]]),
    )
  }

  function changedFilesAttachmentName(projectAlias, sessionId, messageId) {
    const clean = (value, fallback) => {
      const s = String(value || fallback)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
      return s || fallback
    }
    return `${clean(projectAlias, "project")}-${clean(sessionId, "session")}-${clean(messageId, "reply")}.diff.txt`
  }

  function changedFilesSummaryKeyboard(projectAlias, sessionId, messageId) {
    return makeInlineKeyboard([[{ text: "Show diff", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|show`) }]])
  }

  function changedFilesDiffKeyboard(projectAlias, sessionId, messageId) {
    return makeInlineKeyboard([[{ text: "Back", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|back`) }]])
  }

  function extractChangedFilesSummary(projectAlias, msg) {
    const files = extractPatchFiles(msg)
    if (!files.length) return ""
    return formatChangedFilesText(files, { baseDir: projects?.[projectAlias]?.directory, limit: CHANGED_FILES_LIMIT })
  }

  function renderChangedFilesDiffHtml(diffText) {
    return `<b>Changed files diff</b>\n<pre><code>${escapeHtml(diffText)}</code></pre>`
  }

  async function deliverChangedFilesSummary(ctxMeta, projectAlias, sessionId, messageId, msg, { replaceMessageId } = {}) {
    const text = extractChangedFilesSummary(projectAlias, msg)
    if (!text) return null
    const replyMarkup = changedFilesSummaryKeyboard(projectAlias, sessionId, messageId)
    if (replaceMessageId) {
      const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, text, replyMarkup).catch(() => null)
      if (edited) return { mode: "edited" }
    }
    await sendToThread(ctxMeta, text, replyMarkup)
    return { mode: "sent" }
  }

  async function renderChangedFilesView(ctxMeta, projectAlias, sessionId, messageId, action, { editMessageId } = {}) {
    if (!editMessageId) return
    const oc = ocByAlias[projectAlias]
    if (!oc) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, `Unknown project: ${projectAlias}`).catch(() => {})
      return
    }
    const msg = await oc.getMessage(sessionId, messageId).catch(() => null)
    if (!msg) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, "Changed files update is no longer available.").catch(() => {})
      return
    }

    if (action === "back") {
      const summary = extractChangedFilesSummary(projectAlias, msg) || "Changed files are unavailable for this update."
      await tg.editMessageText(
        ctxMeta.chatId,
        editMessageId,
        summary,
        changedFilesSummaryKeyboard(projectAlias, sessionId, messageId),
      )
      return
    }

    const diffText = extractPatchDiffText(msg)
    if (!diffText) {
      await tg.editMessageText(
        ctxMeta.chatId,
        editMessageId,
        "Diff unavailable for this update.",
        changedFilesDiffKeyboard(projectAlias, sessionId, messageId),
      )
      return
    }

    const diffHtml = renderChangedFilesDiffHtml(diffText)
    if (diffText.length > INLINE_DIFF_TEXT_MAX_CHARS || diffHtml.length > 3900) {
      await tg.editMessageText(
        ctxMeta.chatId,
        editMessageId,
        "Diff is too large for an inline preview. It was attached as a .txt file.",
        changedFilesDiffKeyboard(projectAlias, sessionId, messageId),
      )
      await tg.sendDocument(
        ctxMeta.chatId,
        diffText,
        changedFilesAttachmentName(projectAlias, sessionId, messageId),
        `Changed files diff (${projectAlias}/${sessionId})`,
        { message_thread_id: ctxMeta.threadIdOr0 || undefined },
      )
      return
    }

    await tg.editMessageText(ctxMeta.chatId, editMessageId, diffHtml, changedFilesDiffKeyboard(projectAlias, sessionId, messageId), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
  }

  function extractAssistantDisplayText(projectAlias, msg) {
    let text = extractTextParts(msg)
    if (!text || !text.trim()) {
      text = extractChangedFilesSummary(projectAlias, msg)
    }
    return text
  }

  function shouldSendAssistantAsAttachment(text) {
    return typeof text === "string" && text.length >= TEXT_ATTACHMENT_THRESHOLD
  }

  function assistantAttachmentName(projectAlias, sessionId, messageId) {
    const clean = (value, fallback) => {
      const s = String(value || fallback)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
      return s || fallback
    }
    return `${clean(projectAlias, "project")}-${clean(sessionId, "session")}-${clean(messageId, "reply")}.txt`
  }

  function buildAssistantStreamPreviewHtml(text) {
    const body = String(text || "").trim()
    if (!body) return "<i>Streaming reply…</i>"
    const trimmed = clampString(body, STREAM_PREVIEW_MAX_CHARS)
    return `<i>Streaming reply…</i>\n${escapeHtml(trimmed)}`
  }

  async function deliverAssistantText(ctxMeta, projectAlias, sessionId, messageId, text, { replaceMessageId } = {}) {
    if (!text || !text.trim()) return null

    if (shouldSendAssistantAsAttachment(text)) {
      const notice = "Assistant reply was attached as a .txt file because it is too long for Telegram messages."
      if (replaceMessageId) {
        const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, notice, null).catch(() => null)
        if (!edited) {
          await sendToThread(ctxMeta, notice)
        }
      } else {
        await sendToThread(ctxMeta, notice)
      }
      await tg.sendDocument(
        ctxMeta.chatId,
        text,
        assistantAttachmentName(projectAlias, sessionId, messageId),
        `Assistant reply (${projectAlias}/${sessionId})`,
        { message_thread_id: ctxMeta.threadIdOr0 || undefined },
      )
      return { mode: "attachment" }
    }

    const blocks = formatMarkdownToTelegramHtmlBlocks(text)
    if (!blocks.length) return null

    if (replaceMessageId && blocks[0]?.type === "text") {
      const edited = await tg
        .editMessageText(ctxMeta.chatId, replaceMessageId, blocks[0].html, null, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => null)
      if (!edited) {
        await sendBlocksToThread(ctxMeta, blocks, null)
        return { mode: "resent" }
      }
      if (blocks.length > 1) {
        await sendBlocksToThread(ctxMeta, blocks.slice(1), null)
      }
      return { mode: "edited" }
    }

    await sendBlocksToThread(ctxMeta, blocks, null)
    return { mode: "sent" }
  }

  async function restorePendingPromptState() {
    const pending = store.getPendingPrompts?.() || store.get().pendingPrompts || {}

    for (const entry of Object.values(pending.permissions || {})) {
      const ctx = entry?.ctx
      if (!entry?.projectAlias || !entry?.permissionId || !ctx?.chatId || !ctx?.ctxKey) continue
      prompted[entry.projectAlias]?.permission.add(entry.permissionId)
      await sendPermissionPrompt(
        entry.projectAlias,
        {
          id: entry.permissionId,
          sessionID: entry.sessionID,
          permission: entry.permission,
          patterns: Array.isArray(entry.patterns) ? entry.patterns : [],
        },
        ctx,
      ).catch(() => {})
    }

    for (const snapshot of Object.values(pending.questionWizards || {})) {
      const ctx = snapshot?.ctx
      if (!snapshot?.projectAlias || !snapshot?.id || !ctx?.chatId || !ctx?.ctxKey) continue
      prompted[snapshot.projectAlias]?.question.add(snapshot.id)
      const wizard = {
        projectAlias: snapshot.projectAlias,
        id: snapshot.id,
        sessionID: snapshot.sessionID,
        request: snapshot.request,
        index: Number.isInteger(snapshot.index) ? snapshot.index : 0,
        answers: Array.isArray(snapshot.answers) ? snapshot.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
        selectedByIndex:
          snapshot.selectedByIndex && typeof snapshot.selectedByIndex === "object"
            ? Object.fromEntries(
                Object.entries(snapshot.selectedByIndex).map(([idx, selected]) => [idx, Array.isArray(selected) ? [...selected] : []]),
              )
            : {},
        messageIdByIndex: {},
        createdAt: typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now(),
        ctx,
      }
      questionWizards.set(wizardKey(wizard.projectAlias, wizard.id), wizard)
      await sendBlocksToThread(wizard.ctx, [
        {
          type: "text",
          html: `<b>Question request resumed</b>\n<code>${escapeHtml(wizard.id)}</code>\n\n${escapeHtml(`Project: ${wizard.projectAlias}`)}`,
        },
      ]).catch(() => {})
      await sendCurrentQuestionStep(wizard).catch(() => {})
    }

    for (const [ctxKey, value] of Object.entries(pending.rejectNotes || {})) {
      if (!value?.projectAlias || !value?.permissionId) continue
      setRejectNoteAwaitingState(ctxKey, value)
      const bindingCtx = parseCtxKey(ctxKey)
      if (bindingCtx?.chatId) {
        await sendRejectNotePrompt(bindingCtx, value.projectAlias, value.permissionId, { resumed: true }).catch(() => {})
      }
    }

    for (const [ctxKey, value] of Object.entries(pending.customAnswers || {})) {
      if (!value?.projectAlias || !value?.requestId || !Number.isInteger(value?.qIndex)) continue
      setAwaitingCustomAnswerState(ctxKey, value)
      const wizard = getWizard(value.projectAlias, value.requestId)
      const label = wizard?.request?.questions?.[value.qIndex]?.header || "question"
      const bindingCtx = parseCtxKey(ctxKey)
      if (bindingCtx?.chatId) {
        await sendQuestionCustomAnswerPrompt(bindingCtx, value.projectAlias, value.requestId, value.qIndex, label, { resumed: true }).catch(
          () => {},
        )
      }
    }
  }

  async function finishQuestionWizard(wizard) {
    const oc = ocByAlias[wizard.projectAlias]
    await oc.replyQuestion(wizard.request.id, wizard.answers)
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
    clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id)
    setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
    await sendToThread(wizard.ctx, `Answered: ${wizard.request.id}`).catch(() => {})
  }

  const abortController = new AbortController()

  // Prevent abandoned question wizards from accumulating indefinitely.
  const WIZARD_TTL_MS = 2 * 60 * 60 * 1000
  const wizardGcTimer = setInterval(() => {
    const t = Date.now()
    for (const [k, w] of questionWizards.entries()) {
      const createdAt = typeof w?.createdAt === "number" ? w.createdAt : 0
      if (!createdAt || t - createdAt > WIZARD_TTL_MS) {
        questionWizards.delete(k)
        clearPersistedQuestionWizard(w?.projectAlias, w?.request?.id)
      }
    }
  }, 10 * 60 * 1000)
  wizardGcTimer.unref?.()

  const projectLastUnavailableNoticeAt = new Map() // projectAlias -> epochMs

  function ensureForwardedSets(sk) {
    let s = forwardedBySession.get(sk)
    if (!s) {
      s = { user: new LruSet(8000), assistant: new LruSet(8000), changes: new LruSet(8000) }
      forwardedBySession.set(sk, s)
    }
    return s
  }

  function ensureRecentPromptSet(sk) {
    let s = recentTgPromptsBySession.get(sk)
    if (!s) {
      s = new LruSet(2000)
      recentTgPromptsBySession.set(sk, s)
    }
    return s
  }

  function hashTextForEcho(text) {
    const t = String(text ?? "")
    // Keep it fast + stable.
    return crypto.createHash("sha1").update(t, "utf8").digest("hex") + ":" + String(t.length)
  }

  function ctxMetaFromMessage(msg) {
    const chatId = msg?.chat?.id
    const chatType = msg?.chat?.type
    const threadIdOr0 = threadIdOr0FromMessage(msg)
    return { chatId, chatType, threadIdOr0, ctxKey: ctxKeyFrom(chatId, threadIdOr0) }
  }

  function ctxMetaFromRoute(route) {
    return { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
  }

  function getFeedMode(ctxKey) {
    return store.getFeedMode?.(ctxKey) || DEFAULT_FEED_MODE
  }

  function feedModeLabel(mode) {
    const normalized = normalizeFeedMode(mode)
    if (normalized === "main") return "Main"
    if (normalized === "verbose") return "Verbose"
    return "Main + changes"
  }

  function shouldMirrorToFeed(ctxKey, kind) {
    const mode = getFeedMode(ctxKey)
    if (kind === "internal") return false
    if (mode === "main") return kind === "assistant-final"
    if (mode === "main+changes") return kind === "assistant-final" || kind === "changed-files"
    return kind === "assistant-final" || kind === "assistant-stream" || kind === "user-mirror" || kind === "changed-files"
  }

  function renderFeedSettingsText(ctxKey) {
    const mode = getFeedMode(ctxKey)
    return [
      `Feed for this thread: ${feedModeLabel(mode)}`,
      "",
      "Main — final assistant replies only.",
      "Main + changes — final assistant replies and changed files.",
      "Verbose — final replies, streaming previews, user mirror, and changed files.",
      "",
      "Internal compaction output stays hidden in all modes.",
    ].join("\n")
  }

  function feedKeyboard(ctxKey) {
    const current = getFeedMode(ctxKey)
    const button = (mode, label) => ({
      text: `${current === mode ? "✓ " : ""}${label}`,
      callback_data: cb.pack(`feed|${mode}`),
    })
    return makeInlineKeyboard([
      [button("main", "Main")],
      [button("main+changes", "Main + changes")],
      [button("verbose", "Verbose")],
    ])
  }

  async function renderFeedSettings(ctxMeta, { editMessageId } = {}) {
    const text = renderFeedSettingsText(ctxMeta.ctxKey)
    const replyMarkup = feedKeyboard(ctxMeta.ctxKey)
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
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

  function formatProjectUnavailable(projectAlias, err) {
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl)
    const msg = err?.message || String(err)
    return `Project '${projectAlias}' is unavailable. Start opencode at ${baseUrl}.\n\n${msg}`
  }

  function startServerKeyboard(projectAlias) {
    return makeInlineKeyboard([
      [
        {
          text: `Start '${projectAlias}'`,
          callback_data: cb.pack(`srv|${projectAlias}|start`),
        },
      ],
    ])
  }

  async function notifyProjectUnavailable(projectAlias, err, { force = false } = {}) {
    if (!force && startInProgress.has(projectAlias)) return
    const nowMs = Date.now()
    const last = projectLastUnavailableNoticeAt.get(projectAlias) || 0
    const isDown = projectIsDown.get(projectAlias) === true
    const minIntervalMs = isDown ? 10 * 60_000 : 60_000
    if (nowMs - last < minIntervalMs) return
    projectLastUnavailableNoticeAt.set(projectAlias, nowMs)
    projectIsDown.set(projectAlias, true)

    const st = store.get()
    const message = formatProjectUnavailable(projectAlias, err)
    const replyMarkup = canAutoStartProject(projectAlias) ? startServerKeyboard(projectAlias) : null
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      await sendToThread(ctx, message, replyMarkup).catch(() => {})
    }
  }

  async function notifyProjectRecovered(projectAlias) {
    const st = store.get()
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl) || "unknown"
    const message = `Project '${projectAlias}' is back online at ${baseUrl}.`
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      await sendToThread(ctx, message).catch(() => {})
    }
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

  async function ensureBaselineLoaded(projectAlias) {
    const base = promptBaseline[projectAlias]
    if (!base || base.loaded) return
    if (recoverPendingPromptsOnStartup) {
      base.loaded = true
      return
    }
    const oc = ocByAlias[projectAlias]
    try {
      const [perms, questions] = await Promise.all([oc.listPermissions(), oc.listQuestions()])
      if (!Array.isArray(perms) || !Array.isArray(questions)) return
      markProjectUp(projectAlias)
      for (const p of perms) base.permission.add(p.id)
      for (const q of questions) base.question.add(q.id)
      base.loaded = true
    } catch {
      // retry later
    }
  }

  async function handleBindCommand(ctxMeta, argv) {
    const alias = argv[0]
    if (!alias) {
      await sendToThread(ctxMeta, "Usage: /bind <projectAlias>")
      return
    }
    try {
      await validateProject(alias)
      const oc = ocByAlias[alias]

      const existing = store.getBinding(ctxMeta.ctxKey)
      if (existing && existing.projectAlias === alias && existing.sessionId) {
        await sendToThread(ctxMeta, `Already bound: ${alias} / ${existing.sessionId}`)
        return
      }
      const sid = startupSessionByProject[alias]
      const startupSid = sid || (await getStartupSession(alias).catch(() => null))
      if (startupSid) {
        await oc.getSession(startupSid)
        await bindCtxToSession(ctxMeta, alias, startupSid)
        await sendToThread(ctxMeta, `Bound to project '${alias}' (startup session): ${startupSid}`)
      } else {
        const created = await oc.createSession({})
        if (created?.id) logger.info(`[${alias}] created session for bind:`, created.id)
        startupSessionByProject[alias] = created.id
        await bindCtxToSession(ctxMeta, alias, created.id)
        await sendToThread(ctxMeta, `Bound to project '${alias}' with new session: ${created.id}`)
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err)).catch(() => {})
    }
  }

  async function handleNewCommand(ctxMeta, title) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const created = await oc.createSession({ title: title || undefined })
      if (created?.id) logger.info(`[${binding.projectAlias}] /new created session:`, created.id)
      await bindCtxToSession(ctxMeta, binding.projectAlias, created.id)
      await sendToThread(ctxMeta, `Created and switched to session: ${created.id}`)

      const p = projects[binding.projectAlias]
      if (p?.openAttachOnNew === true) {
        if (platform === "win32") {
          await openAttachWindowWindowsFn({ directory: p.directory, baseUrl: p.baseUrl, sessionId: created.id }).catch((err) => {
            logger.error("Failed to open attach window:", binding.projectAlias, err?.message || String(err))
          })
        } else {
          logger.info(`[${binding.projectAlias}] openAttachOnNew is enabled, but attach auto-open is only implemented on Windows.`)
        }
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleUseCommand(ctxMeta, sessionId) {
    const sessionRef = parseSessionReference(sessionId)
    if (!sessionRef) {
      await sendToThread(ctxMeta, "Usage: /use <sessionId|shareLink>")
      return
    }
    if (sessionRef.type === "invalid-link") {
      await sendToThread(ctxMeta, "Unsupported link. Use an OpenCode share link like https://opncd.ai/s/<share-id> or a raw session id.")
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]

    async function listSessionsForShareLookup(projectAlias) {
      // For share-link lookup we intentionally request the full session list for the
      // project instead of a recent-session subset, so older shared sessions still resolve.
      return ocByAlias[projectAlias].listSessions({ directory: projects?.[projectAlias]?.directory })
    }

    try {
      let targetSessionId = sessionRef.sessionId

      if (sessionRef.type === "share-link") {
        const currentSessions = await listSessionsForShareLookup(binding.projectAlias)
        const currentMatch = findSessionByShareUrl(currentSessions, sessionRef.shareUrl)
        if (currentMatch?.id) {
          targetSessionId = currentMatch.id
        } else {
          let mismatch = null
          const otherLookupErrors = []
          for (const alias of Object.keys(projects)) {
            if (alias === binding.projectAlias) continue
            try {
              const otherSessions = await listSessionsForShareLookup(alias)
              const otherMatch = findSessionByShareUrl(otherSessions, sessionRef.shareUrl)
              if (otherMatch?.id) {
                mismatch = { projectAlias: alias, sessionId: otherMatch.id }
                break
              }
            } catch (err) {
              logger.warn(`Failed to check share link against project '${alias}':`, err?.message || String(err))
              otherLookupErrors.push(alias)
            }
          }

          if (mismatch) {
            await sendToThread(
              ctxMeta,
              `This share link belongs to project '${mismatch.projectAlias}' (session: ${mismatch.sessionId}), but this thread is bound to '${binding.projectAlias}'. Use /bind ${mismatch.projectAlias} first.`,
            )
            return
          }

          if (otherLookupErrors.length) {
            await sendToThread(
              ctxMeta,
              `Share link was not found in project '${binding.projectAlias}', but these project lookups failed: ${otherLookupErrors.join(", ")}. The link may belong to one of them; try again when those projects are available.`,
            )
            return
          }

          await sendToThread(
            ctxMeta,
            `Share link not found in project '${binding.projectAlias}'. It may belong to a different project or may not be shared on this server.`,
          )
          return
        }
      }

      await oc.getSession(targetSessionId)
      await bindCtxToSession(ctxMeta, binding.projectAlias, targetSessionId)
      await sendToThread(ctxMeta, `Switched to session: ${targetSessionId}`)
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleSessions(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    try {
      await renderSessionsList(ctxMeta, { binding })
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleAbort(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const aborted = await oc.abortSession(binding.sessionId)
      markProjectUp(binding.projectAlias)
      await sendToThread(
        ctxMeta,
        aborted === false ? `No active run to abort for session: ${binding.sessionId}` : `Abort requested for session: ${binding.sessionId}`,
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  function sessionsKeyboard(projectAlias, sessions, { currentSessionId, startupSessionId, limit = 10 } = {}) {
    const normalized = normalizeSessionsList(sessions).slice(0, limit)
    if (!normalized.length) return null
    return makeInlineKeyboard(
      normalized.map((session) => [
        {
          text: formatSessionButtonLabel(session, { currentSessionId, startupSessionId }),
          callback_data: cb.pack(`s|${projectAlias}|${session.id}`),
        },
      ]),
    )
  }

  async function renderSessionsList(ctxMeta, { binding, editMessageId } = {}) {
    const oc = ocByAlias[binding.projectAlias]
    const sessions = await oc.listSessions({ directory: projects?.[binding.projectAlias]?.directory, limit: 10 })
    markProjectUp(binding.projectAlias)
    const text = formatSessionsListText(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    const replyMarkup = sessionsKeyboard(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function handleWhere(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }
    const startupSessionId = startupSessionByProject[binding.projectAlias] || "unknown"
    const sseStatus = getProjectSseStatus(binding.projectAlias)
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[binding.projectAlias]?.baseUrl) || "unknown"
    const feedMode = feedModeLabel(getFeedMode(ctxMeta.ctxKey))
    await sendToThread(
      ctxMeta,
      [
        `Project: ${binding.projectAlias}`,
        `Session: ${binding.sessionId}`,
        `Startup session: ${startupSessionId}`,
        `Feed: ${feedMode}`,
        `SSE: ${sseStatus}`,
        `Base URL: ${baseUrl}`,
      ].join("\n"),
    )
  }

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleBindings(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await sendToThread(ctxMeta, "Use /bindings only in a private chat with the bot. Bindings contain sensitive session IDs.")
      return
    }

    const entries = Object.entries(store.get().bindings || {})
      .map(([ctxKey, binding]) => ({ ctxKey, binding, ctx: parseCtxKey(ctxKey) }))
      .sort((a, b) => {
        const byChat = compareNumbers(a.ctx?.chatId ?? 0, b.ctx?.chatId ?? 0)
        if (byChat !== 0) return byChat
        const byThread = compareNumbers(a.ctx?.threadIdOr0 ?? 0, b.ctx?.threadIdOr0 ?? 0)
        if (byThread !== 0) return byThread
        return a.ctxKey.localeCompare(b.ctxKey)
      })

    if (!entries.length) {
      await sendToThread(ctxMeta, "No bindings.")
      return
    }

    const lines = ["Bindings:"]
    for (const entry of entries) {
      const scope = entry.ctx ? `chat ${entry.ctx.chatId} / ${formatThreadLabel(entry.ctx.threadIdOr0)}` : entry.ctxKey
      const current = entry.ctxKey === ctxMeta.ctxKey ? " (current)" : ""
      lines.push(`- ${scope}${current} -> ${entry.binding.projectAlias} / ${entry.binding.sessionId}`)
    }

    await sendToThread(ctxMeta, lines.join("\n"))
  }

  async function handleSendLast(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    if (!oc) {
      await sendToThread(ctxMeta, `Unknown project: ${binding.projectAlias}`)
      return
    }
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const last = lastAssistantBySession.get(sk)
    const messageId = last?.messageId
    const messageSessionId = last?.sessionId || binding.sessionId
    let text = typeof last?.text === "string" ? last.text : ""

    if (messageId) {
      const msg = await oc.getMessage(messageSessionId, messageId).catch(() => null)
      if (!mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        // don't surface internal compaction output
      } else {
        const fetched = extractAssistantDisplayText(binding.projectAlias, msg)
        if (fetched && fetched.trim()) {
          text = fetched
        }
      }
    }

    if (!text || !text.trim()) {
      await sendToThread(ctxMeta, "No assistant message yet.")
      return
    }

    await deliverAssistantText(ctxMeta, binding.projectAlias, messageSessionId, messageId || "sendlast", text)
  }

  async function handleProjects(ctxMeta) {
    const aliases = Object.keys(projects)
    await Promise.allSettled(aliases.map((a) => getStartupSession(a).catch(() => null)))
    const lines = []
    for (const a of aliases) {
      const sid = startupSessionByProject[a]
      const url = sanitizeBaseUrlForDisplay(projects[a]?.baseUrl)
      lines.push(`- ${a}${url ? ` (${url})` : ""}${sid ? ` session=${sid}` : ""}`)
    }
    await sendToThread(ctxMeta, lines.length ? `Projects:\n${lines.join("\n")}` : "No projects")
  }

  async function handleUnbind(ctxMeta) {
    const ok = store.unbind(ctxMeta.ctxKey)
    await sendToThread(ctxMeta, ok ? "Unbound." : "Not bound.")
  }

  async function handleTelegramMessage(msg) {
    if (!isAllowedUser(msg?.from)) return
    const ctxMeta = ctxMetaFromMessage(msg)
    if (!ctxMeta.chatId) return

    const text = msg?.text
    if (typeof text !== "string" || !text.trim()) return

    const awaitingQ = awaitingCustomAnswer.get(ctxMeta.ctxKey)
    if (awaitingQ) {
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        await sendToThread(ctxMeta, "Question is no longer active.")
        return
      }
      const nextWizard = cloneWizardState(wizard)
      nextWizard.answers[awaitingQ.qIndex] = [text]
      const nextIndex = awaitingQ.qIndex + 1
      if (nextIndex >= wizard.request.questions.length) {
        persistQuestionWizard(nextWizard)
        await finishQuestionWizard(nextWizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      } else {
        nextWizard.index = nextIndex
        await sendCurrentQuestionStep(nextWizard)
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      const oc = ocByAlias[awaiting.projectAlias]
      await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId)
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      await sendToThread(ctxMeta, "Rejection note sent.").catch(() => {})
      return
    }

    // /bind 2-step flow: after selecting /bind from the Telegram menu,
    // the next non-command message is treated as <projectAlias>.
    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, "Cancelled.")
          return
        }
        // Any other command cancels the pending bind and is handled normally.
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
      } else {
        const alias = String(text).trim().split(/\s+/)[0]
        if (!alias) {
          await sendToThread(ctxMeta, "Send project alias (e.g. 'myproj') or /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        return handleBindCommand(ctxMeta, [alias])
      }
    }

    if (isCommand(text)) {
      const { cmd, args, argv } = parseCommand(text)
      if (cmd === "/cancel") {
        const hadBind = bindAliasAwaiting.delete(ctxMeta.ctxKey)
        const hadRejectNote = rejectNoteAwaiting.has(ctxMeta.ctxKey)
        const hadCustomAnswer = awaitingCustomAnswer.has(ctxMeta.ctxKey)
        if (hadRejectNote) setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        if (hadCustomAnswer) setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        const cancelled = hadBind || hadRejectNote || hadCustomAnswer
        await sendToThread(ctxMeta, cancelled ? "Cancelled." : "Nothing to cancel.")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        await sendToThread(
          ctxMeta,
          [
            "Commands:",
            "/bind <projectAlias>",
            "/new [title]",
            "/use <sessionId|shareLink>",
            "/sessions",
            "/feed",
            "/status",
            "/bindings (private chat only)",
            "/abort",
            "/sendlast",
            "/projects",
            "/unbind",
            "/cancel",
          ].join("\n"),
        )
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, "Send project alias (or /projects to list). You can /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        return handleBindCommand(ctxMeta, argv)
      }
      if (cmd === "/new") return handleNewCommand(ctxMeta, args)
      if (cmd === "/use") return handleUseCommand(ctxMeta, argv[0])
      if (cmd === "/sessions") return handleSessions(ctxMeta)
      if (cmd === "/feed") return handleFeed(ctxMeta)
      if (cmd === "/status") return handleWhere(ctxMeta)
      if (cmd === "/bindings") return handleBindings(ctxMeta)
      if (cmd === "/abort") return handleAbort(ctxMeta)
      if (cmd === "/sendlast") return handleSendLast(ctxMeta)
      if (cmd === "/projects") return handleProjects(ctxMeta)
      if (cmd === "/unbind") return handleUnbind(ctxMeta)
      await sendToThread(ctxMeta, "Unknown command. Use /help.")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      const def = config.defaultProject
      if (def) {
        await sendToThread(ctxMeta, `Not bound. Use /bind <projectAlias> (default: ${def}).`)
      } else {
        await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      }
      return
    }

    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    try {
      const promptText = `${prefix}${text}`
      const sk = sessionKey(binding.projectAlias, binding.sessionId)
      ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
      await oc.promptAsync(binding.sessionId, promptText)
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isLikelyConnectError(err) && canAutoStartProject(alias)
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : null).catch(
        () => {},
      )
    }
  }

  async function handleTelegramCallback(callbackQuery) {
    if (!isAllowedUser(callbackQuery?.from)) return
    const msg = callbackQuery.message
    const ctxMeta = ctxMetaFromMessage(msg)
    const data = cb.unpack(callbackQuery.data)
    if (!data) {
      await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    // p|<projectAlias>|<permissionId>|<action>
    // q|<projectAlias>|<questionId>|<action>
    // s|<projectAlias>|<sessionId>
    // srv|<projectAlias>|start
    // feed|<mode>
    // cf|<projectAlias>|<sessionId>|<messageId>|<show|back>
    const parts = String(data).split("|")
    const kind = parts[0]

    if (kind === "s") {
      const projectAlias = parts[1]
      const targetSessionId = parts[2]
      const oc = ocByAlias[projectAlias]
      const binding = store.getBinding(ctxMeta.ctxKey)
      if (!oc || !projectAlias || !targetSessionId) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      if (!binding) {
        await tg.answerCallbackQuery(callbackQuery.id, "Not bound")
        return
      }
      if (binding.projectAlias !== projectAlias) {
        await tg.answerCallbackQuery(callbackQuery.id, "Binding changed")
        return
      }
      if (binding.sessionId === targetSessionId) {
        await tg.answerCallbackQuery(callbackQuery.id, "Already current")
        return
      }
      try {
        await oc.getSession(targetSessionId)
        await bindCtxToSession(ctxMeta, projectAlias, targetSessionId)
      } catch (err) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unavailable")
        await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err)).catch(() => {})
        return
      }

      await tg.answerCallbackQuery(callbackQuery.id, "Switched")
      await renderSessionsList({ ...ctxMeta, chatId: msg?.chat?.id || ctxMeta.chatId }, {
        binding: { projectAlias, sessionId: targetSessionId },
        editMessageId: msg?.message_id,
      }).catch(async (err) => {
        logger.error("Failed to refresh sessions list:", err?.message || String(err))
        await sendToThread(ctxMeta, `Switched to session: ${targetSessionId}`).catch(() => {})
      })
      return
    }

    if (kind === "srv") {
      const projectAlias = parts[1]
      const action = parts[2]
      if (!projectAlias || !projects?.[projectAlias]) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }
      if (action !== "start") {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id, "Starting…")
      void ensureProjectStarted(projectAlias, ctxMeta)
      return
    }

    if (kind === "feed") {
      const rawMode = parts[1]
      if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      const mode = normalizeFeedMode(rawMode)
      store.setFeedMode(ctxMeta.ctxKey, mode)
      await tg.answerCallbackQuery(callbackQuery.id, `Feed: ${feedModeLabel(mode)}`).catch(() => {})
      await handleFeed(ctxMeta, { editMessageId: msg?.message_id }).catch(() => {})
      return
    }

    if (kind === "cf") {
      const projectAlias = parts[1]
      const sessionId = parts[2]
      const opencodeMessageId = parts[3]
      const action = parts[4]
      if (!projectAlias || !sessionId || !opencodeMessageId || (action !== "show" && action !== "back")) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id).catch(() => {})
      await renderChangedFilesView(ctxMeta, projectAlias, sessionId, opencodeMessageId, action, { editMessageId: msg?.message_id }).catch(
        () => {},
      )
      return
    }

    if (kind === "p") {
      const projectAlias = parts[1]
      const permissionId = parts[2]
      const action = parts[3]
      const oc = ocByAlias[projectAlias]
      if (!oc) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }

      if (action === "once" || action === "always" || action === "reject") {
        await oc.replyPermission(permissionId, { reply: action })
        store.deletePendingPermission(projectAlias, permissionId)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "OK").catch(() => {})
        return
      }
      if (action === "reject_note") {
        setRejectNoteAwaitingState(ctxMeta.ctxKey, { projectAlias, permissionId })
        await tg.answerCallbackQuery(callbackQuery.id, "Send note")
        await sendRejectNotePrompt(ctxMeta, projectAlias, permissionId)
        return
      }
      if (action === "cancel_note") {
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Cancelled")
        return
      }
      await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
      return
    }

    if (kind === "q") {
      const projectAlias = parts[1]
      const questionId = parts[2]
      const oc = ocByAlias[projectAlias]
      if (!oc) {
        await tg.answerCallbackQuery(callbackQuery.id, "Unknown project")
        return
      }

      const wizard = getWizard(projectAlias, questionId)

      // reject (works even if wizard isn't found)
      if (parts.length === 4 && parts[3] === "reject") {
        await oc.rejectQuestion(questionId)
        if (wizard) {
          questionWizards.delete(wizardKey(projectAlias, questionId))
          clearPersistedQuestionWizard(projectAlias, questionId)
        }
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Rejected").catch(() => {})
        return
      }

      if (!wizard) {
        await tg.answerCallbackQuery(callbackQuery.id, "Not found")
        return
      }

      if (parts.length < 5) {
        await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
        return
      }

      const qIndex = Number(parts[3])
      const action = parts[4]
      const arg = parts[5]
      if (!Number.isInteger(qIndex) || qIndex !== wizard.index) {
        await tg.answerCallbackQuery(callbackQuery.id, "Out of date")
        return
      }

      const req = wizard.request
      const q = req.questions[qIndex]
      const multiple = q.multiple === true
      const allowCustom = q.custom !== false
      const messageId = callbackQuery.message?.message_id

      if (action === "custom") {
        if (!allowCustom) {
          await tg.answerCallbackQuery(callbackQuery.id, "Custom disabled")
          return
        }
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, { projectAlias, requestId: questionId, qIndex })
        await tg.answerCallbackQuery(callbackQuery.id, "Send answer")
        await sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, q.header || "question")
        return
      }

      if (action === "cancel_custom") {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await tg.answerCallbackQuery(callbackQuery.id, "Cancelled")
        return
      }

      if (action === "o") {
        const optIndex = Number(arg)
        if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const label = String(q.options[optIndex].label)
        const nextWizard = cloneWizardState(wizard)
        nextWizard.answers[qIndex] = [label]
        const nextIndex = qIndex + 1
        if (nextIndex >= req.questions.length) {
          persistQuestionWizard(nextWizard)
          await finishQuestionWizard(nextWizard)
        } else {
          nextWizard.index = nextIndex
          await sendCurrentQuestionStep(nextWizard)
          applyWizardState(wizard, nextWizard)
          persistQuestionWizard(wizard)
        }
        await tg.answerCallbackQuery(callbackQuery.id, "Selected").catch(() => {})
        return
      }

      if (action === "t") {
        if (!multiple) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const optIndex = Number(arg)
        if (!Number.isInteger(optIndex) || !q.options?.[optIndex]) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const label = String(q.options[optIndex].label)
        const current = new Set(wizard.selectedByIndex?.[qIndex] || [])
        if (current.has(label)) current.delete(label)
        else current.add(label)
        const nextWizard = cloneWizardState(wizard)
        nextWizard.selectedByIndex[qIndex] = Array.from(current)
        if (messageId) await sendCurrentQuestionStep(nextWizard, { editMessageId: messageId })
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        await tg.answerCallbackQuery(callbackQuery.id).catch(() => {})
        return
      }

      if (action === "done") {
        if (!multiple) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const selected = wizard.selectedByIndex?.[qIndex] || []
        const nextWizard = cloneWizardState(wizard)
        nextWizard.answers[qIndex] = selected
        const nextIndex = qIndex + 1
        if (nextIndex >= req.questions.length) {
          persistQuestionWizard(nextWizard)
          await finishQuestionWizard(nextWizard)
        } else {
          nextWizard.index = nextIndex
          await sendCurrentQuestionStep(nextWizard)
          applyWizardState(wizard, nextWizard)
          persistQuestionWizard(wizard)
        }
        await tg.answerCallbackQuery(callbackQuery.id, "Done").catch(() => {})
        return
      }

      await tg.answerCallbackQuery(callbackQuery.id, "Unsupported")
      return
    }

    await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
  }

  async function onSseEvent({ projectAlias, evt }) {
    const type = evt?.type
    const props = evt?.properties || {}

    if (type === "message.updated") {
      const sessionId = props.sessionID
      const info = props.info
      if (!sessionId || !info?.id || !info?.role) return
      logSseDebug(projectAlias, sessionId, `event type=message.updated role=${info.role} msg=${info.id}`)
      const sk = sessionKey(projectAlias, sessionId)
      const resolved = await resolveBoundRoute(projectAlias, sessionId)
      if (!resolved?.route) {
        logSseDebug(projectAlias, sessionId, "drop=no_route")
        return
      }
      const route = resolved.route
      const routeCtx = ctxMetaFromRoute(route)
      const boundKey = sessionKey(projectAlias, resolved.boundSessionId)

      if (resolved.boundSessionId !== sessionId) {
        logSseDebug(projectAlias, sessionId, `drop=child_message bound=${resolved.boundSessionId}`)
        return
      }

      if (!eventStartedAfterLaunch(info, { allowCompletedAfterStart: info.role === "assistant" })) {
        logSseDebug(projectAlias, sessionId, "drop=before_connector_start")
        return
      }

      const oc = ocByAlias[projectAlias]
      const sets = ensureForwardedSets(sk)

      if (info.role === "user") {
        if (sets.user.has(info.id)) {
          logSseDebug(projectAlias, sessionId, `drop=user_already_forwarded msg=${info.id}`)
          return
        }
        const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
        const text = extractTextParts(msg)
        if (!text || !text.trim()) {
          logSseDebug(projectAlias, sessionId, `drop=user_empty msg=${info.id}`)
          return
        }
        const mode = config.echoFilterMode ?? "recent"

        let isEcho = false
        if (mode === "prefix") {
          const prefix = config.tgPrefix ?? ""
          const p = String(prefix).trim()
          isEcho = p ? text.trimStart().startsWith(p) : false
        } else if (mode === "recent") {
          const h = hashTextForEcho(text)
          const recent = ensureRecentPromptSet(sk)
          if (recent.has(h)) {
            isEcho = true
          }
        }
        if (isEcho) {
          logSseDebug(projectAlias, sessionId, `drop=user_echo msg=${info.id}`)
          return
        }

        if (!shouldMirrorToFeed(routeCtx.ctxKey, "user-mirror")) {
          sets.user.add(info.id)
          logSseDebug(projectAlias, sessionId, `drop=user_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
          return
        }

        const blocks = [{ type: "text", html: "<b>User</b>" }, ...formatMarkdownToTelegramHtmlBlocks(text)]
        await tg.sendHtmlBlocks(route.chatId, blocks, null, { message_thread_id: route.threadIdOr0 || undefined })
        sets.user.add(info.id)
        logSseDebug(projectAlias, sessionId, `send=user msg=${info.id} thread=${route.threadIdOr0 || 0}`)
      }

      if (info.role === "assistant") {
        if (!mirrorCompaction && (info.mode === "compaction" || info.agent === "compaction")) {
          logSseDebug(projectAlias, sessionId, `drop=compaction msg=${info.id}`)
          return
        }
        const completed = normalizeEpochMs(info.time?.completed) != null
        const hasError = !!info.error

        // Remember the most recent assistant message for /sendlast.
        lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: null })

        if (hasError) {
          const previewState = assistantPreviewBySession.get(boundKey)
          if (previewState?.messageId === info.id && previewState.telegramMessageId) {
            await tg
              .editMessageText(route.chatId, previewState.telegramMessageId, `Assistant reply failed.\n\n${String(info.error)}`, null)
              .catch(() => {})
            assistantPreviewBySession.delete(boundKey)
          }
          logSseDebug(projectAlias, sessionId, `drop=assistant_error msg=${info.id}`)
          return
        }

        if (!completed) {
          if (!shouldMirrorToFeed(routeCtx.ctxKey, "assistant-stream")) {
            logSseDebug(projectAlias, sessionId, `drop=assistant_preview_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
            return
          }

          const previewState = assistantPreviewBySession.get(boundKey)
          const lastPreviewAt = previewState?.messageId === info.id ? previewState.lastPreviewAt || 0 : 0
          if (Date.now() - lastPreviewAt < 200) {
            logSseDebug(projectAlias, sessionId, `drop=assistant_preview_throttled msg=${info.id}`)
            return
          }

          const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
          if (!eventStartedAfterLaunch(msg?.info || info, { allowCompletedAfterStart: true })) {
            logSseDebug(projectAlias, sessionId, `drop=assistant_preview_before_start msg=${info.id}`)
            return
          }
          if (!mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
            logSseDebug(projectAlias, sessionId, `drop=assistant_preview_compaction msg=${info.id}`)
            return
          }

          const text = extractTextParts(msg)
          const previewHtml = buildAssistantStreamPreviewHtml(text)
          const state =
            previewState?.messageId === info.id
              ? previewState
              : { messageId: info.id, telegramMessageId: null, lastPreviewHtml: "", lastPreviewAt: 0 }
          if (state.lastPreviewHtml === previewHtml) return
          if (!state.telegramMessageId) {
            const sent = await tg
              .sendMessage(route.chatId, previewHtml, null, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                message_thread_id: route.threadIdOr0 || undefined,
              })
              .catch(() => null)
            state.telegramMessageId = sent?.message_id || null
          } else {
            await tg
              .editMessageText(route.chatId, state.telegramMessageId, previewHtml, null, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
              })
              .catch(() => {})
          }
          state.lastPreviewHtml = previewHtml
          state.lastPreviewAt = Date.now()
          assistantPreviewBySession.set(boundKey, state)
          logSseDebug(projectAlias, sessionId, `stream=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
          return
        }

        const existing = assistantDebounce.get(info.id)
        if (existing) clearTimeout(existing)
        const t = setTimeout(() => {
          assistantDebounce.delete(info.id)
          if (sets.assistant.has(info.id)) {
            logSseDebug(projectAlias, sessionId, `drop=assistant_already_forwarded msg=${info.id}`)
            return
          }
          void (async () => {
            const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
            if (!eventStartedAfterLaunch(msg?.info, { allowCompletedAfterStart: true })) {
              logSseDebug(projectAlias, sessionId, `drop=assistant_message_before_start msg=${info.id}`)
              return
            }
            if (!mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
              logSseDebug(projectAlias, sessionId, `drop=compaction_message msg=${info.id}`)
              return
            }

            const displayText = extractAssistantDisplayText(projectAlias, msg)
            const text = extractTextParts(msg)
            const changedFilesSummary = extractChangedFilesSummary(projectAlias, msg)
            const hasAssistantText = !!text?.trim()
            const hasChangedFiles = !!changedFilesSummary

            const previewState = assistantPreviewBySession.get(boundKey)
            const replaceMessageId = previewState?.messageId === info.id ? previewState.telegramMessageId : undefined

            if (!displayText || !displayText.trim()) {
              if (replaceMessageId) {
                await tg
                  .editMessageText(route.chatId, replaceMessageId, "Assistant reply finished with no Telegram-visible content.", null)
                  .catch(() => {})
                assistantPreviewBySession.delete(boundKey)
              }
              sets.assistant.add(info.id)
              logSseDebug(projectAlias, sessionId, `drop=assistant_empty msg=${info.id}`)
              return
            }

            // Only attach text if this is still the latest.
            const current = lastAssistantBySession.get(boundKey)
            if (current?.messageId === info.id) lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: displayText })
            const allowChangedFiles = hasChangedFiles && shouldMirrorToFeed(routeCtx.ctxKey, "changed-files")
            let visibleOutputSent = false

            if (hasAssistantText) {
              await deliverAssistantText(routeCtx, projectAlias, sessionId, info.id, text, { replaceMessageId })
              visibleOutputSent = true
            }

            if (allowChangedFiles) {
              await deliverChangedFilesSummary(routeCtx, projectAlias, sessionId, info.id, msg, {
                replaceMessageId: !hasAssistantText ? replaceMessageId : undefined,
              })
              visibleOutputSent = true
              sets.changes.add(info.id)
              logSseDebug(projectAlias, sessionId, `send=changed_files msg=${info.id} thread=${route.threadIdOr0 || 0}`)
            } else if (hasChangedFiles) {
              sets.changes.add(info.id)
              logSseDebug(projectAlias, sessionId, `drop=changed_files_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
            }

            if (replaceMessageId && !visibleOutputSent) {
              await tg
                .editMessageText(route.chatId, replaceMessageId, "Assistant reply finished, but no updates matched the current feed mode.", null)
                .catch(() => {})
            }

            if (replaceMessageId) assistantPreviewBySession.delete(boundKey)
            sets.assistant.add(info.id)
            logSseDebug(projectAlias, sessionId, `send=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
          })().catch(() => {})
        }, 250)
        assistantDebounce.set(info.id, t)
      }
      return
    }

    if (type === "permission.asked") {
      const sessionId = props.sessionID
      logSseDebug(projectAlias, sessionId, `event type=permission.asked id=${props.id}`)
      const resolved = await resolveBoundRoute(projectAlias, sessionId)
      if (!resolved?.route) {
        logSseDebug(projectAlias, sessionId, "drop=permission_no_route")
        return
      }
      const route = resolved.route
      await ensureBaselineLoaded(projectAlias)
      if (!promptBaseline[projectAlias]?.loaded) return
      if (promptBaseline[projectAlias].permission.has(props.id)) return
      if (prompted[projectAlias].permission.has(props.id)) return
      prompted[projectAlias].permission.add(props.id)
      const ctxMeta = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
      store.setPendingPermission({
        projectAlias,
        permissionId: props.id,
        sessionID: props.sessionID,
        permission: props.permission,
        patterns: Array.isArray(props.patterns) ? props.patterns : [],
        ctx: ctxMeta,
        createdAt: Date.now(),
      })
      await sendPermissionPrompt(projectAlias, props, ctxMeta)
      return
    }

    if (type === "question.asked") {
      const sessionId = props.sessionID
      logSseDebug(projectAlias, sessionId, `event type=question.asked id=${props.id}`)
      const resolved = await resolveBoundRoute(projectAlias, sessionId)
      if (!resolved?.route) {
        logSseDebug(projectAlias, sessionId, "drop=question_no_route")
        return
      }
      const route = resolved.route
      await ensureBaselineLoaded(projectAlias)
      if (!promptBaseline[projectAlias]?.loaded) return
      if (promptBaseline[projectAlias].question.has(props.id)) return
      if (prompted[projectAlias].question.has(props.id)) return
      prompted[projectAlias].question.add(props.id)

      if (!props?.id || !Array.isArray(props.questions) || props.questions.length === 0) return

      const ctx = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
      const wizard = {
        projectAlias,
        id: props.id,
        sessionID: props.sessionID,
        request: props,
        index: 0,
        answers: Array.from({ length: props.questions.length }, () => []),
        selectedByIndex: {},
        messageIdByIndex: {},
        createdAt: Date.now(),
        ctx,
      }
      questionWizards.set(wizardKey(projectAlias, props.id), wizard)
      persistQuestionWizard(wizard)

      await sendBlocksToThread(ctx, [
        {
          type: "text",
          html: `<b>Question request</b>\n<code>${escapeHtml(props.id)}</code>\n\n${escapeHtml(`Project: ${projectAlias}`)}`,
        },
      ])
      await sendCurrentQuestionStep(wizard)
      return
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
        .getUpdates({ offset, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"] })
        .catch((err) => {
          logger.error("Backlog drain error:", err?.message || String(err))
          return null
        })

      if (!Array.isArray(updates)) {
        await sleep(backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

      backoff = 1000
      if (updates.length === 0) break
      offset = updates[updates.length - 1].update_id + 1
      await sleep(200)
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
        .getUpdates({ offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"] })
        .catch((err) => {
          logger.error("getUpdates error:", err?.message || String(err))
          return null
        })
      if (!Array.isArray(updates)) {
        // Avoid a tight loop on network/API errors.
        await sleep(backoff)
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
          await sleep(1000)
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
          return notifyProjectUnavailable(projectAlias, err)
        },
        abortSignal: abortController.signal,
      }),
    )
  }

  // Periodic prompt poll (helps when SSE is down).
  void (async () => {
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
      await sleep(15_000)
    }
  })()

  void telegramLoop()

  const stop = async () => {
    abortController.abort()
    clearInterval(wizardGcTimer)
    for (const s of sseLoops) s.stop?.()
    for (const h of autoStarted.values()) {
      await Promise.resolve(h.stop?.()).catch(() => {})
    }
    await store.flush().catch(() => {})
  }

  return { stop, stateFile }
}
