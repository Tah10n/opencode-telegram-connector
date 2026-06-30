/**
 * @typedef {"allow" | "ask" | "deny"} PermissionDecision
 * @typedef {PermissionDecision | Readonly<Record<string, PermissionDecision>>} PermissionRule
 * @typedef {Record<string, PermissionRule>} PermissionConfig
 * @typedef {"suggest" | "auto-edit" | "full-auto"} PermissionProfileId
 * @typedef {PermissionProfileId | "opencode-default" | "custom"} PermissionProfileDisplayId
 */

/** @type {Readonly<Record<string, PermissionDecision>>} */
const READ_PERMISSION = Object.freeze({
  "*": "allow",
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
})

/** @type {readonly PermissionProfileId[]} */
export const PERMISSION_PROFILE_IDS = Object.freeze(["suggest", "auto-edit", "full-auto"])
export const PERMISSION_RESET_ID = "reset"
export const OPENCODE_DEFAULT_PROFILE_ID = "opencode-default"
export const CUSTOM_PERMISSION_PROFILE_ID = "custom"

/** @type {Readonly<PermissionConfig>} */
const PASSIVE_ALLOW = Object.freeze({
  read: READ_PERMISSION,
  glob: "allow",
  grep: READ_PERMISSION,
  list: "allow",
  lsp: "allow",
  todoread: "allow",
})

/** @type {Readonly<Record<PermissionProfileId, Readonly<PermissionConfig>>>} */
const PERMISSION_PROFILES = Object.freeze({
  "suggest": Object.freeze({
    "*": "ask",
    ...PASSIVE_ALLOW,
    edit: "ask",
    bash: "ask",
    task: "ask",
    skill: "ask",
    todowrite: "ask",
    question: "ask",
    webfetch: "ask",
    websearch: "ask",
    codesearch: "ask",
    repo_clone: "ask",
    repo_overview: "ask",
    external_directory: "ask",
    doom_loop: "ask",
  }),
  "auto-edit": Object.freeze({
    "*": "ask",
    ...PASSIVE_ALLOW,
    edit: "allow",
    todowrite: "allow",
    bash: "ask",
    task: "ask",
    skill: "ask",
    question: "ask",
    webfetch: "ask",
    websearch: "ask",
    codesearch: "ask",
    repo_clone: "ask",
    repo_overview: "ask",
    external_directory: "ask",
    doom_loop: "ask",
  }),
  "full-auto": Object.freeze({
    "*": "ask",
    ...PASSIVE_ALLOW,
    edit: "allow",
    todowrite: "allow",
    bash: "ask",
    task: "allow",
    skill: "allow",
    question: "allow",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
    repo_clone: "deny",
    repo_overview: "deny",
    external_directory: "deny",
    doom_loop: "ask",
  }),
})

/** @type {readonly string[]} */
const LEGACY_OPTIONAL_PROFILE_KEYS = Object.freeze(["repo_clone", "repo_overview"])

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** @param {unknown} value */
function orderedJson(value) {
  return JSON.stringify(value)
}

/**
 * @param {PermissionConfig} value
 * @param {Set<string>} keysToOmit
 * @returns {PermissionConfig}
 */
function omitKeysInOrder(value, keysToOmit) {
  /** @type {PermissionConfig} */
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!keysToOmit.has(key)) out[key] = entry
  }
  return out
}

/**
 * @param {unknown} permission
 * @param {Readonly<PermissionConfig>} profile
 * @returns {boolean}
 */
function matchesPermissionProfile(permission, profile) {
  if (orderedJson(permission) === orderedJson(profile)) return true
  if (!isPlainObject(permission)) return false

  const optionalMissingKeys = []
  for (const key of LEGACY_OPTIONAL_PROFILE_KEYS) {
    if (Object.hasOwn(permission, key)) continue
    if (profile[key] !== profile["*"]) return false
    optionalMissingKeys.push(key)
  }
  if (optionalMissingKeys.length === 0) return false

  return orderedJson(permission) === orderedJson(omitKeysInOrder(profile, new Set(optionalMissingKeys)))
}

/**
 * @param {unknown} value
 * @param {{ includeReset?: boolean }} [options]
 * @returns {PermissionProfileId | typeof PERMISSION_RESET_ID | ""}
 */
export function normalizePermissionProfileId(value, { includeReset = false } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-")
  if (!normalized) return ""
  if (normalized === "suggest" || normalized === "suggestion" || normalized === "read-only" || normalized === "readonly") return "suggest"
  if (normalized === "auto-edit" || normalized === "autoedit" || normalized === "auto") return "auto-edit"
  if (normalized === "full-auto" || normalized === "fullauto" || normalized === "full") return "full-auto"
  if (includeReset && (normalized === "reset" || normalized === "default" || normalized === "opencode-default")) return PERMISSION_RESET_ID
  return ""
}

/**
 * @param {unknown} profileId
 * @returns {PermissionConfig}
 */
export function profileToPermissionConfig(profileId) {
  const normalized = normalizePermissionProfileId(profileId)
  if (!normalized || normalized === PERMISSION_RESET_ID) throw new Error(`Unknown permissions profile: ${profileId}`)
  const profile = PERMISSION_PROFILES[normalized]
  if (!profile) throw new Error(`Unknown permissions profile: ${profileId}`)
  return cloneJson(profile)
}

/**
 * @param {unknown} permission
 * @returns {PermissionProfileDisplayId}
 */
export function detectPermissionProfile(permission) {
  if (permission == null) return OPENCODE_DEFAULT_PROFILE_ID
  for (const profileId of PERMISSION_PROFILE_IDS) {
    if (matchesPermissionProfile(permission, PERMISSION_PROFILES[profileId])) return profileId
  }
  return CUSTOM_PERMISSION_PROFILE_ID
}

/**
 * @param {unknown} profileId
 * @returns {string}
 */
export function permissionProfileLabel(profileId) {
  switch (profileId) {
    case "suggest":
      return "Suggest"
    case "auto-edit":
      return "Auto Edit"
    case "full-auto":
      return "Full Auto"
    case OPENCODE_DEFAULT_PROFILE_ID:
      return "OpenCode default"
    default:
      return "Custom"
  }
}

/**
 * @param {unknown} profileId
 * @returns {PermissionConfig | null}
 */
export function permissionProfileConfigForDisplay(profileId) {
  const normalized = normalizePermissionProfileId(profileId)
  return normalized ? profileToPermissionConfig(normalized) : null
}
