import { botCommandsForLocale } from "../i18n/index.js"

// Best-effort: publish Telegram built-in command menus.
// Telegram expects command names without the leading slash.
export async function publishBotCommandMenus({ tg, i18nConfig, logger }) {
  const defaultLocale = i18nConfig.defaultLocale
  async function publishLocale(locale, options = {}) {
    try {
      await tg.setMyCommands(botCommandsForLocale(locale), options)
    } catch (err) {
      const scope = options.language_code ? `locale ${options.language_code}` : `default locale ${locale}`
      logger.error(`Failed to set bot commands for ${scope}:`, err?.message || String(err))
    }
  }

  await publishLocale(defaultLocale)
  for (const locale of i18nConfig.botCommandLocales || []) {
    if (locale === defaultLocale) continue
    await publishLocale(locale, { language_code: locale })
  }
}
