const READ_PERMISSION = Object.freeze({
  "*": "allow",
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
})

export const PERMISSION_PROFILE_IDS = Object.freeze(["suggest", "auto-edit", "full-auto"])
export const PERMISSION_RESET_ID = "reset"
export const OPENCODE_DEFAULT_PROFILE_ID = "opencode-default"
export const CUSTOM_PERMISSION_PROFILE_ID = "custom"

const PASSIVE_ALLOW = Object.freeze({
  read: READ_PERMISSION,
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  todoread: "allow",
})

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
    external_directory: "ask",
    doom_loop: "ask",
  }),
  "full-auto": Object.freeze({
    "*": "allow",
    ...PASSIVE_ALLOW,
    edit: "allow",
    todowrite: "allow",
    bash: "allow",
    task: "allow",
    skill: "allow",
    question: "allow",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
    external_directory: "deny",
    doom_loop: "ask",
  }),
})

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function sortObjectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]))
}

function canonicalJson(value) {
  return JSON.stringify(sortObjectKeys(value))
}

export function normalizePermissionProfileId(value, { includeReset = false } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-")
  if (!normalized) return ""
  if (normalized === "suggest" || normalized === "suggestion" || normalized === "read-only" || normalized === "readonly") return "suggest"
  if (normalized === "auto-edit" || normalized === "autoedit" || normalized === "auto") return "auto-edit"
  if (normalized === "full-auto" || normalized === "fullauto" || normalized === "full") return "full-auto"
  if (includeReset && (normalized === "reset" || normalized === "default" || normalized === "opencode-default")) return PERMISSION_RESET_ID
  return ""
}

export function profileToPermissionConfig(profileId) {
  const normalized = normalizePermissionProfileId(profileId)
  const profile = PERMISSION_PROFILES[normalized]
  if (!profile) throw new Error(`Unknown permissions profile: ${profileId}`)
  return cloneJson(profile)
}

export function detectPermissionProfile(permission) {
  if (permission == null) return OPENCODE_DEFAULT_PROFILE_ID
  const current = canonicalJson(permission)
  for (const profileId of PERMISSION_PROFILE_IDS) {
    if (canonicalJson(PERMISSION_PROFILES[profileId]) === current) return profileId
  }
  return CUSTOM_PERMISSION_PROFILE_ID
}

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

export function permissionProfileConfigForDisplay(profileId) {
  const normalized = normalizePermissionProfileId(profileId)
  return normalized ? profileToPermissionConfig(normalized) : null
}
