import crypto from "node:crypto"

const SAFE_PART_MAX_CHARS = 80

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value ?? ""), "utf8").digest("hex").slice(0, 8)
}

function normalizeExtension(extension) {
  const raw = String(extension || "").trim().toLowerCase()
  if (!raw) return ""
  const withDot = raw.startsWith(".") ? raw : `.${raw}`
  const clean = withDot.replace(/[^.a-z0-9_-]+/g, "")
  return clean === "." ? "" : clean.slice(0, 16)
}

export function sanitizeFilenamePart(value, fallback = "file") {
  const raw = String(value ?? "").replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || fallback
  const normalized = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[A-Za-z0-9][A-Za-z0-9_-]{31,}/g, (token) => `redacted-${shortHash(token)}`)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")

  const clipped = normalized.length > SAFE_PART_MAX_CHARS
    ? `${normalized.slice(0, SAFE_PART_MAX_CHARS - 9)}-${shortHash(normalized)}`
    : normalized
  return clipped || fallback
}

export function sanitizeFilename(value, { fallback = "attachment", defaultExtension = ".txt" } = {}) {
  const extension = normalizeExtension(defaultExtension)
  let name = sanitizeFilenamePart(value, fallback)
  if (extension && !/\.[a-z0-9][a-z0-9_-]{0,11}$/i.test(name)) name += extension
  return name
}

export function scopedAttachmentFilename({ projectAlias, sessionId, messageId, label = "attachment", fileName = "", extension = ".txt" } = {}) {
  const parts = [
    sanitizeFilenamePart(projectAlias, "project"),
    sanitizeFilenamePart(sessionId, "session"),
    sanitizeFilenamePart(messageId, "message"),
    sanitizeFilenamePart(label, "attachment"),
  ]
  if (fileName) parts.push(sanitizeFilenamePart(fileName, "file"))
  return `${parts.filter(Boolean).join("-")}${normalizeExtension(extension) || ".txt"}`
}

export function humanBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

export function attachmentCaption(kind, { projectAlias, sessionId, fileName } = {}) {
  const scope = [projectAlias, sessionId].filter(Boolean).join("/")
  const suffix = scope ? ` (${scope})` : ""
  if (kind === "assistant") return `Assistant reply${suffix}`
  if (kind === "changed-files-summary") return `Changed files summary${suffix}`
  if (kind === "changed-files-patch") return fileName ? `Changed file diff: ${sanitizeFilenamePart(fileName)}${suffix}` : `Changed files diff${suffix}`
  return `Attachment${suffix}`
}

export const ATTACHMENT_NOTICES = {
  assistantTooLong: "Assistant reply was attached as a .txt file because it is too long for Telegram messages.",
  diffTooLong: "Diff is too large for an inline preview. It was attached as a .patch file.",
}
