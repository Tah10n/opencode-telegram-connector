function normalizeCallbackParts(parts) {
  if (!Array.isArray(parts)) return []
  return parts.map((part) => (part == null ? "" : String(part)))
}

export function encodeCallback(parts) {
  return JSON.stringify(normalizeCallbackParts(parts))
}

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
  return data.split("|")
}

export function packCallbackParts(cb, parts) {
  const data = encodeCallback(parts)
  return typeof cb?.pack === "function" ? cb.pack(data) : data
}

export function callbackPacker(cb) {
  return (...parts) => packCallbackParts(cb, parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts)
}
