import { makeInlineKeyboard } from "../telegram/client.js"
import { redactCmdlineSecrets, sanitizeBaseUrlForDisplay } from "../url-utils.js"
import { isRetryableBoundaryError, normalizeBoundaryError } from "../boundary-errors.js"
import { getLaunchSupport } from "../opencode/launcher.js"

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
    if (showProjectDetails) {
      lines.push(`  URL: ${url || "unknown"}`)
      lines.push(`  Startup session: ${startupSessionId}`)
    }
    lines.push(`  SSE: ${sseStatus}`)
    lines.push(`  Bindings: ${bindingSummary}`)
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
}) {
  const rows = []
  if (showProjectControls || showBindControls) {
    for (const alias of Object.keys(projects || {})) {
      const row = []
      if (showBindControls && (!currentBinding || currentBinding.projectAlias === alias)) {
        row.push({ text: currentBinding?.projectAlias === alias ? `Bound ${alias}` : `Bind ${alias}`, callback_data: cb.pack(`srv|${alias}|bind`) })
      }
      if (showProjectControls && canAutoStartProject?.(alias, { platform })) {
        row.push({ text: `Start ${alias}`, callback_data: cb.pack(`srv|${alias}|start`) })
      }
      if (showProjectControls) row.push({ text: `Status ${alias}`, callback_data: cb.pack(`srv|${alias}|health`) })
      if (showProjectControls && showSessions) row.push({ text: `Sessions ${alias}`, callback_data: cb.pack(`srv|${alias}|sessions`) })
      if (row.length) rows.push(row)
    }
  }
  rows.push([{ text: "Close", callback_data: cb.pack("srv|close") }])
  return makeInlineKeyboard(rows)
}

export function createOverviewHelpers({ projects, store, startInProgress, parseCtxKey, sendToThread, cb }) {
  const projectLastUnavailableNoticeAt = new Map()
  const projectIsDown = new Map()
  const projectSseState = new Map(Object.keys(projects).map((alias) => [alias, "unknown"]))

  function canAutoStartProject(alias, { platform }) {
    return getLaunchSupport({ project: projects?.[alias], platform }).canAutoStart
  }

  function isRetryableProjectError(err) {
    return isRetryableBoundaryError(err, { source: "opencode" })
  }

  function formatProjectUnavailable(projectAlias, err) {
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[projectAlias]?.baseUrl)
    const msg = redactCmdlineSecrets(normalizeBoundaryError(err, { source: "opencode" }).message)
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
      [{ text: "Close", callback_data: cb.pack("srv|close") }],
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
        showProjectDetails: input.showProjectDetails,
        hiddenBindingsLabel: input.hiddenBindingsLabel,
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
    getProjectSseStatus,
    _state: { projectLastUnavailableNoticeAt, projectIsDown, projectSseState },
  }
}
