import test from "node:test"
import assert from "node:assert/strict"
import {
  bindRequestContext,
  captureRequestContext,
  createCorrelationId,
  getRequestContext,
  normalizeCorrelationId,
  runWithCapturedRequestContext,
  runWithRequestContext,
  withRequestContextFields,
} from "../src/runtime/request-context.js"

test("request context is scoped across async work", async () => {
  assert.deepEqual(getRequestContext(), {})

  const first = runWithRequestContext({ correlationId: "first", ctxKey: "1:0" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    return getRequestContext()
  })
  const second = runWithRequestContext({ correlationId: "second", ctxKey: "2:0" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return getRequestContext()
  })

  assert.deepEqual(await first, { correlationId: "first", ctxKey: "1:0" })
  assert.deepEqual(await second, { correlationId: "second", ctxKey: "2:0" })
  assert.deepEqual(getRequestContext(), {})
})

test("request context fields can be nested and captured", async () => {
  await runWithRequestContext({ correlationId: "outer", ctxKey: "1:0" }, async () => {
    const captured = captureRequestContext({ sessionId: "ses_1" })
    await withRequestContextFields({ projectAlias: "demo" }, async () => {
      assert.deepEqual(getRequestContext(), {
        correlationId: "outer",
        ctxKey: "1:0",
        projectAlias: "demo",
      })
    })
    const seen = await runWithCapturedRequestContext(captured, async () => getRequestContext())
    assert.deepEqual(seen, { correlationId: "outer", ctxKey: "1:0", sessionId: "ses_1" })
  })
})

test("bound request context survives delayed callbacks", async () => {
  let resolveValue
  const result = new Promise((resolve) => {
    resolveValue = resolve
  })

  await runWithRequestContext({ correlationId: "timer", projectAlias: "demo" }, async () => {
    const bound = bindRequestContext(() => resolveValue(getRequestContext()), { sessionId: "ses_timer" })
    setTimeout(bound, 1)
  })

  assert.deepEqual(await result, { correlationId: "timer", projectAlias: "demo", sessionId: "ses_timer" })
})

test("correlation ids are safe for HTTP headers", () => {
  assert.equal(normalizeCorrelationId(" tg update/42 secret?x=1 "), "tg-update-42-secret-x-1")
  const id = createCorrelationId("tg", ["update/42", "message"])
  assert.match(id, /^tg-update-42-message-[A-Za-z0-9_-]+$/)
  assert.ok(id.length <= 128)
})

test("correlation ids preserve the random suffix for long inputs", () => {
  const longPrefix = `tg${"p".repeat(90)}`
  const longParts = [`update${"u".repeat(90)}`, `message${"m".repeat(90)}`]
  const id = createCorrelationId(longPrefix, longParts)

  assert.ok(id.length <= 128)
  assert.match(id, /^[A-Za-z0-9._:\-]+$/)

  const suffix = id.slice(id.lastIndexOf("-") + 1)
  assert.match(suffix, /^[A-Za-z0-9_-]{8}$/)
  assert.ok(id.endsWith(`-${suffix}`))
})
