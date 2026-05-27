import test from "node:test"
import assert from "node:assert/strict"
import { sessionProjectScopeDecision, sessionProjectScopeDecisionWithFallback, sessionProjectScopeErrorText } from "../src/session-project-scope.js"

test("sessionProjectScopeDecision allows projects without directory evidence requirements", () => {
  assert.deepEqual(
    sessionProjectScopeDecision({ id: "ses_1", directory: "C:/repo/other" }, { baseUrl: "http://127.0.0.1:4312" }),
    { ok: true, reason: "project-directory-not-configured" },
  )
})

test("sessionProjectScopeDecision requires matching directory evidence when project directory is configured", () => {
  assert.deepEqual(
    sessionProjectScopeDecision({ id: "ses_1", directory: "c:/repo/demo" }, { directory: "C:/repo/demo" }),
    { ok: true, reason: "directory-match" },
  )
  assert.deepEqual(
    sessionProjectScopeDecision({ id: "ses_1", directory: "C:/repo/other" }, { directory: "C:/repo/demo" }),
    { ok: false, reason: "directory-mismatch" },
  )
  assert.deepEqual(
    sessionProjectScopeDecision({ id: "ses_1" }, { directory: "C:/repo/demo" }),
    { ok: false, reason: "missing-directory" },
  )
})

test("sessionProjectScopeDecision allows missing directory only with explicit unscoped fallback", () => {
  assert.deepEqual(
    sessionProjectScopeDecision({ id: "ses_1" }, { directory: "C:/repo/demo", allowUnscopedSessionListFallback: true }),
    { ok: true, reason: "unscoped-fallback" },
  )
})

test("sessionProjectScopeDecisionWithFallback accepts matching list evidence only when details are unscoped", () => {
  const project = { directory: "C:/repo/demo" }

  assert.deepEqual(
    sessionProjectScopeDecisionWithFallback(
      { id: "ses_1" },
      project,
      { id: "ses_1", directory: "C:/repo/demo" },
    ),
    { ok: true, reason: "directory-match" },
  )
  assert.deepEqual(
    sessionProjectScopeDecisionWithFallback(
      { id: "ses_1", directory: "C:/repo/other" },
      project,
      { id: "ses_1", directory: "C:/repo/demo" },
    ),
    { ok: false, reason: "directory-mismatch" },
  )
})

test("sessionProjectScopeErrorText does not expose backend directory paths", () => {
  const text = sessionProjectScopeErrorText("demo", "ses_1", { reason: "directory-mismatch" })

  assert.match(text, /Session ses_1 cannot be used for project 'demo'/)
  assert.doesNotMatch(text, /C:\//i)
})
