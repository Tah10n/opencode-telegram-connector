import test from "node:test"
import assert from "node:assert/strict"
import { startHealthServer } from "../src/runtime/health-server.js"

function makeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

test("health server exposes livez, readyz, healthz, and 404", async () => {
  let ready = false
  const server = await startHealthServer({
    host: "127.0.0.1",
    port: 0,
    logger: makeLogger(),
    getSnapshot: () => ({
      live: true,
      ready,
      checks: { state: { ok: ready } },
    }),
  })
  const baseUrl = `http://127.0.0.1:${server.address.port}`

  try {
    let res = await fetch(`${baseUrl}/livez`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)

    res = await fetch(`${baseUrl}/readyz`)
    assert.equal(res.status, 503)
    assert.equal((await res.json()).status, "not_ready")

    ready = true
    res = await fetch(`${baseUrl}/healthz`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, "ready")

    res = await fetch(`${baseUrl}/missing`)
    assert.equal(res.status, 404)
  } finally {
    server.stop()
    await server.done
  }
})

test("health server redacts diagnostic errors from payloads", async () => {
  const statePath = "C:\\operator\\private\\state.json"
  let throwSnapshot = false
  const server = await startHealthServer({
    host: "127.0.0.1",
    port: 0,
    logger: makeLogger(),
    getSnapshot: () => {
      if (throwSnapshot) throw new Error(`Snapshot failed for ${statePath}`)
      return {
        live: true,
        ready: false,
        checks: {
          state: {
            ok: false,
            pendingSave: true,
            flushInFlight: true,
            lastLoadError: `Cannot load ${statePath}`,
            lastFlushError: `Cannot write ${statePath}.tmp.123`,
          },
        },
      }
    },
  })
  const baseUrl = `http://127.0.0.1:${server.address.port}`

  try {
    let res = await fetch(`${baseUrl}/readyz`)
    assert.equal(res.status, 503)
    let payload = await res.json()
    assert.equal(payload.checks.state.pendingSave, true)
    assert.equal(payload.checks.state.flushInFlight, true)
    let text = JSON.stringify(payload)
    assert.doesNotMatch(text, /operator|private|state\.json/)
    assert.match(text, /<state-file>/)

    throwSnapshot = true
    res = await fetch(`${baseUrl}/readyz`)
    assert.equal(res.status, 503)
    payload = await res.json()
    assert.equal(payload.status, "snapshot_error")
    text = JSON.stringify(payload)
    assert.doesNotMatch(text, /operator|private|state\.json/)
    assert.match(text, /<state-file>/)
  } finally {
    server.stop()
    await server.done
  }
})
