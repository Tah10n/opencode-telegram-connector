import crypto from "node:crypto"
import { makeBoundaryError } from "../boundary-errors.js"

const CLEARLY_UNSENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
])

function promptTextHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex")
}

function stablePromptIdentityText(input) {
  return JSON.stringify({
    projectAlias: String(input.projectAlias || ""),
    sessionId: String(input.sessionId || ""),
    chatId: input.chatId,
    threadIdOr0: input.threadIdOr0 || 0,
    messageId: input.messageId,
    updateId: Number.isInteger(input.updateId) ? input.updateId : null,
    kind: String(input.kind || ""),
  })
}

export function promptDeliveryIdentity(input = {}) {
  const kind = String(input.kind || "")
  if (!["text", "attachment-direct", "attachment-confirmed"].includes(kind)) throw new Error(`Unsupported prompt delivery kind: ${kind || "missing"}`)
  if (!String(input.projectAlias || "").trim() || !String(input.sessionId || "").trim()) throw new Error("Prompt delivery requires projectAlias and sessionId")
  if (!Number.isInteger(input.chatId) || !Number.isInteger(input.messageId)) throw new Error("Prompt delivery requires integer chatId and messageId")
  const normalized = {
    kind,
    projectAlias: String(input.projectAlias).trim(),
    sessionId: String(input.sessionId).trim(),
    chatId: input.chatId,
    threadIdOr0: Number.isInteger(input.threadIdOr0) && input.threadIdOr0 >= 0 ? input.threadIdOr0 : 0,
    messageId: input.messageId,
    ...(Number.isInteger(input.updateId) ? { updateId: input.updateId } : {}),
  }
  const digest = crypto.createHash("sha256").update(stablePromptIdentityText(normalized)).digest("hex").slice(0, 48)
  const openCodeMessageId = `msg_tgc_${digest}`
  return { ...normalized, key: openCodeMessageId, openCodeMessageId }
}

function promptRecord(store, key) {
  if (typeof store?.getPromptDelivery === "function") return store.getPromptDelivery(key)
  return store?.get?.()?.promptDeliveries?.records?.[key] || null
}

function setPromptRecord(store, key, record) {
  if (typeof store?.setPromptDelivery === "function") {
    const stored = store.setPromptDelivery(key, record)
    if (stored === false) {
      throw makeBoundaryError({
        source: "state",
        operation: "persist prompt delivery marker",
        kind: "backpressure",
        outcome: "retryable",
        message: "Durable prompt delivery ledger is full; the prompt was not sent",
      })
    }
    return stored
  }
  const state = store?.get?.()
  if (!state) throw new Error("Durable prompt delivery requires a state store")
  state.promptDeliveries ||= { records: {} }
  state.promptDeliveries.records ||= {}
  state.promptDeliveries.records[key] = { ...record }
  store.scheduleSave?.()
  return true
}

function deletePromptRecord(store, key) {
  if (typeof store?.deletePromptDelivery === "function") return store.deletePromptDelivery(key)
  const records = store?.get?.()?.promptDeliveries?.records
  if (!records?.[key]) return false
  delete records[key]
  store.scheduleSave?.()
  return true
}

async function flushState(store, operation) {
  if (typeof store?.flush !== "function") return
  try {
    await store.flush()
  } catch (err) {
    throw makeBoundaryError({
      source: "state",
      operation,
      kind: "durability",
      outcome: "retryable",
      message: `${operation} failed: ${err?.message || String(err)}`,
      cause: err,
    })
  }
}

function errorCodes(err) {
  const codes = new Set()
  let current = err
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current.code === "string") codes.add(current.code.toUpperCase())
    current = current.cause
  }
  return codes
}

function clearlyUnsent(err) {
  for (const code of errorCodes(err)) {
    if (CLEARLY_UNSENT_CODES.has(code)) return true
  }
  return false
}

function definitivePromptFailure(err) {
  const status = Number(err?.status)
  return Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
}

