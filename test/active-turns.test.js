import test from "node:test"
import assert from "node:assert/strict"
import { formatActiveTurnStatus, formatStaleActiveTurnNotice, resolveActiveTurnStatus } from "../src/connector/active-turns.js"

test("resolveActiveTurnStatus marks inactive running assistant turns as stale", async () => {
  const now = Date.parse("2026-05-02T18:30:00Z")
  const status = await resolveActiveTurnStatus({
    now,
    staleMs: 20 * 60 * 1000,
    sessionId: "ses_1",
    oc: {
      async listMessages() {
        return [{
          info: { id: "msg_stuck", role: "assistant", time: { created: "2026-05-02T18:00:00Z" } },
          parts: [{ type: "tool", state: { status: "running", time: { started: "2026-05-02T18:01:00Z" } } }],
        }]
      },
    },
  })

  assert.equal(status.state, "stale")
  assert.equal(status.messageId, "msg_stuck")
  assert.equal(status.inactiveMs, 29 * 60 * 1000)
  assert.match(formatActiveTurnStatus(status), /stale \(29m without progress; message msg_stuck; use \/abort or \/new\)/)
})

test("resolveActiveTurnStatus ignores remote running summaries that local SSE already ended", async () => {
  const status = await resolveActiveTurnStatus({
    now: Date.now(),
    staleMs: 1,
    projectAlias: "demo",
    sessionId: "ses_1",
    getAgentActivityStatus: () => ({ state: "not-running", endedMessageIds: ["msg_done"] }),
    oc: {
      async listMessages() {
        return [{ info: { id: "msg_done", role: "assistant", time: { updated: Date.now() - 60_000 } } }]
      },
    },
  })

  assert.equal(status.state, "not-running")
})

test("resolveActiveTurnStatus uses the newest active assistant turn before checking staleness", async () => {
  const now = Date.parse("2026-05-02T18:30:00Z")
  const status = await resolveActiveTurnStatus({
    now,
    staleMs: 20 * 60 * 1000,
    sessionId: "ses_1",
    oc: {
      async listMessages() {
        return [
          { info: { id: "msg_old_stuck", role: "assistant", time: { updated: "2026-05-02T17:00:00Z" } } },
          { info: { id: "msg_fresh", role: "assistant", time: { updated: "2026-05-02T18:25:00Z" } } },
        ]
      },
    },
  })

  assert.equal(status.state, "running")
  assert.equal(status.messageId, "msg_fresh")
})

test("resolveActiveTurnStatus trusts recent local running activity when message summaries lag", async () => {
  const now = Date.parse("2026-05-02T18:30:00Z")
  const status = await resolveActiveTurnStatus({
    now,
    staleMs: 20 * 60 * 1000,
    projectAlias: "demo",
    sessionId: "ses_1",
    getAgentActivityStatus: () => ({ state: "running", activeMessageIds: ["msg_remote"], updatedAt: now - 60_000 }),
    oc: {
      async listMessages() {
        return [{ info: { id: "msg_remote", role: "assistant", time: { updated: "2026-05-02T17:00:00Z" } } }]
      },
    },
  })

  assert.equal(status.state, "running")
  assert.equal(status.source, "remote+local")
  assert.equal(status.inactiveMs, 60_000)
})

test("formatStaleActiveTurnNotice explains that the prompt was not queued", () => {
  const text = formatStaleActiveTurnNotice(
    { state: "stale", messageId: "msg_stuck", inactiveMs: 30 * 60 * 1000 },
    { projectAlias: "demo", sessionId: "ses_1" },
  )

  assert.match(text, /Agent appears stuck/)
  assert.match(text, /No assistant\/tool progress for 30m/)
  assert.match(text, /will not be queued behind the hung turn/)
  assert.match(text, /\/abort/)
})
