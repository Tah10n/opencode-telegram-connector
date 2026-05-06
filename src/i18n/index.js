import en from "./locales/en.js"
import ru from "./locales/ru.js"

export const DEFAULT_LOCALE = "en"

export const CATALOGS = Object.freeze({ en, ru })
export const SUPPORTED_LOCALES = Object.freeze(Object.keys(CATALOGS))

export const BOT_COMMAND_NAMES = Object.freeze([
  "help",
  "projects",
  "bind",
  "new",
  "use",
  "sessions",
  "model",
  "feed",
  "language",
  "status",
  "runtime",
  "bindings",
  "abort",
  "sendlast",
  "unbind",
  "cancel",
])

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseBoolField(fieldName, value, defaultValue) {
  if (value == null || value === "") return defaultValue
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false
  }
  throw new Error(`Config field '${fieldName}' must be a boolean`)
}

function localeTokens(value) {
  if (value == null || value === "") return []
  if (Array.isArray(value)) return value
  if (typeof value === "string") return value.split(",")
  throw new Error("locale list must be an array or comma-separated string")
}

export function matchSupportedLocale(value, supportedLocales = SUPPORTED_LOCALES) {
  const supported = Array.isArray(supportedLocales) && supportedLocales.length ? supportedLocales : SUPPORTED_LOCALES
  const raw = String(value ?? "").trim().toLowerCase().replaceAll("_", "-")
  if (!raw) return ""
  if (supported.includes(raw)) return raw
  const base = raw.split("-")[0]
  return supported.includes(base) ? base : ""
}

export function normalizeLocale(value, { supportedLocales = SUPPORTED_LOCALES, defaultLocale = DEFAULT_LOCALE } = {}) {
  return matchSupportedLocale(value, supportedLocales) || matchSupportedLocale(defaultLocale, supportedLocales) || DEFAULT_LOCALE
}

function normalizeConfiguredLocale(value, supportedLocales, fieldName) {
  const locale = matchSupportedLocale(value, supportedLocales)
  if (!locale) throw new Error(`Config field '${fieldName}' must be one of: ${supportedLocales.join(", ")}`)
  return locale
}

function normalizeLocaleList(value, { fieldName, defaultLocales = SUPPORTED_LOCALES, supportedLocales = SUPPORTED_LOCALES } = {}) {
  const rawTokens = localeTokens(value)
  const tokens = rawTokens.length ? rawTokens : defaultLocales
  const locales = []
  for (const token of tokens) {
    const locale = matchSupportedLocale(token, supportedLocales)
    if (!locale) throw new Error(`Config field '${fieldName}' contains unsupported locale '${String(token)}' (expected one of: ${supportedLocales.join(", ")})`)
    if (!locales.includes(locale)) locales.push(locale)
  }
  if (!locales.length) throw new Error(`Config field '${fieldName}' must include at least one locale`)
  return locales
}

export function normalizeI18nConfig(value = {}) {
  const raw = value == null ? {} : value
  if (!isPlainObject(raw)) throw new Error("Config field 'i18n' must be an object")
  const supportedLocales = normalizeLocaleList(raw.supportedLocales, {
    fieldName: "i18n.supportedLocales",
    defaultLocales: SUPPORTED_LOCALES,
    supportedLocales: SUPPORTED_LOCALES,
  })
  const defaultLocale = normalizeConfiguredLocale(raw.defaultLocale || DEFAULT_LOCALE, supportedLocales, "i18n.defaultLocale")
  const autoDetectTelegramLanguage = parseBoolField("i18n.autoDetectTelegramLanguage", raw.autoDetectTelegramLanguage, true)
  const botCommandLocales = normalizeLocaleList(raw.botCommandLocales, {
    fieldName: "i18n.botCommandLocales",
    defaultLocales: supportedLocales,
    supportedLocales,
  })
  return {
    defaultLocale,
    supportedLocales,
    autoDetectTelegramLanguage,
    botCommandLocales,
  }
}

function lookup(catalog, key) {
  let value = catalog
  for (const part of String(key || "").split(".")) {
    if (!part || !isPlainObject(value) || !(part in value)) return undefined
    value = value[part]
  }
  return value
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (params[name] == null ? match : String(params[name])))
}

export function t(locale, key, params = {}) {
  const resolvedLocale = normalizeLocale(locale)
  const value = lookup(CATALOGS[resolvedLocale], key) ?? lookup(CATALOGS[DEFAULT_LOCALE], key)
  if (typeof value === "function") return value(params)
  if (value == null) return String(key)
  return interpolate(value, params)
}

export function localeDisplayName(locale, displayLocale = locale) {
  const resolved = normalizeLocale(locale)
  const label = t(displayLocale, `locales.${resolved}`)
  return label === `locales.${resolved}` ? resolved : label
}

export function botCommandsForLocale(locale) {
  const resolvedLocale = normalizeLocale(locale)
  return BOT_COMMAND_NAMES.map((command) => ({ command, description: t(resolvedLocale, `botCommands.${command}`) }))
}
