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

export function makeCallbackStore() {
  const store = new LruMap(4000)
  const token = () => crypto.randomBytes(8).toString("base64url")
  const pack = (data) => {
    if (Buffer.byteLength(data, "utf8") <= 64) return data
    let t = ""
    for (let i = 0; i < 10; i++) {
      t = token()
      if (store.get(t) == null) break
    }
    store.set(t, data)
    return `cb|${t}`
  }
  const unpack = (data) => {
    if (typeof data !== "string") return null
    if (!data.startsWith("cb|")) return data
    const t = data.slice(3)
    return store.get(t) ?? null
  }
  return { pack, unpack }
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
