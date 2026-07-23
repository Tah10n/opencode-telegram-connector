import test from "node:test"
import assert from "node:assert/strict"
import {
  classifyBoundaryError,
  isAbortBoundaryError,
  isClearlyUnsentRequestError,
  isDisconnectBoundaryError,
  makeBoundaryError,
  normalizeBoundaryError,
} from "../src/boundary-errors.js"

test("classifyBoundaryError marks resource 404s as stale", () => {
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /question/q_1/reply",
    method: "POST",
    pathname: "/question/q_1/reply",
    status: 404,
    message: "POST /question/q_1/reply failed: 404 not found",
  })

  assert.deepEqual(classifyBoundaryError(err), {
    error: err,
    source: "opencode",
    outcome: "stale",
    kind: "stale",
    status: 404,
    code: null,
    stale: true,
    retryable: false,
    fatal: false,
    retryAfterMs: null,
  })
})

test("BoundaryError preserves retry-after metadata", () => {
  const err = makeBoundaryError({ source: "telegram", status: 429, message: "rate limited", retryAfterMs: 2500 })
  const classification = classifyBoundaryError(err)

  assert.equal(err.retryAfterMs, 2500)
  assert.equal(classification.retryable, true)
  assert.equal(classification.retryAfterMs, 2500)
})

test("classifyBoundaryError marks path-prefixed resource 404s as stale", () => {
  const err = makeBoundaryError({
    source: "opencode",
    operation: "POST /api/permission/perm_1/reply",
    method: "POST",
    pathname: "/api/permission/perm_1/reply",
    status: 404,
    message: "POST /api/permission/perm_1/reply failed: 404 not found",
  })

  const classification = classifyBoundaryError(err)
  assert.equal(classification.stale, true)
  assert.equal(err.kind, "stale")
})

test("normalizeBoundaryError lifts retryable network failures from plain errors", () => {
  const err = normalizeBoundaryError(new Error("fetch failed"), {
    source: "opencode",
    operation: "GET /global/health",
    method: "GET",
    pathname: "/global/health",
  })

  const classification = classifyBoundaryError(err)
  assert.equal(err.isBoundaryError, true)
  assert.equal(classification.retryable, true)
  assert.equal(err.kind, "network")
})

test("normalizeBoundaryError keeps abort and disconnect markers", () => {
  const abortErr = normalizeBoundaryError({ name: "AbortError", message: "The operation was aborted." }, { source: "telegram" })
  const disconnectErr = normalizeBoundaryError(new Error("SSE disconnected"), {
    source: "opencode",
    operation: "GET /event",
    method: "GET",
    pathname: "/event",
  })

  assert.equal(isAbortBoundaryError(abortErr), true)
  assert.equal(isDisconnectBoundaryError(disconnectErr), true)
})

test("normalizeBoundaryError lifts a nested transport code from the cause chain", () => {
  const cause = new Error("DNS lookup failed")
  cause.code = "ENOTFOUND"
  const err = normalizeBoundaryError(new Error("request failed", { cause }), {
    source: "telegram",
    operation: "getUpdates",
  })

  assert.equal(err.code, "ENOTFOUND")
  assert.equal(classifyBoundaryError(err).retryable, true)
  assert.equal(isClearlyUnsentRequestError(err), true)
})

test("isClearlyUnsentRequestError stays conservative for ambiguous transport failures", () => {
  for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT"]) {
    const err = new Error(`ambiguous ${code}`)
    err.code = code
    assert.equal(isClearlyUnsentRequestError(err), false, code)
  }

  for (const code of ["EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]) {
    const err = new Error(`clearly unsent ${code}`)
    err.code = code
    assert.equal(isClearlyUnsentRequestError(err), true, code)
    assert.equal(classifyBoundaryError(err).retryable, true, code)
  }
})
