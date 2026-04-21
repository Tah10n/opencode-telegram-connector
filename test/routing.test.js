import test from "node:test"
import assert from "node:assert/strict"
import { ctxKeyFrom, threadIdOr0FromMessage } from "../src/telegram/routing.js"

test("threadIdOr0FromMessage returns the topic id when present", () => {
  assert.equal(threadIdOr0FromMessage({ message_thread_id: 42 }), 42)
})

test("threadIdOr0FromMessage falls back to zero for missing or invalid thread ids", () => {
  assert.equal(threadIdOr0FromMessage({}), 0)
  assert.equal(threadIdOr0FromMessage({ message_thread_id: 4.2 }), 0)
  assert.equal(threadIdOr0FromMessage({ message_thread_id: "42" }), 0)
})

test("ctxKeyFrom normalizes missing thread ids to zero", () => {
  assert.equal(ctxKeyFrom(123, undefined), "123:0")
  assert.equal(ctxKeyFrom(123, 0), "123:0")
  assert.equal(ctxKeyFrom(123, 77), "123:77")
})
