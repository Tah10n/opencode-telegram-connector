import { makeInlineKeyboard } from "../telegram/client.js"
import { redactCmdlineSecrets, sanitizeBaseUrlForDisplay } from "../url-utils.js"
import { isRetryableBoundaryError, normalizeBoundaryError } from "../boundary-errors.js"
import { getLaunchSupport } from "../opencode/launcher.js"
import { callbackPacker } from "./callback-data.js"
import { matchSupportedLocale, t as translate } from "../i18n/index.js"

export function buildProjectsOverviewText({
  projects,
  bindings,
  startupSessionByProject,
  getProjectSseStatus,
  parseCtxKey,
  formatThreadLabel,
  previewLimit = 3,
  showBindingScopes = true,
  showProjectDetails = true,
  hiddenBindingsLabel,
  locale = "en",
  t = translate,
}) {
  const aliases = Object.keys(projects || {})
  if (!aliases.length) return t(locale, "overview.noProjects")

  const lines = [t(locale, "overview.title")]
  for (const alias of aliases) {
    const project = projects?.[alias] || {}
    const url = sanitizeBaseUrlForDisplay(project.baseUrl)
    const startupSessionId = startupSessionByProject?.[alias] || "unknown"
    const sseStatus = getProjectSseStatus(alias)

    const scopes = Object.entries(bindings || {})
      .filter(([, binding]) => binding?.projectAlias === alias)
      .map(([ctxKey]) => parseCtxKey(ctxKey))
      .filter(Boolean)
      .map((ctx) => `chat ${ctx.chatId}/${formatThreadLabel(ctx.threadIdOr0)}`)

    const shownScopes = scopes.slice(0, previewLimit)
    const suffix = scopes.length > previewLimit ? `, ${t(locale, "overview.more", { count: scopes.length - previewLimit })}` : ""
    const bindingSummary = showBindingScopes
      ? `${scopes.length}${shownScopes.length ? ` (${shownScopes.join(", ")}${suffix})` : ""}`
      : hiddenBindingsLabel || t(locale, "overview.hiddenBindings")

    lines.push(`- ${alias}`)
    if (showProjectDetails) {
      lines.push(`  ${t(locale, "overview.url", { url: url || "unknown" })}`)
      lines.push(`  ${t(locale, "overview.startupSession", { session: startupSessionId })}`)
    }
    lines.push(`  ${t(locale, "overview.sse", { status: sseStatus })}`)
    lines.push(`  ${t(locale, "overview.bindings", { summary: bindingSummary })}`)
  }

  return lines.join("\n")
}

export function buildProjectsOverviewKeyboard({
  projects,
  cb,
  canAutoStartProject,
  platform,
  showProjectControls = true,
  showSessions = false,
  showBindControls = false,
  currentBinding = null,
  locale = "en",
  t = translate,
}) {
  const packCallback = callbackPacker(cb)
  const rows = []
  if (showProjectControls || showBindControls) {
    for (const alias of Object.keys(projects || {})) {
      const row = []
      if (showBindControls && (!currentBinding || currentBinding.projectAlias === alias)) {
        row.push({ text: currentBinding?.projectAlias === alias ? t(locale, "overview.bound", { alias }) : t(locale, "overview.bind", { alias }), callback_data: packCallback("srv", alias, "bind") })
      }
      if (showProjectControls && canAutoStartProject?.(alias, { platform })) {
        row.push({ text: t(locale, "overview.start", { alias }), callback_data: packCallback("srv", alias, "start") })
      }
      if (showProjectControls) row.push({ text: t(locale, "overview.status", { alias }), callback_data: packCallback("srv", alias, "health") })
      if (showProjectControls && showSessions) row.push({ text: t(locale, "overview.sessions", { alias }), callback_data: packCallback("srv", alias, "sessions") })
      if (row.length) rows.push(row)
    }
  }
  rows.push([{ text: t(locale, "common.close"), callback_data: packCallback("srv", "close") }])
  return makeInlineKeyboard(rows)
}

