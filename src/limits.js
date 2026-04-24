export const DEFAULT_LIMITS = Object.freeze({
  userAttachmentConfirmBytes: 32 * 1024,
  userAttachmentMaxBytes: 256 * 1024,
  changedFilesLimit: 10,
  inlineDiffTextMaxChars: 2500,
  streamPreviewMaxChars: 3500,
  textAttachmentThreshold: 12_000,
})

const LIMIT_SPECS = Object.freeze({
  userAttachmentConfirmBytes: { min: 0, env: "TG_ATTACHMENT_CONFIRM_BYTES" },
  userAttachmentMaxBytes: { min: 1, env: "TG_ATTACHMENT_MAX_BYTES" },
  changedFilesLimit: { min: 1, env: "TG_CHANGED_FILES_LIMIT" },
  inlineDiffTextMaxChars: { min: 1, env: "TG_INLINE_DIFF_TEXT_MAX_CHARS" },
  streamPreviewMaxChars: { min: 1, env: "TG_STREAM_PREVIEW_MAX_CHARS" },
  textAttachmentThreshold: { min: 1, env: "TG_TEXT_ATTACHMENT_THRESHOLD" },
})

function normalizeLimitValue(name, value) {
  if (value == null || value === "") return DEFAULT_LIMITS[name]
  const n = Number(value)
  const spec = LIMIT_SPECS[name]
  if (!Number.isInteger(n) || n < spec.min) {
    throw new Error(`Invalid limit ${name}: expected integer >= ${spec.min}`)
  }
  return n
}

function envLimit(name, env = process.env) {
  const envName = LIMIT_SPECS[name]?.env
  return envName ? env?.[envName] : undefined
}

export function normalizeLimits(input = {}, { env = process.env } = {}) {
  if (input != null && (typeof input !== "object" || Array.isArray(input))) {
    throw new Error("Invalid limits: expected object")
  }
  const source = input || {}
  const limits = {}
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    limits[name] = normalizeLimitValue(name, source[name] ?? envLimit(name, env))
  }
  if (limits.userAttachmentConfirmBytes > limits.userAttachmentMaxBytes) {
    throw new Error("Invalid limits: userAttachmentConfirmBytes cannot exceed userAttachmentMaxBytes")
  }
  return limits
}

export function userAttachmentLimitsFromConfig(limits = {}) {
  const normalized = normalizeLimits(limits, { env: {} })
  return {
    confirmBytes: normalized.userAttachmentConfirmBytes,
    maxBytes: normalized.userAttachmentMaxBytes,
  }
}
