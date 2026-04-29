import { setTimeout as delay } from "node:timers/promises"
import { boundaryErrorFromException, boundaryErrorFromHttpResponse, makeBoundaryError } from "../boundary-errors.js"

function makeTimeoutSignal(timeoutMs = 30_000) {
  if (!timeoutMs) return { signal: undefined, cancel: () => {} }
  const ctrl = new AbortController()
  let didTimeout = false
  const t = setTimeout(() => {
    didTimeout = true
    ctrl.abort()
  }, timeoutMs)
  return { signal: ctrl.signal, cancel: () => clearTimeout(t), didTimeout: () => didTimeout }
}

function isAbortSignal(value) {
  return !!value && typeof value === "object" && typeof value.addEventListener === "function" && "aborted" in value
}

function combineSignals(...signals) {
  const active = signals.filter(isAbortSignal)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal?.any === "function") return AbortSignal.any(active)

  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  for (const signal of active) {
    if (signal.aborted) {
      ctrl.abort()
      break
    }
    signal.addEventListener("abort", abort, { once: true })
  }
  return ctrl.signal
}

async function readTelegramApiJsonResponse(res, { requestSignal, timeout, ...context }) {
  try {
    return await res.json()
  } catch (err) {
    if (err?.name === "AbortError" || requestSignal?.aborted === true || timeout.didTimeout?.() === true) {
      throw boundaryErrorFromException(err, {
        ...context,
        didTimeout: timeout.didTimeout?.() === true,
      })
    }
    return null
  }
}

function telegramRetryAfterMs(json) {
  const seconds = Number(json?.parameters?.retry_after)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(Math.ceil(seconds * 1000), 60 * 60 * 1000)
}

export function splitTelegramText(text, maxLen = 3900) {
  const s = String(text ?? "")
  if (s.length <= maxLen) return [s]

  const nextWholeCharacterIndex = (value, index) => {
    const first = value.charCodeAt(index)
    if (Number.isNaN(first)) return index + 1
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) return index + 2
    }
    return index + 1
  }

  const splitOversizedChunk = (value) => {
    const pieces = []
    let current = ""
    for (let i = 0; i < value.length;) {
      const next = nextWholeCharacterIndex(value, i)
      const token = value.slice(i, next)
      if (current && current.length + token.length > maxLen) {
        pieces.push(current)
        current = ""
      }
      if (!current && token.length > maxLen) {
        pieces.push(token)
      } else {
        current += token
      }
      i = next
    }
    if (current) pieces.push(current)
    return pieces
  }

  const lines = s.split("\n")
  const chunks = []
  let current = ""
  for (const line of lines) {
    const add = (current ? "\n" : "") + line
    if ((current + add).length <= maxLen) {
      current += add
      continue
    }
    if (current) {
      chunks.push(current)
      current = ""
    }
    if (line.length > maxLen) {
      for (const piece of splitOversizedChunk(line)) chunks.push(piece)
    } else {
      current = line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function splitTelegramHtml(text, maxLen = 3900) {
  const s = String(text ?? "")
  if (s.length <= maxLen) return [s]
  const chunks = []
  let current = ""
  const tagStack = []

  const tagNameOf = (token) => {
    const match = String(token).match(/^<\/?([a-z0-9-]+)/i)
    return match ? match[1].toLowerCase() : ""
  }
  const closingTags = () => tagStack.slice().reverse().map((entry) => `</${entry.name}>`).join("")
  const openingTags = () => tagStack.map((entry) => entry.open).join("")

  const flush = () => {
    if (!current) return
    chunks.push(current + closingTags())
    current = openingTags()
  }

  const ensureRoom = (token) => {
    const closeSuffix = closingTags()
    if (current && current.length + token.length + closeSuffix.length > maxLen) flush()
  }

  const readToken = (index) => {
    const ch = s[index]
    if (ch === "<") {
      const end = s.indexOf(">", index + 1)
      if (end !== -1) return { token: s.slice(index, end + 1), next: end + 1 }
    }
    if (ch === "&") {
      const end = s.indexOf(";", index + 1)
      if (end !== -1 && end - index <= 16) return { token: s.slice(index, end + 1), next: end + 1 }
    }

    const first = s.charCodeAt(index)
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < s.length) {
      const second = s.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        return { token: s.slice(index, index + 2), next: index + 2 }
      }
    }
    return { token: ch, next: index + 1 }
  }

  for (let i = 0; i < s.length;) {
    const { token, next } = readToken(i)
    const isTag = token.startsWith("<") && token.endsWith(">")
    const isClosingTag = isTag && /^<\//.test(token)
    const isOpeningTag = isTag && !isClosingTag && !/^<!/.test(token) && !/\/>$/.test(token)
    ensureRoom(token)
    if (token.length > maxLen) {
      for (const chunk of splitTelegramText(token, maxLen)) chunks.push(chunk)
    } else {
      current += token
      if (isClosingTag) {
        const name = tagNameOf(token)
        const idx = name ? tagStack.map((entry) => entry.name).lastIndexOf(name) : -1
        if (idx !== -1) tagStack.splice(idx, 1)
      } else if (isOpeningTag) {
        const name = tagNameOf(token)
        if (name) tagStack.push({ name, open: token })
      }
    }
    i = next
  }
  if (current) chunks.push(current + closingTags())
  return chunks
}