export function createOverviewHelpers({ projects, store, config, startInProgress, parseCtxKey, sendToThread, cb }) {
  const projectLastUnavailableNoticeAt = new Map()
  const threadLastUnavailableNoticeAt = new Map()
  const threadUnavailableNoticeInFlight = new Set()
  const projectUnavailableNoticeCtxKeys = new Map()
  const projectIsDown = new Map()
  const projectSseState = new Map(Object.keys(projects).map((alias) => [alias, "unknown"]))

  function storedLocaleForCtx(ctxKey) {
    const record = store.getLocaleRecord?.(ctxKey)
    if (record?.source === "telegram" && config?.i18n?.autoDetectTelegramLanguage === false) return ""
    return matchSupportedLocale(record?.locale, config?.i18n?.supportedLocales)
  }

  function canAutoStartProject(alias, { platform }) {
    return getLaunchSupport({ project: projects?.[alias], platform }).canAutoStart
  }

  function isRetryableProjectError(err) {
    return isRetryableBoundaryError(err, { source: "opencode" })
  }

  function formatProjectUnavailable(projectAlias, err, { locale = "en" } = {}) {
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl)
    const msg = redactCmdlineSecrets(normalizeBoundaryError(err, { source: "opencode" }).message)
    return `${translate(locale, "overview.projectUnavailable", { project: projectAlias, baseUrl })}\n\n${msg}`
  }

  function startServerKeyboard(projectAlias, { locale = "en" } = {}) {
    const packCallback = callbackPacker(cb)
    return makeInlineKeyboard([
      [
        {
          text: translate(locale, "overview.startQuoted", { project: projectAlias }),
          callback_data: packCallback("srv", projectAlias, "start"),
        },
      ],
      [{ text: translate(locale, "common.close"), callback_data: packCallback("srv", "close") }],
    ])
  }

  async function notifyProjectRecovered(projectAlias) {
    const st = store.get()
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl) || "unknown"
    const notifiedCtxKeys = new Set(projectUnavailableNoticeCtxKeys.get(projectAlias) || [])
    if (!notifiedCtxKeys.size) return
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      if (!notifiedCtxKeys.has(ctxKey)) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      const locale = storedLocaleForCtx(ctxKey) || config?.i18n?.defaultLocale || "en"
      const message = translate(locale, "overview.recovered", { project: projectAlias, baseUrl })
      await sendToThread(ctx, message).catch(() => {})
    }
  }

  async function notifyProjectRecoveredForThread(projectAlias, ctxMeta) {
    if (!ctxMeta?.chatId) return
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl) || "unknown"
    const locale = ctxMeta.locale || storedLocaleForCtx(ctxMeta.ctxKey) || config?.i18n?.defaultLocale || "en"
    const message = translate(locale, "overview.recovered", { project: projectAlias, baseUrl })
    await sendToThread(ctxMeta, message).catch(() => {})
  }

  function markProjectUp(projectAlias) {
    const wasDown = projectIsDown.get(projectAlias) === true
    if (wasDown) {
      projectIsDown.set(projectAlias, false)
      projectLastUnavailableNoticeAt.set(projectAlias, 0)
      const recovered = notifyProjectRecovered(projectAlias)
      clearThreadUnavailableNoticeState(projectAlias)
      void recovered.catch(() => {})
    } else {
      clearThreadUnavailableNoticeState(projectAlias)
      projectIsDown.set(projectAlias, false)
    }
  }

  function clearThreadUnavailableNoticeState(projectAlias) {
    const prefix = `${projectAlias}:`
    for (const key of threadLastUnavailableNoticeAt.keys()) {
      if (key.startsWith(prefix)) threadLastUnavailableNoticeAt.delete(key)
    }
    for (const key of threadUnavailableNoticeInFlight.keys()) {
      if (key.startsWith(prefix)) threadUnavailableNoticeInFlight.delete(key)
    }
    projectUnavailableNoticeCtxKeys.delete(projectAlias)
  }

  function rememberUnavailableNotice(projectAlias, ctxKey) {
    if (!ctxKey) return
    let ctxKeys = projectUnavailableNoticeCtxKeys.get(projectAlias)
    if (!ctxKeys) {
      ctxKeys = new Set()
      projectUnavailableNoticeCtxKeys.set(projectAlias, ctxKeys)
    }
    ctxKeys.add(ctxKey)
  }

  function markProjectSseConnected(projectAlias) {
    projectSseState.set(projectAlias, "connected")
    markProjectUp(projectAlias)
  }

  function markProjectSseDown(projectAlias) {
    projectSseState.set(projectAlias, "down")
  }

  function markProjectSseUnavailable(projectAlias, reason = "unavailable") {
    const suffix = String(reason || "").trim()
    projectSseState.set(projectAlias, suffix ? `unavailable (${suffix})` : "unavailable")
  }

  function getProjectSseStatus(projectAlias) {
    return projectSseState.get(projectAlias) || "unknown"
  }

  function reserveProjectUnavailableNotice(projectAlias, { force = false } = {}) {
    if (!force && startInProgress.has(projectAlias)) return
    const nowMs = Date.now()
    const last = projectLastUnavailableNoticeAt.get(projectAlias) || 0
    const isDown = projectIsDown.get(projectAlias) === true
    const minIntervalMs = isDown ? 10 * 60_000 : 60_000
    if (!force && nowMs - last < minIntervalMs) return
    projectLastUnavailableNoticeAt.set(projectAlias, nowMs)
    projectIsDown.set(projectAlias, true)
    return true
  }

  function threadUnavailableNoticeKey(projectAlias, ctxKey) {
    return `${projectAlias}:${ctxKey}`
  }

  function ctxKeyForThreadNotice(ctxMeta) {
    return ctxMeta?.ctxKey || `${ctxMeta?.chatId ?? "unknown"}:${ctxMeta?.threadIdOr0 || 0}`
  }

  function canReserveThreadUnavailableNoticeAt(projectAlias, ctxKey, nowMs, { force = false } = {}) {
    if (!ctxKey) return false
    const key = `${projectAlias}:${ctxKey}`
    const last = threadLastUnavailableNoticeAt.get(key) || 0
    const isDown = projectIsDown.get(projectAlias) === true
    const minIntervalMs = isDown ? 10 * 60_000 : 60_000
    return !!(force || nowMs - last >= minIntervalMs)
  }

  function reserveThreadUnavailableNoticeAt(projectAlias, ctxKey, nowMs, { force = false } = {}) {
    if (!canReserveThreadUnavailableNoticeAt(projectAlias, ctxKey, nowMs, { force })) return
    const key = threadUnavailableNoticeKey(projectAlias, ctxKey)
    threadLastUnavailableNoticeAt.set(key, nowMs)
    return true
  }

  function beginThreadUnavailableNoticeDelivery(projectAlias, ctxMeta, { force = false, nowMs = Date.now() } = {}) {
    if (!force && startInProgress.has(projectAlias)) return
    const ctxKey = ctxKeyForThreadNotice(ctxMeta)
    const key = threadUnavailableNoticeKey(projectAlias, ctxKey)
    if (!canReserveThreadUnavailableNoticeAt(projectAlias, ctxKey, nowMs, { force })) return
    if (!force && threadUnavailableNoticeInFlight.has(key)) return
    threadUnavailableNoticeInFlight.add(key)
    return { key, ctxKey, ctxMeta, nowMs }
  }

  async function finishThreadUnavailableNoticeDelivery(projectAlias, reservation, { delivered = false } = {}) {
    if (!reservation) return
    const stillReserved = threadUnavailableNoticeInFlight.delete(reservation.key)
    if (!delivered) return
    if (!stillReserved) {
      if (projectIsDown.get(projectAlias) !== true) await notifyProjectRecoveredForThread(projectAlias, reservation.ctxMeta)
      return
    }
    threadLastUnavailableNoticeAt.set(reservation.key, reservation.nowMs)
    projectIsDown.set(projectAlias, true)
    rememberUnavailableNotice(projectAlias, reservation.ctxKey)
  }

  async function notifyProjectUnavailable(projectAlias, err, { force = false, platform } = {}) {
    if (!reserveProjectUnavailableNotice(projectAlias, { force })) return false

    const st = store.get()
    const nowMs = projectLastUnavailableNoticeAt.get(projectAlias) || Date.now()
    const deliveries = []
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      const reservation = beginThreadUnavailableNoticeDelivery(projectAlias, ctx, { force, nowMs })
      if (!reservation) continue
      const locale = storedLocaleForCtx(ctxKey) || config?.i18n?.defaultLocale || "en"
      const message = formatProjectUnavailable(projectAlias, err, { locale })
      const replyMarkup = canAutoStartProject(projectAlias, { platform }) ? startServerKeyboard(projectAlias, { locale }) : null
      deliveries.push({ ctx, message, replyMarkup, reservation })
    }

    for (const { ctx, message, replyMarkup, reservation } of deliveries) {
      try {
        await sendToThread(ctx, message, replyMarkup)
        await finishThreadUnavailableNoticeDelivery(projectAlias, reservation, { delivered: true })
      } catch {
        await finishThreadUnavailableNoticeDelivery(projectAlias, reservation, { delivered: false })
      }
    }
    return true
  }

  async function notifyProjectUnavailableForThread(ctxMeta, projectAlias, err, { force = false, locale, platform, fallbackReplyMarkup = null } = {}) {
    if (!ctxMeta?.chatId) return false
    const retryable = isRetryableProjectError(err)
    const reservation = retryable ? beginThreadUnavailableNoticeDelivery(projectAlias, ctxMeta, { force }) : null
    if (retryable && !reservation) return false
    const noticeLocale = locale || ctxMeta.locale || config?.i18n?.defaultLocale || "en"
    const message = formatProjectUnavailable(projectAlias, err, { locale: noticeLocale })
    const replyMarkup = retryable && canAutoStartProject(projectAlias, { platform }) ? startServerKeyboard(projectAlias, { locale: noticeLocale }) : fallbackReplyMarkup
    try {
      await sendToThread(ctxMeta, message, replyMarkup)
      if (retryable) await finishThreadUnavailableNoticeDelivery(projectAlias, reservation, { delivered: true })
    } catch {
      if (retryable) await finishThreadUnavailableNoticeDelivery(projectAlias, reservation, { delivered: false })
    }
    return true
  }

  return {
    buildProjectsOverviewText: (input) =>
      buildProjectsOverviewText({
        projects,
        bindings: store.get().bindings || {},
        getProjectSseStatus,
        parseCtxKey,
        formatThreadLabel: input.formatThreadLabel,
        startupSessionByProject: input.startupSessionByProject,
        previewLimit: input.previewLimit,
        showBindingScopes: input.showBindingScopes,
        showProjectDetails: input.showProjectDetails,
        hiddenBindingsLabel: input.hiddenBindingsLabel,
        locale: input.locale,
      }),
    buildProjectsOverviewKeyboard: (input = {}) =>
      buildProjectsOverviewKeyboard({
        projects,
        cb,
        canAutoStartProject,
        platform: input.platform,
        showProjectControls: input.showProjectControls,
        showSessions: input.showSessions,
        showBindControls: input.showBindControls,
        currentBinding: input.currentBinding,
        locale: input.locale,
      }),
    canAutoStartProject,
    isRetryableProjectError,
    formatProjectUnavailable,
    startServerKeyboard,
    notifyProjectUnavailable,
    notifyProjectUnavailableForThread,
    notifyProjectRecovered,
    markProjectUp,
    markProjectSseConnected,
    markProjectSseDown,
    markProjectSseUnavailable,
    getProjectSseStatus,
    _state: { projectLastUnavailableNoticeAt, threadLastUnavailableNoticeAt, projectUnavailableNoticeCtxKeys, projectIsDown, projectSseState },
  }
}
