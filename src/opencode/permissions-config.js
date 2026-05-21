import fs from "node:fs/promises"
import path from "node:path"
import { canonicalDirectoryPath } from "../directory-paths.js"
import { createStateFileBackup, DEFAULT_STATE_BACKUP_MAX_FILES, writeJsonFileAtomic } from "../state/fileStore.js"
import {
  detectPermissionProfile,
  normalizePermissionProfileId,
  OPENCODE_DEFAULT_PROFILE_ID,
  PERMISSION_RESET_ID,
  profileToPermissionConfig,
} from "./permissions-profile.js"

const DEFAULT_OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"

function hasCode(err, ...codes) {
  return !!err && typeof err === "object" && "code" in err && codes.includes(err.code)
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function fileExists(fsImpl, filePath) {
  try {
    const stat = await fsImpl.stat(filePath)
    return typeof stat?.isFile === "function" ? stat.isFile() : true
  } catch (err) {
    if (hasCode(err, "ENOENT", "ENOTDIR")) return false
    throw err
  }
}

async function directoryExists(fsImpl, directory) {
  try {
    const stat = await fsImpl.stat(directory)
    return typeof stat?.isDirectory === "function" ? stat.isDirectory() : true
  } catch (err) {
    if (hasCode(err, "ENOENT", "ENOTDIR")) return false
    throw err
  }
}

function stripJsonComments(text) {
  let out = ""
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  const value = String(text || "")

  for (let index = 0; index < value.length; index++) {
    const ch = value[index]
    const next = value[index + 1]

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false
        out += ch
      }
      continue
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        index++
        blockComment = false
      } else if (ch === "\n") {
        out += ch
      }
      continue
    }

    if (quote) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = ""
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
    } else if (ch === "/" && next === "/") {
      index++
      lineComment = true
    } else if (ch === "/" && next === "*") {
      index++
      blockComment = true
    } else {
      out += ch
    }
  }

  return out
}

function stripTrailingCommas(text) {
  let out = ""
  let quote = ""
  let escaped = false
  const value = String(text || "")

  for (let index = 0; index < value.length; index++) {
    const ch = value[index]
    if (quote) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = ""
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }

    if (ch === ",") {
      let nextIndex = index + 1
      while (/\s/.test(value[nextIndex] || "")) nextIndex++
      if (value[nextIndex] === "}" || value[nextIndex] === "]") continue
    }
    out += ch
  }

  return out
}

function parseJsonc(text, filePath) {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)))
    if (!isPlainObject(parsed)) throw new Error("config root must be an object")
    return parsed
  } catch (err) {
    throw new Error(`Failed to parse OpenCode config '${filePath}': ${err?.message || String(err)}`, { cause: err })
  }
}

function permissionControlEnabled(project) {
  return project?.permissionControl?.enabled !== false
}

function permissionBackupMaxFiles(project) {
  const value = project?.permissionControl?.maxBackups
  if (value == null) return DEFAULT_STATE_BACKUP_MAX_FILES
  const max = Number(value)
  return Number.isInteger(max) && max >= 0 ? max : DEFAULT_STATE_BACKUP_MAX_FILES
}

function isHostLocalDirectory(directory) {
  const canonical = canonicalDirectoryPath(directory)
  if (!canonical) return false
  if (process.platform === "win32") return canonical.flavor === "windows-drive" || canonical.flavor === "windows-unc"
  return canonical.flavor === "posix"
}

function isCurrentProfile(currentProfile, requestedProfile) {
  if (requestedProfile === PERMISSION_RESET_ID) return currentProfile === OPENCODE_DEFAULT_PROFILE_ID
  return currentProfile === requestedProfile
}

export async function resolvePermissionConfigPath(project, { fsImpl = fs } = {}) {
  const explicit = String(project?.permissionConfigPath || "").trim()
  if (explicit) return explicit
  const directory = String(project?.directory || "").trim()
  if (!directory) return ""
  if (!isHostLocalDirectory(directory)) return ""
  if (!(await directoryExists(fsImpl, directory))) return ""

  const jsonPath = path.join(directory, "opencode.json")
  const jsoncPath = path.join(directory, "opencode.jsonc")
  if (await fileExists(fsImpl, jsonPath)) return jsonPath
  if (await fileExists(fsImpl, jsoncPath)) return jsoncPath
  return jsonPath
}

