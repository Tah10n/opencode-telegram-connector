import test from "node:test"
import assert from "node:assert/strict"
import { readBoundedResponseText } from "../src/http-response.js"

test("readBoundedResponseText rejects an oversized declared Content-Length", async () => {
  const response = new Response("abcd", { headers: { "content-length": "4" } })
  await assert.rejects(() => readBoundedResponseText(response, { maxBytes: 3 }), (err) => {
    assert.equal(err.code, "RESPONSE_TOO_LARGE")
    assert.equal(err.maxBytes, 3)
    assert.equal(err.declaredBytes, 4)
    return true
  })
})

test("readBoundedResponseText counts chunked bytes and cancels after crossing the limit", async () => {
  const encoder = new TextEncoder()
  let cancelled = false
  const response = {
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("ab"))
        controller.enqueue(encoder.encode("cd"))
      },
      cancel() {
        cancelled = true
      },
    }),
  }

  await assert.rejects(() => readBoundedResponseText(response, { maxBytes: 3 }), /exceeds 3 bytes/)
  assert.equal(cancelled, true)
})

test("readBoundedResponseText accepts the exact byte boundary and counts UTF-8 bytes", async () => {
  assert.deepEqual(await readBoundedResponseText(new Response("abcd"), { maxBytes: 4 }), {
    text: "abcd",
    bytesRead: 4,
    truncated: false,
  })
  assert.equal((await readBoundedResponseText(new Response("é"), { maxBytes: 2 })).text, "é")
  await assert.rejects(() => readBoundedResponseText(new Response("é"), { maxBytes: 1 }), /exceeds 1 bytes/)
})

test("readBoundedResponseText truncates oversized error bodies without retaining the full body", async () => {
  const result = await readBoundedResponseText(new Response("secret-error-body"), { maxBytes: 6, truncate: true })
  assert.deepEqual(result, { text: "secret", bytesRead: 6, truncated: true })
  assert.equal(result.text.includes("error-body"), false)
})
