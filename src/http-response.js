export const OPENCODE_SUCCESS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
export const OPENCODE_ERROR_RESPONSE_MAX_BYTES = 64 * 1024
export const TELEGRAM_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
export const TELEGRAM_ERROR_RESPONSE_MAX_BYTES = 64 * 1024
export const TELEGRAM_FILE_RESPONSE_MAX_BYTES = 20 * 1024 * 1024

export class ResponseTooLargeError extends Error {
  constructor({ maxBytes, declaredBytes = null } = {}) {
    super(`HTTP response body exceeds ${maxBytes} bytes`)
    this.name = "ResponseTooLargeError"
    this.code = "RESPONSE_TOO_LARGE"
    this.maxBytes = maxBytes
    this.declaredBytes = declaredBytes
  }
}

function normalizeLimit(maxBytes) {
  const value = Number(maxBytes)
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("maxBytes must be a non-negative safe integer")
  return value
}

function declaredContentLength(response) {
  const raw = response?.headers?.get?.("content-length")
  if (raw == null || raw === "") return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function cancelResponseBody(response, reason) {
  try {
    await response?.body?.cancel?.(reason)
  } catch {
    // Cancellation is best-effort; the size failure remains authoritative.
  }
}

function concatBytes(chunks, totalBytes) {
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeBytes(chunks, totalBytes) {
  return new TextDecoder().decode(concatBytes(chunks, totalBytes))
}

async function readStream(response, { maxBytes, truncate }) {
  const reader = response.body.getReader()
  const chunks = []
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0)
      if (bytesRead + chunk.byteLength <= maxBytes) {
        chunks.push(chunk)
        bytesRead += chunk.byteLength
        continue
      }
      if (!truncate) {
        await reader.cancel("response body limit exceeded").catch(() => {})
        throw new ResponseTooLargeError({ maxBytes })
      }
      const remaining = Math.max(0, maxBytes - bytesRead)
      if (remaining) chunks.push(chunk.subarray(0, remaining))
      bytesRead += remaining
      await reader.cancel("response body truncated").catch(() => {})
      return { text: decodeBytes(chunks, bytesRead), bytesRead, truncated: true }
    }
    return { text: decodeBytes(chunks, bytesRead), bytesRead, truncated: false }
  } finally {
    reader.releaseLock?.()
  }
}

export async function readBoundedResponseText(response, { maxBytes, truncate = false } = {}) {
  const limit = normalizeLimit(maxBytes)
  const declaredBytes = declaredContentLength(response)
  if (declaredBytes != null && declaredBytes > limit && !truncate) {
    const err = new ResponseTooLargeError({ maxBytes: limit, declaredBytes })
    await cancelResponseBody(response, err)
    throw err
  }
  if (response?.body?.getReader) return readStream(response, { maxBytes: limit, truncate })

  const text = typeof response?.text === "function" ? await response.text() : ""
  const encoded = new TextEncoder().encode(String(text || ""))
  if (encoded.byteLength <= limit) return { text: String(text || ""), bytesRead: encoded.byteLength, truncated: false }
  if (!truncate) throw new ResponseTooLargeError({ maxBytes: limit, declaredBytes })
  const prefix = encoded.subarray(0, limit)
  return { text: new TextDecoder().decode(prefix), bytesRead: prefix.byteLength, truncated: true }
}
