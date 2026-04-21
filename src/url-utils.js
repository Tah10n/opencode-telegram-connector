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
    return u.toString()
  } catch {
    return s
  }
}

export function redactCmdlineSecrets(cmdline) {
  const s = String(cmdline || "")
  if (!s) return s
  let out = s
  out = out.replace(/\b(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1***:***@")
  out = out.replace(/([?&])([^=&#\s"']+)=([^&\s"']*)/g, "$1$2=***")
  out = out.replace(/#([^\s"']+)/g, "#***")

  const flags = ["password", "pass", "passwd", "token", "api-key", "apikey", "secret", "key"]
  const flagAlternation = flags.map((f) => f.replaceAll("-", "[-_]?"))
  const flagRe = new RegExp(`(\\-\\-(?:${flagAlternation.join("|")}))(?:\\s+|=)("[^"]*"|'[^']*'|\\S+)`, "gi")
  out = out.replace(flagRe, "$1=***")

  out = out.replace(/(Authorization:)(\s*)(Basic|Bearer)\s+\S+/gi, "$1$2$3 ***")
  return out
}

export function sanitizeBaseUrlForCli(baseUrl) {
  const s = String(baseUrl || "").trim()
  if (!s) return { url: s, displayUrl: s, hadUserInfo: false, seemsSensitive: false }
  try {
    const u = new URL(s)
    const hadUserInfo = !!(u.username || u.password)
    if (u.hash) u.hash = ""
    const displayUrl = redactCmdlineSecrets(u.toString())

    let seemsSensitive = hadUserInfo || Boolean(u.search)
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
