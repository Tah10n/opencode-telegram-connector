import test from "node:test"
import assert from "node:assert/strict"
import { TelegramClient, makeInlineKeyboard, splitTelegramHtml, splitTelegramText } from "../src/telegram/client.js"
import { classifyBoundaryError } from "../src/boundary-errors.js"

test("splitTelegramText keeps short lines and splits oversized lines", () => {
  const chunks = splitTelegramText(`short\n${"x".repeat(6)}`, 5)
  assert.deepEqual(chunks, ["short", "xxxxx", "x"])
})

test("splitTelegramText carries a short next line into a fresh chunk", () => {
  const chunks = splitTelegramText("aa\nbbb", 3)
  assert.deepEqual(chunks, ["aa", "bbb"])
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

test("splitTelegramHtml keeps chunks well-formed across open tags", () => {
  const chunks = splitTelegramHtml(`<b>${"a".repeat(20)}</b>`, 12)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 12)
    assert.match(chunk, /^<b>/)
    assert.match(chunk, /<\/b>$/)
  }
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

test("TelegramClient classifies rate limits as retryable boundary errors", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    json: async () => ({ ok: false, description: "rate limited" }),
  })

  try {
    const client = new TelegramClient("token", { baseUrl: "https://api.example.test/bot" })
    await assert.rejects(async () => client.call("sendMessage", { text: "hi" }), (err) => {
      const classification = classifyBoundaryError(err)
      assert.equal(err.isBoundaryError, true)
      assert.equal(err.status, 429)
      assert.equal(classification.retryable, true)
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
