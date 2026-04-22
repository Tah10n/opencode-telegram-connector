import { makeInlineKeyboard } from "../telegram/client.js"
import { sanitizeBaseUrlForDisplay } from "../url-utils.js"

export function buildProjectsOverviewText({
  projects,
  bindings,
  startupSessionByProject,
  getProjectSseStatus,
  parseCtxKey,
  formatThreadLabel,
  previewLimit = 3,
  showBindingScopes = true,
  hiddenBindingsLabel = "hidden outside private chat",
}) {
  const aliases = Object.keys(projects || {})
  if (!aliases.length) return "No projects"

  const lines = ["Projects:"]
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
    const suffix = scopes.length > previewLimit ? `, +${scopes.length - previewLimit} more` : ""
    const bindingSummary = showBindingScopes
      ? `${scopes.length}${shownScopes.length ? ` (${shownScopes.join(", ")}${suffix})` : ""}`
      : hiddenBindingsLabel

    lines.push(`- ${alias}`)
    lines.push(`  URL: ${url || "unknown"}`)
    lines.push(`  Startup session: ${startupSessionId}`)
    lines.push(`  SSE: ${sseStatus}`)
    lines.push(`  Bindings: ${bindingSummary}`)
  }

  return lines.join("\n")
}

export function createOverviewHelpers({ projects, store, startInProgress, parseCtxKey, sendToThread, cb }) {
  const projectLastUnavailableNoticeAt = new Map()
  const projectIsDown = new Map()
  const projectSseState = new Map(Object.keys(projects).map((alias) => [alias, "unknown"]))

  function canAutoStartProject(alias, { platform }) {
    const p = projects?.[alias]
    if (!p?.autoStart) return false
    if (!p.directory || !p.port) return false
    if (platform === "win32") return true
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
    const message = formatProjectUnavailable(projectAlias, err)
    const replyMarkup = canAutoStartProject(projectAlias, { platform }) ? startServerKeyboard(projectAlias) : null
    for (const [ctxKey, binding] of Object.entries(st.bindings || {})) {
      if (binding?.projectAlias !== projectAlias) continue
      const ctx = parseCtxKey(ctxKey)
      if (!ctx) continue
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
        hiddenBindingsLabel: input.hiddenBindingsLabel,
      }),
    canAutoStartProject,
    isLikelyConnectError,
    formatProjectUnavailable,
    startServerKeyboard,
    notifyProjectUnavailable,
    notifyProjectRecovered,
    markProjectUp,
    markProjectSseConnected,
    markProjectSseDown,
    getProjectSseStatus,
    _state: { projectLastUnavailableNoticeAt, projectIsDown, projectSseState },
  }
}