function safeErrorSummary(err) {
  const status = Number(err?.status)
  if (Number.isInteger(status)) return `http_${status}`
  return [...errorCodes(err)][0] || "ambiguous_failure"
}

function recordOutcome(recordPromptDeliveryOutcome, identity, outcome) {
  try {
    recordPromptDeliveryOutcome?.(identity.projectAlias, outcome)
  } catch {
    // Observability must never change delivery semantics.
  }
}

function retryablePromptDeliveryError(err, identity, state) {
  return makeBoundaryError({
    source: "opencode",
    operation: state === "outcome_unknown" ? "reconcile ambiguous prompt delivery" : "retry unsent prompt delivery",
    method: state === "outcome_unknown" ? "GET" : "POST",
    pathname: state === "outcome_unknown"
      ? `/session/${identity.sessionId}/message/${identity.openCodeMessageId}`
      : `/session/${identity.sessionId}/prompt_async`,
    status: typeof err?.status === "number" && Number.isInteger(err.status) ? err.status : undefined,
    code: err?.code,
    kind: state === "outcome_unknown" ? "ambiguous_delivery" : "delivery_unavailable",
    outcome: "retryable",
    retryAfterMs: err?.retryAfterMs,
    message: state === "outcome_unknown"
      ? "Prompt delivery outcome is still unknown; reconciliation must succeed before the Telegram update can be checkpointed"
      : "Prompt delivery was not sent and must be retried before the Telegram update can be checkpointed",
    cause: err,
  })
}

function makeRecord(identity, state, previous, now, patch = {}) {
  const promptHash = patch.promptHash || previous?.promptHash
  return {
    openCodeMessageId: identity.openCodeMessageId,
    state,
    kind: identity.kind,
    projectAlias: identity.projectAlias,
    sessionId: identity.sessionId,
    chatId: identity.chatId,
    threadIdOr0: identity.threadIdOr0,
    messageId: identity.messageId,
    ...(Number.isInteger(identity.updateId) ? { updateId: identity.updateId } : {}),
    attemptCount: previous?.attemptCount || 0,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    ...(promptHash ? { promptHash } : {}),
    ...patch,
  }
}

function isExpectedPromptMessage(found, identity, expectedPromptHash) {
  if (!found || typeof found !== "object") return false
  if (found?.info?.id !== identity.openCodeMessageId || found?.info?.role !== "user") return false
  const foundSessionId = found?.info?.sessionID ?? found?.info?.sessionId
  if (foundSessionId != null && foundSessionId !== identity.sessionId) return false
  const textParts = Array.isArray(found.parts)
    ? found.parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text)
    : []
  return textParts.length === 1 && promptTextHash(textParts[0]) === expectedPromptHash
}

async function reconcileUnknownPrompt({ store, oc, identity, record, now, recordPromptDeliveryOutcome }) {
  if (typeof oc?.getMessage !== "function") throw new Error("OpenCode message API is required to reconcile an ambiguous prompt delivery")
  try {
    const found = await oc.getMessage(identity.sessionId, identity.openCodeMessageId)
    if (!isExpectedPromptMessage(found, identity, record.promptHash)) {
      throw makeBoundaryError({
        source: "opencode",
        operation: "reconcile prompt delivery",
        kind: "protocol",
        outcome: "fatal",
        message: "OpenCode reconciliation did not return the exact expected user message",
      })
    }
    const accepted = makeRecord(identity, "accepted", record, now)
    setPromptRecord(store, identity.key, accepted)
    await flushState(store, "persist reconciled prompt delivery")
    recordOutcome(recordPromptDeliveryOutcome, identity, "reconciled")
    return { accepted: true, reconciled: true, messageID: identity.openCodeMessageId }
  } catch (err) {
    const notFound = Number(err?.status) === 404
    const unknown = makeRecord(identity, "outcome_unknown", record, now, {
      outcomeUnknownSince: record.outcomeUnknownSince || record.updatedAt || now,
      reconcileNotFoundCount: (record.reconcileNotFoundCount || 0) + (notFound ? 1 : 0),
      lastError: notFound ? "reconciliation_not_found" : safeErrorSummary(err),
    })
    setPromptRecord(store, identity.key, unknown)
    await flushState(store, "persist unresolved prompt reconciliation")
    recordOutcome(recordPromptDeliveryOutcome, identity, "ambiguous")
    throw retryablePromptDeliveryError(err, identity, "outcome_unknown")
  }
}

