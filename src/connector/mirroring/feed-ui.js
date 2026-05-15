import { t as translate } from "../../i18n/index.js"
import { DEFAULT_FEED_MODE, normalizeFeedMode } from "../../state/store.js"
import { makeInlineKeyboard } from "../../telegram/client.js"

export function createFeedUi({ store, config, tg, sendToThread, packCallback } = {}) {
  function getFeedMode(ctxKey) {
    return store.getFeedMode?.(ctxKey) || DEFAULT_FEED_MODE
  }

  function feedModeLabel(mode, locale = "en") {
    const normalized = normalizeFeedMode(mode)
    if (normalized === "main") return translate(locale, "feed.main")
    if (normalized === "verbose") return translate(locale, "feed.verbose")
    return translate(locale, "feed.mainChanges")
  }

  function shouldMirrorToFeed(ctxKey, kind) {
    const mode = getFeedMode(ctxKey)
    if (kind === "internal") return false
    if (mode === "main") return kind === "assistant-final"
    if (mode === "main+changes") return kind === "assistant-final" || kind === "changed-files"
    return kind === "assistant-final" || kind === "assistant-stream" || kind === "changed-files" || kind === "agent-action"
  }

  function renderFeedSettingsText(ctxKey, locale = "en") {
    const mode = getFeedMode(ctxKey)
    return [
      translate(locale, "feed.title", { mode: feedModeLabel(mode, locale) }),
      "",
      translate(locale, "feed.mainDescription"),
      translate(locale, "feed.mainChangesDescription"),
      translate(locale, "feed.verboseDescription"),
      translate(locale, "feed.tuiMirror"),
      "",
      translate(locale, "feed.compactionHidden"),
    ].join("\n")
  }

  function feedKeyboard(ctxKey, locale = "en") {
    const current = getFeedMode(ctxKey)
    const button = (mode, label) => ({ text: `${current === mode ? "✓ " : ""}${label}`, callback_data: packCallback("feed", mode) })
    return makeInlineKeyboard([
      [button("main", feedModeLabel("main", locale))],
      [button("main+changes", feedModeLabel("main+changes", locale))],
      [button("verbose", feedModeLabel("verbose", locale))],
      [{ text: translate(locale, "common.close"), callback_data: packCallback("feed", "close") }],
    ])
  }

  async function renderFeedSettings(ctxMeta, { editMessageId, noticeText = "" } = {}) {
    const locale = ctxMeta?.locale || config?.i18n?.defaultLocale || "en"
    const settingsText = renderFeedSettingsText(ctxMeta.ctxKey, locale)
    const text = noticeText ? `${noticeText}\n\n${settingsText}` : settingsText
    const replyMarkup = feedKeyboard(ctxMeta.ctxKey, locale)
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  return {
    getFeedMode,
    feedModeLabel,
    shouldMirrorToFeed,
    renderFeedSettingsText,
    feedKeyboard,
    renderFeedSettings,
  }
}
