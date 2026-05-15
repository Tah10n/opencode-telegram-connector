import { localeDisplayName, matchSupportedLocale } from "../../i18n/index.js"
import { languageSettingsView, supportedLocaleSummary } from "../language-ui.js"

export function createLanguageCommandHandler({ store, config, sendToThread, ctxMetaWithLocale, packCallback, closeOnlyKeyboard, t }) {
  return async function handleLanguage(ctxMeta, argv = []) {
    const arg = String(argv?.[0] || "").trim()
    if (arg) {
      if (arg.toLowerCase() === "reset") {
        store.clearLocale?.(ctxMeta.ctxKey)
        ctxMeta = ctxMetaWithLocale?.({ ...ctxMeta, locale: "" }) || { ...ctxMeta, locale: "" }
        const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
        await sendToThread(ctxMeta, `${t(ctxMeta, "language.reset")}\n\n${view.text}`, view.replyMarkup)
        return
      }

      const locale = matchSupportedLocale(arg, config.i18n?.supportedLocales)
      if (!locale) {
        await sendToThread(
          ctxMeta,
          t(ctxMeta, "language.unsupported", { locale: arg, supported: supportedLocaleSummary({ config, displayLocale: ctxMeta.locale }) }),
          closeOnlyKeyboard(ctxMeta),
        )
        return
      }

      store.setLocale?.(ctxMeta.ctxKey, locale, { source: "manual" })
      ctxMeta = ctxMetaWithLocale?.(ctxMeta) || { ...ctxMeta, locale }
      const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
      await sendToThread(ctxMeta, `${t(ctxMeta, "language.changed", { language: localeDisplayName(locale, locale) })}\n\n${view.text}`, view.replyMarkup)
      return
    }

    const view = languageSettingsView(ctxMeta, { store, config, packCallback, t })
    await sendToThread(ctxMeta, view.text, view.replyMarkup)
  }
}