function isMessageNotModifiedError(err) {
  const description = [err?.message, err?.details?.description]
    .filter((value) => typeof value === "string" && value)
    .join(" ")
  return /message is not modified/i.test(description)
}

const MESSAGE_CONTEXT_LIMIT = 2000

function messageContextKey(chatId, messageId) {
  const chat = String(chatId ?? "").trim()
  const message = String(messageId ?? "").trim()
  return chat && message ? `${chat}:${message}` : ""
}

export class TelegramClient {
  constructor(token, { baseUrl, fileBaseUrl, onApiFailure, logger } = {}) {
    this.token = token
    this.baseUrl = baseUrl || `https://api.telegram.org/bot${token}`
    this.fileBaseUrl = fileBaseUrl || deriveTelegramFileBaseUrl(this.baseUrl, token)
    this.onApiFailure = typeof onApiFailure === "function" ? onApiFailure : null
    this._logger = logger || null
    this._messageContexts = new Map()
  }

  /**
   * Observability contract:
   * 1) Recordable outbound-delivery API failures:
   *    `sendMessage`, `sendDocument`, `editMessageText`, `editMessageReplyMarkup`.
   *    These are the only Telegram API failures reflected in `/runtime` counters.
   *
   * 2) Non-recorded methods on purpose:
   *    polling/control and cleanup helpers (`getMe`, `getUpdates`, `getFile`,
   *    `downloadFile`, `setMyCommands`, `deleteMessage`, `answerCallbackQuery`) and
   *    transport primitives (`call`, `callMultipart`) do not call `onApiFailure`.
   *    Their callers own retry/ignore handling, and we keep failure counters focused
   *    on user-visible send/edit delivery health only.
   */
  recordApiFailure(method, params, err) {
    if (!this.onApiFailure) return
    try {
      this.onApiFailure({ method, params, err })
    } catch (observabilityErr) {
      // Observability must never change Telegram API behavior.
      this._logger?.warn("onApiFailure callback threw", { error: observabilityErr?.message })
    }
  }

  rememberMessageContext(message, params) {
    const key = messageContextKey(params?.chat_id, message?.message_id)
    if (!key) return
    if (this._messageContexts.has(key)) this._messageContexts.delete(key)
    this._messageContexts.set(key, {
      chat_id: params.chat_id,
      ...(params.message_thread_id ? { message_thread_id: params.message_thread_id } : {}),
    })
    while (this._messageContexts.size > MESSAGE_CONTEXT_LIMIT) {
      const oldest = this._messageContexts.keys().next().value
      this._messageContexts.delete(oldest)
    }
  }

  paramsWithRememberedMessageContext(params) {
    const context = this._messageContexts.get(messageContextKey(params?.chat_id, params?.message_id))
    if (!context?.message_thread_id || params?.message_thread_id) return params
    return { ...params, message_thread_id: context.message_thread_id }
  }

