const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
])

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function normalizeCode(value) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null
}

function parseMethodAndPath(message) {
  const match = cleanString(message).match(/\b(GET|POST|PUT|PATCH|DELETE)\s+([^\s]+)\s+failed:\s+(\d{3})\b/i)
  if (!match) return null
  return { method: match[1].toUpperCase(), pathname: match[2], status: Number(match[3]) }
}

function parseStatus(message) {
  const methodMatch = parseMethodAndPath(message)
  if (methodMatch?.status) return methodMatch.status

  const sseMatch = cleanString(message).match(/\bSSE\s+(\d{3})\b/i)
  if (sseMatch) return Number(sseMatch[1])

  return null
}

function parsePathname(message) {
  return parseMethodAndPath(message)?.pathname || null
}

function parseMethod(message) {
  return parseMethodAndPath(message)?.method || null
}

function isResourceNotFoundPath(pathname) {
  const path = cleanString(pathname)
  return /(?:^|\/)\b(session|permission|question)\b(?:\/|$)/.test(path)
}

function messageLooksLikeDisconnect(message) {
  const lower = cleanString(message).toLowerCase()
  return lower.includes("terminated") || lower.includes("disconnected")
}

function messageLooksLikeTimeout(message) {
  return /timed out/i.test(cleanString(message))
}

function messageLooksLikeNetwork(message) {
  const lower = cleanString(message).toLowerCase()
  return (
    lower.includes("fetch failed") ||
    lower.includes("socket") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("enet")
  )
}

function inferKind({ message, status, code, kind, pathname, name, didTimeout = false }) {
  if (cleanString(kind)) return kind
  if (didTimeout) return "timeout"
  if (name === "AbortError") return "abort"

  const normalizedCode = normalizeCode(code)
  if (normalizedCode === "ETIMEDOUT") return "timeout"
  if (normalizedCode && RETRYABLE_NETWORK_CODES.has(normalizedCode)) return normalizedCode === "ETIMEDOUT" ? "timeout" : "network"

  if (messageLooksLikeDisconnect(message)) return "disconnect"
  if (messageLooksLikeTimeout(message)) return "timeout"
  if (messageLooksLikeNetwork(message)) return "network"
  if (typeof status === "number") {
    if ((status === 404 || status === 410) && isResourceNotFoundPath(pathname)) return "stale"
    return "http"
  }

  if (/not found/i.test(cleanString(message)) && isResourceNotFoundPath(pathname)) return "stale"
  return "unknown"
}

function inferOutcome({ status, kind, pathname }) {
  if (kind === "stale") return "stale"
  if (kind === "disconnect" || kind === "network" || kind === "timeout") return "retryable"
  if (typeof status === "number") {
    if ((status === 404 || status === 410) && isResourceNotFoundPath(pathname)) return "stale"
    if (RETRYABLE_STATUS_CODES.has(status) || status >= 500) return "retryable"
    return "fatal"
  }
  return "fatal"
}

function inferOperation({ operation, method, pathname }) {
  if (cleanString(operation)) return operation
  const normalizedMethod = cleanString(method).toUpperCase()
  const normalizedPath = cleanString(pathname)
  return [normalizedMethod, normalizedPath].filter(Boolean).join(" ") || null
}

export class BoundaryError extends Error {
  constructor(message, init = {}) {
    super(message, init?.cause ? { cause: init.cause } : undefined)
    this.name = "BoundaryError"
    this.isBoundaryError = true
    this.source = init.source || "boundary"
    this.operation = init.operation || null
    this.method = init.method || null
    this.pathname = init.pathname || null
    this.status = typeof init.status === "number" ? init.status : null
    this.code = normalizeCode(init.code)
    this.kind = init.kind || "unknown"
    this.outcome = init.outcome || "fatal"
    this.details = init.details || null
  }
}

export function makeBoundaryError(init = {}) {
  const message = cleanString(init.message) || "Boundary error"
  const operation = inferOperation(init)
  const kind = inferKind({
    message,
    status: init.status,
    code: init.code,
    kind: init.kind,
    pathname: init.pathname,
    name: init.name,
    didTimeout: init.didTimeout === true,
  })
  const outcome = init.outcome || inferOutcome({ status: init.status, kind, pathname: init.pathname })
  return new BoundaryError(message, {
    ...init,
    operation,
    kind,
    outcome,
  })
}

export function normalizeBoundaryError(err, context = {}) {
  if (err?.isBoundaryError === true) return err

  const message = cleanString(context.message) || cleanString(err?.message) || String(err || "Boundary error")
  const method = context.method || err?.method || parseMethod(message)
  const pathname = context.pathname || err?.pathname || parsePathname(message)
  const status =
    typeof context.status === "number"
      ? context.status
      : typeof err?.status === "number"
        ? err.status
        : typeof err?.statusCode === "number"
          ? err.statusCode
          : parseStatus(message)
  const code = context.code || err?.code || null

  return makeBoundaryError({
    message,
    source: context.source || err?.source || "boundary",
    operation: context.operation || err?.operation,
    method,
    pathname,
    status,
    code,
    kind: context.kind || err?.kind,
    outcome: context.outcome || err?.outcome,
    didTimeout: context.didTimeout === true,
    cause: context.cause || err,
    details: context.details || err?.details || null,
    name: err?.name,
  })
}

export function classifyBoundaryError(err, context = {}) {
  const error = normalizeBoundaryError(err, context)
  return {
    error,
    source: error.source,
    outcome: error.outcome,
    kind: error.kind,
    status: error.status,
    code: error.code,
    stale: error.outcome === "stale",
    retryable: error.outcome === "retryable",
    fatal: error.outcome === "fatal",
  }
}

export function isStaleBoundaryError(err, context = {}) {
  return classifyBoundaryError(err, context).stale
}

export function isRetryableBoundaryError(err, context = {}) {
  return classifyBoundaryError(err, context).retryable
}

export function isFatalBoundaryError(err, context = {}) {
  return classifyBoundaryError(err, context).fatal
}

export function isAbortBoundaryError(err, context = {}) {
  return normalizeBoundaryError(err, context).kind === "abort"
}

export function isDisconnectBoundaryError(err, context = {}) {
  return normalizeBoundaryError(err, context).kind === "disconnect"
}

export function boundaryErrorFromHttpResponse({ source, message, operation, method, pathname, status, statusText, bodyText, details }) {
  const suffix = cleanString(bodyText) || cleanString(statusText) || "Request failed"
  return makeBoundaryError({
    source,
    message: cleanString(message) || `${operation || `${method} ${pathname}` || "Request"} failed: ${status} ${suffix}`,
    operation,
    method,
    pathname,
    status,
    details,
  })
}

export function boundaryErrorFromException(err, context = {}) {
  return normalizeBoundaryError(err, context)
}
