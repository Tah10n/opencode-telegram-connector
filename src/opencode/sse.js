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
import { createCorrelationId, runWithRequestContext } from "../runtime/request-context.js"

const DEFAULT_EVENT_PATH = "/global/event"
export const OPENCODE_SSE_EVENT_META = Symbol.for("telegram-opencode-connector.opencodeSseEventMeta")

function canonicalEventPath(value) {
  const raw = String(value || "").trim()
  const withLeadingSlash = raw ? (raw.startsWith("/") ? raw : `/${raw}`) : DEFAULT_EVENT_PATH
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/g, "") : withLeadingSlash
}

function directoryMetadata(value) {
  if (typeof value !== "string") return null
  const directory = value.trim()
  return directory ? directory : null
}

function makeSseEventMeta({ directory, eventPath, wrapped }) {
  return Object.freeze({
    directory: directoryMetadata(directory),
    eventPath,
    wrapped,
    requiresDirectoryRouting: canonicalEventPath(eventPath) === DEFAULT_EVENT_PATH,
  })
}

function defineSseEventMeta(evt, meta) {
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) return evt
  Object.defineProperty(evt, OPENCODE_SSE_EVENT_META, {
    value: meta,
    enumerable: false,
    configurable: false,
  })
  return evt
}

function sseEventContext(projectAlias, evt) {
  const props = evt?.properties || {}
  const part = props?.part || {}
  const info = props?.info || {}
  const sessionId = props.sessionID || props.sessionId || part.sessionID || part.sessionId || ""
  const messageId = info.id || props.messageID || props.messageId || part.messageID || part.messageId || ""
  return {
    correlationId: createCorrelationId("sse", [projectAlias, evt?.type || "event"]),
    source: "opencode",
    operation: "handle SSE event",
    projectAlias,
    eventType: evt?.type || "unknown",
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
  }
}

