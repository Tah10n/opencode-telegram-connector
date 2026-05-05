import { redactSensitiveText } from "../url-utils.js"
import { getRequestContext } from "./request-context.js"

const LEVEL_TO_STREAM = {
  debug: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
}

function normalizeFormat(format) {
  const normalized = String(format || "text").trim().toLowerCase()
  return normalized === "json" ? "json" : "text"
}

function normalizeError(error, redactionOptions) {
  if (!error || typeof error !== "object") return redactSensitiveText(String(error ?? ""), redactionOptions)
  return {
    name: redactSensitiveText(error.name || "Error", redactionOptions),
    message: redactSensitiveText(error.message || String(error), redactionOptions),
    ...(error.code ? { code: redactSensitiveText(error.code, redactionOptions) } : {}),
    ...(error.status != null ? { status: error.status } : {}),
    ...(error.kind ? { kind: redactSensitiveText(error.kind, redactionOptions) } : {}),
    ...(error.outcome ? { outcome: redactSensitiveText(error.outcome, redactionOptions) } : {}),
    ...(error.source ? { source: redactSensitiveText(error.source, redactionOptions) } : {}),
    ...(error.operation ? { operation: redactSensitiveText(error.operation, redactionOptions) } : {}),
    ...(error.pathname ? { pathname: redactSensitiveText(error.pathname, redactionOptions) } : {}),
    // stack is intentionally dropped — it may contain sensitive paths and token fragments.
    // stack_redacted: true signals to the reader that a stack existed but was omitted.
    ...(error.stack ? { stack_redacted: true } : {}),
  }
}

function sanitizeValue(value, redactionOptions, seen = new WeakSet()) {
  if (typeof value === "string") return redactSensitiveText(value, redactionOptions)
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error || value?.isBoundaryError === true) return normalizeError(value, redactionOptions)
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, redactionOptions, seen))
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeValue(entry, redactionOptions, seen)
    }
    seen.delete(value)
    return out
  }
  return redactSensitiveText(String(value), redactionOptions)
}

function formatLegacyArg(arg, redactionOptions) {
  const safe = sanitizeValue(arg, redactionOptions)
  if (typeof safe === "string") return safe
  if (safe == null) return String(safe)
  try {
    return JSON.stringify(safe)
  } catch {
    return redactSensitiveText(String(safe), redactionOptions)
  }
}

function splitMessageAndFields(args, redactionOptions) {
  const list = Array.from(args)
  if (list.length === 0) return { msg: "", fields: {} }

  const last = list[list.length - 1]
  const hasStructuredFields = list.length >= 2 && isPlainObject(last)
  const messageArgs = hasStructuredFields ? list.slice(0, -1) : list
  const fields = hasStructuredFields ? sanitizeValue(last, redactionOptions) : {}
  const msg = messageArgs.map((arg) => formatLegacyArg(arg, redactionOptions)).join(" ")
  return { msg, fields }
}

function serializeText(entry) {
  const { ts, level, msg, ...fields } = entry
  const parts = [ts, level.toUpperCase(), msg].filter(Boolean)
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue
    const formatted = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value)
    parts.push(`${key}=${formatted}`)
  }
  return parts.join(" ")
}

function defaultStdout(line) {
  console.log(line)
}

function defaultStderr(line) {
  console.error(line)
}

export function createConnectorLogger({
  format = "text",
  knownSecrets = [],
  sensitivePaths = [],
  stdout = defaultStdout,
  stderr = defaultStderr,
  now = () => new Date().toISOString(),
} = {}) {
  const logFormat = normalizeFormat(format)
  const redactionOptions = { knownSecrets, sensitivePaths }

  function sanitizeFields(fields) {
    return isPlainObject(fields) ? sanitizeValue(fields, redactionOptions) : {}
  }

  function write(level, args, scopedFields = {}) {
    const { msg, fields } = splitMessageAndFields(args, redactionOptions)
    const entry = {
      ts: now(),
      level,
      msg,
      ...sanitizeFields(getRequestContext()),
      ...sanitizeFields(scopedFields),
      ...fields,
    }
    const line = logFormat === "json" ? JSON.stringify(entry) : serializeText(entry)
    const stream = LEVEL_TO_STREAM[level] === "stderr" ? stderr : stdout
    stream(line)
  }

  function createScopedLogger(scopedFields = {}) {
    return {
      debug: (...args) => write("debug", args, scopedFields),
      info: (...args) => write("info", args, scopedFields),
      warn: (...args) => write("warn", args, scopedFields),
      error: (...args) => write("error", args, scopedFields),
      child: (fields = {}) => createScopedLogger({
        ...(isPlainObject(scopedFields) ? scopedFields : {}),
        ...(isPlainObject(fields) ? fields : {}),
      }),
    }
  }

  return createScopedLogger()
}

export function collectLoggerRedactionOptions(config = {}) {
  const knownSecrets = [config?.telegram?.botToken]
  for (const project of Object.values(config?.projects || {})) {
    if (project?.password) knownSecrets.push(project.password)
  }
  const sensitivePaths = []
  if (config?.stateFile) sensitivePaths.push({ path: config.stateFile, label: "state-file" })
  return { knownSecrets: knownSecrets.filter(Boolean), sensitivePaths }
}
