import { makeInlineKeyboard } from "../telegram/client.js"
import { parseSessionReference, findSessionByShareUrl } from "../session-ref.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "../session-list.js"
import { sanitizeBaseUrlForDisplay } from "../url-utils.js"
import { sessionKey } from "../state/store.js"
import { getLaunchSupport } from "../opencode/launcher.js"
import { permissionNoteIdempotencyKey, telegramMessageIdempotencyKey } from "./idempotency.js"
import {
  collectModelCandidates,
  commonVariantsForModel,
  configuredModelInfo,
  formatModelLabel,
  modelKeyOf,
  modelSourceLabel,
  normalizeModelPreference,
  normalizeModelReference,
  normalizeVariant,
  pickMostRecentSessionModelInfo,
} from "../model-selection.js"
import { isRetryableBoundaryError, isStaleBoundaryError } from "../boundary-errors.js"

function helpText() {
  return [
    "Commands:",
    "/bind <projectAlias>",
    "/new [title]",
    "/use <sessionId|shareLink>",
    "/sessions",
    "/model",
    "/model default",
    "/model reset",
    "/model <provider/model> [variant]",
    "/feed",
    "/status",
    "/runtime or /health (private chat only)",
    "/bindings (private chat only)",
    "/abort",
    "/sendlast",
    "/projects",
    "/unbind",
    "/cancel",
  ].join("\n")
}

