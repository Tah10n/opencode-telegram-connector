import test from "node:test"
import assert from "node:assert/strict"
import { TelegramClient, makeInlineKeyboard, splitTelegramHtml, splitTelegramText } from "../src/telegram/client.js"
import { classifyBoundaryError, makeBoundaryError } from "../src/boundary-errors.js"

function makeJsonAbortResponse(signal, { ok = true, status = 200, statusText = "OK" } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () =>
      await new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new DOMException("timed out", "AbortError"))
          return
        }
        signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
      }),
  }
}

function assertNoDanglingSurrogates(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(i + 1 < text.length, "high surrogate must have a following code unit")
      const next = text.charCodeAt(i + 1)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "high surrogate must be followed by low surrogate")
      i += 1
      continue
    }
    assert.ok(code < 0xdc00 || code > 0xdfff, "low surrogate must follow a high surrogate")
  }
}

test("splitTelegramText keeps short lines and splits oversized lines", () => {
  const chunks = splitTelegramText(`short\n${"x".repeat(6)}`, 5)
  assert.deepEqual(chunks, ["short", "xxxxx", "x"])
})

test("splitTelegramText carries a short next line into a fresh chunk", () => {
  const chunks = splitTelegramText("aa\nbbb", 3)
  assert.deepEqual(chunks, ["aa", "bbb"])
})

test("splitTelegramText does not split surrogate pairs in oversized emoji lines", () => {
  const text = `${"😀".repeat(6)}\n${"x".repeat(3)}`
  const chunks = splitTelegramText(text, 5)

  assert.deepEqual(chunks, ["😀😀", "😀😀", "😀😀", "xxx"])
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 5)
    assertNoDanglingSurrogates(chunk)
  }
})

test("splitTelegramHtml avoids splitting tags and entities", () => {
  const chunks = splitTelegramHtml(`<b>ok</b>\n${"&lt;".repeat(10)}`, 17)

  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(""), `<b>ok</b>\n${"&lt;".repeat(10)}`)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 17)
    assert.doesNotMatch(chunk, /<[^>]*$/)
    assert.doesNotMatch(chunk, /&(?:l|lt)$/)
  }
})

test("splitTelegramHtml keeps chunks well-formed across open tags without splitting emoji", () => {
  const text = `<b>${"😀".repeat(10)}</b>`
  const chunks = splitTelegramHtml(text, 11)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 11)
    assert.match(chunk, /^<b>/)
    assert.match(chunk, /<\/b>$/)
    assertNoDanglingSurrogates(chunk)
  }
  assert.equal(chunks.map((chunk) => chunk.replace(/<\/?b>/g, "")).join(""), "😀".repeat(10))
})

