// @ts-check

const MAX_OPENCODE_ID_LENGTH = 256
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/
const UNSAFE_BINDING_ID_RE = /[:|\s\\/?#]/

/**
 * Normalize a user/API supplied OpenCode identifier into the internal string form.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOpenCodeId(value) {
  if (typeof value !== "string") return ""
  const id = value.trim()
  if (!id || id.length > MAX_OPENCODE_ID_LENGTH || CONTROL_CHARS_RE.test(id)) return ""
  return id
}

/**
 * Return whether an identifier is safe for connector binding keys.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeOpenCodeId(value) {
  const id = normalizeOpenCodeId(value)
  return !!id && !UNSAFE_BINDING_ID_RE.test(id)
}

/**
 * Normalize and require an identifier that is safe for connector binding keys.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function requireSafeOpenCodeId(value, label = "opencode id") {
  const id = normalizeOpenCodeId(value)
  if (!id || !isSafeOpenCodeId(id)) {
    throw new Error(`Invalid ${label}: expected a non-empty id without whitespace, colon, pipe, or URL path/query separators`)
  }
  return id
}

/**
 * Normalize and URL-encode an identifier for OpenCode dynamic path segments.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function encodeOpenCodePathSegment(value, label = "opencode id") {
  const id = normalizeOpenCodeId(value)
  if (!id) throw new Error(`Invalid ${label}: expected a non-empty id`)
  return encodeURIComponent(id)
}
