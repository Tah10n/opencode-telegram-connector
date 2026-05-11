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
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      const locale = storedLocaleForCtx(ctxKey) || config?.i18n?.defaultLocale || "en"
      const message = translate(locale, "overview.recovered", { project: projectAlias, baseUrl })
      await sendToThread(ctx, message).catch(() => {})
    }
  }

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

  function markProjectSseUnavailable(projectAlias, reason = "unavailable") {
    const suffix = String(reason || "").trim()
    projectSseState.set(projectAlias, suffix ? `unavailable (${suffix})` : "unavailable")
  }

  function getProjectSseStatus(projectAlias) {
    return projectSseState.get(projectAlias) || "unknown"
  }

  async function notifyProjectUnavailable(projectAlias, err, { force = false, platform } = {}) {
    if (!force && startInProgress.has(projectAlias)) return
    const nowMs = Date.now()
    const last = projectLastUnavailableNoticeAt.get(projectAlias) || 0
    const isDown = projectIsDown.get(projectAlias) === true
    const minIntervalMs = isDown ? 10 * 60_000 : 60_000
    if (nowMs - last < minIntervalMs) return
    projectLastUnavailableNoticeAt.set(projectAlias, nowMs)
    projectIsDown.set(projectAlias, true)

    const st = store.get()
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
      const locale = storedLocaleForCtx(ctxKey) || config?.i18n?.defaultLocale || "en"
      const message = formatProjectUnavailable(projectAlias, err, { locale })
      const replyMarkup = canAutoStartProject(projectAlias, { platform }) ? startServerKeyboard(projectAlias, { locale }) : null
      await sendToThread(ctx, message, replyMarkup).catch(() => {})
    }
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
    notifyProjectRecovered,
    markProjectUp,
    markProjectSseConnected,
    markProjectSseDown,
    markProjectSseUnavailable,
    getProjectSseStatus,
    _state: { projectLastUnavailableNoticeAt, projectIsDown, projectSseState },
  }
}