test("TelegramClient call and callMultipart return Telegram results and surface API errors", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: calls.length !== 2,
      statusText: "Bad Request",
      json: async () => (calls.length === 2 ? { ok: false, description: "broken" } : { ok: true, result: { ok: true } }),
    }
  }

    try {
      const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
      const external = new AbortController()
      assert.deepEqual(await client.call("getMe", { probe: true }, { timeoutMs: 5, signal: external.signal }), { ok: true })

      const formData = new FormData()
      formData.set("probe", "1")
      await assert.rejects(async () => client.callMultipart("sendDocument", formData, { timeoutMs: 5 }), (err) => {
        assert.match(err.message, /sendDocument failed: broken/)
        assert.equal(err.isBoundaryError, true)
        assert.equal(err.source, "telegram")
        assert.equal(err.status, null)
        assert.equal(classifyBoundaryError(err).fatal, true)
        return true
      })

      assert.equal(calls[0].url, "https://api.example.test/bot/getMe")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers["content-type"], "application/json")
    assert.equal(calls[0].init.body, JSON.stringify({ probe: true }))
    assert.equal(typeof calls[0].init.signal.addEventListener, "function")
    assert.equal(calls[1].url, "https://api.example.test/bot/sendDocument")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient call keeps its timeout active through JSON body reads", { timeout: 1_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => makeJsonAbortResponse(init.signal)

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    await assert.rejects(async () => client.call("getMe", { probe: true }, { timeoutMs: 10 }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.method, "POST")
      assert.equal(err.pathname, "/getMe")
      assert.equal(classification.kind, "timeout")
      assert.equal(classification.retryable, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient callMultipart keeps its timeout active through JSON body reads", { timeout: 1_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => makeJsonAbortResponse(init.signal)

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    const formData = new FormData()
    formData.set("probe", "1")
    await assert.rejects(async () => client.callMultipart("sendDocument", formData, { timeoutMs: 10 }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.method, "POST")
      assert.equal(err.pathname, "/sendDocument")
      assert.equal(classification.kind, "timeout")
      assert.equal(classification.retryable, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient classifies rate limits as retryable boundary errors", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    json: async () => ({ ok: false, description: "rate limited", parameters: { retry_after: 3 } }),
  })

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    await assert.rejects(async () => client.call("sendMessage", { text: "hi" }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.status, 429)
      assert.equal(err.retryAfterMs, 3000)
      assert.equal(classification.retryable, true)
      assert.equal(classification.retryAfterMs, 3000)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient getUpdates forwards params and timeout metadata", async () => {
  const client = new TelegramClient("token")
  let captured = null
  client.call = async (method, params, options) => {
    captured = { method, params, options }
    return []
  }

  const signal = { name: "abort-signal" }
  await client.getUpdates({ offset: 10, timeout: 30, signal, allowed_updates: ["message"] })

  assert.deepEqual(captured, {
    method: "getUpdates",
    params: { offset: 10, timeout: 30, allowed_updates: ["message"] },
    options: { timeoutMs: 40_000, signal },
  })
})

test("TelegramClient getFile and downloadFile use Telegram file API", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/getFile")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, result: { file_path: "docs/a b.txt", file_size: 5 } }) }
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? "5" : null) },
      arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
    }
  }

  try {
    const client = new TelegramClient("token", {
      baseUrl: "https://api.example.test/bottoken",
      fileBaseUrl: "https://files.example.test/file/bottoken",
    })
    assert.deepEqual(await client.getFile("file_1"), { file_path: "docs/a b.txt", file_size: 5 })
    assert.equal(new TextDecoder().decode(await client.downloadFile("docs/a b.txt", { maxBytes: 10 })), "hello")
    assert.equal(calls[0].url, "https://api.example.test/bottoken/getFile")
    assert.equal(calls[1].url, "https://files.example.test/file/bottoken/docs/a%20b.txt")
    assert.equal(calls[1].init.method, "GET")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient downloadFile rejects oversized downloads", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "100" },
    arrayBuffer: async () => new ArrayBuffer(100),
  })

  try {
    const client = new TelegramClient("token", { fileBaseUrl: "https://files.example.test/file/bottoken" })
    await assert.rejects(async () => client.downloadFile("big.txt", { maxBytes: 10 }), /exceeds limit/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient downloadFile reads streaming bodies and cancels over-limit streams", async () => {
  const originalFetch = globalThis.fetch
  const enc = new TextEncoder()
  const cancellations = []
  let fetchCount = 0

  globalThis.fetch = async () => {
    fetchCount += 1
    const chunks = fetchCount === 1 ? [enc.encode("he"), enc.encode("llo")] : [enc.encode("abc"), enc.encode("def")]
    let index = 0
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true }
              return { done: false, value: chunks[index++] }
            },
            async cancel() {
              cancellations.push(fetchCount)
            },
          }
        },
      },
    }
  }

  try {
    const client = new TelegramClient("token", { fileBaseUrl: "https://files.example.test/file/bottoken" })
    assert.equal(new TextDecoder().decode(await client.downloadFile("stream.txt", { maxBytes: 10 })), "hello")
    await assert.rejects(async () => client.downloadFile("stream.txt", { maxBytes: 5 }), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.match(err.message, /exceeds limit: 6 bytes/)
      return true
    })
    assert.deepEqual(cancellations, [2])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient downloadFile rejects over-limit arrayBuffer bodies without content-length", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  })

  try {
    const client = new TelegramClient("token", { fileBaseUrl: "https://files.example.test/file/bottoken" })
    await assert.rejects(async () => client.downloadFile("big.txt", { maxBytes: 3 }), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.match(err.message, /exceeds limit: 4 bytes/)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient downloadFile rejects unsafe file paths", async () => {
  const client = new TelegramClient("token", { fileBaseUrl: "https://files.example.test/file/bottoken" })

  await assert.rejects(async () => client.downloadFile("../secret.txt"), /unsafe/i)
  await assert.rejects(async () => client.downloadFile("safe/../secret.txt"), /unsafe/i)
})

