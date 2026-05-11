// @ts-check

export const LEGACY_CALLBACK_PREFIXES = Object.freeze(["rt", "s", "srv", "b", "feed", "m", "cf", "att", "p", "q", "lang"])

const LEGACY_CALLBACK_PREFIX_SET = new Set(LEGACY_CALLBACK_PREFIXES)

/**
 * Normalize callback payload parts before JSON encoding.
 *
 * @param {unknown} parts
 * @returns {string[]}
 */
function normalizeCallbackParts(parts) {
  if (!Array.isArray(parts)) return []
  return parts.map((part) => (part == null ? "" : String(part)))
}

/**
 * Return the supported legacy callback prefix, or an empty string when absent.
 *
 * @param {unknown} data
 * @returns {string}
 */
export function legacyCallbackPrefix(data) {
  if (typeof data !== "string" || data.length === 0 || data.startsWith("[")) return ""
  const separator = data.indexOf("|")
  if (separator <= 0) return ""
  const prefix = data.slice(0, separator)
  return LEGACY_CALLBACK_PREFIX_SET.has(prefix) ? prefix : ""
}

/**
 * Encode callback parts as the structured callback payload format.
 *
 * @param {unknown} parts
 * @returns {string}
 */
export function encodeCallback(parts) {
  return JSON.stringify(normalizeCallbackParts(parts))
}

/**
 * Decode structured callback data or supported legacy pipe-delimited payloads.
 *
 * @param {unknown} data
 * @returns {string[] | null}
 */
export function decodeCallbackData(data) {
  if (typeof data !== "string" || data.length === 0) return null
  if (data.startsWith("[")) {
    try {
      const parsed = JSON.parse(data)
      if (!Array.isArray(parsed) || parsed.length === 0) return null
      return normalizeCallbackParts(parsed)
    } catch {
      return null
    }
  }
  return legacyCallbackPrefix(data) ? data.split("|") : null
}

/**
 * @typedef {{ pack?: (data: string) => string }} CallbackPackContext
 */

/**
 * Encode callback parts and pass them through an optional Telegram packer.
 *
 * @param {CallbackPackContext | null | undefined} cb
 * @param {unknown} parts
 * @returns {string}
 */
export function packCallbackParts(cb, parts) {
  const data = encodeCallback(parts)
  return typeof cb?.pack === "function" ? cb.pack(data) : data
}

/**
 * Create a variadic callback data packer.
 *
 * @param {CallbackPackContext | null | undefined} cb
 * @returns {(...parts: unknown[]) => string}
 */
export function callbackPacker(cb) {
  return (...parts) => packCallbackParts(cb, parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts)
}
