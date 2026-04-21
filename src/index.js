import { setTimeout as delay } from "node:timers/promises"
import crypto from "node:crypto"
import { TelegramClient, makeInlineKeyboard } from "./telegram/client.js"
import { formatMarkdownToTelegramHtmlBlocks, escapeHtml } from "./telegram/formatter.js"
import { ctxKeyFrom, threadIdOr0FromMessage } from "./telegram/routing.js"
import { OpenCodeClient } from "./opencode/client.js"
import { startOpenCodeSseLoop } from "./opencode/sse.js"
import { ensureStartupSession } from "./opencode/startup-session.js"
import { ensureOpenCodeRunning, openAttachWindowWindows } from "./opencode/launcher.js"
import { StateStore, resolveDefaultStatePath, sessionKey } from "./state/store.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "./session-list.js"
import { sanitizeBaseUrlForDisplay } from "./url-utils.js"

function now() {
  return new Date().toISOString()
}

function defaultLogger() {
  return {
    info: (...args) => console.log(now(), ...args),
    error: (...args) => console.error(now(), ...args),
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

export async function startConnector({ config, logger: loggerIn } = {}) {
  const logger = loggerIn || defaultLogger()
  const startedAt = Date.now()

  const stateFile = config?.stateFile || resolveDefaultStatePath({ cwd: config?.cwd })
  const store = new StateStore({ filePath: stateFile, logger })
  await store.load()

  // Log only aggregate persisted-state info; bindings themselves are sensitive.
  try {
    const st = store.get()
    const entries = Object.entries(st?.bindings || {})
    logger.info("State bindings:", entries.length)
  } catch {
    // ignore
  }

  const tg = new TelegramClient(config.telegram.botToken)
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
      { command: "status", description: "Показать текущую привязку" },
      { command: "sendlast", description: "Отправить последнее сообщение модели" },
      { command: "unbind", description: "Убрать привязку" },
      { command: "cancel", description: "Отменить текущий ввод" },
    ])
    .catch((err) => logger.error("Failed to set bot commands:", err?.message || String(err)))

  const projects = config.projects
  const ocByAlias = {}
  for (const [alias, p] of Object.entries(projects)) {
    ocByAlias[alias] = new OpenCodeClient({
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
    return ensureStartupSession({
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
        const handle = await ensureOpenCodeRunning({ projectAlias: alias, project: p, ocClient: oc, logger })
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
    if (process.platform === "win32") return true
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
  // Bound the amount of per-session state we keep.
  const forwardedBySession = new LruMap(2000) // sessionKey -> {user:LruSet, assistant:LruSet}
  const assistantDebounce = new Map() // msgId -> timeout
  const recentTgPromptsBySession = new LruMap(2000) // sessionKey -> LruSet(hash)
  const lastAssistantBySession = new LruMap(2000) // sessionKey -> { messageId, text }

  const promptBaseline = {}
  const prompted = {}
  for (const alias of Object.keys(projects)) {
    promptBaseline[alias] = { loaded: false, permission: new Set(), question: new Set() }
    prompted[alias] = { permission: new LruSet(5000), question: new LruSet(5000) }
  }

  // projectAlias -> boolean (used to suppress repeated Telegram notices while a project stays down)
  const projectIsDown = new Map()

  function markProjectUp(projectAlias) {
    if (projectIsDown.get(projectAlias)) {
      projectIsDown.set(projectAlias, false)
      projectLastUnavailableNoticeAt.set(projectAlias, 0)
    }
  }


  const rejectNoteAwaiting = new Map() // key ctxKey -> { projectAlias, permissionId }
  const awaitingCustomAnswer = new Map() // key ctxKey -> { projectAlias, requestId, qIndex }
  const questionWizards = new Map() // key `${projectAlias}:${requestId}` -> wizard

  const bindAliasAwaiting = new Map() // key ctxKey -> { startedAt }

  const wizardKey = (projectAlias, requestId) => `${projectAlias}:${requestId}`
  const getWizard = (projectAlias, requestId) => questionWizards.get(wizardKey(projectAlias, requestId)) || null

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

  async function finishQuestionWizard(wizard) {
    const oc = ocByAlias[wizard.projectAlias]
    await oc.replyQuestion(wizard.request.id, wizard.answers)
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
    await sendToThread(wizard.ctx, `Answered: ${wizard.request.id}`)
  }

  const abortController = new AbortController()

  // Prevent abandoned question wizards from accumulating indefinitely.
  const WIZARD_TTL_MS = 2 * 60 * 60 * 1000
  const wizardGcTimer = setInterval(() => {
    const t = Date.now()
    for (const [k, w] of questionWizards.entries()) {
      const createdAt = typeof w?.createdAt === "number" ? w.createdAt : 0
      if (!createdAt || t - createdAt > WIZARD_TTL_MS) questionWizards.delete(k)
    }
  }, 10 * 60 * 1000)
  wizardGcTimer.unref?.()

  const projectLastUnavailableNoticeAt = new Map() // projectAlias -> epochMs

  function ensureForwardedSets(sk) {
    let s = forwardedBySession.get(sk)
    if (!s) {
      s = { user: new LruSet(8000), assistant: new LruSet(8000) }
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
    const threadIdOr0 = threadIdOr0FromMessage(msg)
    return { chatId, threadIdOr0, ctxKey: ctxKeyFrom(chatId, threadIdOr0) }
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

  async function ensureBaselineLoaded(projectAlias) {
    const base = promptBaseline[projectAlias]
    if (!base || base.loaded) return
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
        if (process.platform === "win32") {
          await openAttachWindowWindows({ directory: p.directory, baseUrl: p.baseUrl, sessionId: created.id }).catch((err) => {
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
    if (!sessionId) {
      await sendToThread(ctxMeta, "Usage: /use <sessionId>")
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      await oc.getSession(sessionId)
      await bindCtxToSession(ctxMeta, binding.projectAlias, sessionId)
      await sendToThread(ctxMeta, `Switched to session: ${sessionId}`)
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
    await sendToThread(ctxMeta, `Project: ${binding.projectAlias}\nSession: ${binding.sessionId}`)
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
    let text = typeof last?.text === "string" ? last.text : ""

    if (messageId) {
      const msg = await oc.getMessage(binding.sessionId, messageId).catch(() => null)
      const fetched = extractTextParts(msg)
      if (fetched && fetched.trim()) text = fetched
    }

    if (!text || !text.trim()) {
      await sendToThread(ctxMeta, "No assistant message yet.")
      return
    }

    const blocks = formatMarkdownToTelegramHtmlBlocks(text)
    await sendBlocksToThread(ctxMeta, blocks, null)
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
      awaitingCustomAnswer.delete(ctxMeta.ctxKey)
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        await sendToThread(ctxMeta, "Question is no longer active.")
        return
      }
      wizard.answers[awaitingQ.qIndex] = [text]
      wizard.index = awaitingQ.qIndex + 1
      if (wizard.index >= wizard.request.questions.length) {
        await finishQuestionWizard(wizard)
      } else {
        await sendCurrentQuestionStep(wizard)
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      rejectNoteAwaiting.delete(ctxMeta.ctxKey)
      const oc = ocByAlias[awaiting.projectAlias]
      await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      await sendToThread(ctxMeta, "Rejection note sent.")
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
        const had =
          bindAliasAwaiting.delete(ctxMeta.ctxKey) ||
          rejectNoteAwaiting.delete(ctxMeta.ctxKey) ||
          awaitingCustomAnswer.delete(ctxMeta.ctxKey)
        await sendToThread(ctxMeta, had ? "Cancelled." : "Nothing to cancel.")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        await sendToThread(
          ctxMeta,
          [
            "Commands:",
            "/bind <projectAlias>",
            "/new [title]",
            "/use <sessionId>",
            "/sessions",
            "/status",
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
      if (cmd === "/status") return handleWhere(ctxMeta)
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
        await tg.answerCallbackQuery(callbackQuery.id, "OK")
        return
      }
      if (action === "reject_note") {
        rejectNoteAwaiting.set(ctxMeta.ctxKey, { projectAlias, permissionId })
        await tg.answerCallbackQuery(callbackQuery.id, "Send note")
        await sendToThread(
          ctxMeta,
          `Send rejection note for ${permissionId} (next message will be used).`,
          makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`p|${projectAlias}|${permissionId}|cancel_note`) }]]),
        )
        return
      }
      if (action === "cancel_note") {
        rejectNoteAwaiting.delete(ctxMeta.ctxKey)
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
        if (wizard) questionWizards.delete(wizardKey(projectAlias, questionId))
        awaitingCustomAnswer.delete(ctxMeta.ctxKey)
        await tg.answerCallbackQuery(callbackQuery.id, "Rejected")
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
        awaitingCustomAnswer.set(ctxMeta.ctxKey, { projectAlias, requestId: questionId, qIndex })
        await tg.answerCallbackQuery(callbackQuery.id, "Send answer")
        await sendToThread(
          ctxMeta,
          `Send your answer for: ${q.header || "question"} (next message will be used).`,
          makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`q|${projectAlias}|${questionId}|${qIndex}|cancel_custom`) }]]),
        )
        return
      }

      if (action === "cancel_custom") {
        awaitingCustomAnswer.delete(ctxMeta.ctxKey)
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
        wizard.answers[qIndex] = [label]
        wizard.index = qIndex + 1
        await tg.answerCallbackQuery(callbackQuery.id, "Selected")
        if (wizard.index >= req.questions.length) await finishQuestionWizard(wizard)
        else await sendCurrentQuestionStep(wizard)
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
        wizard.selectedByIndex[qIndex] = Array.from(current)
        await tg.answerCallbackQuery(callbackQuery.id)
        if (messageId) await sendCurrentQuestionStep(wizard, { editMessageId: messageId })
        return
      }

      if (action === "done") {
        if (!multiple) {
          await tg.answerCallbackQuery(callbackQuery.id, "Invalid")
          return
        }
        const selected = wizard.selectedByIndex?.[qIndex] || []
        wizard.answers[qIndex] = selected
        wizard.index = qIndex + 1
        await tg.answerCallbackQuery(callbackQuery.id, "Done")
        if (wizard.index >= req.questions.length) await finishQuestionWizard(wizard)
        else await sendCurrentQuestionStep(wizard)
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
      const sk = sessionKey(projectAlias, sessionId)
      const route = store.get().sessionIndex[sk]
      if (!route) return

      const createdMs = normalizeEpochMs(info.time?.created)
      if (createdMs != null && createdMs < startedAt) return

      const oc = ocByAlias[projectAlias]
      const sets = ensureForwardedSets(sk)

      if (info.role === "user") {
        if (sets.user.has(info.id)) return
        const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
        const msgCreated = normalizeEpochMs(msg?.info?.time?.created)
        if (msgCreated == null || msgCreated < startedAt) return
        const text = extractTextParts(msg)
        if (!text || !text.trim()) return
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
        if (isEcho) return

        const blocks = [{ type: "text", html: "<b>User</b>" }, ...formatMarkdownToTelegramHtmlBlocks(text)]
        await tg.sendHtmlBlocks(route.chatId, blocks, null, { message_thread_id: route.threadIdOr0 || undefined })
        sets.user.add(info.id)
      }

      if (info.role === "assistant") {
        const completed = normalizeEpochMs(info.time?.completed) != null
        const hasError = !!info.error
        if (!completed || hasError) return

        // Remember the most recent assistant message for /sendlast.
        lastAssistantBySession.set(sk, { messageId: info.id, text: null })

        const existing = assistantDebounce.get(info.id)
        if (existing) clearTimeout(existing)
        const t = setTimeout(() => {
          assistantDebounce.delete(info.id)
          if (sets.assistant.has(info.id)) return
          void (async () => {
            const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
            const msgCreated = normalizeEpochMs(msg?.info?.time?.created)
            if (msgCreated == null || msgCreated < startedAt) return
            const text = extractTextParts(msg)
            if (!text || !text.trim()) return

            // Only attach text if this is still the latest.
            const current = lastAssistantBySession.get(sk)
            if (current?.messageId === info.id) lastAssistantBySession.set(sk, { messageId: info.id, text })

            const blocks = formatMarkdownToTelegramHtmlBlocks(text)
            await tg.sendHtmlBlocks(route.chatId, blocks, null, { message_thread_id: route.threadIdOr0 || undefined })
            sets.assistant.add(info.id)
          })().catch(() => {})
        }, 250)
        assistantDebounce.set(info.id, t)
      }
      return
    }

    if (type === "permission.asked") {
      const sessionId = props.sessionID
      const sk = sessionKey(projectAlias, sessionId)
      const route = store.get().sessionIndex[sk]
      if (!route) return
      await ensureBaselineLoaded(projectAlias)
      if (!promptBaseline[projectAlias]?.loaded) return
      if (promptBaseline[projectAlias].permission.has(props.id)) return
      if (prompted[projectAlias].permission.has(props.id)) return
      prompted[projectAlias].permission.add(props.id)
      const ctxMeta = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
      await sendBlocksToThread(
        ctxMeta,
        [
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
        makeInlineKeyboard([
          [
            { text: "Allow once", callback_data: cb.pack(`p|${projectAlias}|${props.id}|once`) },
            { text: "Always allow", callback_data: cb.pack(`p|${projectAlias}|${props.id}|always`) },
          ],
          [
            { text: "Reject", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject`) },
            { text: "Reject with note", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject_note`) },
          ],
        ]),
      )
      return
    }

    if (type === "question.asked") {
      const sessionId = props.sessionID
      const sk = sessionKey(projectAlias, sessionId)
      const route = store.get().sessionIndex[sk]
      if (!route) return
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
        await delay(backoff)
        backoff = Math.min(30_000, backoff * 2)
        continue
      }

      backoff = 1000
      if (updates.length === 0) break
      offset = updates[updates.length - 1].update_id + 1
      await delay(200)
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
        await delay(backoff)
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
          await delay(1000)
          break
        }
      }
    }
  }

  const sseLoops = []
  for (const alias of Object.keys(projects)) {
    sseLoops.push(
      startOpenCodeSseLoop({
        projectAlias: alias,
        ocClient: ocByAlias[alias],
        logger,
        onConnect: ({ projectAlias }) => markProjectUp(projectAlias),
        onEvent: onSseEvent,
        onError: ({ projectAlias, err }) => notifyProjectUnavailable(projectAlias, err),
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
      await delay(15_000)
    }
  })()

  void telegramLoop()

  const stop = async () => {
    abortController.abort()
    clearInterval(wizardGcTimer)
    for (const s of sseLoops) s.stop?.()
    for (const h of autoStarted.values()) {
      await h.stop?.().catch(() => {})
    }
    await store.flush().catch(() => {})
  }

  return { stop, stateFile }
}
