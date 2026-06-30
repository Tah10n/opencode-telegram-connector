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
const NEW_PERMISSION_CONFIG_MODE = 0o600
const ALLOWED_PERMISSION_CONFIG_FILENAMES = Object.freeze(new Set(["opencode.json", "opencode.jsonc"]))
const PERMISSION_CONFIG_TEXT = Symbol("permissionConfigText")
const PERMISSION_CONFIG_PARENT_REALPATH = Symbol("permissionConfigParentRealpath")
const permissionConfigWriteLocks = new Map()

function hasCode(err, ...codes) {
  return !!err && typeof err === "object" && "code" in err && codes.includes(err.code)
}

function isAccessDenied(err) {
  return hasCode(err, "EACCES", "EPERM")
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

function normalizedFileMode(mode) {
  if (mode == null) return undefined
  const numeric = Number(mode)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric & 0o777 : undefined
}

function permissionResultUnavailable(filePath = "", reason = "") {
  return {
    ok: false,
    editable: false,
    status: "unavailable",
    ...(reason ? { reason } : {}),
    filePath,
    config: null,
    permission: undefined,
    profile: "custom",
  }
}

function permissionResultConflict(filePath, reason = "changed") {
  return {
    ok: false,
    editable: false,
    status: "conflict",
    reason,
    filePath,
    config: null,
    permission: undefined,
    profile: "custom",
  }
}

function attachConfigText(result, text, includeText) {
  if (!includeText) return result
  Object.defineProperty(result, PERMISSION_CONFIG_TEXT, { value: text, enumerable: false })
  return result
}
function attachConfigWriteMetadata(result, { text = "", parentRealPath } = {}, includeText) {
  if (!includeText) return result
  Object.defineProperty(result, PERMISSION_CONFIG_TEXT, { value: text, enumerable: false })
  if (parentRealPath) Object.defineProperty(result, PERMISSION_CONFIG_PARENT_REALPATH, { value: parentRealPath, enumerable: false })
  return result
}

function comparableFsPath(value) {
  const normalized = path.normalize(String(value || ""))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function sameFsPath(left, right) {
  return comparableFsPath(left) === comparableFsPath(right)
}

function permissionConfigLockKey(filePath) {
  const normalized = path.normalize(String(filePath || ""))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function permissionEmergencyBackupPrefix(filePath) {
  return `${path.basename(filePath)}.bak.`
}

function permissionEmergencyBackupIsUnsafe(stat) {
  return (typeof stat?.isSymbolicLink === "function" && stat.isSymbolicLink())
    || (typeof stat?.isFile === "function" && !stat.isFile())
}

async function permissionEmergencyBackupState(fsImpl, backupPath) {
  const statFile = typeof fsImpl?.lstat === "function" ? fsImpl.lstat.bind(fsImpl) : fsImpl.stat.bind(fsImpl)
  const stat = await statFile(backupPath)
  return permissionEmergencyBackupIsUnsafe(stat) ? "unsafe" : "file"
}

async function listPermissionEmergencyBackups(filePath, { fsImpl = fs } = {}) {
  const dir = path.dirname(filePath)
  const prefix = permissionEmergencyBackupPrefix(filePath)
  let names
  if (typeof fsImpl?.readdir !== "function") return []
  try {
    names = await fsImpl.readdir(dir)
  } catch (err) {
    if (hasCode(err, "ENOENT", "ENOTDIR")) return []
    throw err
  }

  const backups = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const backupPath = path.join(dir, name)
    let stat = null
    try {
      const statFile = typeof fsImpl?.lstat === "function" ? fsImpl.lstat.bind(fsImpl) : fsImpl.stat.bind(fsImpl)
      stat = await statFile(backupPath)
    } catch (err) {
      if (!hasCode(err, "ENOENT")) throw err
      continue
    }
    backups.push({ path: backupPath, name, mtimeMs: Number(stat?.mtimeMs) || 0, unsafe: permissionEmergencyBackupIsUnsafe(stat) })
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  return backups
}

async function hasPermissionEmergencyBackup(filePath, { fsImpl = fs } = {}) {
  return (await listPermissionEmergencyBackups(filePath, { fsImpl })).length > 0
}

function permissionResultInvalidEmergencyBackup(filePath, backupPath, err) {
  return {
    ok: false,
    editable: false,
    exists: false,
    status: "invalid",
    filePath,
    config: null,
    permission: undefined,
    profile: "custom",
    error: new Error(
      `OpenCode config '${filePath}' is missing, and emergency backup '${backupPath}' could not be loaded (${err?.message || String(err)}). Refusing to create a new config over it.`,
      { cause: err },
    ),
  }
}

async function inspectMissingPermissionConfigEmergencyBackup(filePath, { fsImpl = fs } = {}) {
  let backups
  try {
    backups = await listPermissionEmergencyBackups(filePath, { fsImpl })
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable(filePath, "access-denied")
    throw err
  }
  if (backups.length === 0) return null

  const backup = backups[0]
  if (backup.unsafe) {
    return permissionResultInvalidEmergencyBackup(filePath, backup.path, new Error("unsafe emergency backup target; expected a regular file"))
  }
  try {
    const backupState = await permissionEmergencyBackupState(fsImpl, backup.path)
    if (backupState === "unsafe") {
      return permissionResultInvalidEmergencyBackup(filePath, backup.path, new Error("unsafe emergency backup target; expected a regular file"))
    }
    parseJsonc(await fsImpl.readFile(backup.path, "utf8"), backup.path)
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable(filePath, "access-denied")
    if (hasCode(err, "ENOENT", "ENOTDIR")) return permissionResultUnavailable(filePath)
    return permissionResultInvalidEmergencyBackup(filePath, backup.path, err)
  }

  return permissionResultConflict(filePath, "emergency-backup")
}

async function withPermissionConfigWriteLock(lockKey, fn) {
  const key = permissionConfigLockKey(lockKey)
  const previous = permissionConfigWriteLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  permissionConfigWriteLocks.set(key, current)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (permissionConfigWriteLocks.get(key) === current) permissionConfigWriteLocks.delete(key)
  }
}

async function parentRealPathForWrite(fsImpl, filePath) {
  if (typeof fsImpl?.realpath !== "function") return undefined
  return fsImpl.realpath(path.dirname(filePath))
}

async function permissionConfigWriteLockKey(fsImpl, filePath, expectedParentRealPath) {
  const parentRealPath = await parentRealPathForWrite(fsImpl, filePath)
  if (expectedParentRealPath && parentRealPath && !sameFsPath(parentRealPath, expectedParentRealPath)) {
    const err = new Error(`Parent directory changed while locking '${filePath}'.`)
    err.code = "EPARENTCHANGED"
    throw err
  }
  if (expectedParentRealPath) return path.join(expectedParentRealPath, path.basename(filePath))
  if (!parentRealPath) return filePath
  return path.join(parentRealPath, path.basename(filePath))
}

async function permissionConfigExistingFileMode(fsImpl, filePath) {
  try {
    const stat = typeof fsImpl?.lstat === "function" ? await fsImpl.lstat(filePath) : await fsImpl.stat(filePath)
    if (typeof stat?.isSymbolicLink === "function" && stat.isSymbolicLink()) return { ok: false }
    if (typeof stat?.isFile === "function" && !stat.isFile()) return { ok: false }
    return { ok: true, mode: normalizedFileMode(stat?.mode) }
  } catch (err) {
    if (hasCode(err, "ENOENT", "ENOTDIR")) return { ok: false }
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
  if (project?.permissionControl === false) return false
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

function configuredPermissionConfigParentPath(project) {
  const explicit = String(project?.permissionConfigPath || "").trim()
  if (explicit && hostLocalPathInfo(explicit)) return path.dirname(explicit)
  const directory = String(project?.directory || "").trim()
  return isHostLocalDirectory(directory) ? directory : ""
}

async function configuredPermissionConfigParentRealPath(project, { fsImpl }) {
  const parentPath = configuredPermissionConfigParentPath(project)
  if (!parentPath || typeof fsImpl?.realpath !== "function") return undefined
  return fsImpl.realpath(parentPath)
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
  const jsoncState = await permissionConfigTargetState(fsImpl, jsoncPath)
  if (jsoncState === "unsafe") return ""
  if (jsoncState === "file") return jsoncPath
  const jsonState = await permissionConfigTargetState(fsImpl, jsonPath)
  if (jsonState === "unsafe") return ""
  if (jsonState === "file") return jsonPath
  if (jsoncState === "missing" && await hasPermissionEmergencyBackup(jsoncPath, { fsImpl })) return jsoncPath
  if (jsonState === "missing" && await hasPermissionEmergencyBackup(jsonPath, { fsImpl })) return jsonPath
  return jsonPath
}

async function readOpenCodePermissionConfigInternal(project, { fsImpl = fs, includeText = false, expectedParentRealPath } = {}) {
  if (!permissionControlEnabled(project)) {
    const filePath = String(project?.permissionConfigPath || "").trim()
    return { ok: false, editable: false, status: "disabled", filePath, config: null, permission: undefined, profile: "custom" }
  }
  let filePath
  try {
    filePath = await resolvePermissionConfigPath(project, { fsImpl })
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable("", "access-denied")
    throw err
  }
  if (!filePath) {
    return { ok: false, editable: false, status: "unavailable", filePath: "", config: null, permission: undefined, profile: "custom" }
  }

  let parentRealPath
  if (includeText) {
    try {
      parentRealPath = await parentRealPathForWrite(fsImpl, filePath)
    } catch (err) {
      if (isAccessDenied(err)) return permissionResultUnavailable(filePath, "access-denied")
      if (hasCode(err, "ENOENT", "ENOTDIR")) return permissionResultUnavailable(filePath)
      throw err
    }
    if (expectedParentRealPath && parentRealPath && !sameFsPath(parentRealPath, expectedParentRealPath)) {
      return permissionResultConflict(filePath)
    }
  }

  let text
  try {
    text = await fsImpl.readFile(filePath, "utf8")
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      const emergencyBackupResult = await inspectMissingPermissionConfigEmergencyBackup(filePath, { fsImpl })
      if (emergencyBackupResult) return emergencyBackupResult
      return attachConfigWriteMetadata({
        ok: true,
        editable: true,
        exists: false,
        status: "missing",
        filePath,
        config: {},
        permission: undefined,
        profile: detectPermissionProfile(undefined),
      }, { text: "", parentRealPath }, includeText)
    }
    if (isAccessDenied(err)) return permissionResultUnavailable(filePath, "access-denied")
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
  return attachConfigWriteMetadata({
    ok: true,
    editable: true,
    exists: true,
    status: "ok",
    filePath,
    config,
    permission,
    profile: detectPermissionProfile(permission),
  }, { text, parentRealPath }, includeText)
}

export async function readOpenCodePermissionConfig(project, { fsImpl = fs } = {}) {
  return readOpenCodePermissionConfigInternal(project, { fsImpl })
}

async function verifyPermissionConfigWriteTarget(project, current, expectedText, { fsImpl }) {
  const expectedParentRealPath = current[PERMISSION_CONFIG_PARENT_REALPATH]
  let parentRealPathBefore
  try {
    parentRealPathBefore = await parentRealPathForWrite(fsImpl, current.filePath)
  } catch (err) {
    if (isAccessDenied(err) || hasCode(err, "ENOENT", "ENOTDIR")) {
      return { ok: false, result: permissionResultUnavailable(current.filePath, isAccessDenied(err) ? "access-denied" : "") }
    }
    throw err
  }
  if (expectedParentRealPath && parentRealPathBefore && !sameFsPath(parentRealPathBefore, expectedParentRealPath)) {
    return { ok: false, result: permissionResultConflict(current.filePath) }
  }

  let pathStillValid
  try {
    pathStillValid = await revalidatePermissionConfigPathForWrite(project, current, { fsImpl })
  } catch (err) {
    if (isAccessDenied(err) || hasCode(err, "ENOENT", "ENOTDIR")) {
      return { ok: false, result: permissionResultUnavailable(current.filePath, isAccessDenied(err) ? "access-denied" : "") }
    }
    throw err
  }
  if (!pathStillValid) {
    return { ok: false, result: permissionResultUnavailable(current.filePath) }
  }

  let parentRealPath
  try {
    parentRealPath = await parentRealPathForWrite(fsImpl, current.filePath)
  } catch (err) {
    if (isAccessDenied(err) || hasCode(err, "ENOENT", "ENOTDIR")) {
      return { ok: false, result: permissionResultUnavailable(current.filePath, isAccessDenied(err) ? "access-denied" : "") }
    }
    throw err
  }
  if (expectedParentRealPath && parentRealPath && !sameFsPath(parentRealPath, expectedParentRealPath)) {
    return { ok: false, result: permissionResultConflict(current.filePath) }
  }
  if (parentRealPathBefore && parentRealPath && !sameFsPath(parentRealPathBefore, parentRealPath)) {
    return { ok: false, result: permissionResultConflict(current.filePath) }
  }
  parentRealPath = expectedParentRealPath || parentRealPath || parentRealPathBefore

  if (!current.exists) {
    let state
    try {
      state = await permissionConfigTargetState(fsImpl, current.filePath)
    } catch (err) {
      if (isAccessDenied(err)) return { ok: false, result: permissionResultUnavailable(current.filePath, "access-denied") }
      throw err
    }
    if (state === "missing") {
      let emergencyBackups
      try {
        emergencyBackups = await listPermissionEmergencyBackups(current.filePath, { fsImpl })
      } catch (err) {
        if (isAccessDenied(err)) return { ok: false, result: permissionResultUnavailable(current.filePath, "access-denied") }
        throw err
      }
      if (emergencyBackups.length > 0) return { ok: false, result: permissionResultConflict(current.filePath, "emergency-backup") }
      return { ok: true, mode: NEW_PERMISSION_CONFIG_MODE, text: "", parentRealPath }
    }
    if (state === "file") return { ok: false, result: permissionResultConflict(current.filePath) }
    return { ok: false, result: permissionResultUnavailable(current.filePath) }
  }

  let modeResult
  try {
    modeResult = await permissionConfigExistingFileMode(fsImpl, current.filePath)
  } catch (err) {
    if (isAccessDenied(err)) return { ok: false, result: permissionResultUnavailable(current.filePath, "access-denied") }
    throw err
  }
  if (!modeResult.ok) return { ok: false, result: permissionResultUnavailable(current.filePath) }

  let latestText
  try {
    latestText = await fsImpl.readFile(current.filePath, "utf8")
  } catch (err) {
    if (isAccessDenied(err)) return { ok: false, result: permissionResultUnavailable(current.filePath, "access-denied") }
    if (hasCode(err, "ENOENT", "ENOTDIR")) return { ok: false, result: permissionResultConflict(current.filePath) }
    throw err
  }
  if (latestText !== expectedText) return { ok: false, result: permissionResultConflict(current.filePath) }

  return { ok: true, mode: modeResult.mode, text: latestText, parentRealPath }
}

export async function writeOpenCodePermissionProfile(project, profileId, { fsImpl = fs, now = new Date() } = {}) {
  const normalizedProfileId = normalizePermissionProfileId(profileId, { includeReset: true })
  if (!normalizedProfileId) throw new Error(`Unknown permissions profile: ${profileId}`)

  if (!permissionControlEnabled(project)) {
    const filePath = String(project?.permissionConfigPath || "").trim()
    return { ok: false, editable: false, status: "disabled", filePath, config: null, permission: undefined, profile: "custom" }
  }

  let initialParentRealPath
  try {
    initialParentRealPath = await configuredPermissionConfigParentRealPath(project, { fsImpl })
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable("", "access-denied")
    if (hasCode(err, "ENOENT", "ENOTDIR")) return permissionResultUnavailable("")
    throw err
  }

  let resolvedFilePath
  try {
    resolvedFilePath = await resolvePermissionConfigPath(project, { fsImpl })
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable("", "access-denied")
    throw err
  }
  if (!resolvedFilePath) return permissionResultUnavailable("")

  let lockKey
  try {
    lockKey = await permissionConfigWriteLockKey(fsImpl, resolvedFilePath, initialParentRealPath)
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable(resolvedFilePath, "access-denied")
    if (hasCode(err, "EPARENTCHANGED", "ENOENT", "ENOTDIR")) return permissionResultConflict(resolvedFilePath)
    throw err
  }

  return withPermissionConfigWriteLock(lockKey, async () => writeOpenCodePermissionProfileLocked(project, normalizedProfileId, resolvedFilePath, { fsImpl, now, expectedParentRealPath: initialParentRealPath }))
}

async function writeOpenCodePermissionProfileLocked(project, normalizedProfileId, resolvedFilePath, { fsImpl, now, expectedParentRealPath }) {
  const current = await readOpenCodePermissionConfigInternal(project, { fsImpl, includeText: true, expectedParentRealPath })
  if (!current.editable) return { ok: false, ...current, filePath: current.filePath || resolvedFilePath }
  if (current.filePath !== resolvedFilePath) return permissionResultUnavailable(current.filePath || resolvedFilePath)

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

  const expectedText = current[PERMISSION_CONFIG_TEXT] ?? ""
  const verified = await verifyPermissionConfigWriteTarget(project, current, expectedText, { fsImpl })
  if (!verified.ok) return verified.result

  const writeMode = verified.mode

  let backupPath = ""
  if (current.exists) {
    try {
      backupPath = await createStateFileBackup(current.filePath, {
        reason: "opencode-permissions",
        schemaVersion: "config",
        maxBackups: permissionBackupMaxFiles(project),
        fsImpl,
        now,
        mode: writeMode,
        contents: Buffer.from(verified.text, "utf8"),
        expectedParentRealPath: verified.parentRealPath,
      })
    } catch (err) {
      if (isAccessDenied(err)) return permissionResultUnavailable(current.filePath, "access-denied")
      if (hasCode(err, "EPARENTCHANGED", "ENOENT", "ENOTDIR")) return permissionResultConflict(current.filePath)
      throw err
    }
  }

  const beforeWrite = await verifyPermissionConfigWriteTarget(project, current, expectedText, { fsImpl })
  if (!beforeWrite.ok) return beforeWrite.result

  try {
    await writeJsonFileAtomic(current.filePath, nextConfig, {
      fsImpl,
      mode: writeMode,
      expectedParentRealPath: beforeWrite.parentRealPath,
      overwrite: current.exists !== false,
    })
  } catch (err) {
    if (isAccessDenied(err)) return permissionResultUnavailable(current.filePath, "access-denied")
    if (hasCode(err, "ENOTSUP", "ENOSYS", "EOPNOTSUPP")) return permissionResultUnavailable(current.filePath, "unsupported-create")
    if (hasCode(err, "EPARENTCHANGED", "EEXIST", "ENOENT", "ENOTDIR")) return permissionResultConflict(current.filePath)
    throw err
  }
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
