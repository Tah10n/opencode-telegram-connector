import { setTimeout as delay } from "node:timers/promises"
import { boundaryErrorFromException, boundaryErrorFromHttpResponse } from "../boundary-errors.js"

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

export function splitTelegramText(text, maxLen = 3900) {
  const s = String(text ?? "")
  if (s.length <= maxLen) return [s]
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
      for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen))
    } else {
      current = line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export class TelegramClient {
  constructor(token, { baseUrl } = {}) {
    this.token = token
    this.baseUrl = baseUrl || `https://api.telegram.org/bot${token}`
  }

  async call(method, params, { timeoutMs, signal } = {}) {
    const url = `${this.baseUrl}/${method}`
    const timeout = makeTimeoutSignal(timeoutMs)
    let res
    try {
      const requestSignal = combineSignals(signal, timeout.signal)
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: requestSignal,
        body: params ? JSON.stringify(params) : "{}",
      })
    } catch (err) {
      throw boundaryErrorFromException(err, {
        source: "telegram",
        operation: `POST ${method}`,
        method: "POST",
        pathname: `/${method}`,
        didTimeout: timeout.didTimeout?.() === true,
      })
    } finally {
      timeout.cancel()
    }
    const json = await res.json().catch(() => null)
    if (!res.ok || !json || json.ok !== true) {
      const msg = json?.description || res.statusText || "Telegram API error"
      throw boundaryErrorFromHttpResponse({
        source: "telegram",
        operation: `POST ${method}`,
        method: "POST",
        pathname: `/${method}`,
        status: res.status,
        statusText: res.statusText,
        bodyText: msg,
        details: json,
        message: `${method} failed: ${msg}`,
      })
    }
    return json.result
  }

  async callMultipart(method, formData, { timeoutMs, signal } = {}) {
    const url = `${this.baseUrl}/${method}`
    const timeout = makeTimeoutSignal(timeoutMs)
    let res
    try {
      const requestSignal = combineSignals(signal, timeout.signal)
      res = await fetch(url, {
        method: "POST",
        body: formData,
        signal: requestSignal,
      })
    } catch (err) {
      throw boundaryErrorFromException(err, {
        source: "telegram",
        operation: `POST ${method}`,
        method: "POST",
        pathname: `/${method}`,
        didTimeout: timeout.didTimeout?.() === true,
      })
    } finally {
      timeout.cancel()
    }
    const json = await res.json().catch(() => null)
    if (!res.ok || !json || json.ok !== true) {
      const msg = json?.description || res.statusText || "Telegram API error"
      throw boundaryErrorFromHttpResponse({
        source: "telegram",
        operation: `POST ${method}`,
        method: "POST",
        pathname: `/${method}`,
        status: res.status,
        statusText: res.statusText,
        bodyText: msg,
        details: json,
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
    const chunks = splitTelegramText(text)
    let last = null
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const markup = i === chunks.length - 1 ? replyMarkup : null
      last = await this.call(
        "sendMessage",
        {
          chat_id: chatId,
          text: chunk,
          ...(options.message_thread_id ? { message_thread_id: options.message_thread_id } : {}),
          ...(markup ? { reply_markup: markup } : {}),
          ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
          ...(options.disable_web_page_preview != null
            ? { disable_web_page_preview: options.disable_web_page_preview }
            : {}),
        },
        { timeoutMs: 20_000 },
      )
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
    return this.callMultipart("sendDocument", formData, { timeoutMs: 60_000 })
  }

  editMessageText(chatId, messageId, text, replyMarkup, options = {}) {
    return this.call(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
        ...(options.disable_web_page_preview != null ? { disable_web_page_preview: options.disable_web_page_preview } : {}),
      },
      { timeoutMs: 20_000 },
    )
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call(
      "editMessageReplyMarkup",
      { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
      { timeoutMs: 20_000 },
    )
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

export function makeInlineKeyboard(rows) {
  return { inline_keyboard: rows }
}
