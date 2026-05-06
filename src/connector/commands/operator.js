import { makeInlineKeyboard } from "../../telegram/client.js"
import { sessionKey } from "../../state/store.js"
import { sanitizeBaseUrlForDisplay } from "../../url-utils.js"
import { isStaleBoundaryError } from "../../boundary-errors.js"
import { formatActiveTurnStatus, resolveActiveTurnStatus } from "../active-turns.js"
import { callbackPacker } from "./shared.js"
import { t as translate } from "../../i18n/index.js"

function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function sessionModelTimestamp(message) {
  const time = message?.info?.time || message?.time || {}
  return normalizeEpochMs(time.completed) ?? normalizeEpochMs(time.updated) ?? normalizeEpochMs(time.created) ?? normalizeEpochMs(time.started) ?? null
}

function compareMessageRecency(a, b) {
  const aTime = sessionModelTimestamp(a)
  const bTime = sessionModelTimestamp(b)
  if (aTime != null && bTime != null) return bTime - aTime
  if (aTime != null) return -1
  if (bTime != null) return 1
  return 0
}

export function createOperatorCommandHandlers(deps) {
  const {
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    platform,
    cb,
    sendToThread,
    safeInformThread,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    boundThreadActionsKeyboard,
    formatThreadLabel,
    getProjectSseStatus,
    getFeedMode,
    feedModeLabel,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
    resolveStartupSession,
    validateProject,
    isRetryableProjectError,
    formatProjectUnavailable,
    buildProjectsOverviewText,
    buildProjectsOverviewKeyboard,
    deliverAssistantText,
    extractAssistantDisplayText,
    lastAssistantBySession,
    clearAgentActivity,
    getAgentActivityStatus,
    activeTurnStaleMs,
    mirrorCompaction,
    appendEffectiveModelLines,
    resolveEffectiveModelState,
    compareNumbers,
    markProjectUp,
    threadScopeLabel,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
  } = deps
  const packCallback = callbackPacker(cb)

  function runtimeControlsKeyboard(locale = "en") {
    return makeInlineKeyboard([
      [
        { text: t(locale, "operator.restart"), callback_data: packCallback("rt", "confirm-restart") },
        { text: t(locale, "operator.stop"), callback_data: packCallback("rt", "confirm-stop") },
      ],
      [{ text: t(locale, "common.close"), callback_data: packCallback("rt", "close") }],
    ])
  }

  function unbindConfirmationText(ctxMeta, binding) {
    return [
      t(ctxMeta, "operator.confirmUnbind"),
      t(ctxMeta, "operator.scope", { scope: threadScopeLabel(ctxMeta) }),
      t(ctxMeta, "operator.project", { project: binding.projectAlias }),
      t(ctxMeta, "operator.session", { session: binding.sessionId }),
      t(ctxMeta, "operator.unbindNote"),
    ].join("\n")
  }

  function unbindConfirmationKeyboard(ctxKey, binding, locale = "en") {
    return makeInlineKeyboard([
      [{ text: t(locale, "operator.removeBinding"), callback_data: packCallback("b", "unbind", ctxKey, binding.projectAlias, binding.sessionId) }],
      [{ text: t(locale, "common.close"), callback_data: packCallback("b", "close") }],
    ])
  }

  function bindingHealthLabel(health) {
    if (health?.status === "ok") return "ok"
    if (health?.status === "stale" && health.reason === "project-missing") return "stale: project missing"
    if (health?.status === "stale" && health.reason === "session-missing") return "stale: session missing"
    if (health?.status === "unreachable") return "unreachable"
    return "unknown"
  }

  async function resolveAgentStatus(binding, health) {
    if (health?.status !== "ok") return `unknown (${bindingHealthLabel(health)})`

    const oc = ocByAlias[binding.projectAlias]
    try {
      const status = await resolveActiveTurnStatus({
        oc,
        projectAlias: binding.projectAlias,
        sessionId: binding.sessionId,
        getAgentActivityStatus,
        mirrorCompaction,
        staleMs: activeTurnStaleMs,
      })
      return formatActiveTurnStatus(status)
    } catch {
      const localStatus = getAgentActivityStatus?.(binding.projectAlias, binding.sessionId)
      return localStatus?.state === "running" ? "running" : "unknown (message list failed)"
    }
  }

  async function resolveBindingHealth(ctxKey, binding) {
    if (!binding?.projectAlias || !binding?.sessionId) return { status: "stale", reason: "malformed", ctxKey }
    if (!projects?.[binding.projectAlias] || !ocByAlias?.[binding.projectAlias]) return { status: "stale", reason: "project-missing", ctxKey }

    try {
      await validateProject(binding.projectAlias)
    } catch (err) {
      return { status: "unreachable", reason: "project-unreachable", ctxKey, retryable: isRetryableProjectError(err) }
    }

    const oc = ocByAlias[binding.projectAlias]
    if (typeof oc?.getSession !== "function") return { status: "unknown", reason: "session-check-unavailable", ctxKey }
    try {
      await oc.getSession(binding.sessionId)
      return { status: "ok", ctxKey }
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/session/${binding.sessionId}`, method: "GET" })) {
        return { status: "stale", reason: "session-missing", ctxKey }
      }
      return { status: "unreachable", reason: "session-check-failed", ctxKey, retryable: isRetryableProjectError(err) }
    }
  }

  async function resolveBindingHealthMap(entries) {
    const pairs = await Promise.all(entries.map(async (entry) => [entry.ctxKey, await resolveBindingHealth(entry.ctxKey, entry.binding)]))
    return Object.fromEntries(pairs)
  }

  function bindingRepairKeyboard(entries, { includeRepair = false } = {}) {
    const rows = []
    for (const entry of entries) {
      const ctxKey = entry.ctxKey
      const projectAlias = entry.binding?.projectAlias
      const projectKnown = !!projects?.[projectAlias]
      rows.push([{ text: `Remove ${ctxKey}`, callback_data: packCallback("b", "confirm-unbind", ctxKey) }])
      if (projectKnown) {
        rows.push([
          { text: `Rebind startup ${ctxKey}`, callback_data: packCallback("b", "rebind", ctxKey) },
          { text: `New session ${ctxKey}`, callback_data: packCallback("b", "new", ctxKey) },
        ])
      }
      rows.push([{ text: `Keep ${ctxKey}`, callback_data: packCallback("b", "keep", ctxKey) }])
    }
    if (includeRepair) rows.push([{ text: "Repair index", callback_data: packCallback("b", "repair") }])
    rows.push([{ text: "Close", callback_data: packCallback("b", "close") }])
    return makeInlineKeyboard(rows)
  }

  async function resolveLatestAssistantReply(projectAlias, sessionId) {
    const oc = ocByAlias[projectAlias]
    if (!oc?.listMessages || !sessionId) return null
    const messages = await oc.listMessages(sessionId).catch(() => null)
    if (!Array.isArray(messages) || messages.length === 0) return null

    const candidates = messages
      .filter((message) => {
        const info = message?.info || message || {}
        if (info?.role !== "assistant") return false
        if (!mirrorCompaction && (info?.mode === "compaction" || info?.agent === "compaction")) return false
        return true
      })
      .sort(compareMessageRecency)

    for (const candidate of candidates) {
      const info = candidate?.info || candidate || {}
      const messageId = String(info?.id || "").trim()
      let message = candidate
      let text = extractAssistantDisplayText(projectAlias, message)
      if ((!text || !text.trim()) && messageId) {
        const fetched = await oc.getMessage(sessionId, messageId).catch(() => null)
        if (fetched) {
          message = fetched
          text = extractAssistantDisplayText(projectAlias, message)
        }
      }
      if (!text || !text.trim()) continue
      return { messageId: messageId || "sendlast", sessionId, text }
    }

    return null
  }

  async function handleAbort(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.abortNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const aborted = await oc.abortSession(binding.sessionId)
      markProjectUp?.(binding.projectAlias)
      clearAgentActivity?.(binding.projectAlias, binding.sessionId)
      await sendToThread(
        ctxMeta,
        aborted === false ? `No active run to abort for session: ${binding.sessionId}` : `Abort requested for session: ${binding.sessionId}`,
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err, { locale: ctxMeta.locale })).catch(() => {})
    }
  }

  async function handleWhere(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.statusNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const health = await resolveBindingHealth(ctxMeta.ctxKey, binding)
    const startupSessionId = startupSessionByProject[binding.projectAlias] || "unknown"
    const sseStatus = getProjectSseStatus(binding.projectAlias)
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[binding.projectAlias]?.baseUrl) || "unknown"
    const feedMode = feedModeLabel(getFeedMode(ctxMeta.ctxKey), ctxMeta.locale)
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding)
    const agentStatus = await resolveAgentStatus(binding, health)
    const runtimeLines = buildRuntimeStatusLines?.(binding.projectAlias) || []
    const replyMarkup = health.status === "ok"
      ? boundThreadActionsKeyboard(ctxMeta)
      : makeInlineKeyboard([
        ...boundThreadActionsKeyboard(ctxMeta).inline_keyboard.slice(0, 2),
        ...bindingRepairKeyboard([{ ctxKey: ctxMeta.ctxKey, binding, health }]).inline_keyboard,
      ])
    await sendToThread(
      ctxMeta,
      appendEffectiveModelLines(
        [
          `Project: ${binding.projectAlias}`,
          `Session: ${binding.sessionId}`,
          `Startup session: ${startupSessionId}`,
          `Feed: ${feedMode}`,
          `Agent: ${agentStatus}`,
          `SSE: ${sseStatus}`,
          `Base URL: ${baseUrl}`,
          `Binding health: ${bindingHealthLabel(health)}`,
          ...runtimeLines,
        ],
        effectiveState,
      ).join("\n"),
      replyMarkup,
    )
  }

  async function handleRuntime(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, t(ctxMeta, "operator.privateRuntimeOnly"))
      return
    }
    const lines = buildGlobalRuntimeStatusLines?.() || [t(ctxMeta, "operator.runtimeUnavailable")]
    await sendToThread(ctxMeta, [t(ctxMeta, "operator.runtimeTitle"), ...lines].join("\n"), runtimeControlsKeyboard(ctxMeta.locale))
  }

  async function handleBindings(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, t(ctxMeta, "operator.privateBindingsOnly"))
      return
    }
    const entries = Object.entries(store.get().bindings || {})
      .map(([ctxKey, binding]) => ({ ctxKey, binding, ctx: deps.parseCtxKey(ctxKey) }))
      .sort((a, b) => {
        const byChat = compareNumbers(a.ctx?.chatId ?? 0, b.ctx?.chatId ?? 0)
        if (byChat !== 0) return byChat
        const byThread = compareNumbers(a.ctx?.threadIdOr0 ?? 0, b.ctx?.threadIdOr0 ?? 0)
        if (byThread !== 0) return byThread
        return a.ctxKey.localeCompare(b.ctxKey)
      })

    if (!entries.length) {
      await safeInformThread(ctxMeta, t(ctxMeta, "operator.noBindings"))
      return
    }

    const repairPreview = store.repairBindingIndex?.({ dryRun: true })
    const healthByCtx = await resolveBindingHealthMap(entries)

    const lines = [t(ctxMeta, "operator.bindingsTitle")]
    for (const entry of entries) {
      const scope = entry.ctx ? `chat ${entry.ctx.chatId} / ${formatThreadLabel(entry.ctx.threadIdOr0)}` : entry.ctxKey
      const current = entry.ctxKey === ctxMeta.ctxKey ? " (current)" : ""
      lines.push(`- ${scope}${current} -> ${entry.binding.projectAlias} / ${entry.binding.sessionId} [${bindingHealthLabel(healthByCtx[entry.ctxKey])}]`)
    }
    if (repairPreview?.changed) {
      lines.push(
        `Index repair available: removedBindings=${repairPreview.removedBindings?.length || 0} removedIndex=${repairPreview.removedIndexEntries?.length || 0} rebuilt=${repairPreview.rebuiltIndexEntries || 0}`,
      )
    }
    await sendToThread(ctxMeta, lines.join("\n"), bindingRepairKeyboard(entries, { includeRepair: true }))
  }

  async function handleSendLast(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.sendLastNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    if (!oc) {
      await safeInformThread(ctxMeta, `Unknown project: ${binding.projectAlias}`)
      return
    }
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const latest = await resolveLatestAssistantReply(binding.projectAlias, binding.sessionId)
    if (latest) {
      lastAssistantBySession.set(sk, latest)
      await deliverAssistantText(ctxMeta, binding.projectAlias, latest.sessionId, latest.messageId, latest.text)
      return
    }

    const last = lastAssistantBySession.get(sk)
    const messageId = last?.messageId
    const messageSessionId = last?.sessionId || binding.sessionId
    let text = typeof last?.text === "string" ? last.text : ""

    if (messageId) {
      const msg = await oc.getMessage(messageSessionId, messageId).catch(() => null)
      if (!mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        // ignore
      } else {
        const fetched = extractAssistantDisplayText(binding.projectAlias, msg)
        if (fetched && fetched.trim()) text = fetched
      }
    }

    if (!text || !text.trim()) {
      await safeInformThread(ctxMeta, t(ctxMeta, "operator.noAssistantYet"))
      return
    }
    await deliverAssistantText(ctxMeta, binding.projectAlias, messageSessionId, messageId || "sendlast", text)
  }

  async function handleProjects(ctxMeta) {
    const aliases = Object.keys(projects)
    await Promise.allSettled(aliases.map((a) => resolveStartupSession(a, { forceRefresh: true })))
    const currentBinding = store.getBinding(ctxMeta.ctxKey)
    const lines = [buildProjectsOverviewText({
      startupSessionByProject,
      formatThreadLabel,
      previewLimit: 3,
      showBindingScopes: ctxMeta?.chatType === "private",
      showProjectDetails: ctxMeta?.chatType === "private",
      ...(ctxMeta.locale ? { locale: ctxMeta.locale } : {}),
    })]
    if (ctxMeta?.chatType === "private") {
      const entries = Object.entries(store.get().bindings || {}).map(([ctxKey, binding]) => ({ ctxKey, binding }))
      const healthByCtx = await resolveBindingHealthMap(entries)
      const byProject = new Map()
      for (const entry of entries) {
        const alias = entry.binding?.projectAlias || "unknown"
        const bucket = byProject.get(alias) || { ok: 0, stale: 0, unreachable: 0, unknown: 0 }
        const status = healthByCtx[entry.ctxKey]?.status || "unknown"
        if (Object.hasOwn(bucket, status)) bucket[status] += 1
        else bucket.unknown += 1
        byProject.set(alias, bucket)
      }
      if (byProject.size) {
        lines.push(t(ctxMeta, "operator.bindingHealthTitle"))
        for (const [alias, bucket] of [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`- ${alias}: ok=${bucket.ok} stale=${bucket.stale} unreachable=${bucket.unreachable} unknown=${bucket.unknown}`)
        }
      }
    }
    const replyMarkup = buildProjectsOverviewKeyboard?.({
      platform,
      showProjectControls: ctxMeta?.chatType === "private",
      showSessions: ctxMeta?.chatType === "private",
      showBindControls: ctxMeta?.chatType === "private" || !currentBinding,
      currentBinding,
      ...(ctxMeta.locale ? { locale: ctxMeta.locale } : {}),
    })
    await sendToThread(ctxMeta, lines.join("\n"), replyMarkup)
  }

  async function handleUnbind(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "operator.alreadyUnbound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    await sendToThread(ctxMeta, unbindConfirmationText(ctxMeta, binding), unbindConfirmationKeyboard(ctxMeta.ctxKey, binding, ctxMeta.locale))
  }

  return {
    handleAbort,
    handleWhere,
    handleRuntime,
    handleBindings,
    handleSendLast,
    handleProjects,
    handleUnbind,
    resolveBindingHealthMap,
  }
}
