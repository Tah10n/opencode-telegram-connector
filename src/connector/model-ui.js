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

export function modelModeLabel(preference, effectiveState) {
  if (preference?.mode === "project-default") {
    return effectiveState?.source === "thread-project-default" ? "Project default override" : "Project default override (unavailable)"
  }
  if (preference?.mode === "custom") return "Custom override"
  return "Inherit"
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
}) {
  const normalizedPreference = preference || { mode: "inherit" }
  const lines = [
    "Model for this thread:",
    `Project: ${binding.projectAlias}`,
    `Session: ${binding.sessionId}`,
    `Mode: ${modelModeLabel(normalizedPreference, effectiveState)}`,
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

export function modelSettingsKeyboard({ cbPack, preference, providerCatalog, selectedProviderId, selectedModelKey }) {
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
        text: `${normalizedPreference.mode === "custom" && currentCustomModelKey === selectedModelKey && !currentVariant ? "✓ " : ""}No variant`,
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
      { text: "Back", callback_data: pack("m", "provider", selectedProvider?.id || selectedModel?.providerID || selectedProviderId) },
      { text: "Close", callback_data: pack("m", "close") },
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
      { text: "Back", callback_data: pack("m", "root") },
      { text: "Close", callback_data: pack("m", "close") },
    ])
    return makeInlineKeyboard(rows)
  }

  const rows = [
    [
      { text: `${normalizedPreference.mode === "inherit" ? "✓ " : ""}Inherit`, callback_data: pack("m", "set", "inherit") },
      {
        text: `${normalizedPreference.mode === "project-default" ? "✓ " : ""}Project default`,
        callback_data: pack("m", "set", "project-default"),
      },
    ],
  ]

  for (const provider of providerCatalog) {
    const prefix = currentCustomProviderId === provider.id ? "✓ " : ""
    rows.push([{ text: `${prefix}${formatProviderChoiceLabel(provider)}`, callback_data: pack("m", "provider", provider.id) }])
  }

  rows.push([{ text: "Close", callback_data: pack("m", "close") }])
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
  })
  return {
    text: noticeText ? `${noticeText}\n\n${settingsText}` : settingsText,
    replyMarkup: modelSettingsKeyboard({
      cbPack,
      preference,
      providerCatalog,
      selectedProviderId,
      selectedModelKey,
    }),
  }
}
