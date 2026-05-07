import { AsyncLocalStorage } from "node:async_hooks"
import crypto from "node:crypto"

const storage = new AsyncLocalStorage()
const MAX_CORRELATION_ID_LENGTH = 128

function isPlainObject(value) {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
}

export function normalizeCorrelationId(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  return raw
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CORRELATION_ID_LENGTH)
}

export function createCorrelationId(prefix = "req", parts = []) {
  const safePrefix = normalizeCorrelationId(prefix) || "req"
  const safeParts = (Array.isArray(parts) ? parts : [parts])
    .map((part) => normalizeCorrelationId(part))
    .filter(Boolean)
  const suffix = crypto.randomBytes(6).toString("base64url").replace(/-/g, "_")
  const base = [safePrefix, ...safeParts].join("-")
  const maxBaseLength = MAX_CORRELATION_ID_LENGTH - suffix.length - 1
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength).replace(/-+$/g, "") : base
  return `${truncatedBase}-${suffix}`
}

function normalizeContextFields(fields = {}) {
  if (!isPlainObject(fields)) return {}
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (key === "correlationId") {
      const id = normalizeCorrelationId(value)
      if (id) out.correlationId = id
      continue
    }
    out[key] = value
  }
  return out
}

export function getRequestContext() {
  return storage.getStore() || {}
}

export function runWithRequestContext(fields, fn) {
  const next = {
    ...getRequestContext(),
    ...normalizeContextFields(fields),
  }
  return storage.run(next, fn)
}

export function withRequestContextFields(fields, fn) {
  return runWithRequestContext(fields, fn)
}

export function captureRequestContext(fields = {}) {
  return {
    ...getRequestContext(),
    ...normalizeContextFields(fields),
  }
}

export function runWithCapturedRequestContext(context, fn) {
  return storage.run(normalizeContextFields(context), fn)
}

export function bindRequestContext(fn, fields = {}) {
  const captured = captureRequestContext(fields)
  return (...args) => runWithCapturedRequestContext(captured, () => fn(...args))
}
