import { Buffer } from "node:buffer"
import { boundaryErrorFromException, boundaryErrorFromHttpResponse } from "../boundary-errors.js"
import { appendPathToBaseUrl, isLoopbackHostname, normalizeEndpointBaseUrl } from "../url-utils.js"
import { encodeOpenCodePathSegment, normalizeOpenCodeId } from "./ids.js"

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return `Basic ${token}`
}

function makeTimeoutSignal(timeoutMs = 30_000) {
  if (!timeoutMs) return { signal: undefined, cancel: () => {} }
  const ctrl = new AbortController()
  let didTimeout = false
  const t = setTimeout(() => {
    didTimeout = true
    ctrl.abort()
  }, timeoutMs)
  return { signal: ctrl.signal, cancel: () => clearTimeout(t), didTimeout: () => didTimeout }
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal?.any === "function") return AbortSignal.any(active)

  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  for (const signal of active) {
    if (signal.aborted) {
      ctrl.abort()
      break
    }
    signal.addEventListener?.("abort", abort, { once: true })
  }
  return ctrl.signal
}

export class OpenCodeClient {
  constructor({ baseUrl, username, password, allowInsecureHttp = false }) {
    this.baseUrl = normalizeEndpointBaseUrl(baseUrl, { label: "OpenCode baseUrl" })
    this.username = username || ""
    this.password = password || ""
    this.allowInsecureHttp = allowInsecureHttp === true

    if (this.password) {
      const u = new URL(this.baseUrl)
      // Treat only true loopback names/addresses as safe for insecure HTTP.
      // NOTE: 0.0.0.0 is a bind-all address, not loopback.
      const isLoopback = isLoopbackHostname(u.hostname)
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
    const url = appendPathToBaseUrl(this.baseUrl, pathname)
    const operation = `${method} ${url.pathname}`
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        url.searchParams.set(k, String(v))
      }
    }
    const t = makeTimeoutSignal(timeoutMs)
    const requestSignal = combineSignals(signal, t.signal)
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(json ? { "content-type": "application/json" } : undefined),
        signal: requestSignal,
        body: json ? JSON.stringify(json) : undefined,
      })

      if (res.status === 204) return null

      const text = await res.text()
      if (!res.ok) {
        const statusSummary = [res.status, res.statusText].filter(Boolean).join(" ")
        throw boundaryErrorFromHttpResponse({
          source: "opencode",
          operation,
          method,
          pathname: url.pathname,
          status: res.status,
          statusText: res.statusText,
          bodyText: text,
          message: `${operation} failed: ${statusSummary}`,
        })
      }
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } catch (err) {
      throw boundaryErrorFromException(err, {
        source: "opencode",
        operation,
        method,
        pathname: url.pathname,
        didTimeout: t.didTimeout?.() === true,
      })
    } finally {
      t.cancel()
    }
  }

  health({ signal } = {}) {
    return signal ? this.request("/global/health", { signal }) : this.request("/global/health")
  }

  getConfig({ directory } = {}) {
    return this.request(`/config`, { query: { directory } })
  }

  getConfigProviders() {
    return this.request(`/config/providers`)
  }

  listSessions({ directory, limit, signal } = {}) {
    return this.request("/session", { query: { directory, limit }, ...(signal ? { signal } : {}) })
  }

  getSession(sessionId) {
    return this.request(`/session/${encodeOpenCodePathSegment(sessionId, "session id")}`)
  }

  createSession({ title, directory, signal } = {}) {
    const json = {}
    if (title) json.title = title
    if (directory) json.directory = directory
    return this.request("/session", { method: "POST", json, ...(signal ? { signal } : {}) })
  }

  abortSession(sessionId) {
    return this.request(`/session/${encodeOpenCodePathSegment(sessionId, "session id")}/abort`, { method: "POST" })
  }

  promptAsync(sessionId, text, options = {}) {
    const payload = {
      parts: [{ type: "text", text }],
    }
    if (options.model) payload.model = options.model
    if (options.variant) payload.variant = options.variant
    if (options.agent) payload.agent = options.agent
    if (options.noReply === true) payload.noReply = true
    if (options.system) payload.system = options.system
    if (options.tools) payload.tools = options.tools
    return this.request(`/session/${encodeOpenCodePathSegment(sessionId, "session id")}/prompt_async`, {
      method: "POST",
      json: payload,
    })
  }

  getMessage(sessionId, messageId, { signal, timeoutMs } = {}) {
    const options = { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) }
    return this.request(
      `/session/${encodeOpenCodePathSegment(sessionId, "session id")}/message/${encodeOpenCodePathSegment(messageId, "message id")}`,
      Object.keys(options).length ? options : undefined,
    )
  }

  listMessages(sessionId, { limit } = {}) {
    return this.request(`/session/${encodeOpenCodePathSegment(sessionId, "session id")}/message`, { query: { limit } })
  }

  replyPermission(permissionId, { reply, message }) {
    return this.request(`/permission/${encodeOpenCodePathSegment(permissionId, "permission id")}/reply`, {
      method: "POST",
      json: { reply, ...(message ? { message } : {}) },
    })
  }

  replyQuestion(questionId, answers) {
    return this.request(`/question/${encodeOpenCodePathSegment(questionId, "question id")}/reply`, { method: "POST", json: { answers } })
  }

  rejectQuestion(questionId) {
    return this.request(`/question/${encodeOpenCodePathSegment(questionId, "question id")}/reject`, { method: "POST" })
  }

  listPermissions({ signal } = {}) {
    return this.request(`/permission`, { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
  }

  listQuestions({ signal } = {}) {
    return this.request(`/question`, { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
  }

  async selectTuiSession(sessionId, { timeoutMs = 5000 } = {}) {
    const normalizedSessionId = normalizeOpenCodeId(sessionId)
    if (!normalizedSessionId) throw new Error("Invalid session id: expected a non-empty id")
    // Best-effort: the /tui/select-session endpoint is not guaranteed to exist
    // in all opencode versions. Fall back to publishing the equivalent event.
    try {
      return await this.request(`/tui/select-session`, {
        method: "POST",
        json: { sessionID: normalizedSessionId },
        timeoutMs,
      })
    } catch (err) {
      if (err?.isBoundaryError === true && err.status === 404) {
        // Fallback: /tui/publish { type: "tui.session.select", properties: { sessionID } }
        try {
          return await this.request(`/tui/publish`, {
            method: "POST",
            json: {
              type: "tui.session.select",
              properties: { sessionID: normalizedSessionId },
            },
            timeoutMs,
          })
        } catch {
          // Keep the original error for diagnostics.
        }
      }
      throw err
    }
  }

  getActiveTuiSession({ timeoutMs = 5000, signal } = {}) {
    return this.request(`/tui/active-session`, {
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
  }
}
