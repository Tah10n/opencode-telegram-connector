import test from "node:test"
import assert from "node:assert/strict"
import { botCommandsForLocale, localeDisplayName, matchSupportedLocale, normalizeI18nConfig, normalizeLocale, t } from "../src/i18n/index.js"

test("i18n normalizes Telegram locale codes and falls back to default", () => {
  assert.equal(matchSupportedLocale("ru-RU"), "ru")
  assert.equal(matchSupportedLocale("en_US"), "en")
  assert.equal(matchSupportedLocale("de-DE"), "")
  assert.equal(normalizeLocale("de-DE"), "en")
})

test("i18n translates with interpolation and fallback", () => {
  assert.equal(t("ru", "language.changed", { language: "русский" }), "Язык изменён на русский.")
  assert.equal(t("de", "language.changed", { language: "English" }), "Language changed to English.")
  assert.equal(t("ru", "missing.key"), "missing.key")
  assert.equal(localeDisplayName("ru", "ru"), "русский")
})

test("i18n normalizes runtime config", () => {
  assert.deepEqual(normalizeI18nConfig({ defaultLocale: "ru-RU", botCommandLocales: "ru,en", autoDetectTelegramLanguage: "off" }), {
    defaultLocale: "ru",
    supportedLocales: ["en", "ru"],
    autoDetectTelegramLanguage: false,
    botCommandLocales: ["ru", "en"],
  })
  assert.throws(() => normalizeI18nConfig({ supportedLocales: ["de"] }), /unsupported locale/)
})

test("i18n builds localized Telegram command menus", () => {
  const en = botCommandsForLocale("en")
  const ru = botCommandsForLocale("ru")

  assert.ok(en.some((entry) => entry.command === "language" && entry.description === "Choose bot language"))
  assert.ok(ru.some((entry) => entry.command === "language" && entry.description === "Выбрать язык бота"))
  assert.equal(en.length, ru.length)
})
