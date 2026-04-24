import { humanBytes, sanitizeFilename } from "./attachment-utils.js"
import { DEFAULT_LIMITS } from "../limits.js"

export const USER_ATTACHMENT_LIMITS = Object.freeze({
  confirmBytes: DEFAULT_LIMITS.userAttachmentConfirmBytes,
  maxBytes: DEFAULT_LIMITS.userAttachmentMaxBytes,
})

const SUPPORTED_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/x-sh",
  "application/x-powershell",
  "application/csv",
])

const SUPPORTED_EXTENSIONS = new Set([
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".log",
  ".json",
  ".jsonl",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".diff",
  ".patch",
  ".csv",
])

const UNSUPPORTED_MEDIA_FIELDS = [
  "photo",
  "video",
  "animation",
  "audio",
  "voice",
  "video_note",
  "sticker",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
]

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeSize(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
}

function fileExtension(fileName) {
  const base = cleanString(fileName).replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return ""
  return base.slice(dot).toLowerCase()
}

export function describeTelegramDocument(document, { limits = USER_ATTACHMENT_LIMITS } = {}) {
  if (!document || typeof document !== "object") return { supported: false, reason: "missing", safeName: "attachment.txt" }
  const fileId = cleanString(document.file_id)
  const originalName = cleanString(document.file_name) || "attachment.txt"
  const safeName = sanitizeFilename(originalName, { fallback: "attachment", defaultExtension: ".txt" })
  const mimeType = cleanString(document.mime_type).toLowerCase()
  const extension = fileExtension(originalName)
  const fileSize = normalizeSize(document.file_size)
  const isTextMime = mimeType.startsWith("text/") || SUPPORTED_MIME_TYPES.has(mimeType)
  const isTextExtension = SUPPORTED_EXTENSIONS.has(extension)

  if (!fileId) {
    return { supported: false, reason: "missing_file_id", fileId, originalName, safeName, mimeType, extension, fileSize }
  }
  if (!isTextMime && !isTextExtension) {
    return { supported: false, reason: "unsupported_type", fileId, originalName, safeName, mimeType, extension, fileSize }
  }
  if (fileSize != null && fileSize > limits.maxBytes) {
    return { supported: false, reason: "too_large", fileId, originalName, safeName, mimeType, extension, fileSize }
  }
  return { supported: true, fileId, originalName, safeName, mimeType, extension, fileSize }
}

export function unsupportedMediaKind(message) {
  if (!message || typeof message !== "object" || message.document) return ""
  return UNSUPPORTED_MEDIA_FIELDS.find((field) => message[field] != null) || ""
}

export function shouldConfirmAttachment(documentInfo, { limits = USER_ATTACHMENT_LIMITS } = {}) {
  const size = normalizeSize(documentInfo?.fileSize)
  return size != null && size >= limits.confirmBytes
}

export function decodeTextAttachment(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (data.length === 0) return ""
  const sample = data.subarray(0, Math.min(data.length, 4096))
  if (sample.includes(0)) throw new Error("Attachment appears to be binary, not UTF-8 text.")
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    throw new Error("Attachment is not valid UTF-8 text.")
  }
  return text.replace(/^\uFEFF/, "")
}

export function formatAttachmentPrompt({ prefix = "", caption = "", documentInfo, text, byteLength } = {}) {
  const lead = cleanString(caption) || "Please use this Telegram attachment as context."
  const safeName = documentInfo?.safeName || "attachment.txt"
  const mimeType = documentInfo?.mimeType || "unknown"
  const size = byteLength ?? documentInfo?.fileSize
  return [
    `${prefix}${lead}`,
    "",
    "Telegram attachment:",
    `- Filename: ${safeName}`,
    `- MIME type: ${mimeType || "unknown"}`,
    `- Size: ${humanBytes(size)}`,
    "",
    `----- BEGIN FILE ${safeName} -----`,
    String(text ?? ""),
    `----- END FILE ${safeName} -----`,
  ].join("\n")
}

export function attachmentConfirmationText(documentInfo, { limits = USER_ATTACHMENT_LIMITS } = {}) {
  return [
    "Confirm sending this file to OpenCode:",
    `File: ${documentInfo?.safeName || "attachment.txt"}`,
    `Size: ${humanBytes(documentInfo?.fileSize)}`,
    `Large-file confirmation threshold: ${humanBytes(limits.confirmBytes)}`,
    "",
    "The file contents will be included in the prompt for this thread's bound session.",
  ].join("\n")
}

export function unsupportedAttachmentText(documentInfo, { limits = USER_ATTACHMENT_LIMITS } = {}) {
  if (documentInfo?.reason === "too_large") {
    return `Attachment '${documentInfo.safeName}' is too large (${humanBytes(documentInfo.fileSize)}). Maximum supported text/code/log file size is ${humanBytes(limits.maxBytes)}.`
  }
  return [
    `Attachment '${documentInfo?.safeName || "attachment"}' is not supported.`,
    "Supported attachments: UTF-8 text, code, log, diff/patch, JSON/YAML/TOML/XML/CSV, and shell/PowerShell scripts.",
    `Maximum size: ${humanBytes(limits.maxBytes)}. Large files from ${humanBytes(limits.confirmBytes)} require confirmation.`,
  ].join("\n")
}

export function unsupportedMediaText(kind, { limits = USER_ATTACHMENT_LIMITS } = {}) {
  return [
    `${kind ? `Telegram ${kind} messages are` : "This Telegram media message is"} not supported as an OpenCode prompt attachment.`,
    "Send a UTF-8 text/code/log file as a Telegram document instead.",
    `Maximum supported file size: ${humanBytes(limits.maxBytes)}.`,
  ].join("\n")
}

export function attachmentSentText(documentInfo, binding) {
  const scope = binding?.projectAlias && binding?.sessionId ? ` to ${binding.projectAlias}/${binding.sessionId}` : ""
  return `Attachment sent${scope}: ${documentInfo?.safeName || "attachment.txt"}`
}

export function attachmentDownloadFailedText(documentInfo) {
  return `Attachment '${documentInfo?.safeName || "attachment"}' could not be downloaded from Telegram. Please try again.`
}
