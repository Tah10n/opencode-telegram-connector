import { setTimeout as delay } from "node:timers/promises"
import {
  boundaryErrorFromException,
  boundaryErrorFromHttpResponse,
  isAbortBoundaryError,
  isDisconnectBoundaryError,
  isRetryableBoundaryError,
  makeBoundaryError,
} from "../boundary-errors.js"

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

export function startOpenCodeSseLoop({ projectAlias, ocClient, logger, onConnect, onEvent, onError, abortSignal }) {
  let stopped = false
  let activeCtrl = null
  let forwardAbort = null
  let idleTimer = null

  const HEALTH_CHECK_MIN_INTERVAL_MS = readIntEnv("OPENCODE_SSE_HEALTHCHECK_MIN_INTERVAL_MS", 15_000)
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
    stopped = true
    clearIdleTimer()
    activeCtrl?.abort()
  }

  void (async () => {
    let backoff = 1000
    while (!stopped && !(abortSignal?.aborted)) {
      const ctrl = new AbortController()
      activeCtrl = ctrl
      forwardAbort = () => ctrl.abort()
      abortSignal?.addEventListener?.("abort", forwardAbort)
      try {
        const url = new URL(ocClient.baseUrl + "/event")
        const res = await fetch(url, {
          method: "GET",
          headers: ocClient.headers({ accept: "text/event-stream" }),
          signal: ctrl.signal,
        })
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
        logger?.info?.(`[${projectAlias}] SSE connected`)
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
              logger?.error?.("SSE event handler error:", projectAlias, err?.message || String(err))
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
        })
        const msg = normalized.message
        const isAbort = isAbortBoundaryError(normalized)
        const isTransientDisconnect = isDisconnectBoundaryError(normalized)

        if (isAbort) {
          // Normal: stop/idle-timeout abort.
          logger?.info?.("SSE aborted:", projectAlias, msg)
        } else if (isTransientDisconnect) {
          logger?.info?.("SSE disconnected:", projectAlias, msg)
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
            logger?.info?.("SSE retryable error:", projectAlias, msg)
          } else {
            logger?.error?.("SSE error:", projectAlias, msg)
          }
          try {
            await onError?.({ projectAlias, err: normalized })
          } catch {}
        }
        await delay(backoff)
        backoff = Math.min(30_000, backoff * 2)
      } finally {
        abortSignal?.removeEventListener?.("abort", forwardAbort)
        clearIdleTimer()
        ctrl.abort()
        if (activeCtrl === ctrl) activeCtrl = null
      }
    }
  })()

  return { stop }
}
