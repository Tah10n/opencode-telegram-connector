import test from "node:test"
import assert from "node:assert/strict"
import { createRuntimeObservability } from "../src/runtime/observability.js"

test("createRuntimeObservability redacts loop errors in runtime and project status", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })
  const sensitiveError = new Error("GET http://user:secret@example.test:4312/path?token=abc#frag Authorization: Bearer supersecret")

  observability.recordLoopError("telegramPoll", { err: sensitiveError })
  observability.recordLoopError("sse", { projectAlias: "demo", err: sensitiveError })

  const runtimeText = observability.buildRuntimeStatusLines().join("\n")
  const projectText = observability.buildStatusLines("demo").join("\n")

  for (const text of [runtimeText, projectText]) {
    assert.match(text, /token=\*\*\*/)
    assert.doesNotMatch(text, /user|supersecret|token=abc|frag|Bearer supersecret/)
  }
})

test("createRuntimeObservability records compact privacy-safe counters", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })

  observability.recordAssistantMirrored("demo")
  observability.recordNoisyEventSkipped("demo", "compaction")
  observability.recordPromptDelivered("demo", "permission")
  observability.recordPromptAnswered("demo", "permission", "ok")
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "sendMessage" })
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "editMessageText" })
  observability.recordAttachmentFallback("demo", "assistant-long-output")
  observability.recordLegacyCallbackFallback("demo")

  const projectText = observability.buildStatusLines("demo").join("\n")
  const runtimeText = observability.buildRuntimeStatusLines().join("\n")

  for (const text of [projectText, runtimeText]) {
    assert.match(text, /Messages: assistant=1 skipped=1 attachmentFallbacks=1/)
    assert.match(text, /Prompts: delivered=1 answered=1/)
    assert.match(text, /Telegram delivery: sendFailures=1 editFailures=1/)
    assert.match(text, /legacyFallback=1|Legacy callbacks: fallback=1/)
    assert.doesNotMatch(text, /chat|session|state\.json|token/i)
  }
})

test("createRuntimeObservability builds readiness health snapshots", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })
  const readyInputs = {
    managedTasks: [{ name: "telegramLoop", kind: "loop", stopCalled: false }],
    shutdownState: "running",
    state: { loaded: true, lastFlushError: "", lastFlushOk: true },
  }

  let snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.telegramPoll.ok, false)

  observability.recordLoopSuccess("telegramPoll")
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.live, true)
  assert.equal(snapshot.ready, true)

  observability.recordLoopRetry("telegramPoll", { err: new Error("Telegram getUpdates failed") })
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.telegramPoll.ok, false)
  assert.match(snapshot.checks.telegramPoll.lastError, /Telegram getUpdates failed/)

  observability.recordLoopSuccess("telegramPoll")
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, true)

  snapshot = observability.buildHealthSnapshot({
    managedTasks: [{ name: "telegramLoop", kind: "loop", stopCalled: false }],
    shutdownState: "running",
    state: { loaded: true, lastFlushError: "disk full", lastFlushOk: false },
  })
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.state.ok, false)

  for (const state of [
    { loaded: true, lastFlushError: "", lastFlushOk: true, pendingSave: true },
    { loaded: true, lastFlushError: "", lastFlushOk: true, flushInFlight: true },
  ]) {
    snapshot = observability.buildHealthSnapshot({ ...readyInputs, state })
    assert.equal(snapshot.ready, false)
    assert.equal(snapshot.checks.state.ok, false)
  }

  snapshot = observability.buildHealthSnapshot({
    ...readyInputs,
    state: {
      loaded: true,
      lastFlushOk: false,
      lastLoadError: "Cannot load C:\\operator\\private\\state.json",
      lastFlushError: "Cannot write C:/operator/private/state.json.tmp.123",
      lastFlushErrorAt: 1,
    },
  })
  const stateChecks = JSON.stringify(snapshot.checks.state)
  assert.doesNotMatch(stateChecks, /operator|private|state\.json/)
  assert.match(stateChecks, /<state-file>/)
})
