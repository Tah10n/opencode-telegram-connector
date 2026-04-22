import test from "node:test"
import assert from "node:assert/strict"
import { findSessionByShareUrl, normalizeShareUrl, parseSessionReference } from "../src/session-ref.js"

test("parseSessionReference returns null for empty input", () => {
  assert.equal(parseSessionReference("  \n  "), null)
})

test("parseSessionReference keeps raw session ids", () => {
  assert.deepEqual(parseSessionReference("ses_123"), {
    type: "session-id",
    raw: "ses_123",
    sessionId: "ses_123",
  })
})

test("normalizeShareUrl strips query, hash, and trailing slash", () => {
  assert.equal(normalizeShareUrl("https://opncd.ai/s/abc123/?utm_source=tg#fragment"), "https://opncd.ai/share/abc123")
  assert.equal(normalizeShareUrl("https://opncd.ai/share/abc123/?utm_source=tg#fragment"), "https://opncd.ai/share/abc123")
})

test("parseSessionReference recognizes share links", () => {
  assert.deepEqual(parseSessionReference("https://opncd.ai/s/abc123?x=1"), {
    type: "share-link",
    raw: "https://opncd.ai/s/abc123?x=1",
    shareUrl: "https://opncd.ai/share/abc123",
  })
  assert.deepEqual(parseSessionReference("https://opncd.ai/share/abc123?x=1"), {
    type: "share-link",
    raw: "https://opncd.ai/share/abc123?x=1",
    shareUrl: "https://opncd.ai/share/abc123",
  })
})

test("parseSessionReference rejects unsupported http links", () => {
  assert.deepEqual(parseSessionReference("https://opncd.ai/session/ses_123"), {
    type: "invalid-link",
    raw: "https://opncd.ai/session/ses_123",
  })
})

test("findSessionByShareUrl matches normalized shared session urls", () => {
  const match = findSessionByShareUrl(
    [
      { id: "ses_1" },
      { id: "ses_2", share: { url: "https://opncd.ai/s/abc123/" } },
    ],
    "https://opncd.ai/share/abc123?from=telegram",
  )

  assert.deepEqual(match, { id: "ses_2", share: { url: "https://opncd.ai/s/abc123/" } })
})

test("findSessionByShareUrl returns null when there is no matching shared session", () => {
  const match = findSessionByShareUrl([{ id: "ses_1", share: { url: "https://opncd.ai/share/abc123" } }], "https://opncd.ai/s/missing")

  assert.equal(match, null)
})
