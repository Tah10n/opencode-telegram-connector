import { localeDisplayName, matchSupportedLocale } from "../../i18n/index.js"
import { languageSettingsView, supportedLocaleSummary } from "../language-ui.js"

function ignoreError() {}

export async function handleLanguageCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  config,
  tg,
  answerCallbackQuery,
  closeInteractiveMessage,
  flushStoreIfAvailable,
  ctxMetaWithLocale,
  packCallbackData,
  t,
}) {
  const action = parts[1]
  if (action === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (action === "reset") {
    store.clearLocale?.(ctxMeta.ctxKey)
    await flushStoreIfAvailable()
    const nextCtxMeta = ctxMetaWithLocale?.({ ...ctxMeta, locale: "" }) || { ...ctxMeta, locale: "" }
    const view = languageSettingsView(nextCtxMeta, { store, config, packCallback: packCallbackData, t })
    await answerCallbackQuery(callbackQuery.id, t(nextCtxMeta, "language.reset"))
    if (msg?.message_id && typeof tg.editMessageText === "function") {
      await tg.editMessageText(nextCtxMeta.chatId, msg.message_id, view.text, view.replyMarkup).catch(ignoreError)
    }
    return true
  }
  if (action === "set") {
    const locale = matchSupportedLocale(parts[2], config?.i18n?.supportedLocales)
    if (!locale) {
      await answerCallbackQuery(
        callbackQuery.id,
        t(ctxMeta, "language.unsupported", { locale: parts[2] || "", supported: supportedLocaleSummary({ config, displayLocale: ctxMeta.locale }) }),
      )
      return true
    }
    store.setLocale?.(ctxMeta.ctxKey, locale, { source: "manual" })
    await flushStoreIfAvailable()
    const nextCtxMeta = ctxMetaWithLocale?.(ctxMeta) || { ...ctxMeta, locale }
    const view = languageSettingsView(nextCtxMeta, { store, config, packCallback: packCallbackData, t })
    await answerCallbackQuery(callbackQuery.id, t(nextCtxMeta, "language.changed", { language: localeDisplayName(locale, locale) }))
    if (msg?.message_id && typeof tg.editMessageText === "function") {
      await tg.editMessageText(nextCtxMeta.chatId, msg.message_id, view.text, view.replyMarkup).catch(ignoreError)
    }
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