test("TelegramClient wrappers forward getMe, setMyCommands, and deleteMessage", async () => {
  const client = new TelegramClient("token")
  const calls = []
  client.call = async (method, params, options) => {
    calls.push({ method, params, options })
    return { ok: true }
  }

  await client.getMe()
  await client.setMyCommands([{ command: "start", description: "Start" }], {
    scope: { type: "all_private_chats" },
    language_code: "ru",
  })
  await client.deleteMessage(100, 200)

  assert.deepEqual(calls, [
    { method: "getMe", params: null, options: { timeoutMs: 15_000 } },
    {
      method: "setMyCommands",
      params: {
        commands: [{ command: "start", description: "Start" }],
        scope: { type: "all_private_chats" },
        language_code: "ru",
      },
      options: { timeoutMs: 15_000 },
    },
    { method: "deleteMessage", params: { chat_id: 100, message_id: 200 }, options: { timeoutMs: 20_000 } },
  ])
})

test("TelegramClient callMultipart returns Telegram results on success", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ ok: true, result: { uploaded: true } }),
  })

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    const formData = new FormData()
    formData.set("probe", "1")
    assert.deepEqual(await client.callMultipart("sendDocument", formData, { timeoutMs: 5 }), { uploaded: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient call and callMultipart surface unparsable API responses as Telegram failures", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async () => {
    callCount += 1
    const currentCall = callCount
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        if (currentCall === 1) return null
        throw new SyntaxError("unexpected token")
      },
    }
  }

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    await assert.rejects(async () => client.call("getMe", null, { timeoutMs: 5 }), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.pathname, "/getMe")
      assert.equal(err.status, 200)
      assert.equal(err.details, null)
      assert.match(err.message, /getMe failed: OK/)
      return true
    })

    const formData = new FormData()
    formData.set("probe", "1")
    await assert.rejects(async () => client.callMultipart("sendDocument", formData, { timeoutMs: 5 }), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.pathname, "/sendDocument")
      assert.equal(err.status, 200)
      assert.equal(err.details, null)
      assert.match(err.message, /sendDocument failed: OK/)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient wraps timeout aborts and multipart fetch failures as boundary errors", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async (_url, init) => {
    callCount += 1
    if (callCount === 1) {
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
      })
    }
    throw new Error("multipart down")
  }

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    await assert.rejects(async () => client.call("getMe", { probe: true }, { timeoutMs: 1 }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.pathname, "/getMe")
      assert.equal(classification.retryable, true)
      return true
    })

    const formData = new FormData()
    formData.set("probe", "1")
    await assert.rejects(async () => client.callMultipart("sendDocument", formData, { timeoutMs: 5 }), (err) => {
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.pathname, "/sendDocument")
      assert.match(err.message, /multipart down/)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient keeps its request timeout when an external abort signal is supplied", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) =>
    await new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
    })

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    const external = new AbortController()
    await assert.rejects(async () => client.call("getUpdates", { timeout: 30 }, { timeoutMs: 1, signal: external.signal }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.source, "telegram")
      assert.equal(err.pathname, "/getUpdates")
      assert.equal(classification.retryable, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("TelegramClient sendMessage splits long output and keeps reply markup on the last chunk", async () => {
  const client = new TelegramClient("token")
  const calls = []
  client.call = async (method, params) => {
    calls.push({ method, params })
    return { message_id: calls.length }
  }

  const replyMarkup = makeInlineKeyboard([[{ text: "Open", callback_data: "open" }]])
  const text = `${"a".repeat(3900)}${"b".repeat(20)}`
  const result = await client.sendMessage(100, text, replyMarkup, { parse_mode: "HTML", message_thread_id: 7 })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, "sendMessage")
  assert.equal(calls[0].params.chat_id, 100)
  assert.equal(calls[0].params.message_thread_id, 7)
  assert.equal(calls[0].params.reply_markup, undefined)
  assert.equal(calls[1].params.reply_markup, replyMarkup)
  assert.equal(calls[1].params.parse_mode, "HTML")
  assert.equal(result.message_id, 2)
})

test("TelegramClient sendHtmlBlocks, sendDocument, and edit helpers use the expected wrappers", async () => {
  const client = new TelegramClient("token")
  const sendCalls = []
  const multipartCalls = []
  const editCalls = []

  client.sendMessage = async (chatId, text, replyMarkup, options) => {
    sendCalls.push({ chatId, text, replyMarkup, options })
    return { message_id: sendCalls.length }
  }
  client.callMultipart = async (method, formData, options) => {
    multipartCalls.push({ method, formData, options })
    return { ok: true }
  }
  client.call = async (method, params) => {
    editCalls.push({ method, params })
    return { ok: true }
  }

  const replyMarkup = makeInlineKeyboard([[{ text: "Next", callback_data: "next" }]])
  await client.sendHtmlBlocks(
    100,
    [{ type: "text", html: "<b>first</b>" }, { type: "noop" }, { type: "text", html: "<b>second</b>" }],
    replyMarkup,
    { message_thread_id: 7 },
  )
  await client.sendDocument(100, "hello", "out.txt", "caption", { message_thread_id: 7 })
  await client.editMessageText(100, 200, "updated", replyMarkup, { parse_mode: "HTML", disable_web_page_preview: true })
  await client.editMessageReplyMarkup(100, 200, replyMarkup)
  await client.answerCallbackQuery("cb_1", "Done")

  assert.deepEqual(sendCalls, [
    {
      chatId: 100,
      text: "<b>first</b>",
      replyMarkup,
      options: { message_thread_id: 7, parse_mode: "HTML", disable_web_page_preview: true },
    },
    {
      chatId: 100,
      text: "<b>second</b>",
      replyMarkup: null,
      options: { message_thread_id: 7, parse_mode: "HTML", disable_web_page_preview: true },
    },
  ])
  assert.equal(multipartCalls[0].method, "sendDocument")
  assert.equal(multipartCalls[0].formData.get("chat_id"), "100")
  assert.equal(multipartCalls[0].formData.get("message_thread_id"), "7")
  assert.equal(multipartCalls[0].formData.get("caption"), "caption")
  assert.ok(multipartCalls[0].formData.get("document"))
  assert.deepEqual(editCalls, [
    {
      method: "editMessageText",
      params: {
        chat_id: 100,
        message_id: 200,
        text: "updated",
        reply_markup: replyMarkup,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
    },
    { method: "editMessageReplyMarkup", params: { chat_id: 100, message_id: 200, reply_markup: replyMarkup } },
    { method: "answerCallbackQuery", params: { callback_query_id: "cb_1", text: "Done" } },
  ])
})

test("TelegramClient editMessageText treats Telegram unchanged edits as no-ops", async () => {
  const client = new TelegramClient("token")
  const replyMarkup = makeInlineKeyboard([[{ text: "Refresh", callback_data: "s|refresh" }]])
  const calls = []

  client.call = async (method, params) => {
    calls.push({ method, params })
    throw makeBoundaryError({
      source: "telegram",
      operation: "POST editMessageText",
      method: "POST",
      pathname: "/editMessageText",
      status: 400,
      message: "editMessageText failed: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      details: { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    })
  }

  const result = await client.editMessageText(100, 200, "unchanged", replyMarkup)

  assert.equal(result, true)
  assert.deepEqual(calls, [
    {
      method: "editMessageText",
      params: {
        chat_id: 100,
        message_id: 200,
        text: "unchanged",
        reply_markup: replyMarkup,
      },
    },
  ])
})

test("TelegramClient reports send and edit delivery failures to observer", async () => {
  const failures = []
  const client = new TelegramClient("token", { onApiFailure: (entry) => failures.push(entry) })

  client.call = async (method, params) => {
    throw makeBoundaryError({
      source: "telegram",
      operation: `POST ${method}`,
      method: "POST",
      pathname: `/${method}`,
      status: 500,
      message: `${method} failed`,
      details: { params },
    })
  }

  await assert.rejects(() => client.sendMessage(100, "hello", null, { message_thread_id: 7 }))
  await assert.rejects(() => client.editMessageText(100, 200, "hello", null))

  assert.equal(failures.length, 2)
  assert.equal(failures[0].method, "sendMessage")
  assert.equal(failures[0].params.chat_id, 100)
  assert.equal(failures[0].params.message_thread_id, 7)
  assert.equal(failures[1].method, "editMessageText")
  assert.equal(failures[1].params.message_id, 200)
})

test("TelegramClient keeps original send and edit failures when observer throws", async () => {
  const warnings = []
  const client = new TelegramClient("token", {
    onApiFailure: () => {
      throw new Error("observer down")
    },
    logger: { warn: (...args) => warnings.push(args) },
  })

  client.call = async (method, params) => {
    throw makeBoundaryError({
      source: "telegram",
      operation: `POST ${method}`,
      method: "POST",
      pathname: `/${method}`,
      status: 502,
      message: `${method} original failure`,
      details: { params },
    })
  }

  await assert.rejects(() => client.sendMessage(100, "hello", null), /sendMessage original failure/)
  await assert.rejects(() => client.editMessageText(100, 200, "hello", null), /editMessageText original failure/)

  assert.equal(warnings.length, 2)
  assert.equal(warnings[0][0], "onApiFailure callback threw")
  assert.deepEqual(warnings[0][1], { error: "observer down" })
  assert.equal(warnings[1][0], "onApiFailure callback threw")
})

test("TelegramClient only applies remembered topic context when absent", () => {
  const client = new TelegramClient("token")
  const absent = { chat_id: 100, message_id: 200 }

  assert.equal(client.paramsWithRememberedMessageContext(absent), absent)

  client.rememberMessageContext({ message_id: 200 }, { chat_id: 100, message_thread_id: 7 })

  assert.deepEqual(client.paramsWithRememberedMessageContext({ chat_id: 100, message_id: 200 }), {
    chat_id: 100,
    message_id: 200,
    message_thread_id: 7,
  })

  const explicit = { chat_id: 100, message_id: 200, message_thread_id: 9 }
  assert.equal(client.paramsWithRememberedMessageContext(explicit), explicit)

  const unthreaded = { chat_id: 101, message_id: 201 }
  client.rememberMessageContext({ message_id: 201 }, { chat_id: 101 })
  assert.equal(client.paramsWithRememberedMessageContext(unthreaded), unthreaded)
})

test("TelegramClient reports edit failures with remembered topic context", async () => {
  const failures = []
  const calls = []
  const client = new TelegramClient("token", { onApiFailure: (entry) => failures.push(entry) })

  client.call = async (method, params) => {
    calls.push({ method, params })
    if (method === "sendMessage") return { message_id: 200 }
    throw makeBoundaryError({
      source: "telegram",
      operation: `POST ${method}`,
      method: "POST",
      pathname: `/${method}`,
      status: 500,
      message: `${method} failed`,
      details: { params },
    })
  }

  await client.sendMessage(100, "hello", null, { message_thread_id: 7 })
  await assert.rejects(() => client.editMessageText(100, 200, "updated", null))
  await assert.rejects(() => client.editMessageReplyMarkup(100, 200, null))

  assert.equal(calls[1].method, "editMessageText")
  assert.equal(calls[1].params.message_thread_id, undefined, "thread context must not be sent to Telegram edit APIs")
  assert.equal(failures.length, 2)
  assert.equal(failures[0].method, "editMessageText")
  assert.equal(failures[0].params.message_thread_id, 7)
  assert.equal(failures[1].method, "editMessageReplyMarkup")
  assert.equal(failures[1].params.message_thread_id, 7)
})
