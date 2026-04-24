const MAX_OPENCODE_ID_LENGTH = 256
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/
const UNSAFE_BINDING_ID_RE = /[\s\\/?#]/

export function normalizeOpenCodeId(value) {
  if (typeof value !== "string") return ""
  const id = value.trim()
  if (!id || id.length > MAX_OPENCODE_ID_LENGTH || CONTROL_CHARS_RE.test(id)) return ""
  return id
}

export function isSafeOpenCodeId(value) {
  const id = normalizeOpenCodeId(value)
  return !!id && !UNSAFE_BINDING_ID_RE.test(id)
}

export function requireSafeOpenCodeId(value, label = "opencode id") {
  const id = normalizeOpenCodeId(value)
  if (!id || !isSafeOpenCodeId(id)) {
    throw new Error(`Invalid ${label}: expected a non-empty id without whitespace or URL path/query separators`)
  }
  return id
}

export function encodeOpenCodePathSegment(value, label = "opencode id") {
  const id = normalizeOpenCodeId(value)
  if (!id) throw new Error(`Invalid ${label}: expected a non-empty id`)
  return encodeURIComponent(id)
}
