import test from "node:test"
import assert from "node:assert/strict"
import {
  classifyBoundaryError,
  isAbortBoundaryError,
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
  })
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
