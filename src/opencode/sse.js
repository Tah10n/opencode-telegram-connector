import { setTimeout as delay } from "node:timers/promises"
import {
  boundaryErrorFromException,
  boundaryErrorFromHttpResponse,
  isAbortBoundaryError,
  isDisconnectBoundaryError,
  isRetryableBoundaryError,
  makeBoundaryError,
} from "../boundary-errors.js"
import { appendPathToBaseUrl } from "../url-utils.js"

function readIntEnv(name, fallback) {
  const raw = process.env?.[name]
  if (raw == null || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

async function* readLines(readableStream) {
  const reader = readableStream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  // Some SSE lines (single `data:` line with a large JSON payload) can be very large.
  // Keep this bounded, but high enough for long assistant/tool outputs.
  const MAX_BUF_BYTES = readIntEnv("OPENCODE_SSE_MAX_LINE_BYTES", 8 * 1024 * 1024)
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    if (Buffer.byteLength(buf, "utf8") > MAX_BUF_BYTES) {
      throw new Error(`SSE line buffer exceeded limit (${Math.round(MAX_BUF_BYTES / 1024 / 1024)}MB)`)
    }
    while (true) {
      const idx = buf.indexOf("\n")
      if (idx === -1) break
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      yield line
    }
  }
  // Flush the decoder in case the final chunk ends mid-codepoint.
  buf += decoder.decode()
  if (buf) yield buf
}

export function startOpenCodeSseLoop({ projectAlias, ocClient, logger, onConnect, onEvent, onError, onAbort, abortSignal }) {
  let stopped = false
  let activeCtrl = null
  let forwardAbort = null
  let idleTimer = null
  let resolveStopped = () => {}
  const stopRequested = new Promise((resolve) => {
    resolveStopped = resolve
  })

  const HEALTH_CHECK_MIN_INTERVAL_MS = readIntEnv("OPENCODE_SSE_HEALTHCHECK_MIN_INTERVAL_MS", 15_000)
  const CONNECT_TIMEOUT_MS = readIntEnv("OPENCODE_SSE_CONNECT_TIMEOUT_MS", 15_000)
  let lastHealthCheckAt = 0

  const IDLE_TIMEOUT_MS = 30 * 60 * 1000
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      // If the connection hangs without emitting data, abort to force a reconnect.
      activeCtrl?.abort()
    }, IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }

  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    resolveStopped()
    clearIdleTimer()
    activeCtrl?.abort()
  }

  async function waitForRetryBackoff(ms) {
    if (stopped || abortSignal?.aborted) return
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      abortSignal?.addEventListener?.("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([delay(ms), stopRequested, abortPromise])
    } finally {
      if (onAbort) abortSignal?.removeEventListener?.("abort", onAbort)
    }
  }

  const done = (async () => {
    let backoff = 1000
    while (!stopped && !(abortSignal?.aborted)) {
      const ctrl = new AbortController()
      activeCtrl = ctrl
      forwardAbort = () => ctrl.abort()
      abortSignal?.addEventListener?.("abort", forwardAbort)
      let connectTimer = null
      let connectTimedOut = false
      try {
        const url = appendPathToBaseUrl(ocClient.baseUrl, "/event")
        connectTimer = setTimeout(() => {
          connectTimedOut = true
          ctrl.abort()
        }, CONNECT_TIMEOUT_MS)
        connectTimer.unref?.()
        const res = await fetch(url, {
          method: "GET",
          headers: ocClient.headers({ accept: "text/event-stream" }),
          signal: ctrl.signal,
        })
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw boundaryErrorFromHttpResponse({
            source: "opencode",
            operation: "GET /event",
            method: "GET",
            pathname: "/event",
            status: res.status,
            statusText: res.statusText,
            bodyText: text,
            message: `SSE ${res.status}: ${text || res.statusText}`,
          })
        }
        logger?.info?.("SSE connected", { projectAlias, source: "opencode", operation: "GET /event", method: "GET", pathname: "/event" })
        try {
          await onConnect?.({ projectAlias })
        } catch {}
        backoff = 1000

        resetIdleTimer()

        let lines = []
        let eventBytes = 0
        // Some events (e.g. long assistant/tool messages) can be large.
        const MAX_EVENT_BYTES = readIntEnv("OPENCODE_SSE_MAX_EVENT_BYTES", 8 * 1024 * 1024)
        const MAX_EVENT_LINES = readIntEnv("OPENCODE_SSE_MAX_EVENT_LINES", 5000)

        for await (const line of readLines(res.body)) {
          resetIdleTimer()
          if (line === "") {
            const dataLines = lines.filter((l) => l.startsWith("data:"))
            const payload = dataLines.map((l) => l.slice(5).replace(/^\s/, "")).join("\n")
            lines = []
            eventBytes = 0
            if (!payload) continue
            let evt
            try {
              evt = JSON.parse(payload)
            } catch {
              continue
            }
            try {
              await onEvent({ projectAlias, evt })
            } catch (err) {
              logger?.error?.("SSE event handler error", { projectAlias, source: "opencode", operation: "handle SSE event", error: err?.message || String(err) })
            }
            continue
          }

          eventBytes += Buffer.byteLength(line, "utf8")
          if (eventBytes > MAX_EVENT_BYTES || lines.length >= MAX_EVENT_LINES) {
            lines = []
            eventBytes = 0
            throw makeBoundaryError({
              source: "opencode",
              operation: "GET /event",
              method: "GET",
              pathname: "/event",
              kind: "protocol",
              outcome: "fatal",
              message: `SSE event exceeded limit (${Math.round(MAX_EVENT_BYTES / 1024 / 1024)}MB)`,
            })
          }
          lines.push(line)
        }
        throw makeBoundaryError({
          source: "opencode",
          operation: "GET /event",
          method: "GET",
          pathname: "/event",
          kind: "disconnect",
          outcome: "retryable",
          message: "SSE disconnected",
        })
      } catch (err) {
        if (stopped || abortSignal?.aborted) break
        const normalized = boundaryErrorFromException(err, {
          source: "opencode",
          operation: "GET /event",
          method: "GET",
          pathname: "/event",
          didTimeout: connectTimedOut,
        })
        const msg = normalized.message
        const isAbort = isAbortBoundaryError(normalized)
        const isTransientDisconnect = isDisconnectBoundaryError(normalized)

        if (isAbort) {
          // Normal: stop/idle-timeout abort.
          logger?.info?.("SSE aborted", { projectAlias, source: "opencode", operation: "GET /event", kind: normalized.kind, outcome: normalized.outcome, error: msg })
          try {
            await onAbort?.({ projectAlias, err: normalized })
          } catch {}
        } else if (isTransientDisconnect) {
          logger?.info?.("SSE disconnected", { projectAlias, source: "opencode", operation: "GET /event", kind: normalized.kind, outcome: normalized.outcome, error: msg })
          // Transient disconnects happen; only escalate if the server is actually unhealthy.
          const now = Date.now()
          if (now - lastHealthCheckAt >= HEALTH_CHECK_MIN_INTERVAL_MS) {
            lastHealthCheckAt = now
            try {
              await ocClient.health()
            } catch {
              try {
                await onError?.({ projectAlias, err: normalized })
              } catch {}
            }
          }
        } else {
          if (isRetryableBoundaryError(normalized)) {
            logger?.info?.("SSE retryable error", { projectAlias, source: "opencode", operation: "GET /event", kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, retryable: true, error: msg })
          } else {
            logger?.error?.("SSE error", { projectAlias, source: "opencode", operation: "GET /event", kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, retryable: false, error: msg })
          }
          try {
            await onError?.({ projectAlias, err: normalized })
          } catch {}
        }
        if (!isAbort && !isTransientDisconnect && !isRetryableBoundaryError(normalized)) break
        await waitForRetryBackoff(backoff)
        backoff = Math.min(30_000, backoff * 2)
      } finally {
        if (connectTimer) clearTimeout(connectTimer)
        abortSignal?.removeEventListener?.("abort", forwardAbort)
        clearIdleTimer()
        ctrl.abort()
        if (activeCtrl === ctrl) activeCtrl = null
      }
    }
  })().catch(async (err) => {
    const normalized = boundaryErrorFromException(err, {
      source: "opencode",
      operation: "GET /event",
      method: "GET",
      pathname: "/event",
    })
    if (!stopped && !(abortSignal?.aborted)) {
      logger?.error?.("SSE loop crashed", { projectAlias, source: "opencode", operation: "GET /event", kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, error: normalized.message })
      try {
        await onError?.({ projectAlias, err: normalized })
      } catch {}
    }
  })

  return { stop, done }
}
