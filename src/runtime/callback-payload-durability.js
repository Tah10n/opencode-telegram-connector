import { makeBoundaryError } from "../boundary-errors.js"

const REPLY_MARKUP_ARG_BY_METHOD = {
  sendMessage: 2,
  sendHtmlBlocks: 2,
  editMessageText: 3,
  editMessageReplyMarkup: 2,
}

export function replyMarkupHasPackedCallbackPayload(value, seen = new Set()) {
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)

  if (typeof value.callback_data === "string" && value.callback_data.startsWith("cb|")) return true
  if (Array.isArray(value)) return value.some((entry) => replyMarkupHasPackedCallbackPayload(entry, seen))
  return Object.values(value).some((entry) => replyMarkupHasPackedCallbackPayload(entry, seen))
}

export async function flushPackedCallbackPayloadsForReplyMarkup(replyMarkup, { store, operation } = {}) {
  if (!replyMarkupHasPackedCallbackPayload(replyMarkup)) return false
  if (typeof store?.flush !== "function") return false
  const op = operation || "persist callback payloads before Telegram delivery"
  try {
    await store.flush()
    return true
  } catch (err) {
    throw makeBoundaryError({
      source: "state",
      operation: op,
      kind: "durability",
      outcome: "retryable",
      message: `${op} failed: ${err?.message || String(err)}`,
      cause: err,
    })
  }
}

export function wrapTelegramClientWithCallbackPayloadFlush(tg, { store } = {}) {
  if (!tg || typeof tg !== "object") return tg
  return new Proxy(tg, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      if (!Object.prototype.hasOwnProperty.call(REPLY_MARKUP_ARG_BY_METHOD, prop)) {
        return value.bind(target)
      }

      return async (...args) => {
        await flushPackedCallbackPayloadsForReplyMarkup(args[REPLY_MARKUP_ARG_BY_METHOD[prop]], {
          store,
          operation: `persist callback payloads before Telegram ${String(prop)}`,
        })
        return value.apply(target, args)
      }
    },
  })
}
