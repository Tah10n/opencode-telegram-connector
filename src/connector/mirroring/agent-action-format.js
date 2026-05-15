import crypto from "node:crypto"
import { redactSensitiveText } from "../../url-utils.js"

export function normalizeAgentActionStatus(status) {
  const normalized = String(status || "").trim().toLowerCase()
  if (normalized === "running" || normalized === "completed" || normalized === "error") return normalized
  return ""
}

function compactAgentActionText(value, { fallback = "", max = 180 } = {}) {
  let text = redactSensitiveText(String(value ?? ""))
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) text = fallback
  if (!text) return ""
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`
  return text
}

function formatToolName(tool) {
  const raw = String(tool || "").trim()
  if (!raw) return "tool"
  return raw.replace(/[_-]+/g, " ")
}

function agentActionStatusLabel(status) {
  if (status === "running") return "Running"
  if (status === "completed") return "Done"
  return "Failed"
}

function agentActionIcon(status) {
  if (status === "running") return "🛠"
  if (status === "completed") return "✅"
  return "⚠️"
}

export function formatAgentActionText(part) {
  if (part?.type !== "tool") return ""
  const status = normalizeAgentActionStatus(part?.state?.status)
  if (!status) return ""

  const toolName = compactAgentActionText(part.tool, { fallback: "tool", max: 80 })
  const title = compactAgentActionText(part?.state?.title || part?.metadata?.title || part?.state?.metadata?.title, {
    fallback: formatToolName(toolName),
    max: 180,
  })
  const lines = [`${agentActionIcon(status)} Agent action`, `${agentActionStatusLabel(status)}: ${title}`]
  if (toolName && toolName.toLowerCase() !== title.toLowerCase()) lines.push(`Tool: ${toolName}`)
  if (status === "error") {
    const errorText = compactAgentActionText(part?.state?.error, { max: 240 })
    if (errorText) lines.push(`Error: ${errorText}`)
  }
  return lines.join("\n")
}

function stableHash(value) {
  let text = ""
  try {
    text = JSON.stringify(value ?? null)
  } catch {
    text = String(value ?? "")
  }
  return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12)
}

export function fallbackAgentActionPartId(part, props) {
  const state = part?.state || {}
  const stateTime = state.time || {}
  const identity = [part?.tool || "tool", stateTime.start ?? "", state.raw ?? "", state.input ?? null]
  if (!stateTime.start && !state.raw && state.input == null) identity.push(state.title ?? part?.metadata?.title ?? state.metadata?.title ?? part?.time ?? "")
  return `tool:${stableHash(identity)}`
}

export function agentActionForwardKey(messageId, partId, status) {
  return `${messageId}:${partId}:${status}`
}

export function partEventTimeInfo(part, props) {
  const stateTime = part?.state?.time || {}
  const created = stateTime.start ?? props?.time ?? part?.time
  const completed = stateTime.end ?? (part?.state?.status === "completed" || part?.state?.status === "error" ? props?.time : undefined)
  return { time: { created, updated: props?.time, completed } }
}
