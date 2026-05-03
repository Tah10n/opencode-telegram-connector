import net from "node:net"

export function normalizeEndpointBaseUrl(baseUrl, { label = "baseUrl" } = {}) {
  const s = String(baseUrl || "").trim()
  if (!s) return s
  const u = new URL(s)
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${label} must use http or https`)
  if (u.username || u.password) throw new Error(`${label} must not include username or password`)
  if (u.search || u.hash) throw new Error(`${label} must not include query strings or fragments`)
  u.search = ""
  u.hash = ""
  u.pathname = u.pathname.replace(/\/+$/g, "") || "/"
  const normalized = u.toString()
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

export function appendPathToBaseUrl(baseUrl, pathname) {
  const base = new URL(normalizeEndpointBaseUrl(baseUrl))
  const suffix = String(pathname || "")
  if (!suffix.startsWith("/")) throw new Error(`Endpoint path must start with '/': ${suffix}`)
  const basePath = base.pathname.replace(/\/+$/g, "")
  base.pathname = `${basePath === "/" ? "" : basePath}${suffix}`
  base.search = ""
  base.hash = ""
  return base
}

export function isLoopbackHostname(hostname) {
  let host = String(hostname || "").trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host === "::1") return true
  if (net.isIP(host) === 4) return host.split(".")[0] === "127"
  return false
}

export function sanitizeBaseUrlForDisplay(baseUrl) {
  const s = String(baseUrl || "").trim()
  if (!s) return s
  try {
    const u = new URL(s)
    if (u.username || u.password) {
      u.username = ""
      u.password = ""
    }
    if (u.hash) u.hash = ""
    for (const [k] of u.searchParams) u.searchParams.set(k, "***")
    u.pathname = sanitizePathForDisplay(u.pathname)
    return u.toString()
  } catch {
    return redactCmdlineSecrets(s)
  }
}

const SENSITIVE_PATH_VALUE_RE = /^(?:token|access[-_.~]?token|password|passwd|secret|api[-_.~]?key|apikey|key|auth|jwt|signature|sig|sso|session|credential|credentials)[-_.~:=].{3,}$/i

function decodePathSegmentForDetection(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function isSensitivePathSegment(segment) {
  const decoded = decodePathSegmentForDetection(segment)
  return SENSITIVE_PATH_VALUE_RE.test(decoded) || redactHighEntropyTokens(decoded) !== decoded
}

function sanitizePathForDisplay(pathname) {
  return String(pathname || "")
    .split("/")
    .map((segment) => (segment && isSensitivePathSegment(segment) ? "***" : segment))
    .join("/")
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function shannonEntropy(str) {
  const freq = {}
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1
  const len = str.length
  return -Object.values(freq).reduce((sum, count) => {
    const p = count / len
    return sum + p * Math.log2(p)
  }, 0)
}

// Matches 32+ char token-like strings, including URL-safe/base64 segments.
// Keeping entropy-based filtering prevents common short IDs and low-entropy IDs
// (like ULIDs and UUID-like strings) from being redacted too aggressively.
const TOKEN_LIKE_RE = /[A-Za-z0-9_+\-.=]{32,}/g
const JWT_LIKE_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g

function redactHighEntropyTokens(text) {
  // Entropy threshold 4.0 bits/char: filters hex UUIDs (~3.7) while catching
  // real API tokens and secrets (GitHub PATs, Anthropic keys, etc. — 4.5+).
  let out = String(text || "")
  out = out.replace(TOKEN_LIKE_RE, (match) => (shannonEntropy(match) >= 4.0 ? "***" : match))
  out = out.replace(JWT_LIKE_RE, "***")
  return out
}

function redactKnownSecrets(text, knownSecrets = []) {
  let out = String(text || "")
  for (const secret of knownSecrets || []) {
    const raw = String(secret ?? "")
    // Avoid replacing short common words such as project aliases or usernames.
    if (raw.length < 6) continue
    out = out.replace(new RegExp(escapeRegExp(raw), "g"), "***")
  }
  return out
}

function redactTelegramBotTokens(text) {
  return String(text || "")
    // URL-path form /bot<id>:<secret>. 6+ chars after the colon covers all known Telegram
    // token formats (real tokens have ~33 chars); the /bot prefix provides context to avoid
    // false positives from short numeric strings.
    .replace(/(\/bot)\d{5,}:[A-Za-z0-9_-]{6,}/g, "$1***")
    // Bare token form <id>:<secret> without URL context. 20+ chars avoids false positives
    // on short numeric ratios like "12345:abc123" that are not bot tokens.
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "***")
}

function redactSensitivePaths(text, sensitivePaths = []) {
  let out = String(text || "")
  for (const entry of sensitivePaths || []) {
    const rawPath = typeof entry === "string" ? entry : entry?.path
    const label = typeof entry === "string" ? "sensitive-path" : entry?.label || "sensitive-path"
    const raw = String(rawPath || "").trim()
    if (!raw) continue
    out = out.replace(new RegExp(escapeRegExp(raw), "g"), `<${label}>`)
    const slashNormalized = raw.replace(/\\/g, "/")
    if (slashNormalized !== raw) out = out.replace(new RegExp(escapeRegExp(slashNormalized), "g"), `<${label}>`)
  }

  // Generic path redaction for runtime-sensitive connector files. These files can
  // contain bot tokens, Basic Auth credentials, chat/session bindings, offsets,
  // pending prompts, and idempotency history.
  out = out.replace(/(?:(?:[A-Za-z]:)?[^\s"'<>]*[\\/])?\.env(?![.\w-])/g, "<env-file>")
  out = out.replace(/(?:(?:[A-Za-z]:)?[^\s"'<>]*[\\/])?connector\.config\.mjs\b/g, "<config-file>")
  out = out.replace(/(?:(?:[A-Za-z]:)?[^\s"'<>]*[\\/])?state\.json(?:\.backup\.[^\s"'<>]+)?\b/g, "<state-file>")
  return out
}

function redactSensitiveUrlPathSegments(text) {
  return String(text || "").replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const u = new URL(raw)
      const sanitizedPath = sanitizePathForDisplay(u.pathname)
      if (sanitizedPath === u.pathname) return raw
      u.pathname = sanitizedPath
      return u.toString()
    } catch {
      return raw
    }
  })
}

export function redactCmdlineSecrets(cmdline, options = {}) {
  const s = String(cmdline || "")
  if (!s) return s
  let out = s
  out = out.replace(/\b(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1***:***@")
  out = out.replace(/([?&])([^=&#\s"']+)=([^&\s"']*)/g, "$1$2=***")
  out = out.replace(/#([^\s"']+)/g, "#***")
  out = redactSensitiveUrlPathSegments(out)

  const flags = ["password", "pass", "passwd", "token", "api-key", "apikey", "secret", "key"]
  const flagAlternation = flags.map((f) => f.replaceAll("-", "[-_]?"))
  const flagRe = new RegExp(`(\\-\\-(?:${flagAlternation.join("|")}))(?:\\s+|=)("[^"]*"|'[^']*'|\\S+)`, "gi")
  out = out.replace(flagRe, "$1=***")

  out = out.replace(/(Authorization:)(\s*)(Basic|Bearer)\s+\S+/gi, "$1$2$3 ***")
  out = redactTelegramBotTokens(out)
  out = redactKnownSecrets(out, options.knownSecrets)
  out = redactSensitivePaths(out, options.sensitivePaths)
  out = redactHighEntropyTokens(out)
  return out
}

