import {
  configuredModelInfo,
  formatModelLabel,
  modelSourceLabel,
  modelKeyOf,
  normalizeModelPreference,
  normalizeModelReference,
  normalizeVariant,
  pickMostRecentSessionModelInfo,
} from "../../model-selection.js"
import { t as translate } from "../../i18n/index.js"
import { callbackPacker } from "./shared.js"

export function createModelCommandHandlers(deps) {
  const {
    store,
    projects,
    ocByAlias,
    sendToThread,
    tg,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    formatModelUiChoices,
    resolveModelProviderCatalog,
    getFeedMode,
    feedModeLabel,
    cb,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
  } = deps
  const packCallback = callbackPacker(cb)

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
    const lines = [`Changed: this thread now uses session ${sessionId}.`, `Project: ${projectAlias}`, `Session: ${sessionId}`]
    if (ctxKey) lines.push(`Feed: ${feedModeLabel(getFeedMode(ctxKey))}`)
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  async function buildNewSessionText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [`Changed: this thread now uses new session ${sessionId}.`, `Project: ${projectAlias}`, `Session: ${sessionId}`]
    if (ctxKey) lines.push(`Feed: ${feedModeLabel(getFeedMode(ctxKey))}`)
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  async function setThreadModelPreference(ctxMeta, binding, nextPreference) {
    const preference = normalizeModelPreference(nextPreference)

    if (preference.mode === "project-default") {
      const configuredInfo = await resolveConfiguredModelInfo(binding.projectAlias)
      if (!configuredInfo?.model) {
        return {
          ok: false,
          callbackText: "No project default",
          message: t(ctxMeta, "modelCommands.noProjectDefaultMessage"),
        }
      }
      setModelPreference(ctxMeta.ctxKey, preference)
      return {
        ok: true,
        callbackText: "Model: project default",
        noticeText: t(ctxMeta, "modelCommands.noticeProjectDefault"),
      }
    }

    if (preference.mode === "custom") {
      setModelPreference(ctxMeta.ctxKey, preference)
      return {
        ok: true,
        callbackText: preference.variant ? `Model: ${formatModelLabel(preference.model, preference.variant)}` : `Model: ${formatModelLabel(preference.model)}`,
        noticeText: t(ctxMeta, "modelCommands.noticeCustom", { model: formatModelLabel(preference.model, preference.variant) }),
      }
    }

    setModelPreference(ctxMeta.ctxKey, null)
    return {
      ok: true,
      callbackText: "Model: inherit",
      noticeText: t(ctxMeta, "modelCommands.noticeInherit"),
    }
  }

  async function renderModelSettings(ctxMeta, { binding, editMessageId, selectedProviderId, selectedModelKey, noticeText = "" } = {}) {
    const currentBinding = binding || store.getBinding(ctxMeta.ctxKey)
    if (!currentBinding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.modelSettingsNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }

    const preference = getModelPreference(ctxMeta.ctxKey)
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(currentBinding.projectAlias),
      resolveSessionModelInfo(currentBinding.projectAlias, currentBinding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, currentBinding, { configuredInfo, sessionModelInfo })
    const oc = ocByAlias[currentBinding.projectAlias]
    const providerCatalog = await resolveModelProviderCatalog(
      oc,
      preference.mode === "custom" ? preference.model : null,
      sessionModelInfo?.model,
      configuredInfo?.model,
    )
    const requestedModelKey = selectedModelKey && modelKeyOf(selectedModelKey) ? modelKeyOf(selectedModelKey) : ""
    const requestedModel = requestedModelKey ? normalizeModelReference(requestedModelKey) : null
    const normalizedSelectedProviderIdCandidate = trimProviderIdForProviderSelection(selectedProviderId)
    const normalizedSelectedModelKey =
      requestedModelKey && requestedModel
        ? providerCatalog.some((provider) => provider.id === requestedModel.providerID && provider.models.some((entry) => entry.key === requestedModelKey))
          ? requestedModelKey
          : ""
        : ""
    const normalizedSelectedProviderId =
      normalizedSelectedProviderIdCandidate && providerCatalog.some((provider) => provider.id === normalizedSelectedProviderIdCandidate)
        ? normalizedSelectedProviderIdCandidate
        : normalizedSelectedModelKey && requestedModel && providerCatalog.some((provider) => provider.id === requestedModel.providerID)
          ? requestedModel.providerID
          : ""
    const { text, replyMarkup } = formatModelUiChoices({
      cbPack: packCallback,
      noticeText,
      binding: currentBinding,
      preference,
      effectiveState,
      configuredInfo,
      sessionModelInfo,
      providerCatalog,
      selectedProviderId: normalizedSelectedProviderId,
      selectedModelKey: normalizedSelectedModelKey,
      locale: ctxMeta.locale,
    })

    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  function trimProviderIdForProviderSelection(value) {
    return typeof value === "string" ? value.trim() : ""
  }

  async function handleModelCommand(ctxMeta, argv) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.modelChangesNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
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
      const result = await setThreadModelPreference(ctxMeta, binding, null)
      await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
      return
    }

    if (normalized === "default" || normalized === "project-default" || normalized === "project_default") {
      const result = await setThreadModelPreference(ctxMeta, binding, { mode: "project-default" })
      if (!result.ok) {
        await sendToThread(ctxMeta, result.message)
        return
      }
      await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
      return
    }

    const model = normalizeModelReference(modelArg)
    const reservedVariant = ["reset", "inherit", "default", "project-default", "project_default"].includes(String(variantArg || "").toLowerCase())
    if (reservedVariant) {
      await sendToThread(ctxMeta, t(ctxMeta, "modelCommands.usage"))
      return
    }
    if (!model) {
      await sendToThread(ctxMeta, t(ctxMeta, "modelCommands.usage"))
      return
    }

    const result = await setThreadModelPreference(ctxMeta, binding, { mode: "custom", model, variant: variantArg })
    await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
  }

  return {
    getModelPreference,
    setModelPreference,
    resolveSessionModelInfo,
    resolveConfiguredModelInfo,
    resolveEffectiveModelState,
    resolvePromptOverride,
    appendEffectiveModelLines,
    buildSessionSwitchText,
    buildNewSessionText,
    setThreadModelPreference,
    renderModelSettings,
    trimProviderIdForProviderSelection,
    handleModelCommand,
  }
}
