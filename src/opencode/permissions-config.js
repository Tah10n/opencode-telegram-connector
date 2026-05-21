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
const ALLOWED_PERMISSION_CONFIG_FILENAMES = Object.freeze(new Set(["opencode.json", "opencode.jsonc"]))

function hasCode(err, ...codes) {
  return !!err && typeof err === "object" && "code" in err && codes.includes(err.code)
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
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

async function directoryState(fsImpl, directory) {
  try {
    const stat = await fsImpl.stat(directory)
    return typeof stat?.isDirectory === "function" && !stat.isDirectory() ? "not-directory" : "directory"
  } catch (err) {
    if (hasCode(err, "ENOENT")) return "missing"
    if (hasCode(err, "ENOTDIR")) return "not-directory"
    throw err
  }
}

async function fileState(fsImpl, filePath) {
  try {
    const stat = typeof fsImpl?.lstat === "function" ? await fsImpl.lstat(filePath) : await fsImpl.stat(filePath)
    if (typeof stat?.isSymbolicLink === "function" && stat.isSymbolicLink()) return "symlink"
    return typeof stat?.isFile === "function" && !stat.isFile() ? "not-file" : "file"
  } catch (err) {
    if (hasCode(err, "ENOENT")) return "missing"
    if (hasCode(err, "ENOTDIR")) return "not-file"
    throw err
  }
}

async function permissionConfigTargetState(fsImpl, filePath) {
  const state = await fileState(fsImpl, filePath)
  return state === "symlink" || state === "not-file" ? "unsafe" : state
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

function permissionControlRemoteDirectory(project) {
  return project?.permissionControl?.remoteDirectory === true
}

function hostLocalPathInfo(value) {
  const canonical = canonicalDirectoryPath(value)
  if (!canonical) return null
  if (process.platform === "win32") {
    return canonical.flavor === "windows-drive" || canonical.flavor === "windows-unc" ? canonical : null
  }
  return canonical.flavor === "posix" ? canonical : null
}

function isHostLocalDirectory(directory) {
  return !!hostLocalPathInfo(directory)
}

function canonicalBasename(canonical) {
  const parts = String(canonical?.path || "").split("/")
  return parts.at(-1) || ""
}

function canonicalDirname(canonical) {
  if (!canonical?.path) return ""
  return canonical.flavor === "posix" ? path.posix.dirname(canonical.path) : path.win32.dirname(canonical.path)
}

function isPathSameOrInsideDirectory(target, directory) {
  if (!target || !directory || target.flavor !== directory.flavor) return false
  if (target.key === directory.key) return true
  const prefix = directory.key.endsWith("/") ? directory.key : `${directory.key}/`
  return target.key.startsWith(prefix)
}

async function realHostLocalPathInfo(fsImpl, value) {
  const realPath = typeof fsImpl?.realpath === "function" ? await fsImpl.realpath(value) : value
  return hostLocalPathInfo(realPath)
}

async function resolveExplicitPermissionConfigPath(project, explicit, { fsImpl }) {
  const target = hostLocalPathInfo(explicit)
  if (!target) return ""
  if (!ALLOWED_PERMISSION_CONFIG_FILENAMES.has(canonicalBasename(target))) return ""

  const parentDirectory = canonicalDirname(target)
  if (!parentDirectory || !(await directoryExists(fsImpl, parentDirectory))) return ""

  const targetFileState = await fileState(fsImpl, explicit)
  if (targetFileState === "symlink" || targetFileState === "not-file") return ""

  const configuredProjectDirectory = String(project?.directory || "").trim()
  const projectDirectory = hostLocalPathInfo(configuredProjectDirectory)
  if (projectDirectory) {
    const state = await directoryState(fsImpl, projectDirectory.path)
    if (state === "not-directory") return ""
    if (state !== "directory") return permissionControlRemoteDirectory(project) ? explicit : ""
    const projectReal = await realHostLocalPathInfo(fsImpl, projectDirectory.path)
    const parentReal = await realHostLocalPathInfo(fsImpl, parentDirectory)
    if (!isPathSameOrInsideDirectory(parentReal, projectReal)) return ""
    if (targetFileState === "file") {
      const targetReal = await realHostLocalPathInfo(fsImpl, explicit)
      if (!isPathSameOrInsideDirectory(targetReal, projectReal)) return ""
    }
  }
  return explicit
}

async function revalidatePermissionConfigPathForWrite(project, current, { fsImpl }) {
  const filePath = String(current?.filePath || "")
  if (!filePath) return false
  const resolved = await resolvePermissionConfigPath(project, { fsImpl })
  return resolved === filePath
}

function isCurrentProfile(currentProfile, requestedProfile) {
  if (requestedProfile === PERMISSION_RESET_ID) return currentProfile === OPENCODE_DEFAULT_PROFILE_ID
  return currentProfile === requestedProfile
}

export async function resolvePermissionConfigPath(project, { fsImpl = fs } = {}) {
  const explicit = String(project?.permissionConfigPath || "").trim()
  if (explicit) return resolveExplicitPermissionConfigPath(project, explicit, { fsImpl })
  const directory = String(project?.directory || "").trim()
  if (!directory) return ""
  if (!isHostLocalDirectory(directory)) return ""
  if (!(await directoryExists(fsImpl, directory))) return ""

  const jsonPath = path.join(directory, "opencode.json")
  const jsoncPath = path.join(directory, "opencode.jsonc")
  const jsonState = await permissionConfigTargetState(fsImpl, jsonPath)
  if (jsonState === "unsafe") return ""
  if (jsonState === "file") return jsonPath
  const jsoncState = await permissionConfigTargetState(fsImpl, jsoncPath)
  if (jsoncState === "unsafe") return ""
  if (jsoncState === "file") return jsoncPath
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

  if (!(await revalidatePermissionConfigPathForWrite(project, current, { fsImpl }))) {
    return { ok: false, editable: false, status: "unavailable", filePath: current.filePath, config: null, permission: undefined, profile: "custom" }
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
