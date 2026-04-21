import test from "node:test"
import assert from "node:assert/strict"
import { formatSessionsListText } from "../src/session-list.js"

test("formatSessionsListText shows current and startup markers", () => {
  const text = formatSessionsListText(
    "pocket",
    [
      { id: "ses_current", title: "Current session" },
      { id: "ses_startup", title: "Startup session" },
      { id: "ses_other" },
    ],
    { currentSessionId: "ses_current", startupSessionId: "ses_startup" },
  )

  assert.match(text, /Sessions for 'pocket':/)
  assert.match(text, /Current: ses_current/)
  assert.match(text, /Startup: ses_startup/)
  assert.match(text, /- ses_current \[current\] — Current session/)
  assert.match(text, /- ses_startup \[startup\] — Startup session/)
  assert.match(text, /Use \/use <sessionId> to switch\./)
})

test("formatSessionsListText handles empty session lists", () => {
  const text = formatSessionsListText("demo", [], { currentSessionId: "ses_bound" })

  assert.match(text, /Current: ses_bound/)
  assert.match(text, /No sessions found\./)
  assert.match(text, /Use \/new to create one or \/use <sessionId> to switch\./)
})

test("formatSessionsListText limits long lists and ignores invalid entries", () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `ses_${index + 1}` }))
  sessions.splice(3, 0, { title: "missing id" })

  const text = formatSessionsListText("demo", sessions, { limit: 10 })

  assert.doesNotMatch(text, /missing id/)
  assert.match(text, /- ses_10/)
  assert.doesNotMatch(text, /- ses_11/)
  assert.match(text, /…and 2 more\./)
})