  async call(method, params, { timeoutMs, signal } = {}) {
    const url = `${this.baseUrl}/${method}`
    const timeout = makeTimeoutSignal(timeoutMs)
    const context = {
      source: "telegram",
      operation: `POST ${method}`,
      method: "POST",
      pathname: `/${method}`,
    }
    let res
    let json
    try {
      const requestSignal = combineSignals(signal, timeout.signal)
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: requestSignal,
        body: params ? JSON.stringify(params) : "{}",
      })
      json = await readTelegramApiJsonResponse(res, { ...context, requestSignal, timeout })
    } catch (err) {
      throw boundaryErrorFromException(err, { ...context, didTimeout: timeout.didTimeout?.() === true })
    } finally {
      timeout.cancel()
    }
    if (!res.ok || !json || json.ok !== true) {
      const msg = json?.description || res.statusText || "Telegram API error"
      throw boundaryErrorFromHttpResponse({
        ...context,
        status: res.status,
        statusText: res.statusText,
        bodyText: msg,
        details: json,
        retryAfterMs: telegramRetryAfterMs(json),
        message: `${method} failed: ${msg}`,
      })
    }
    return json.result
  }

  async callMultipart(method, formData, { timeoutMs, signal } = {}) {
    const url = `${this.baseUrl}/${method}`
    const timeout = makeTimeoutSignal(timeoutMs)
    const context = {
      source: "telegram",
      operation: `POST ${method}`,
      method: "POST",
      pathname: `/${method}`,
    }
    let res
    let json
    try {
      const requestSignal = combineSignals(signal, timeout.signal)
      res = await fetch(url, {
        method: "POST",
        body: formData,
        signal: requestSignal,
      })
      json = await readTelegramApiJsonResponse(res, { ...context, requestSignal, timeout })
    } catch (err) {
      throw boundaryErrorFromException(err, { ...context, didTimeout: timeout.didTimeout?.() === true })
    } finally {
      timeout.cancel()
    }
    if (!res.ok || !json || json.ok !== true) {
      const msg = json?.description || res.statusText || "Telegram API error"
      throw boundaryErrorFromHttpResponse({
        ...context,
        status: res.status,
        statusText: res.statusText,
        bodyText: msg,
        details: json,
        retryAfterMs: telegramRetryAfterMs(json),
        message: `${method} failed: ${msg}`,
      })
    }
    return json.result
  }

  getMe() {
    return this.call("getMe", null, { timeoutMs: 15_000 })
  }

  getUpdates(input) {
    const { signal, ...params } = input || {}
    const timeoutSec = typeof params?.timeout === "number" ? params.timeout : 0
    const timeoutMs = Math.max(10_000, (timeoutSec + 10) * 1000)
    return this.call("getUpdates", params, { timeoutMs, signal })
  }

  getFile(fileId) {
    return this.call("getFile", { file_id: fileId }, { timeoutMs: 20_000 })
  }

  async downloadFile(filePath, { timeoutMs = 60_000, maxBytes, signal } = {}) {
    const cleanPath = String(filePath || "").replace(/^\/+/, "")
    if (!cleanPath) {
      throw makeBoundaryError({
        source: "telegram",
        operation: "GET file",
        method: "GET",
        pathname: "/file",
        message: "Telegram file path is empty",
      })
    }
    const pathParts = cleanPath.split("/")
    if (pathParts.some((part) => !part || part === "." || part === "..")) {
      throw makeBoundaryError({
        source: "telegram",
        operation: "GET file",
        method: "GET",
        pathname: "/file",
        message: "Telegram file path is unsafe",
      })
    }
    const encodedPath = pathParts.map((part) => encodeURIComponent(part)).join("/")
    const url = `${this.fileBaseUrl.replace(/\/+$/, "")}/${encodedPath}`
    const timeout = makeTimeoutSignal(timeoutMs)
    let res
    try {
      const requestSignal = combineSignals(signal, timeout.signal)
      res = await fetch(url, { method: "GET", signal: requestSignal })
    } catch (err) {
      timeout.cancel()
      throw boundaryErrorFromException(err, {
        source: "telegram",
        operation: "GET file",
        method: "GET",
        pathname: `/file/${cleanPath}`,
        didTimeout: timeout.didTimeout?.() === true,
      })
    }

    try {
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "")
        throw boundaryErrorFromHttpResponse({
          source: "telegram",
          operation: "GET file",
          method: "GET",
          pathname: `/file/${cleanPath}`,
          status: res.status,
          statusText: res.statusText,
          bodyText,
          message: `Telegram file download failed: ${res.status} ${bodyText || res.statusText || "Request failed"}`,
        })
      }

      const declaredLength = Number(res.headers?.get?.("content-length"))
      if (Number.isFinite(declaredLength) && Number.isFinite(Number(maxBytes)) && declaredLength > Number(maxBytes)) {
        throw makeBoundaryError({
          source: "telegram",
          operation: "GET file",
          method: "GET",
          pathname: `/file/${cleanPath}`,
          message: `Telegram file download exceeds limit: ${declaredLength} bytes`,
        })
      }

      if (!res.body?.getReader) {
        const buffer = new Uint8Array(await res.arrayBuffer())
        if (Number.isFinite(Number(maxBytes)) && buffer.byteLength > Number(maxBytes)) {
          throw makeBoundaryError({
            source: "telegram",
            operation: "GET file",
            method: "GET",
            pathname: `/file/${cleanPath}`,
            message: `Telegram file download exceeds limit: ${buffer.byteLength} bytes`,
          })
        }
        return buffer
      }

      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
          total += chunk.byteLength
          if (Number.isFinite(Number(maxBytes)) && total > Number(maxBytes)) {
            await reader.cancel().catch(() => {})
            throw makeBoundaryError({
              source: "telegram",
              operation: "GET file",
              method: "GET",
              pathname: `/file/${cleanPath}`,
              message: `Telegram file download exceeds limit: ${total} bytes`,
            })
          }
          chunks.push(chunk)
        }
      } catch (err) {
        if (err?.isBoundaryError === true) throw err
        throw boundaryErrorFromException(err, {
          source: "telegram",
          operation: "GET file",
          method: "GET",
          pathname: `/file/${cleanPath}`,
          didTimeout: timeout.didTimeout?.() === true,
        })
      }

      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    } finally {
      timeout.cancel()
    }
  }

  setMyCommands(commands, options = {}) {
    return this.call(
      "setMyCommands",
      {
        commands,
        ...(options?.scope ? { scope: options.scope } : {}),
        ...(options?.language_code ? { language_code: options.language_code } : {}),
      },
      { timeoutMs: 15_000 },
    )
  }

  async sendMessage(chatId, text, replyMarkup, options = {}) {
    const chunks = options.parse_mode === "HTML" ? splitTelegramHtml(text) : splitTelegramText(text)
    let last = null
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const markup = i === chunks.length - 1 ? replyMarkup : null
      const params = {
        chat_id: chatId,
        text: chunk,
        ...(options.message_thread_id ? { message_thread_id: options.message_thread_id } : {}),
        ...(markup ? { reply_markup: markup } : {}),
        ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
        ...(options.disable_web_page_preview != null
          ? { disable_web_page_preview: options.disable_web_page_preview }
          : {}),
      }
      try {
        last = await this.call("sendMessage", params, { timeoutMs: 20_000 })
        this.rememberMessageContext(last, params)
      } catch (err) {
        this.recordApiFailure("sendMessage", params, err)
        throw err
      }
      // be nice to Telegram
      await delay(60)
    }
    return last
  }

  async sendHtmlBlocks(chatId, blocks, replyMarkup, options = {}) {
    let last = null
    for (const b of blocks || []) {
      if (!b || b.type !== "text") continue
      last = await this.sendMessage(chatId, b.html, replyMarkup, {
        ...options,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
      replyMarkup = null
    }
    return last
  }

  sendDocument(chatId, contents, filename, caption, options = {}) {
    const formData = new FormData()
    formData.set("chat_id", String(chatId))
    if (options.message_thread_id) formData.set("message_thread_id", String(options.message_thread_id))
    if (caption) formData.set("caption", String(caption))
    formData.set("document", new Blob([contents], { type: "text/plain;charset=utf-8" }), filename || "output.txt")
    return this.callMultipart("sendDocument", formData, { timeoutMs: 60_000 }).catch((err) => {
      this.recordApiFailure("sendDocument", formData, err)
      throw err
    })
  }

  editMessageText(chatId, messageId, text, replyMarkup, options = {}) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
      ...(options.disable_web_page_preview != null ? { disable_web_page_preview: options.disable_web_page_preview } : {}),
    }
    return this.call("editMessageText", params, { timeoutMs: 20_000 }).catch((err) => {
      if (isMessageNotModifiedError(err)) return true
      this.recordApiFailure("editMessageText", this.paramsWithRememberedMessageContext(params), err)
      throw err
    })
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    const params = { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }
    return this.call("editMessageReplyMarkup", params, { timeoutMs: 20_000 }).catch((err) => {
      this.recordApiFailure("editMessageReplyMarkup", this.paramsWithRememberedMessageContext(params), err)
      throw err
    })
  }

  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, { timeoutMs: 20_000 })
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call(
      "answerCallbackQuery",
      { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
      { timeoutMs: 10_000 },
    )
  }
}

function deriveTelegramFileBaseUrl(baseUrl, token) {
  try {
    const url = new URL(baseUrl)
    const marker = `/bot${token}`
    if (url.pathname.endsWith(marker)) {
      url.pathname = `${url.pathname.slice(0, -marker.length)}/file/bot${token}`
      return url.toString().replace(/\/+$/, "")
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/file/bot${token}`
    return url.toString().replace(/\/+$/, "")
  } catch {
    return `https://api.telegram.org/file/bot${token}`
  }
}

export function makeInlineKeyboard(rows) {
  return { inline_keyboard: rows }
}