function readIntEnv(name, fallback) {
  const raw = process.env?.[name]
  if (raw == null || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function readPathEnv(name, fallback) {
  const raw = String(process.env?.[name] || "").trim()
  if (!raw) return fallback
  return raw.startsWith("/") ? raw : `/${raw}`
}

function normalizeSseEvent(evt, eventPath) {
  const directory = evt?.directory
  if (evt?.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)) {
    const payload = evt.payload
    return defineSseEventMeta(payload, makeSseEventMeta({ directory, eventPath, wrapped: true }))
  }
  return defineSseEventMeta(evt, makeSseEventMeta({ directory, eventPath, wrapped: false }))
}

export function getOpenCodeSseEventMeta(evt) {
  return evt?.[OPENCODE_SSE_EVENT_META] || null
}

function shouldPropagateHandlerError(err) {
  return err?.isBoundaryError === true && err.source === "state" && err.kind === "durability"
}

async function* readLines(readableStream) {
  const reader = readableStream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  // Some SSE lines (single `data:` line with a large JSON payload) can be very large.
  // Keep this bounded, but high enough for long assistant/tool outputs.
  const MAX_BUF_BYTES = readIntEnv("OPENCODE_SSE_MAX_LINE_BYTES", 8 * 1024 * 1024)
  const assertLineWithinLimit = (line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_BUF_BYTES) {
      throw new Error(`SSE line buffer exceeded limit (${Math.round(MAX_BUF_BYTES / 1024 / 1024)}MB)`)
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf("\n")
      if (idx === -1) break
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      assertLineWithinLimit(line)
      yield line
    }
    assertLineWithinLimit(buf)
  }
  // Flush the decoder in case the final chunk ends mid-codepoint.
  buf += decoder.decode()
  assertLineWithinLimit(buf)
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
  const EVENT_PATH = readPathEnv("OPENCODE_SSE_EVENT_PATH", DEFAULT_EVENT_PATH)
  const EVENT_OPERATION = `GET ${EVENT_PATH}`
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
        const url = appendPathToBaseUrl(ocClient.baseUrl, EVENT_PATH)
        connectTimer = setTimeout(() => {
          connectTimedOut = true
          ctrl.abort()
        }, CONNECT_TIMEOUT_MS)
        connectTimer.unref?.()
        const connectCorrelationId = createCorrelationId("sse-connect", [projectAlias])
        const headers = ocClient.headers({ accept: "text/event-stream" }, { correlationId: connectCorrelationId })
        const res = await runWithRequestContext(
          {
            correlationId: connectCorrelationId,
            source: "opencode",
            operation: EVENT_OPERATION,
            method: "GET",
            pathname: EVENT_PATH,
            projectAlias,
          },
          () => fetch(url, {
            method: "GET",
            headers,
            signal: ctrl.signal,
          }),
        )
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw boundaryErrorFromHttpResponse({
            source: "opencode",
            operation: EVENT_OPERATION,
            method: "GET",
            pathname: EVENT_PATH,
            status: res.status,
            statusText: res.statusText,
            bodyText: text,
            message: `SSE ${res.status}: ${res.statusText || "Request failed"}`,
          })
        }
        logger?.info?.("SSE connected", { projectAlias, source: "opencode", operation: EVENT_OPERATION, method: "GET", pathname: EVENT_PATH })
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
              evt = normalizeSseEvent(JSON.parse(payload), EVENT_PATH)
            } catch {
              continue
            }
            try {
              await runWithRequestContext(sseEventContext(projectAlias, evt), () => onEvent({ projectAlias, evt }))
            } catch (err) {
              logger?.error?.("SSE event handler error", { projectAlias, source: "opencode", operation: "handle SSE event", error: err?.message || String(err) })
              if (shouldPropagateHandlerError(err)) throw err
            }
            continue
          }

          eventBytes += Buffer.byteLength(line, "utf8")
          if (eventBytes > MAX_EVENT_BYTES || lines.length >= MAX_EVENT_LINES) {
            lines = []
            eventBytes = 0
            throw makeBoundaryError({
              source: "opencode",
              operation: EVENT_OPERATION,
              method: "GET",
              pathname: EVENT_PATH,
              kind: "protocol",
              outcome: "fatal",
              message: `SSE event exceeded limit (${Math.round(MAX_EVENT_BYTES / 1024 / 1024)}MB)`,
            })
          }
          lines.push(line)
        }
        throw makeBoundaryError({
          source: "opencode",
          operation: EVENT_OPERATION,
          method: "GET",
          pathname: EVENT_PATH,
          kind: "disconnect",
          outcome: "retryable",
          message: "SSE disconnected",
        })
      } catch (err) {
        if (stopped || abortSignal?.aborted) break
        const normalized = boundaryErrorFromException(err, {
          source: "opencode",
          operation: EVENT_OPERATION,
          method: "GET",
          pathname: EVENT_PATH,
          didTimeout: connectTimedOut,
        })
        const msg = normalized.message
        const isAbort = isAbortBoundaryError(normalized)
        const isTransientDisconnect = isDisconnectBoundaryError(normalized)

        if (isAbort) {
          // Normal: stop/idle-timeout abort.
          logger?.info?.("SSE aborted", { projectAlias, source: "opencode", operation: EVENT_OPERATION, kind: normalized.kind, outcome: normalized.outcome, error: msg })
          try {
            await onAbort?.({ projectAlias, err: normalized })
          } catch {}
        } else if (isTransientDisconnect) {
          logger?.info?.("SSE disconnected", { projectAlias, source: "opencode", operation: EVENT_OPERATION, kind: normalized.kind, outcome: normalized.outcome, error: msg })
          // Transient disconnects happen; only escalate if the server is actually unhealthy.
          const now = Date.now()
          if (now - lastHealthCheckAt >= HEALTH_CHECK_MIN_INTERVAL_MS) {
            lastHealthCheckAt = now
            try {
              await ocClient.health({ signal: abortSignal })
            } catch {
              try {
                await onError?.({ projectAlias, err: normalized })
              } catch {}
            }
          }
        } else {
          if (isRetryableBoundaryError(normalized)) {
            logger?.info?.("SSE retryable error", { projectAlias, source: "opencode", operation: EVENT_OPERATION, kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, retryable: true, error: msg })
          } else {
            logger?.error?.("SSE error", { projectAlias, source: "opencode", operation: EVENT_OPERATION, kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, retryable: false, error: msg })
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
      operation: EVENT_OPERATION,
      method: "GET",
      pathname: EVENT_PATH,
    })
    if (!stopped && !(abortSignal?.aborted)) {
      logger?.error?.("SSE loop crashed", { projectAlias, source: "opencode", operation: EVENT_OPERATION, kind: normalized.kind, outcome: normalized.outcome, status: normalized.status, code: normalized.code, error: normalized.message })
      try {
        await onError?.({ projectAlias, err: normalized })
      } catch {}
    }
  })

  return { stop, done }
}
