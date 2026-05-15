import { normalizeBoundaryError } from "../boundary-errors.js"
import { ctxKeyFrom, threadIdOr0FromMessage } from "../telegram/routing.js"
import { matchSupportedLocale, normalizeLocale, t } from "../i18n/index.js"
import { createCorrelationId, runWithRequestContext, withRequestContextFields } from "./request-context.js"

export function createTelegramContextTools({ config, store, tg } = {}) {
  function detectedLocaleFromTelegram(from) {
    if (config.i18n?.autoDetectTelegramLanguage === false) return ""
    return matchSupportedLocale(from?.language_code, config.i18n?.supportedLocales)
  }

  function effectiveLocaleForContext(ctxKey, detectedLocale = "") {
    const storedRecord = store.getLocaleRecord?.(ctxKey)
    if (storedRecord?.locale && (storedRecord.source === "manual" || config.i18n?.autoDetectTelegramLanguage !== false)) {
      return normalizeLocale(storedRecord.locale, config.i18n)
    }
    if (detectedLocale) return normalizeLocale(detectedLocale, config.i18n)
    return config.i18n?.defaultLocale || "en"
  }

  function ctxMetaWithLocale(ctxMeta) {
    if (!ctxMeta) return ctxMeta
    const chatId = ctxMeta.chatId
    const threadIdOr0 = ctxMeta.threadIdOr0 || 0
    const ctxKey = ctxMeta.ctxKey || ctxKeyFrom(chatId, threadIdOr0)
    return {
      ...ctxMeta,
      threadIdOr0,
      ctxKey,
      locale: effectiveLocaleForContext(ctxKey, ctxMeta.detectedLocale || ctxMeta.locale),
    }
  }

  function rememberTelegramLocale(ctxMeta) {
    if (!ctxMeta?.ctxKey || !ctxMeta.detectedLocale) return ctxMetaWithLocale(ctxMeta)
    store.noteTelegramLocale?.(ctxMeta.ctxKey, ctxMeta.detectedLocale)
    return ctxMetaWithLocale(ctxMeta)
  }

  function localize(ctxMetaOrLocale, key, params) {
    const locale = typeof ctxMetaOrLocale === "string" ? ctxMetaOrLocale : ctxMetaWithLocale(ctxMetaOrLocale)?.locale
    return t(locale || config.i18n?.defaultLocale || "en", key, params)
  }

  function ctxMetaFromMessage(msg, from = msg?.from) {
    const chatId = msg?.chat?.id
    const chatType = msg?.chat?.type
    const threadIdOr0 = threadIdOr0FromMessage(msg)
    const ctxKey = ctxKeyFrom(chatId, threadIdOr0)
    const detectedLocale = detectedLocaleFromTelegram(from || msg?.from)
    return ctxMetaWithLocale({ chatId, chatType, threadIdOr0, ctxKey, detectedLocale })
  }

  function requestContextForCtxMeta(ctxMeta, binding) {
    if (!ctxMeta) return {}
    return {
      chatId: ctxMeta.chatId,
      chatType: ctxMeta.chatType,
      threadIdOr0: ctxMeta.threadIdOr0,
      ctxKey: ctxMeta.ctxKey,
      ...(ctxMeta.locale ? { locale: ctxMeta.locale } : {}),
      ...(binding?.projectAlias ? { projectAlias: binding.projectAlias } : {}),
      ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
    }
  }

  function telegramUpdateContext(update) {
    const eventType = update?.message ? "message" : update?.callback_query ? "callback" : "unknown"
    const msg = update?.message || update?.callback_query?.message || null
    const from = update?.message?.from || update?.callback_query?.from || null
    const ctxMeta = msg ? ctxMetaFromMessage(msg, from) : null
    const binding = ctxMeta?.ctxKey ? store.getBinding(ctxMeta.ctxKey) : null
    return {
      correlationId: createCorrelationId("tg", [update?.update_id, eventType]),
      source: "telegram",
      operation: eventType,
      updateId: update?.update_id,
      eventType,
      ...requestContextForCtxMeta(ctxMeta, binding),
    }
  }

  function runTelegramUpdateContext(update, fn) {
    return runWithRequestContext(telegramUpdateContext(update), fn)
  }

  function isAllowedUser(from) {
    const allowedUserId = config.telegram.allowedUserId
    return from && typeof from.id === "number" && from.id === allowedUserId
  }

  async function sendToThread(ctxMeta, text, replyMarkup, options = {}) {
    ctxMeta = ctxMetaWithLocale(ctxMeta)
    if (!ctxMeta?.chatId) return
    return withRequestContextFields(requestContextForCtxMeta(ctxMeta, store.getBinding(ctxMeta.ctxKey)), async () => {
      try {
        await tg.sendMessage(ctxMeta.chatId, text, replyMarkup, {
          ...options,
          message_thread_id: ctxMeta.threadIdOr0 || undefined,
        })
      } catch (err) {
        throw normalizeBoundaryError(err, {
          source: "telegram",
          operation: "sendMessage",
          method: "POST",
          pathname: "/sendMessage",
          ...(err?.isBoundaryError === true ? {} : { outcome: "retryable" }),
        })
      }
    })
  }

  async function sendBlocksToThread(ctxMeta, blocks, replyMarkup) {
    ctxMeta = ctxMetaWithLocale(ctxMeta)
    if (!ctxMeta?.chatId) return
    return withRequestContextFields(requestContextForCtxMeta(ctxMeta, store.getBinding(ctxMeta.ctxKey)), async () => {
      try {
        await tg.sendHtmlBlocks(ctxMeta.chatId, blocks, replyMarkup, {
          message_thread_id: ctxMeta.threadIdOr0 || undefined,
        })
      } catch (err) {
        throw normalizeBoundaryError(err, {
          source: "telegram",
          operation: "sendHtmlBlocks",
          method: "POST",
          pathname: "/sendMessage",
          ...(err?.isBoundaryError === true ? {} : { outcome: "retryable" }),
        })
      }
    })
  }

  function parseCtxKey(key) {
    const m = String(key).match(/^(-?\d+):(\d+)$/)
    if (!m) return null
    return { chatId: Number(m[1]), threadIdOr0: Number(m[2]), ctxKey: key }
  }

  function formatThreadLabel(threadIdOr0) {
    return threadIdOr0 ? `topic ${threadIdOr0}` : "main"
  }

  return {
    ctxMetaWithLocale,
    rememberTelegramLocale,
    localize,
    ctxMetaFromMessage,
    requestContextForCtxMeta,
    runTelegramUpdateContext,
    isAllowedUser,
    sendToThread,
    sendBlocksToThread,
    parseCtxKey,
    formatThreadLabel,
  }
}
