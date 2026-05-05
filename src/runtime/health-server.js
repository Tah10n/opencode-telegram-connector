import http from "node:http"
import { redactSensitiveText } from "../url-utils.js"

function sanitizeHealthValue(value) {
  if (typeof value === "string") return redactSensitiveText(value)
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((entry) => sanitizeHealthValue(entry))
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = sanitizeHealthValue(entry)
  return out
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

function normalizePath(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname
  } catch {
    return "/"
  }
}

export async function startHealthServer({ host = "127.0.0.1", port = 8787, getSnapshot, logger } = {}) {
  const server = http.createServer((req, res) => {
    const path = normalizePath(req)
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "method_not_allowed" })
      return
    }
    if (path !== "/livez" && path !== "/readyz" && path !== "/healthz") {
      writeJson(res, 404, { ok: false, error: "not_found" })
      return
    }

    let snapshot
    try {
      snapshot = typeof getSnapshot === "function" ? getSnapshot() : {}
    } catch (err) {
      writeJson(res, 503, { ok: false, status: "snapshot_error", error: redactSensitiveText(err?.message || String(err)) })
      return
    }

    if (path === "/livez") {
      const live = snapshot?.live !== false
      writeJson(res, live ? 200 : 503, {
        ok: live,
        status: live ? "live" : "not_live",
        checks: sanitizeHealthValue(snapshot?.checks || {}),
      })
      return
    }

    const ready = snapshot?.ready === true
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      checks: sanitizeHealthValue(snapshot?.checks || {}),
    })
  })

  const done = new Promise((resolve) => {
    server.once("close", resolve)
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  logger?.info?.("Health server listening", {
    source: "health",
    operation: "listen",
    host,
    port: typeof address === "object" && address ? address.port : port,
  })

  return {
    address,
    stop() {
      if (!server.listening) return
      server.close()
    },
    done,
  }
}
