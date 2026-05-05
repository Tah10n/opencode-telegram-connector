import { makeInlineKeyboard } from "../telegram/client.js"
import {
  collectModelCandidates,
  commonVariantsForModel,
  modelSourceLabel,
  normalizeModelReference,
  normalizeVariant,
  modelKeyOf,
} from "../model-selection.js"
import { encodeCallback } from "./callback-data.js"
import { t as translate } from "../i18n/index.js"

function trimString(value) {
  return typeof value === "string" ? value.trim() : ""
}

export async function resolveModelProviderCatalog(oc, ...fallbackEntries) {
  const effectiveProvidersInfo = await (oc?.getConfigProviders?.() || Promise.resolve(null)).catch(() => null)
  const providerMap = new Map()

  const fallbackArray = [...fallbackEntries]

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

  function normalizeProviderModelReference(providerId, modelValue, modelIdHint = "") {
    const normalized = normalizeModelReference(modelValue)
    if (normalized) return normalized

    const normalizedProviderId = trimString(providerId)
    if (!normalizedProviderId) return null

    const modelId =
      typeof modelValue === "string"
        ? trimString(modelValue)
        : trimString(modelValue?.modelID || modelValue?.modelId || modelValue?.model || modelValue?.id || modelIdHint)
    return modelId ? { providerID: normalizedProviderId, modelID: modelId } : null
  }

  function addModel(providerId, providerName, modelValue, modelName = "", { providerContext = false, modelIdHint = "" } = {}) {
    const model = providerContext ? normalizeProviderModelReference(providerId, modelValue, modelIdHint) : normalizeModelReference(modelValue)
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

  if (Array.isArray(effectiveProvidersInfo?.providers)) {
    for (const providerEntry of effectiveProvidersInfo.providers) {
      const providerId = trimString(providerEntry?.id || providerEntry?.providerID || providerEntry?.providerId || providerEntry?.provider)
      if (!providerId) continue
      const providerName = trimString(providerEntry?.name)
      ensureProvider(providerId, providerName)

      const models = providerEntry?.models
      if (Array.isArray(models)) {
        for (const modelEntry of models) {
          addModel(providerId, providerName, modelEntry, modelEntry?.name || modelEntry?.id || modelEntry?.modelID || modelEntry?.modelId, {
            providerContext: true,
          })
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
          addModel(providerId, providerName, normalizedModel, modelEntry?.name || modelId, { providerContext: true, modelIdHint: modelId })
        }
      }
    }
  }

  for (const candidate of collectModelCandidates(...fallbackArray)) {
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

function chunkEntries(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function modelModeLabel(preference, effectiveState, locale = "en") {
  if (preference?.mode === "project-default") {
    return effectiveState?.source === "thread-project-default" ? translate(locale, "model.modeProjectDefault") : translate(locale, "model.modeProjectDefaultUnavailable")
  }
  if (preference?.mode === "custom") return translate(locale, "model.modeCustom")
  return translate(locale, "model.modeInherit")
}

export function buildModelSettingsText({
  binding,
  preference,
  effectiveState,
  configuredInfo,
  sessionModelInfo,
  providerCatalog,
  selectedProviderId,
  selectedModelKey,
  locale = "en",
}) {
  const normalizedPreference = preference || { mode: "inherit" }
  const lines = [
    translate(locale, "model.title"),
    translate(locale, "model.project", { project: binding.projectAlias }),
    translate(locale, "model.session", { session: binding.sessionId }),
    translate(locale, "model.mode", { mode: modelModeLabel(normalizedPreference, effectiveState, locale) }),
    translate(locale, "model.active", { active: effectiveState?.label || "unknown" }),
  ]

  if (effectiveState?.source && effectiveState.source !== "unknown") {
    lines.push(translate(locale, "model.source", { source: modelSourceLabel(effectiveState.source) }))
  }

  lines.push(translate(locale, "model.projectDefault", { model: configuredInfo?.label || "unknown" }))
  if (sessionModelInfo?.label) lines.push(translate(locale, "model.lastSessionModel", { model: sessionModelInfo.label }))

  lines.push("")
  if (selectedModelKey) {
    lines.push(translate(locale, "model.pickVariant", { model: selectedModelKey }))
    lines.push(translate(locale, "model.noVariantHelp"))
  } else if (selectedProviderId) {
    const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
    lines.push(translate(locale, "model.pickProviderModel", { provider: selectedProvider ? formatProviderChoiceLabel(selectedProvider) : selectedProviderId }))
  } else {
    lines.push(translate(locale, "model.pickMode"))
    if (!providerCatalog.length) lines.push(translate(locale, "model.noProviders"))
  }
  lines.push(translate(locale, "model.typedForms"))

  return lines.join("\n")
}

export function modelSettingsKeyboard({ cbPack, preference, providerCatalog, selectedProviderId, selectedModelKey, locale = "en" }) {
  const pack = typeof cbPack === "function" ? cbPack : (...parts) => encodeCallback(parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts)
  const normalizedPreference = preference || { mode: "inherit" }

  const currentCustomModelKey = normalizedPreference.mode === "custom" ? modelKeyOf(normalizedPreference.model) : ""
  const currentCustomProviderId = normalizedPreference.mode === "custom" ? trimString(normalizedPreference.model?.providerID) : ""

  if (selectedModelKey) {
    const selectedModel = normalizeModelReference(selectedModelKey)
    const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
    const rows = []
    const currentVariant = normalizedPreference.mode === "custom" && currentCustomModelKey === selectedModelKey ? normalizeVariant(normalizedPreference.variant) : ""
    rows.push([
      {
        text: `${normalizedPreference.mode === "custom" && currentCustomModelKey === selectedModelKey && !currentVariant ? "✓ " : ""}${translate(locale, "model.noVariant")}`,
        callback_data: pack("m", "apply", selectedModelKey, "~"),
      },
    ])
    for (const chunk of chunkEntries(commonVariantsForModel(selectedModel), 3)) {
      rows.push(
        chunk.map((variant) => ({
          text: `${currentVariant === variant ? "✓ " : ""}${variant}`,
          callback_data: pack("m", "apply", selectedModelKey, variant),
        })),
      )
    }
    rows.push([
      { text: translate(locale, "model.back"), callback_data: pack("m", "provider", selectedProvider?.id || selectedModel?.providerID || selectedProviderId) },
      { text: translate(locale, "common.close"), callback_data: pack("m", "close") },
    ])
    return makeInlineKeyboard(rows)
  }

  if (selectedProviderId) {
    const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
    const rows = []
    for (const candidate of selectedProvider?.models || []) {
      const prefix = currentCustomModelKey === candidate.key ? "✓ " : ""
      rows.push([{ text: `${prefix}${formatModelChoiceLabel(candidate)}`, callback_data: pack("m", "model", candidate.key) }])
    }
    rows.push([
      { text: translate(locale, "model.back"), callback_data: pack("m", "root") },
      { text: translate(locale, "common.close"), callback_data: pack("m", "close") },
    ])
    return makeInlineKeyboard(rows)
  }

  const rows = [
    [
      { text: `${normalizedPreference.mode === "inherit" ? "✓ " : ""}${translate(locale, "model.modeInherit")}`, callback_data: pack("m", "set", "inherit") },
      {
        text: `${normalizedPreference.mode === "project-default" ? "✓ " : ""}${translate(locale, "model.projectDefaultButton")}`,
        callback_data: pack("m", "set", "project-default"),
      },
    ],
  ]

  for (const provider of providerCatalog) {
    const prefix = currentCustomProviderId === provider.id ? "✓ " : ""
    rows.push([{ text: `${prefix}${formatProviderChoiceLabel(provider)}`, callback_data: pack("m", "provider", provider.id) }])
  }

  rows.push([{ text: translate(locale, "common.close"), callback_data: pack("m", "close") }])
  return makeInlineKeyboard(rows)
}

export function formatModelUiChoices({
  cbPack,
  noticeText = "",
  binding,
  preference,
  effectiveState,
  configuredInfo,
  sessionModelInfo,
  providerCatalog,
  selectedProviderId,
  selectedModelKey,
  locale = "en",
}) {
  const settingsText = buildModelSettingsText({
    binding,
    preference,
    effectiveState,
    configuredInfo,
    sessionModelInfo,
    providerCatalog,
    selectedProviderId,
    selectedModelKey,
    locale,
  })
  return {
    text: noticeText ? `${noticeText}\n\n${settingsText}` : settingsText,
    replyMarkup: modelSettingsKeyboard({
      cbPack,
      preference,
      providerCatalog,
      selectedProviderId,
      selectedModelKey,
      locale,
    }),
  }
}
