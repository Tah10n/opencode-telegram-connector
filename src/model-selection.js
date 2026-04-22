function trimString(value) {
  return typeof value === "string" ? value.trim() : ""
}

export function normalizeModelReference(value) {
  if (typeof value === "string") {
    const raw = value.trim()
    const slashIndex = raw.indexOf("/")
    if (slashIndex <= 0 || slashIndex === raw.length - 1) return null
    const providerID = raw.slice(0, slashIndex).trim()
    const modelID = raw.slice(slashIndex + 1).trim()
    return providerID && modelID ? { providerID, modelID } : null
  }

  if (value && typeof value === "object") {
    const providerID = trimString(value.providerID || value.providerId || value.provider)
    const modelID = trimString(value.modelID || value.modelId || value.model)
    return providerID && modelID ? { providerID, modelID } : null
  }

  return null
}

export function normalizeVariant(value) {
  return trimString(value)
}

export function modelKeyOf(value) {
  const model = normalizeModelReference(value)
  return model ? `${model.providerID}/${model.modelID}` : ""
}

export function formatModelLabel(value, variant) {
  const model = normalizeModelReference(value)
  if (!model) return ""
  const base = `${model.providerID}/${model.modelID}`
  const normalizedVariant = normalizeVariant(variant)
  return normalizedVariant ? `${base} ${normalizedVariant}` : base
}

export function normalizeModelPreference(value) {
  if (!value || typeof value !== "object") return { mode: "inherit" }

  const mode = trimString(value.mode).toLowerCase()
  if (mode === "project-default") return { mode: "project-default" }

  if (mode === "custom") {
    const model = normalizeModelReference(value.model || value)
    if (!model) return { mode: "inherit" }
    return {
      mode: "custom",
      model,
      variant: normalizeVariant(value.variant),
    }
  }

  return { mode: "inherit" }
}

export function storedModelPreference(value) {
  const pref = normalizeModelPreference(value)
  if (pref.mode === "project-default") return pref
  if (pref.mode === "custom") return pref
  return null
}

export function sessionModelInfoFromMessage(message) {
  const info = message?.info || message || {}
  const model = normalizeModelReference(info.model || {
    providerID: info.providerID || info.providerId || info?.model?.providerID || info?.model?.providerId,
    modelID: info.modelID || info.modelId || info?.model?.modelID || info?.model?.modelId,
  })
  if (!model) return null
  const variant = normalizeVariant(info.variant || info?.model?.variant)
  return {
    model,
    variant,
    label: formatModelLabel(model, variant),
  }
}

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
  return (
    normalizeEpochMs(time.completed) ?? normalizeEpochMs(time.updated) ?? normalizeEpochMs(time.created) ?? normalizeEpochMs(time.started) ?? null
  )
}

export function pickMostRecentSessionModelInfo(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  let best = null
  for (const message of messages) {
    const info = sessionModelInfoFromMessage(message)
    if (!info?.label) continue
    const timestamp = sessionModelTimestamp(message)
    if (!best || (timestamp != null && (best.timestamp == null || timestamp > best.timestamp))) {
      best = { ...info, timestamp }
    }
  }
  return best
}

export function configuredModelInfo(configInfo) {
  if (!configInfo || typeof configInfo !== "object") return null

  const defaultAgentName = trimString(configInfo.default_agent || configInfo.defaultAgent)
  const agentMap = configInfo.agent && typeof configInfo.agent === "object" ? configInfo.agent : configInfo.agents
  const agentConfig =
    defaultAgentName && agentMap && typeof agentMap === "object" && agentMap[defaultAgentName] && typeof agentMap[defaultAgentName] === "object"
      ? agentMap[defaultAgentName]
      : null

  const model = normalizeModelReference(agentConfig?.model ?? configInfo.model)
  if (!model) return null
  const variant = normalizeVariant(agentConfig?.variant ?? configInfo.variant)
  return {
    model,
    variant,
    label: formatModelLabel(model, variant),
  }
}

export function modelSourceLabel(source) {
  if (source === "thread-custom") return "Thread custom override"
  if (source === "thread-project-default") return "Thread project default override"
  if (source === "session-history") return "Inherited from session history"
  if (source === "project-default") return "Inherited from project default"
  return "Unknown"
}

export function commonVariantsForModel(value) {
  const model = normalizeModelReference(value)
  const providerID = model?.providerID?.toLowerCase()
  if (!providerID) return ["low", "medium", "high"]
  if (providerID === "openai" || providerID === "opencode") return ["none", "minimal", "low", "medium", "high", "xhigh"]
  if (providerID === "anthropic") return ["high", "max"]
  if (providerID === "google") return ["low", "high"]
  return ["low", "medium", "high"]
}

export function collectModelCandidates(...entries) {
  const deduped = new Map()
  for (const entry of entries.flat()) {
    const model = normalizeModelReference(entry?.model || entry)
    if (!model) continue
    const key = modelKeyOf(model)
    if (!key || deduped.has(key)) continue
    deduped.set(key, {
      model,
      label: formatModelLabel(model),
    })
  }
  return [...deduped.values()]
}