export async function reconcilePromptDeliveryBeforePayload({ store, oc, identity, now = Date.now(), recordPromptDeliveryOutcome } = {}) {
  if (!identity?.key || !identity?.openCodeMessageId) throw new Error("Prompt delivery identity is required")
  const record = promptRecord(store, identity.key)
  if (!record) return null
  if (record.state === "accepted") return { accepted: true, replayed: true, messageID: identity.openCodeMessageId }
  if (record.state !== "outcome_unknown") return null
  return reconcileUnknownPrompt({ store, oc, identity, record, now, recordPromptDeliveryOutcome })
}

export async function deliverPromptExactlyOnce({ store, oc, identity, text, options, now = Date.now(), recordPromptDeliveryOutcome }) {
  if (!identity?.key || !identity?.openCodeMessageId) throw new Error("Prompt delivery identity is required")
  if (!oc?.promptAsync) throw new Error("OpenCode prompt API is required")

  let record = promptRecord(store, identity.key)
  if (record?.state === "accepted") {
    return { accepted: true, replayed: true, messageID: identity.openCodeMessageId }
  }
  if (record?.state === "outcome_unknown") {
    return reconcileUnknownPrompt({ store, oc, identity, record, now, recordPromptDeliveryOutcome })
  }
  if (!record) {
    record = makeRecord(identity, "pending", null, now, { promptHash: promptTextHash(text) })
    setPromptRecord(store, identity.key, record)
    await flushState(store, "persist pending prompt delivery")
    recordOutcome(recordPromptDeliveryOutcome, identity, "pending")
  }

  const attempting = makeRecord(identity, "outcome_unknown", record, now, {
    promptHash: promptTextHash(text),
    attemptCount: (record.attemptCount || 0) + 1,
    outcomeUnknownSince: now,
    reconcileNotFoundCount: 0,
  })
  setPromptRecord(store, identity.key, attempting)
  try {
    await flushState(store, "persist prompt delivery attempt")
  } catch (err) {
    setPromptRecord(store, identity.key, record)
    throw err
  }

  try {
    await oc.promptAsync(identity.sessionId, text, { ...(options || {}), messageID: identity.openCodeMessageId })
    const accepted = makeRecord(identity, "accepted", attempting, Date.now())
    setPromptRecord(store, identity.key, accepted)
    await flushState(store, "persist accepted prompt delivery")
    recordOutcome(recordPromptDeliveryOutcome, identity, "accepted")
    return { accepted: true, reconciled: false, messageID: identity.openCodeMessageId }
  } catch (err) {
    if (definitivePromptFailure(err)) {
      deletePromptRecord(store, identity.key)
      await flushState(store, "release failed prompt delivery")
      recordOutcome(recordPromptDeliveryOutcome, identity, "released")
      throw err
    }
    const state = clearlyUnsent(err) ? "pending" : "outcome_unknown"
    setPromptRecord(store, identity.key, makeRecord(identity, state, attempting, Date.now(), {
      lastError: safeErrorSummary(err),
      ...(state === "outcome_unknown" ? {
        outcomeUnknownSince: attempting.outcomeUnknownSince,
        reconcileNotFoundCount: attempting.reconcileNotFoundCount,
      } : {}),
    }))
    await flushState(store, "persist failed prompt delivery attempt")
    recordOutcome(recordPromptDeliveryOutcome, identity, state === "outcome_unknown" ? "ambiguous" : "retryable")
    throw retryablePromptDeliveryError(err, identity, state)
  }
}
