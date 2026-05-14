import crypto from "node:crypto"
import { escapeHtml } from "../../telegram/formatter.js"
import { scopedAttachmentFilename } from "../attachment-utils.js"
import { redactSensitiveText } from "../../url-utils.js"

const AGENT_STOP_ERROR_TEXT_KEYS = ["message", "error", "errorMessage", "error_description", "reason", "description", "detail", "details", "body", "data", "response", "cause", "errors"]
const AGENT_STOP_ERROR_METADATA_KEYS = ["name", "type", "code", "status", "statusCode", "kind", "outcome", "providerID", "providerId", "modelID", "modelId"]

export function extractTextParts(message) {
  if (!message || !Array.isArray(message.parts)) return ""
  const parts = message.parts.filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
  return parts.map((p) => p.text).join("")
}

export function hashTextForEcho(text) {
  const t = String(text ?? "")
  return crypto.createHash("sha1").update(t, "utf8").digest("hex") + ":" + String(t.length)
}

export function agentStopErrorDedupeKey({ messageId = "", partId = "", details = "" } = {}) {
  const msg = String(messageId || "").trim()
  if (msg) return msg
  const part = String(partId || "").trim()
  if (part) return `part:${part}:${hashTextForEcho(details || "agent-stop-error")}`
  return `error:${hashTextForEcho(details || "agent-stop-error")}`
}

function safeReadAgentStopErrorField(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

function primitiveAgentStopErrorText(value) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return ""
}

function agentStopErrorMetadata(value) {
  const parts = []
  for (const key of AGENT_STOP_ERROR_METADATA_KEYS) {
    const entry = safeReadAgentStopErrorField(value, key)
    const text = primitiveAgentStopErrorText(entry).trim()
    if (text) parts.push(`${key}=${text}`)
  }
  return parts.join(" ")
}

function readableAgentStopErrorText(value, seen = new WeakSet()) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (!value || typeof value !== "object") return ""
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (value instanceof Error || safeReadAgentStopErrorField(value, "isBoundaryError") === true) {
    return [agentStopErrorMetadata(value), primitiveAgentStopErrorText(safeReadAgentStopErrorField(value, "message")).trim()].filter(Boolean).join("\n")
  }

  if (Array.isArray(value)) {
    const entries = []
    let sample = []
    try {
      sample = value.slice(0, 3)
    } catch {
      sample = []
    }
    for (const entry of sample) {
      const text = readableAgentStopErrorText(entry, seen).trim()
      if (text && text !== "[Circular]") entries.push(text)
    }
    return entries.join("\n")
  }

  const metadata = agentStopErrorMetadata(value)
  for (const key of AGENT_STOP_ERROR_TEXT_KEYS) {
    const entry = safeReadAgentStopErrorField(value, key)
    if (entry == null) continue
    const text = readableAgentStopErrorText(entry, seen).trim()
    if (text && text !== "[Circular]") return [metadata, text].filter(Boolean).join("\n")
  }

  return metadata
}

function redactAgentStopErrorText(value) {
  return redactSensitiveText(readableAgentStopErrorText(value))
    .replace(/(^|[^A-Za-z0-9_-])(["']?)(set[-_]?cookie|cookie|authorization)\2(\s*[:=]\s*)[^\n\r]+/gi, "$1$2$3$2$4***")
    .replace(/(^|[^A-Za-z0-9_-])(["']?)([A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|auth|authorization|cookie|set[-_]?cookie|session|credential)[A-Za-z0-9_-]*)\2(\s*[:=]\s*)("[^"\n\r]*"|'[^'\n\r]*'|[^,;\n\r]+)/gi, "$1$2$3$2$4***")
    .trim()
}

export function formatAgentStopErrorNotice({ reason = "Agent stopped due to error.", details = "" } = {}) {
  const lines = ["⚠️ Agent stopped due to error."]
  const reasonText = redactAgentStopErrorText(reason)
  if (reasonText) lines.push("", reasonText)
  let detailsText = redactAgentStopErrorText(details)
  if (detailsText.length > 2000) detailsText = `${detailsText.slice(0, 1999)}…`
  if (detailsText) lines.push("", detailsText)
  return lines.join("\n")
}

export function shouldSendAssistantAsAttachment(text, threshold) {
  return typeof text === "string" && text.length >= threshold
}

export function assistantAttachmentName(projectAlias, sessionId, messageId) {
  return scopedAttachmentFilename({ projectAlias, sessionId, messageId, label: "assistant", extension: ".txt" })
}

export function buildAssistantStreamPreviewHtml(text, { maxChars } = {}) {
  const body = String(text || "").trim()
  if (!body) return ""
  const maxLen = Math.min(Number.isFinite(maxChars) ? maxChars : 3900, 3900)
  let escaped = ""
  for (const ch of body) {
    const next = escapeHtml(ch)
    if (escaped.length + next.length > maxLen) {
      escaped = `${escaped.slice(0, Math.max(0, maxLen - 1))}…`
      break
    }
    escaped += next
  }
  return escaped
}
