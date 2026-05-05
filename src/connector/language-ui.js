import { makeInlineKeyboard } from "../telegram/client.js"
import { localeDisplayName, matchSupportedLocale, t as translate } from "../i18n/index.js"

function localeFromContext(ctxMeta, { store, config } = {}) {
  const defaultLocale = config?.i18n?.defaultLocale || "en"
  const record = activeLocaleRecord(ctxMeta, { store, config })
  return record?.locale || ctxMeta?.locale || defaultLocale
}

function activeLocaleRecord(ctxMeta, { store, config } = {}) {
  const record = store?.getLocaleRecord?.(ctxMeta?.ctxKey)
  if (record?.source === "telegram" && config?.i18n?.autoDetectTelegramLanguage === false) return null
  const locale = matchSupportedLocale(record?.locale, config?.i18n?.supportedLocales)
  return locale ? { ...record, locale } : null
}

function sourceKey(record) {
  if (record?.source === "manual") return "language.sourceManual"
  if (record?.source === "telegram") return "language.sourceTelegram"
  return "language.sourceDefault"
}

export function supportedLocaleSummary({ config, displayLocale } = {}) {
  const locales = config?.i18n?.supportedLocales || ["en"]
  return locales.map((locale) => `${locale} (${localeDisplayName(locale, displayLocale || locale)})`).join(", ")
}

export function languageSettingsView(ctxMeta, { store, config, packCallback, t = translate } = {}) {
  const locale = localeFromContext(ctxMeta, { store, config })
  const record = activeLocaleRecord(ctxMeta, { store, config })
  const currentLanguage = localeDisplayName(locale, locale)
  const text = [
    t(locale, "language.title"),
    t(locale, "language.current", { language: currentLanguage }),
    t(locale, sourceKey(record)),
    "",
    t(locale, "language.choose"),
  ].join("\n")

  const rows = (config?.i18n?.supportedLocales || ["en"]).map((candidate) => [
    {
      text: `${candidate === locale ? "✓ " : ""}${localeDisplayName(candidate, candidate)}`,
      callback_data: packCallback("lang", "set", candidate),
    },
  ])
  rows.push([
    { text: t(locale, "language.resetButton"), callback_data: packCallback("lang", "reset") },
    { text: t(locale, "common.close"), callback_data: packCallback("lang", "close") },
  ])

  return { text, replyMarkup: makeInlineKeyboard(rows), locale }
}
