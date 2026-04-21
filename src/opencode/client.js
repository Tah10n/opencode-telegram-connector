import { Buffer } from "node:buffer"

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return `Basic ${token}`
}

function makeTimeoutSignal(timeoutMs = 30_000) {
  if (!timeoutMs) return { signal: undefined, cancel: () => {} }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) }
}

export class OpenCodeClient {
  constructor({ baseUrl, username, password, allowInsecureHttp = false }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "")
    this.username = username || ""
    this.password = password || ""
    this.allowInsecureHttp = allowInsecureHttp === true

    if (this.password) {
      const u = new URL(this.baseUrl)
      const host = (u.hostname || "").toLowerCase()
      // Treat only true loopback names/addresses as safe for insecure HTTP.
      // NOTE: 0.0.0.0 is a bind-all address, not loopback.
      const isLoopback = host === "localhost" || host === "::1" || host.startsWith("127.")
      const isHttps = u.protocol === "https:"
      if (!isHttps && !isLoopback && !this.allowInsecureHttp) {
        throw new Error(
          `Refusing to send Basic Auth credentials over insecure HTTP to non-loopback host: ${u.hostname}. Set OPENCODE_ALLOW_INSECURE_HTTP=1 to override.`,
        )
      }
    }
  }

  headers(extra) {
    const h = {
      accept: "application/json",
      ...(extra || {}),
    }
    if (this.password) {
      h.authorization = basicAuthHeader(this.username || "opencode", this.password)
    }
    return h
  }

  async request(pathname, { method = "GET", query, json, timeoutMs = 30_000, signal } = {}) {
    const url = new URL(this.baseUrl + pathname)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        url.searchParams.set(k, String(v))
      }
    }
    const t = makeTimeoutSignal(timeoutMs)
    const res = await fetch(url, {
      method,
      headers: this.headers(json ? { "content-type": "application/json" } : undefined),
      signal: signal || t.signal,
      body: json ? JSON.stringify(json) : undefined,
    }).finally(t.cancel)
    if (res.status === 204) return null
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${url.pathname} failed: ${res.status} ${text || res.statusText}`)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  health() {
    return this.request("/global/health")
  }

  listSessions({ directory, limit } = {}) {
    return this.request("/session", { query: { directory, limit } })
  }

  getSession(sessionId) {
    return this.request(`/session/${sessionId}`)
  }

  createSession({ title } = {}) {
    return this.request("/session", { method: "POST", json: title ? { title } : {} })
  }

  promptAsync(sessionId, text) {
    return this.request(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      json: { parts: [{ type: "text", text }] },
    })
  }

  getMessage(sessionId, messageId) {
    return this.request(`/session/${sessionId}/message/${messageId}`)
  }

  replyPermission(permissionId, { reply, message }) {
    return this.request(`/permission/${permissionId}/reply`, {
      method: "POST",
      json: { reply, ...(message ? { message } : {}) },
    })
  }

  replyQuestion(questionId, answers) {
    return this.request(`/question/${questionId}/reply`, { method: "POST", json: { answers } })
  }

  rejectQuestion(questionId) {
    return this.request(`/question/${questionId}/reject`, { method: "POST" })
  }

  listPermissions() {
    return this.request(`/permission`, { timeoutMs: 15_000 })
  }

  listQuestions() {
    return this.request(`/question`, { timeoutMs: 15_000 })
  }
}
