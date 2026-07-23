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
  for (const outcome of ["pending", "accepted", "ambiguous", "reconciled", "retryable", "released"]) {
    observability.recordPromptDeliveryOutcome("demo", outcome)
  }
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "sendMessage" })
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "editMessageText" })
  observability.recordAttachmentFallback("demo", "assistant-long-output")
  observability.recordLegacyCallbackFallback("demo")
  observability.recordOutboxQueued("demo")
  observability.recordOutboxDelivered("demo")
  observability.recordOutboxDiscarded("demo")
  observability.recordOutboxRetry("demo")
  observability.recordOutboxExpired("demo", 2)
  observability.recordOutboxBackpressure("demo")

  const projectText = observability.buildStatusLines("demo").join("\n")
  const runtimeText = observability.buildRuntimeStatusLines().join("\n")

  for (const text of [projectText, runtimeText]) {
    assert.match(text, /Messages: assistant=1 skipped=1 attachmentFallbacks=1/)
    assert.match(text, /Prompts: delivered=1 answered=1/)
    assert.match(text, /Prompt delivery ledger: pending=1 accepted=1 ambiguous=1 reconciled=1 retryable=1 released=1/)
    assert.match(text, /Telegram delivery: sendFailures=1 editFailures=1/)
    assert.match(text, /Durable outbox: queued=1 delivered=1 discarded=1 retries=1 expired=2 backpressure=1/)
    assert.match(text, /legacyFallback=1|Legacy callbacks: fallback=1/)
    assert.doesNotMatch(text, /chat|session|state\.json|token/i)
  }
})

test("createRuntimeObservability builds readiness health snapshots", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })
  let outboxSnapshot = {
    queueSize: 0,
    maxEntries: 2000,
    inFlight: 0,
    blockedWaiters: 0,
    full: false,
    nextDueAt: 0,
    workerActive: true,
    lastFatalError: "",
  }
  observability.setOutboxSnapshotProvider(() => outboxSnapshot)
  const readyInputs = {
    managedTasks: [
      { name: "telegramLoop", kind: "loop", stopCalled: false },
      { name: "durableOutbox", kind: "loop", stopCalled: false },
    ],
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

  outboxSnapshot = { ...outboxSnapshot, queueSize: 2000, blockedWaiters: 1, full: true }
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, false)
  assert.deepEqual(snapshot.checks.outbox, {
    ok: false,
    active: true,
    queueSize: 2000,
    maxEntries: 2000,
    inFlight: 0,
    blockedWaiters: 1,
    full: true,
    nextDueAt: 0,
    workerActive: true,
    lastFatalError: "",
  })
  assert.match(observability.buildRuntimeStatusLines().join("\n"), /Outbox runtime: size=2000\/2000 inFlight=0 blocked=1 full=true worker=true/)

  outboxSnapshot = { ...outboxSnapshot, queueSize: 0, blockedWaiters: 0, full: false }
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, true)

  outboxSnapshot = { ...outboxSnapshot, workerActive: false }
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.outbox.ok, false)
  outboxSnapshot = { ...outboxSnapshot, workerActive: true }

  snapshot = observability.buildHealthSnapshot({
    ...readyInputs,
    managedTasks: [{ name: "telegramLoop", kind: "loop", stopCalled: false }],
  })
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.outbox.active, false)

  outboxSnapshot = { ...outboxSnapshot, lastFatalError: "http:401" }
  snapshot = observability.buildHealthSnapshot(readyInputs)
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.checks.outbox.lastFatalError, "http:401")
  outboxSnapshot = { ...outboxSnapshot, lastFatalError: "" }

  snapshot = observability.buildHealthSnapshot({
    managedTasks: [
      { name: "telegramLoop", kind: "loop", stopCalled: false },
      { name: "durableOutbox", kind: "loop", stopCalled: false },
    ],
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