export async function readOpenCodePermissionConfig(project, { fsImpl = fs } = {}) {
  if (!permissionControlEnabled(project)) {
    const filePath = String(project?.permissionConfigPath || "").trim()
    return { ok: false, editable: false, status: "disabled", filePath, config: null, permission: undefined, profile: "custom" }
  }
  const filePath = await resolvePermissionConfigPath(project, { fsImpl })
  if (!filePath) {
    return { ok: false, editable: false, status: "unavailable", filePath: "", config: null, permission: undefined, profile: "custom" }
  }

  let text
  try {
    text = await fsImpl.readFile(filePath, "utf8")
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      return {
        ok: true,
        editable: true,
        exists: false,
        status: "missing",
        filePath,
        config: {},
        permission: undefined,
        profile: detectPermissionProfile(undefined),
      }
    }
    throw err
  }

  let config
  try {
    config = parseJsonc(text, filePath)
  } catch (err) {
    return {
      ok: false,
      editable: false,
      exists: true,
      status: "invalid",
      filePath,
      config: null,
      permission: undefined,
      profile: "custom",
      error: err,
    }
  }
  const permission = config.permission
  return {
    ok: true,
    editable: true,
    exists: true,
    status: "ok",
    filePath,
    config,
    permission,
    profile: detectPermissionProfile(permission),
  }
}

export async function writeOpenCodePermissionProfile(project, profileId, { fsImpl = fs, now = new Date() } = {}) {
  const normalizedProfileId = normalizePermissionProfileId(profileId, { includeReset: true })
  if (!normalizedProfileId) throw new Error(`Unknown permissions profile: ${profileId}`)

  const current = await readOpenCodePermissionConfig(project, { fsImpl })
  if (!current.editable) return { ok: false, ...current }

  const nextConfig = isPlainObject(current.config) ? { ...current.config } : {}
  const hasOwnPermissionKey = isPlainObject(current.config) && Object.hasOwn(current.config, "permission")
  const isUnchangedProfile = normalizedProfileId === PERMISSION_RESET_ID
    ? current.profile === OPENCODE_DEFAULT_PROFILE_ID && !hasOwnPermissionKey
    : isCurrentProfile(current.profile, normalizedProfileId)

  if (isUnchangedProfile) {
    return {
      ok: true,
      status: current.status,
      filePath: current.filePath,
      backupPath: "",
      changed: false,
      profile: current.profile,
      permission: current.permission,
      config: nextConfig,
    }
  }
  if (normalizedProfileId === PERMISSION_RESET_ID && !current.exists) {
    return {
      ok: true,
      status: "missing",
      filePath: current.filePath,
      backupPath: "",
      changed: false,
      profile: detectPermissionProfile(undefined),
      permission: undefined,
      config: nextConfig,
    }
  }
  if (!current.exists && !nextConfig.$schema) nextConfig.$schema = DEFAULT_OPENCODE_CONFIG_SCHEMA

  if (normalizedProfileId === PERMISSION_RESET_ID) {
    delete nextConfig.permission
  } else {
    nextConfig.permission = profileToPermissionConfig(normalizedProfileId)
  }

  let backupPath = ""
  if (current.exists) {
    backupPath = await createStateFileBackup(current.filePath, {
      reason: "opencode-permissions",
      schemaVersion: "config",
      maxBackups: permissionBackupMaxFiles(project),
      fsImpl,
      now,
    })
  }

  await writeJsonFileAtomic(current.filePath, nextConfig, { fsImpl })
  return {
    ok: true,
    status: "ok",
    filePath: current.filePath,
    backupPath,
    changed: true,
    profile: detectPermissionProfile(nextConfig.permission),
    permission: nextConfig.permission,
    config: nextConfig,
  }
}