export function redactSensitiveText(value, options = {}) {
  return redactCmdlineSecrets(value, options)
}

export function sanitizeBaseUrlForCli(baseUrl) {
  const s = String(baseUrl || "").trim()
  if (!s) return { url: s, displayUrl: s, hadUserInfo: false, seemsSensitive: false }
  try {
    const u = new URL(s)
    const hadUserInfo = !!(u.username || u.password)
    if (u.hash) u.hash = ""
    const display = new URL(u.toString())
    display.pathname = sanitizePathForDisplay(display.pathname)
    const displayUrl = redactCmdlineSecrets(display.toString())

    let seemsSensitive =
      hadUserInfo ||
      Boolean(u.search) ||
      String(u.pathname || "")
        .split("/")
        .some((segment) => segment && isSensitivePathSegment(segment))
    const sensitiveKeysRe = /(token|access[_-]?token|password|passwd|secret|api[_-]?key|key|auth|jwt|signature|sig|code|sso|session)/i
    for (const k of u.searchParams.keys()) {
      if (sensitiveKeysRe.test(String(k))) {
        seemsSensitive = true
        break
      }
    }
    return { url: u.toString(), displayUrl, hadUserInfo, seemsSensitive }
  } catch {
    return { url: s, displayUrl: redactCmdlineSecrets(s), hadUserInfo: false, seemsSensitive: false }
  }
}