export function createCommandHandlers(runtime) {
  const {
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    config,
    logger,
    platform,
    getStartupSession,
    openAttachWindowFn,
    openAttachWindowWindowsFn,
    validateProject,
    bindCtxToSession,
    primeTuiActiveSessionFollow,
    sendToThread,
    parseCtxKey,
    formatThreadLabel,
    getProjectSseStatus,
    renderFeedSettings,
    feedModeLabel,
    getFeedMode,
    deliverAssistantText,
    extractAssistantDisplayText,
    lastAssistantBySession,
    canAutoStartProject,
    isRetryableProjectError,
    startServerKeyboard,
    ensureRecentPromptSet,
    hashTextForEcho,
    formatProjectUnavailable,
    buildProjectsOverviewText,
    buildProjectsOverviewKeyboard,
    isCommand,
    parseCommand,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    bindAliasAwaiting,
    getWizard,
    cloneWizardState,
    applyWizardState,
    persistQuestionWizard,
    finishQuestionWizard,
    sendCurrentQuestionStep,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
  } = runtime

  async function resolveStartupSession(alias, { forceRefresh = false } = {}) {
    return getStartupSession(alias, { waitForStart: false, forceRefresh }).catch(() => null)
  }

  async function resolveValidStartupSession(alias, oc) {
    let startupSid = startupSessionByProject[alias] || (await resolveStartupSession(alias))
    if (!startupSid) return null

    try {
      await oc.getSession(startupSid)
      return startupSid
    } catch (err) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      startupSid = await resolveStartupSession(alias, { forceRefresh: true })
      if (!startupSid) throw err
      await oc.getSession(startupSid)
      return startupSid
    }
  }

  async function safeInformThread(ctxMeta, text, replyMarkup, options) {
    await sendToThread(ctxMeta, text, replyMarkup, options).catch(() => {})
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function markIdempotencyEntries(entries, { flush = true } = {}) {
    const normalized = entries.filter((entry) => !!entry?.key)
    if (!normalized.length) return false
    if (typeof store?.markIdempotencyKey === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = store.markIdempotencyKey(entry.key, entry.metadata || {}) || marked
      }
      if (marked && flush && typeof store?.flush === "function") await store.flush()
      return marked
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = (await store.markIdempotencyKeyAndFlush(entry.key, entry.metadata || {})) || marked
      }
      return marked
    }
    return false
  }

  function normalizeEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
    if (typeof value === "string") {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function compareMessageRecency(a, b) {
    const aTime = sessionModelTimestamp(a)
    const bTime = sessionModelTimestamp(b)
    if (aTime != null && bTime != null) return bTime - aTime
    if (aTime != null) return -1
    if (bTime != null) return 1
    return 0
  }

  function sessionModelTimestamp(message) {
    const time = message?.info?.time || message?.time || {}
    return (
      normalizeEpochMs(time.completed) ?? normalizeEpochMs(time.updated) ?? normalizeEpochMs(time.created) ?? normalizeEpochMs(time.started) ?? null
    )
  }

  function getModelPreference(ctxKey) {
    return normalizeModelPreference(store.getModelPreference?.(ctxKey))
  }

  function setModelPreference(ctxKey, value) {
    store.setModelPreference?.(ctxKey, value)
  }

  async function resolveSessionModelInfo(projectAlias, sessionId) {
    const oc = ocByAlias[projectAlias]
    if (!oc?.listMessages || !sessionId) return null
    const messages = await oc.listMessages(sessionId).catch(() => null)
    return pickMostRecentSessionModelInfo(messages)
  }

  async function resolveConfiguredModelInfo(projectAlias) {
    const oc = ocByAlias[projectAlias]
    const directory = projects?.[projectAlias]?.directory
    if (!oc?.getConfig) return null
    const configInfo = await oc.getConfig({ directory }).catch(() => null)
    return configuredModelInfo(configInfo)
  }

  async function resolveEffectiveModelState(ctxKey, binding, { sessionModelInfo, configuredInfo } = {}) {
    if (!binding?.projectAlias) return { label: "", source: "unknown", model: null, variant: "", preference: { mode: "inherit" } }

    const preference = getModelPreference(ctxKey)
    if (preference.mode === "custom") {
      return {
        ...preference,
        label: formatModelLabel(preference.model, preference.variant),
        source: "thread-custom",
        preference,
      }
    }

    if (preference.mode === "project-default") {
      const resolvedConfiguredInfo = configuredInfo ?? (await resolveConfiguredModelInfo(binding.projectAlias))
      if (resolvedConfiguredInfo?.label) {
        return { ...resolvedConfiguredInfo, source: "thread-project-default", preference }
      }
    }

    const resolvedSessionInfo = sessionModelInfo ?? (await resolveSessionModelInfo(binding.projectAlias, binding.sessionId))
    if (resolvedSessionInfo?.label) {
      return { ...resolvedSessionInfo, source: "session-history", preference }
    }

    const resolvedConfiguredInfo = configuredInfo ?? (await resolveConfiguredModelInfo(binding.projectAlias))
    if (resolvedConfiguredInfo?.label) {
      return { ...resolvedConfiguredInfo, source: "project-default", preference }
    }

    return { label: "", source: "unknown", model: null, variant: "", preference }
  }

  async function resolvePromptOverride(ctxKey, binding) {
    const effectiveState = await resolveEffectiveModelState(ctxKey, binding)
    if (!effectiveState?.model || (effectiveState.source !== "thread-custom" && effectiveState.source !== "thread-project-default")) {
      return null
    }
    return {
      model: effectiveState.model,
      ...(effectiveState.variant ? { variant: effectiveState.variant } : {}),
    }
  }

  function appendEffectiveModelLines(lines, effectiveState) {
    if (!effectiveState?.label) return lines
    lines.push(`Model: ${effectiveState.label}`)
    if (effectiveState.source && effectiveState.source !== "unknown") {
      lines.push(`Source: ${modelSourceLabel(effectiveState.source)}`)
    }
    return lines
  }

  async function buildSessionSwitchText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [`Switched to session: ${sessionId}`]
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  async function buildNewSessionText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [`Created and switched to session: ${sessionId}`]
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  async function buildCreatedSessionText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [`Created session: ${sessionId}`]
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  function modelModeLabel(preference, effectiveState) {
    if (preference?.mode === "project-default") {
      return effectiveState?.source === "thread-project-default" ? "Project default override" : "Project default override (unavailable)"
    }
    if (preference?.mode === "custom") return "Custom override"
    return "Inherit"
  }

  function chunkEntries(items, size) {
    const chunks = []
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
    return chunks
  }

  function trimString(value) {
    return typeof value === "string" ? value.trim() : ""
  }

  function formatProviderChoiceLabel(provider) {
    const providerId = trimString(provider?.id)
    const providerName = trimString(provider?.name)
    if (!providerId) return providerName || "unknown"
    if (!providerName || providerName.toLowerCase() === providerId.toLowerCase()) return providerId
    return `${providerName} (${providerId})`
  }

  function formatModelChoiceLabel(entry) {
    const modelId = trimString(entry?.model?.modelID)
    const modelName = trimString(entry?.name)
    if (!modelId) return modelName || "unknown"
    if (!modelName || modelName.toLowerCase() === modelId.toLowerCase()) return modelId
    return `${modelName} (${modelId})`
  }

  async function resolveModelProviderCatalog(projectAlias, ...fallbackEntries) {
    const oc = ocByAlias[projectAlias]
    const providersInfo = await oc?.getConfigProviders?.().catch(() => null)
    const providerMap = new Map()

    function ensureProvider(providerId, providerName = "") {
      const normalizedProviderId = trimString(providerId)
      if (!normalizedProviderId) return null
      const existing = providerMap.get(normalizedProviderId)
      if (existing) {
        if (providerName && (!existing.name || existing.name === existing.id)) existing.name = providerName
        return existing
      }
      const created = {
        id: normalizedProviderId,
        name: trimString(providerName) || normalizedProviderId,
        modelByKey: new Map(),
      }
      providerMap.set(normalizedProviderId, created)
      return created
    }

    function addModel(providerId, providerName, modelValue, modelName = "") {
      const model = normalizeModelReference(modelValue)
      if (!model) return
      const provider = ensureProvider(model.providerID || providerId, providerName)
      if (!provider) return
      const key = modelKeyOf(model)
      if (!key || provider.modelByKey.has(key)) return
      provider.modelByKey.set(key, {
        key,
        model,
        name: trimString(modelName) || trimString(model.modelID),
      })
    }

    if (Array.isArray(providersInfo?.providers)) {
      for (const providerEntry of providersInfo.providers) {
        const providerId = trimString(providerEntry?.id || providerEntry?.providerID || providerEntry?.providerId || providerEntry?.provider)
        if (!providerId) continue
        const providerName = trimString(providerEntry?.name)
        ensureProvider(providerId, providerName)

        const models = providerEntry?.models
        if (Array.isArray(models)) {
          for (const modelEntry of models) {
            addModel(providerId, providerName, modelEntry, modelEntry?.name || modelEntry?.id || modelEntry?.modelID || modelEntry?.modelId)
          }
          continue
        }

        if (models && typeof models === "object") {
          for (const [modelId, modelEntry] of Object.entries(models)) {
            const normalizedModel =
              normalizeModelReference(modelEntry) ||
              normalizeModelReference({
                providerID: providerId,
                modelID: trimString(modelEntry?.id || modelEntry?.modelID || modelEntry?.modelId || modelId),
              })
            addModel(providerId, providerName, normalizedModel, modelEntry?.name || modelId)
          }
        }
      }
    }

    for (const candidate of collectModelCandidates(...fallbackEntries)) {
      addModel(candidate.model?.providerID, candidate.model?.providerID, candidate.model, candidate.model?.modelID)
    }

    return [...providerMap.values()]
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: [...provider.modelByKey.values()].sort((a, b) => {
          const byName = formatModelChoiceLabel(a).localeCompare(formatModelChoiceLabel(b))
          if (byName !== 0) return byName
          return a.key.localeCompare(b.key)
        }),
      }))
      .filter((provider) => provider.models.length > 0)
      .sort((a, b) => {
        const byName = formatProviderChoiceLabel(a).localeCompare(formatProviderChoiceLabel(b))
        if (byName !== 0) return byName
        return a.id.localeCompare(b.id)
      })
  }

  function buildModelSettingsText({ binding, preference, effectiveState, configuredInfo, sessionModelInfo, providerCatalog, selectedProviderId, selectedModelKey }) {
    const lines = [
      "Model for this thread:",
      `Project: ${binding.projectAlias}`,
      `Session: ${binding.sessionId}`,
      `Mode: ${modelModeLabel(preference, effectiveState)}`,
      `Active: ${effectiveState?.label || "unknown"}`,
    ]

    if (effectiveState?.source && effectiveState.source !== "unknown") {
      lines.push(`Source: ${modelSourceLabel(effectiveState.source)}`)
    }

    lines.push(`Project default: ${configuredInfo?.label || "unknown"}`)
    if (sessionModelInfo?.label) lines.push(`Last session model: ${sessionModelInfo.label}`)

    lines.push("")
    if (selectedModelKey) {
      lines.push(`Pick a variant for: ${selectedModelKey}`)
      lines.push("Use 'No variant' to keep only provider/model.")
    } else if (selectedProviderId) {
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      lines.push(`Pick a model from provider: ${selectedProvider ? formatProviderChoiceLabel(selectedProvider) : selectedProviderId}`)
    } else {
      lines.push("Pick a mode, then choose a provider below.")
      if (!providerCatalog.length) lines.push("No providers discovered automatically. Use a typed /model command if needed.")
    }
    lines.push("Typed forms: /model default, /model reset, /model <provider/model> [variant]")

    return lines.join("\n")
  }

  async function setThreadModelPreference(ctxMeta, binding, nextPreference) {
    const preference = normalizeModelPreference(nextPreference)

    if (preference.mode === "project-default") {
      const configuredInfo = await resolveConfiguredModelInfo(binding.projectAlias)
      if (!configuredInfo?.model) {
        return {
          ok: false,
          callbackText: "No project default",
          message: "Project default model is not configured for this project.",
        }
      }
      setModelPreference(ctxMeta.ctxKey, preference)
      return { ok: true, callbackText: "Model: project default" }
    }

    if (preference.mode === "custom") {
      setModelPreference(ctxMeta.ctxKey, preference)
      return {
        ok: true,
        callbackText: preference.variant ? `Model: ${formatModelLabel(preference.model, preference.variant)}` : `Model: ${formatModelLabel(preference.model)}`,
      }
    }

    setModelPreference(ctxMeta.ctxKey, null)
    return { ok: true, callbackText: "Model: inherit" }
  }

  function modelSettingsKeyboard({ preference, providerCatalog, selectedProviderId, selectedModelKey }) {
    const currentCustomModelKey = preference.mode === "custom" ? modelKeyOf(preference.model) : ""
    const currentCustomProviderId = preference.mode === "custom" ? trimString(preference.model?.providerID) : ""

    if (selectedModelKey) {
      const selectedModel = normalizeModelReference(selectedModelKey)
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      const rows = []
      const currentVariant = preference.mode === "custom" && currentCustomModelKey === selectedModelKey ? normalizeVariant(preference.variant) : ""
      rows.push([
        {
          text: `${preference.mode === "custom" && currentCustomModelKey === selectedModelKey && !currentVariant ? "✓ " : ""}No variant`,
          callback_data: runtime.cb.pack(`m|apply|${selectedModelKey}|~`),
        },
      ])
      for (const chunk of chunkEntries(commonVariantsForModel(selectedModel), 3)) {
        rows.push(
          chunk.map((variant) => ({
            text: `${currentVariant === variant ? "✓ " : ""}${variant}`,
            callback_data: runtime.cb.pack(`m|apply|${selectedModelKey}|${variant}`),
          })),
        )
      }
      rows.push([
        { text: "Back", callback_data: runtime.cb.pack(`m|provider|${selectedProvider?.id || selectedModel?.providerID || selectedProviderId}`) },
        { text: "Close", callback_data: runtime.cb.pack("m|close") },
      ])
      return makeInlineKeyboard(rows)
    }

    if (selectedProviderId) {
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      const rows = []
      for (const candidate of selectedProvider?.models || []) {
        const prefix = currentCustomModelKey === candidate.key ? "✓ " : ""
        rows.push([{ text: `${prefix}${formatModelChoiceLabel(candidate)}`, callback_data: runtime.cb.pack(`m|model|${candidate.key}`) }])
      }
      rows.push([
        { text: "Back", callback_data: runtime.cb.pack("m|root") },
        { text: "Close", callback_data: runtime.cb.pack("m|close") },
      ])
      return makeInlineKeyboard(rows)
    }

    const rows = [
      [
        { text: `${preference.mode === "inherit" ? "✓ " : ""}Inherit`, callback_data: runtime.cb.pack("m|set|inherit") },
        {
          text: `${preference.mode === "project-default" ? "✓ " : ""}Project default`,
          callback_data: runtime.cb.pack("m|set|project-default"),
        },
      ],
    ]

    for (const provider of providerCatalog) {
      const prefix = currentCustomProviderId === provider.id ? "✓ " : ""
      rows.push([{ text: `${prefix}${formatProviderChoiceLabel(provider)}`, callback_data: runtime.cb.pack(`m|provider|${provider.id}`) }])
    }

    rows.push([{ text: "Close", callback_data: runtime.cb.pack("m|close") }])
    return makeInlineKeyboard(rows)
  }

  async function renderModelSettings(ctxMeta, { binding, editMessageId, selectedProviderId, selectedModelKey } = {}) {
    const currentBinding = binding || store.getBinding(ctxMeta.ctxKey)
    if (!currentBinding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }

    const preference = getModelPreference(ctxMeta.ctxKey)
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(currentBinding.projectAlias),
      resolveSessionModelInfo(currentBinding.projectAlias, currentBinding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, currentBinding, { configuredInfo, sessionModelInfo })
    const providerCatalog = await resolveModelProviderCatalog(
      currentBinding.projectAlias,
      preference.mode === "custom" ? preference.model : null,
      sessionModelInfo?.model,
      configuredInfo?.model,
    )
    const requestedModelKey = selectedModelKey && modelKeyOf(selectedModelKey) ? modelKeyOf(selectedModelKey) : ""
    const requestedModel = requestedModelKey ? normalizeModelReference(requestedModelKey) : null
    const normalizedSelectedModelKey =
      requestedModelKey && requestedModel
        ? providerCatalog.some((provider) => provider.id === requestedModel.providerID && provider.models.some((entry) => entry.key === requestedModelKey))
          ? requestedModelKey
          : ""
        : ""
    const normalizedSelectedProviderId =
      trimString(selectedProviderId) && providerCatalog.some((provider) => provider.id === trimString(selectedProviderId))
        ? trimString(selectedProviderId)
        : normalizedSelectedModelKey && requestedModel && providerCatalog.some((provider) => provider.id === requestedModel.providerID)
          ? requestedModel.providerID
          : ""
    const text = buildModelSettingsText({
      binding: currentBinding,
      preference,
      effectiveState,
      configuredInfo,
      sessionModelInfo,
      providerCatalog,
      selectedProviderId: normalizedSelectedProviderId,
      selectedModelKey: normalizedSelectedModelKey,
    })
    const replyMarkup = modelSettingsKeyboard({
      preference,
      providerCatalog,
      selectedProviderId: normalizedSelectedProviderId,
      selectedModelKey: normalizedSelectedModelKey,
    })

    if (editMessageId) {
      await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function handleModelCommand(ctxMeta, argv) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }

    const modelArg = String(argv?.[0] || "").trim()
    const variantArg = normalizeVariant(argv?.[1])
    if (!modelArg) {
      await renderModelSettings(ctxMeta, { binding })
      return
    }

    const normalized = modelArg.toLowerCase()
    if (normalized === "reset" || normalized === "inherit") {
      await setThreadModelPreference(ctxMeta, binding, null)
      await renderModelSettings(ctxMeta, { binding })
      return
    }

    if (normalized === "default" || normalized === "project-default" || normalized === "project_default") {
      const result = await setThreadModelPreference(ctxMeta, binding, { mode: "project-default" })
      if (!result.ok) {
        await sendToThread(ctxMeta, result.message)
        return
      }
      await renderModelSettings(ctxMeta, { binding })
      return
    }

    const model = normalizeModelReference(modelArg)
    const reservedVariant = ["reset", "inherit", "default", "project-default", "project_default"].includes(String(variantArg || "").toLowerCase())
    if (reservedVariant) {
      await sendToThread(ctxMeta, "Usage: /model\n/model default\n/model reset\n/model <provider/model> [variant]")
      return
    }
    if (!model) {
      await sendToThread(ctxMeta, "Usage: /model\n/model default\n/model reset\n/model <provider/model> [variant]")
      return
    }

    await setThreadModelPreference(ctxMeta, binding, { mode: "custom", model, variant: variantArg })
    await renderModelSettings(ctxMeta, { binding })
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
        if (!runtime.mirrorCompaction && (info?.mode === "compaction" || info?.agent === "compaction")) return false
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

  function sessionsKeyboard(projectAlias, sessions, { currentSessionId, startupSessionId, limit = 10 } = {}) {
    const normalized = normalizeSessionsList(sessions).slice(0, limit)
    const rows = normalized.map((session) => [
      {
        text: formatSessionButtonLabel(session, { currentSessionId, startupSessionId }),
        callback_data: runtime.cb.pack(`s|${projectAlias}|${session.id}`),
      },
    ])
    rows.push([{ text: "Close", callback_data: runtime.cb.pack("s|close") }])
    return makeInlineKeyboard(rows)
  }

  function closeKeyboard(callbackData = "s|close") {
    return makeInlineKeyboard([[{ text: "Close", callback_data: runtime.cb.pack(callbackData) }]])
  }

  async function renderSessionsList(ctxMeta, { binding, editMessageId } = {}) {
    const oc = ocByAlias[binding.projectAlias]
    const sessions = await oc.listSessions({ directory: projects?.[binding.projectAlias]?.directory, limit: 10 })
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(binding.projectAlias),
      resolveSessionModelInfo(binding.projectAlias, binding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding, { configuredInfo, sessionModelInfo })
    runtime.markProjectUp(binding.projectAlias)
    const text = formatSessionsListText(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      currentSessionModelLabel: effectiveState?.label,
      currentSessionModelSourceLabel:
        effectiveState?.source && effectiveState.source !== "unknown" ? modelSourceLabel(effectiveState.source) : "",
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    const replyMarkup = sessionsKeyboard(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    if (editMessageId) {
      await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function renderProjectSessions(ctxMeta, projectAlias, { editMessageId } = {}) {
    if (!projectAlias || !projects?.[projectAlias]) {
      await safeInformThread(ctxMeta, "Unknown project.")
      return
    }
    const existing = store.getBinding(ctxMeta.ctxKey)
    if (ctxMeta?.chatType !== "private" && existing?.projectAlias !== projectAlias) {
      await safeInformThread(ctxMeta, "Use project session actions only in a private chat unless this thread is bound to that project.")
      return
    }
    const startupSid = startupSessionByProject[projectAlias] || (await resolveStartupSession(projectAlias)) || ""
    if (existing?.projectAlias !== projectAlias) {
      const oc = ocByAlias[projectAlias]
      const sessions = await oc.listSessions({ directory: projects?.[projectAlias]?.directory, limit: 10 })
      runtime.markProjectUp(projectAlias)
      const text = `${formatSessionsListText(projectAlias, sessions, { startupSessionId: startupSid })}\n\nViewing only. Bind the target chat/thread to switch sessions with buttons.`
        .replace("Tap a button below to switch:\n\n", "")
        .replace("Use /new to create one or /use <sessionId> to switch.", "Bind the target chat/thread to this project before creating or switching sessions from Telegram.")
        .replace("Use /use <sessionId> to switch.", "Use /bind <projectAlias> in the target chat/thread, then /use <sessionId> to switch.")
      const replyMarkup = closeKeyboard("srv|close")
      if (editMessageId) {
        await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
        return
      }
      await sendToThread(ctxMeta, text, replyMarkup)
      return
    }
    await renderSessionsList(ctxMeta, {
      binding: { projectAlias, sessionId: existing.sessionId || startupSid },
      editMessageId,
    })
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
      const startupSid = await resolveValidStartupSession(alias, oc)
      if (startupSid) {
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
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const p = projects[binding.projectAlias]
      const attachOnNewMode = String(p?.openAttachOnNewMode || "same-window")
      const created = await oc.createSession({ title: title || undefined })
      if (created?.id) logger.info(`[${binding.projectAlias}] /new created session:`, created.id)

      let tuiSwitchErr = null
      const canRequestTuiSwitch = attachOnNewMode === "same-window" && typeof oc?.selectTuiSession === "function"
      if (canRequestTuiSwitch) {
        await oc
          .selectTuiSession(created.id, { timeoutMs: 2500 })
          .then(() => {
            logger.info(`[${binding.projectAlias}] requested TUI switch to session:`, created.id)
          })
          .catch((err) => {
            tuiSwitchErr = err
            logger.info(
              `[${binding.projectAlias}] failed to request TUI switch (same-window) for session=${created.id}: ${err?.message || String(err)}`,
            )
          })
      }

      let activeSessionSyncUnsupported = false
      if (attachOnNewMode === "same-window" && !tuiSwitchErr && typeof oc?.getActiveTuiSession === "function") {
        await oc.getActiveTuiSession({ timeoutMs: 1500 }).catch((err) => {
          if (err?.isBoundaryError === true && err.status === 404) {
            activeSessionSyncUnsupported = true
            logger.info(`[${binding.projectAlias}] /tui/active-session is unavailable; same-window /new will stay in manual mode.`)
          }
        })
      }

      const sameWindowSwitchFailed = attachOnNewMode === "same-window" && (!canRequestTuiSwitch || !!tuiSwitchErr)
      const canAutoFollowSameWindow =
        attachOnNewMode === "same-window" && !sameWindowSwitchFailed && typeof oc?.getActiveTuiSession === "function" && !activeSessionSyncUnsupported
      if (attachOnNewMode === "same-window") {
        const createdSessionText = await buildCreatedSessionText(binding.projectAlias, created.id, { ctxKey: ctxMeta.ctxKey })
        if (!canAutoFollowSameWindow) {
          const sameWindowFallbackNote = sameWindowSwitchFailed
            ? `Note: Could not switch the existing TUI automatically in same-window mode. Reattach manually if needed, use /use ${created.id}, or change the project to openAttachOnNewMode=new-window.`
            : `Note: This opencode server does not expose confirmed active TUI session tracking, so Telegram stays on the current session. Use /use ${created.id} after switching in TUI, or change the project to openAttachOnNewMode=new-window.`
          await sendToThread(
            ctxMeta,
            [
              createdSessionText,
              `Current thread stays on session: ${binding.sessionId}`,
              sameWindowFallbackNote,
            ].join("\n\n"),
          )
        } else {
          primeTuiActiveSessionFollow?.(binding.projectAlias, ctxMeta, binding.sessionId)
          await sendToThread(
            ctxMeta,
            [
              createdSessionText,
              `Current thread stays on session: ${binding.sessionId}`,
              `Requested TUI switch to session: ${created.id}. Telegram will switch after the TUI reports the new active session.`,
            ].join("\n\n"),
          )
        }
      } else {
        await bindCtxToSession(ctxMeta, binding.projectAlias, created.id)
        await sendToThread(ctxMeta, await buildNewSessionText(binding.projectAlias, created.id, { ctxKey: ctxMeta.ctxKey }))
      }

      if (attachOnNewMode === "new-window") {
        const launchSupport = getLaunchSupport({ project: p, platform })
        const openAttach = openAttachWindowFn || openAttachWindowWindowsFn
        if (launchSupport.canOpenAttachWindow && openAttach) {
          await openAttach({ directory: p.directory, baseUrl: p.baseUrl, sessionId: created.id, platform }).catch((err) => {
            logger.error("Failed to open attach window:", binding.projectAlias, err?.message || String(err))
          })
        } else {
          logger.info(`[${binding.projectAlias}] openAttachOnNewMode=new-window is configured, but no attach-window launcher is available on platform=${platform}.`)
        }
      } else if (attachOnNewMode === "same-window") {
        logger.info(`[${binding.projectAlias}] /new created ${created.id}; openAttachOnNewMode=same-window (no new window spawned).`)
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleUseCommand(ctxMeta, sessionId) {
    const sessionRef = parseSessionReference(sessionId)
    if (!sessionRef) {
      await safeInformThread(ctxMeta, "Usage: /use <sessionId|shareLink>")
      return
    }
    if (sessionRef.type === "invalid-link") {
      await safeInformThread(
        ctxMeta,
        "Unsupported link. Use an OpenCode share link like https://opncd.ai/share/<share-id> (or https://opncd.ai/s/<share-id>) or a raw session id.",
      )
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]

    async function listSessionsForShareLookup(projectAlias) {
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
            await safeInformThread(
              ctxMeta,
              `This share link belongs to project '${mismatch.projectAlias}' (session: ${mismatch.sessionId}), but this thread is bound to '${binding.projectAlias}'. Use /bind ${mismatch.projectAlias} first.`,
            )
            return
          }

          if (otherLookupErrors.length) {
            await safeInformThread(
              ctxMeta,
              `Share link was not found in project '${binding.projectAlias}', but these project lookups failed: ${otherLookupErrors.join(", ")}. The link may belong to one of them; try again when those projects are available.`,
            )
            return
          }

          await safeInformThread(
            ctxMeta,
            `Share link not found in project '${binding.projectAlias}'. It may belong to a different project or may not be shared on this server.`,
          )
          return
        }
      }

      await oc.getSession(targetSessionId)
      await bindCtxToSession(ctxMeta, binding.projectAlias, targetSessionId)
      await sendToThread(ctxMeta, await buildSessionSwitchText(binding.projectAlias, targetSessionId, { ctxKey: ctxMeta.ctxKey }))
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleSessions(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
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
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias> first.")
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const aborted = await oc.abortSession(binding.sessionId)
      runtime.markProjectUp(binding.projectAlias)
      await sendToThread(
        ctxMeta,
        aborted === false ? `No active run to abort for session: ${binding.sessionId}` : `Abort requested for session: ${binding.sessionId}`,
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleWhere(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      return
    }
    const startupSessionId = startupSessionByProject[binding.projectAlias] || "unknown"
    const sseStatus = getProjectSseStatus(binding.projectAlias)
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[binding.projectAlias]?.baseUrl) || "unknown"
    const feedMode = feedModeLabel(getFeedMode(ctxMeta.ctxKey))
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding)
    const runtimeLines = buildRuntimeStatusLines?.(binding.projectAlias) || []
    await sendToThread(
      ctxMeta,
      appendEffectiveModelLines(
        [
          `Project: ${binding.projectAlias}`,
          `Session: ${binding.sessionId}`,
          `Startup session: ${startupSessionId}`,
          `Feed: ${feedMode}`,
          `SSE: ${sseStatus}`,
          `Base URL: ${baseUrl}`,
          ...runtimeLines,
        ],
        effectiveState,
      ).join("\n"),
    )
  }

  async function handleRuntime(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, "Use /runtime only in a private chat with the bot. Runtime state can include project aliases and operational details.")
      return
    }
    const lines = buildGlobalRuntimeStatusLines?.() || ["Runtime status is unavailable."]
    await sendToThread(ctxMeta, ["Runtime:", ...lines].join("\n"))
  }

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleBindings(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, "Use /bindings only in a private chat with the bot. Bindings contain sensitive session IDs.")
      return
    }
    const entries = Object.entries(store.get().bindings || {})
      .map(([ctxKey, binding]) => ({ ctxKey, binding, ctx: parseCtxKey(ctxKey) }))
      .sort((a, b) => {
        const byChat = runtime.compareNumbers(a.ctx?.chatId ?? 0, b.ctx?.chatId ?? 0)
        if (byChat !== 0) return byChat
        const byThread = runtime.compareNumbers(a.ctx?.threadIdOr0 ?? 0, b.ctx?.threadIdOr0 ?? 0)
        if (byThread !== 0) return byThread
        return a.ctxKey.localeCompare(b.ctxKey)
      })

    if (!entries.length) {
      await safeInformThread(ctxMeta, "No bindings.")
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
      await safeInformThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
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
      if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        // ignore
      } else {
        const fetched = extractAssistantDisplayText(binding.projectAlias, msg)
        if (fetched && fetched.trim()) text = fetched
      }
    }

    if (!text || !text.trim()) {
      await safeInformThread(ctxMeta, "No assistant message yet.")
      return
    }
    await deliverAssistantText(ctxMeta, binding.projectAlias, messageSessionId, messageId || "sendlast", text)
  }

  async function handleProjects(ctxMeta) {
    const aliases = Object.keys(projects)
    await Promise.allSettled(aliases.map((a) => resolveStartupSession(a, { forceRefresh: true })))
    const text = buildProjectsOverviewText({
      startupSessionByProject,
      formatThreadLabel,
      previewLimit: 3,
      showBindingScopes: ctxMeta?.chatType === "private",
    })
    const replyMarkup = buildProjectsOverviewKeyboard?.({
      platform,
      showProjectControls: ctxMeta?.chatType === "private",
      showSessions: ctxMeta?.chatType === "private",
    })
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function handleUnbind(ctxMeta) {
    const ok = store.unbind(ctxMeta.ctxKey)
    await sendToThread(ctxMeta, ok ? "Unbound." : "Not bound.")
  }

  async function handleTelegramMessage(msg, options = {}) {
    if (!runtime.isAllowedUser(msg?.from)) return
    const ctxMeta = runtime.ctxMetaFromMessage(msg)
    if (!ctxMeta.chatId) return

    const text = msg?.text
    if (typeof text !== "string" || !text.trim()) return

    const messageKey = telegramMessageIdempotencyKey(ctxMeta, msg)
    if (hasIdempotencyKey(messageKey)) return

    async function markMessageHandled(operation, metadata = {}) {
      await markIdempotencyEntries([
        {
          key: messageKey,
          metadata: {
            kind: "telegram-message",
            ctxKey: ctxMeta.ctxKey,
            operation,
            updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
            messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
            ...metadata,
          },
        },
      ])
    }

    const awaitingQ = awaitingCustomAnswer.get(ctxMeta.ctxKey)
    if (awaitingQ) {
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId, awaitingQ.sessionID)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, "Question is no longer active.")
        await markMessageHandled("customAnswerStale", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const nextWizard = cloneWizardState(wizard)
      nextWizard.answers[awaitingQ.qIndex] = [text]
      const nextIndex = awaitingQ.qIndex + 1
      if (nextIndex >= wizard.request.questions.length) {
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        const result = await finishQuestionWizard(wizard)
        if (result?.outcome === "retryable") {
          await sendToThread(ctxMeta, "Question answer is temporarily unavailable. Send the answer again or /cancel.").catch(() => {})
          return
        }
        await markMessageHandled("replyQuestion", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })
      } else {
        nextWizard.index = nextIndex
        await sendCurrentQuestionStep(nextWizard)
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await store.flush?.()
        await markMessageHandled("questionNextStep", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      const oc = ocByAlias[awaiting.projectAlias]
      const noteKey = permissionNoteIdempotencyKey(awaiting.projectAlias, awaiting.sessionID, awaiting.permissionId, text)
      if (hasIdempotencyKey(noteKey)) {
        store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await markMessageHandled("replyPermissionNote", { projectAlias: awaiting.projectAlias })
        await sendToThread(ctxMeta, "Rejection note already sent.").catch(() => {})
        return
      }
      try {
        await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      } catch (err) {
        if (isStaleBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await markIdempotencyEntries([
            {
              key: noteKey,
              metadata: {
                kind: "permission-note",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermission",
                action: "reject_note",
              },
            },
            {
              key: messageKey,
              metadata: {
                kind: "telegram-message",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermissionNote",
                updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
                messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
              },
            },
          ], { flush: false })
          store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await store.flush?.()
          await sendToThread(ctxMeta, "Permission request is no longer active.").catch(() => {})
          return
        }
        if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await sendToThread(ctxMeta, "Permission reply is temporarily unavailable. Send the note again or /cancel.").catch(() => {})
          return
        }
        throw err
      }
      await markIdempotencyEntries([
        {
          key: noteKey,
          metadata: {
            kind: "permission-note",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermission",
            action: "reject_note",
          },
        },
        {
          key: messageKey,
          metadata: {
            kind: "telegram-message",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermissionNote",
            updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
            messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
          },
        },
      ], { flush: false })
      store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      await store.flush?.()
      await sendToThread(ctxMeta, "Rejection note sent.").catch(() => {})
      return
    }

    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, "Cancelled.")
          await markMessageHandled("bindAliasCancel")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
      } else {
        const alias = String(text).trim().split(/\s+/)[0]
        if (!alias) {
          await sendToThread(ctxMeta, "Send project alias (e.g. 'myproj') or /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, [alias])
        await markMessageHandled("bindAlias", { projectAlias: alias })
        return
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
        await markMessageHandled("cancel")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        await sendToThread(ctxMeta, helpText())
        await markMessageHandled(cmd)
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, "Send project alias (or /projects to list). You can /cancel.")
          await markMessageHandled("bindPrompt")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, argv)
        await markMessageHandled("bind", { projectAlias: argv[0] })
        return
      }
      if (cmd === "/new") {
        await handleNewCommand(ctxMeta, args)
        await markMessageHandled("new")
        return
      }
      if (cmd === "/use") {
        await handleUseCommand(ctxMeta, argv[0])
        await markMessageHandled("use")
        return
      }
      if (cmd === "/sessions") {
        await handleSessions(ctxMeta)
        await markMessageHandled("sessions")
        return
      }
      if (cmd === "/model") {
        await handleModelCommand(ctxMeta, argv)
        await markMessageHandled("model")
        return
      }
      if (cmd === "/feed") {
        await handleFeed(ctxMeta)
        await markMessageHandled("feed")
        return
      }
      if (cmd === "/status") {
        await handleWhere(ctxMeta)
        await markMessageHandled("status")
        return
      }
      if (cmd === "/runtime" || cmd === "/health") {
        await handleRuntime(ctxMeta)
        await markMessageHandled("runtime")
        return
      }
      if (cmd === "/bindings") {
        await handleBindings(ctxMeta)
        await markMessageHandled("bindings")
        return
      }
      if (cmd === "/abort") {
        await handleAbort(ctxMeta)
        await markMessageHandled("abort")
        return
      }
      if (cmd === "/sendlast") {
        await handleSendLast(ctxMeta)
        await markMessageHandled("sendlast")
        return
      }
      if (cmd === "/projects") {
        await handleProjects(ctxMeta)
        await markMessageHandled("projects")
        return
      }
      if (cmd === "/unbind") {
        await handleUnbind(ctxMeta)
        await markMessageHandled("unbind")
        return
      }
      await sendToThread(ctxMeta, "Unknown command. Use /help.")
      await markMessageHandled("unknownCommand")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      const def = config.defaultProject
      if (def) await sendToThread(ctxMeta, `Not bound. Use /bind <projectAlias> (default: ${def}).`)
      else await sendToThread(ctxMeta, "Not bound. Use /bind <projectAlias>.")
      await markMessageHandled("unbound")
      return
    }

    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    try {
      const promptText = `${prefix}${text}`
      const sk = sessionKey(binding.projectAlias, binding.sessionId)
      ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
      const promptOverride = await resolvePromptOverride(ctxMeta.ctxKey, binding)
      await oc.promptAsync(binding.sessionId, promptText, promptOverride || undefined)
      await markMessageHandled("promptAsync", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isRetryableProjectError(err) && canAutoStartProject(alias, { platform })
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : null).catch(() => {})
    }
  }

  return {
    renderSessionsList,
    renderModelSettings,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
    handleModelCommand,
    handleAbort,
    handleWhere,
    handleRuntime,
    handleFeed,
    handleBindings,
    handleSendLast,
    handleProjects,
    renderProjectSessions,
    handleUnbind,
    handleTelegramMessage,
    buildSessionSwitchText,
    setThreadModelPreference,
  }
}
