import crypto from "node:crypto"
import { LruMap } from "../util/lru.js"

export function parseSseDebugFilter(rawValue) {
  const raw = String(rawValue || "").trim()
  if (!raw) return null
  const [projectAlias, sessionId] = raw.split(":", 2)
  return {
    projectAlias: projectAlias ? projectAlias.trim() : "",
    sessionId: sessionId ? sessionId.trim() : "",
  }
}

export const DEFAULT_CALLBACK_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000

export function makeCallbackStore({ store: persistentStore, ttlMs = DEFAULT_CALLBACK_PAYLOAD_TTL_MS } = {}) {
  const store = new LruMap(4000)
  const token = () => crypto.randomBytes(8).toString("base64url")
  const now = () => Date.now()
  const normalizedTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_CALLBACK_PAYLOAD_TTL_MS
  const remember = (t, data, { createdAt = now(), expiresAt = createdAt + normalizedTtlMs } = {}) => {
    store.set(t, { data, createdAt, expiresAt })
  }
  const readMemory = (t) => {
    const entry = store.get(t)
    if (!entry) return null
    if (typeof entry.expiresAt === "number" && entry.expiresAt <= now()) {
      store.delete(t)
      persistentStore?.deleteCallbackPayload?.(t)
      return null
    }
    return entry.data
  }
  const readPersistent = (t) => {
    if (typeof persistentStore?.getCallbackPayloadRecord === "function") {
      return persistentStore.getCallbackPayloadRecord(t)
    }
    const data = persistentStore?.getCallbackPayload?.(t)
    if (data == null) return null
    const createdAt = now()
    return { data, createdAt, expiresAt: createdAt + normalizedTtlMs }
  }
  const pack = (data) => {
    if (Buffer.byteLength(data, "utf8") <= 64) return data
    let t = ""
    for (let i = 0; i < 10; i++) {
      t = token()
      if (readMemory(t) == null && readPersistent(t) == null) break
    }
    const createdAt = now()
    const expiresAt = createdAt + normalizedTtlMs
    remember(t, data, { createdAt, expiresAt })
    persistentStore?.setCallbackPayload?.(t, data, { ttlMs: normalizedTtlMs, createdAt, expiresAt })
    return `cb|${t}`
  }
  const unpackDetailed = (data) => {
    if (typeof data !== "string") return { ok: false, reason: "invalid", data: null }
    if (!data.startsWith("cb|")) return { ok: true, reason: "inline", data }
    const t = data.slice(3)
    if (!t) return { ok: false, reason: "invalid", data: null }
    const memoryValue = readMemory(t)
    if (memoryValue != null) return { ok: true, reason: "packed", data: memoryValue }
    const persisted = readPersistent(t)
    if (persisted != null) {
      remember(t, persisted.data, { createdAt: persisted.createdAt, expiresAt: persisted.expiresAt })
      return { ok: true, reason: "persisted", data: persisted.data }
    }
    return { ok: false, reason: "expired", data: null }
  }
  const unpack = (data) => {
    const result = unpackDetailed(data)
    return result.ok ? result.data : null
  }
  return { pack, unpack, unpackDetailed }
}

export function clampString(s, max) {
  const str = String(s ?? "")
  if (str.length <= max) return str
  return str.slice(0, Math.max(0, max - 1)) + "…"
}

export function compareNumbers(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export function isCommand(text) {
  return typeof text === "string" && text.trim().startsWith("/")
}

export function parseCommand(text, { botUsername } = {}) {
  const trimmed = text.trim()
  const [cmd, ...rest] = trimmed.split(/\s+/)
  // Telegram may send commands as /cmd@BotName in groups.
  const [commandName, targetBot] = String(cmd || "").split("@", 2)
  const normalizedTargetBot = String(targetBot || "").trim().toLowerCase()
  const normalizedBotUsername = String(botUsername || "").trim().toLowerCase()
  if (normalizedTargetBot && normalizedBotUsername && normalizedTargetBot !== normalizedBotUsername) {
    return { cmd: null, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: false }
  }
  if (normalizedTargetBot && !normalizedBotUsername) {
    return { cmd: null, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: false }
  }
  const normalizedCmd = String(commandName || "")
    .toLowerCase()
  return { cmd: normalizedCmd, args: rest.join(" ").trim(), argv: rest, targetBot: normalizedTargetBot, isForThisBot: true }
}

export function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function readPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readNonNegativeNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function normalizeOpenCodeWatchdogOptions(options = {}) {
  return {
    failureThreshold: Math.max(1, Math.floor(readPositiveNumber(options.failureThreshold ?? process.env.OPENCODE_WATCHDOG_FAILURE_THRESHOLD, 6))),
    windowMs: Math.max(1, Math.floor(readPositiveNumber(options.windowMs ?? process.env.OPENCODE_WATCHDOG_WINDOW_MS, 120_000))),
    cooldownMs: Math.max(0, Math.floor(readNonNegativeNumber(options.cooldownMs ?? process.env.OPENCODE_WATCHDOG_COOLDOWN_MS, 60_000))),
  }
}

export function extractTextParts(message) {
  if (!message || !Array.isArray(message.parts)) return ""
  const parts = message.parts.filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
  return parts.map((p) => p.text).join("")
}
