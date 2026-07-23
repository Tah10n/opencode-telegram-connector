import fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export const DEFAULT_STATE_BACKUP_MAX_FILES = 5
export const DEFAULT_STATE_FILE_MODE = 0o600

function hasCode(err, ...codes) {
  return !!err && typeof err === "object" && "code" in err && codes.includes(err.code)
}

async function unlinkIfExists(fsImpl, filePath) {
  try {
    await fsImpl.unlink(filePath)
  } catch (err) {
    if (!hasCode(err, "ENOENT")) throw err
  }
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
}

function cleanBackupLabel(value, fallback) {
  const text = String(value || fallback)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return text || fallback
}

function backupPrefix(filePath) {
  return `${path.basename(filePath)}.backup.`
}

function pathWithExpectedParent(filePath, expectedParentRealPath) {
  if (!expectedParentRealPath) return filePath
  return path.join(expectedParentRealPath, path.basename(filePath))
}

function normalizedFileMode(mode) {
  if (mode == null) return undefined
  const numeric = Number(mode)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric & 0o777 : undefined
}

function writeFileOptionsForMode(mode, encoding) {
  const normalized = normalizedFileMode(mode)
  if (normalized == null) return encoding
  return encoding ? { encoding, mode: normalized } : { mode: normalized }
}

async function chmodIfSupported(fsImpl, filePath, mode) {
  const normalized = normalizedFileMode(mode)
  if (normalized == null || typeof fsImpl?.chmod !== "function") return
  await fsImpl.chmod(filePath, normalized)
}

async function chmodIfSupportedBestEffort(fsImpl, filePath, mode) {
  await chmodIfSupported(fsImpl, filePath, mode).catch(() => {})
}

async function writeFileAndSync(fsImpl, filePath, contents, { mode, encoding } = {}) {
  const normalized = normalizedFileMode(mode)
  if (typeof fsImpl?.open !== "function") {
    await fsImpl.writeFile(filePath, contents, writeFileOptionsForMode(mode, encoding))
    await chmodIfSupported(fsImpl, filePath, mode)
    return
  }

  const handle = await fsImpl.open(filePath, "w", normalized)
  try {
    await handle.writeFile(contents, encoding)
    if (normalized != null) {
      if (typeof handle.chmod === "function") await handle.chmod(normalized)
      else await chmodIfSupported(fsImpl, filePath, normalized)
    }
    if (typeof handle.sync !== "function") {
      const err = new Error(`Cannot durably write '${filePath}'; file handle does not support sync().`)
      err.code = "ENOTSUP"
      throw err
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function directorySyncUnsupported(err) {
  return hasCode(err, "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EBADF")
}

async function syncParentDirectory(fsImpl, filePath, { platform = process.platform } = {}) {
  // Windows does not provide a portable directory fsync through Node. The
  // already-synced temp file and recoverable replacement backup remain the
  // strongest available guarantee there.
  if (platform === "win32" || typeof fsImpl?.open !== "function") return false

  let handle
  try {
    handle = await fsImpl.open(path.dirname(filePath), "r")
    if (typeof handle.sync !== "function") return false
    await handle.sync()
    return true
  } catch (err) {
    if (directorySyncUnsupported(err)) return false
    throw err
  } finally {
    await handle?.close?.()
  }
}

async function syncFilePath(fsImpl, filePath) {
  if (typeof fsImpl?.open !== "function") return false
  const handle = await fsImpl.open(filePath, "r")
  try {
    if (typeof handle.sync !== "function") return false
    await handle.sync()
    return true
  } finally {
    await handle.close()
  }
}

function comparablePath(value) {
  const normalized = path.normalize(String(value || ""))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function parentChangedError(filePath) {
  const err = new Error(`Parent directory changed while writing '${filePath}'.`)
  err.code = "EPARENTCHANGED"
  return err
}

async function assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath) {
  if (!expectedParentRealPath || typeof fsImpl?.realpath !== "function") return
  const actual = await fsImpl.realpath(path.dirname(filePath))
  if (comparablePath(actual) !== comparablePath(expectedParentRealPath)) {
    throw parentChangedError(filePath)
  }
}

function emergencyBackupPrefix(filePath) {
  return `${path.basename(filePath)}.bak.`
}

async function listEmergencyStateBackups(filePath, { fsImpl = fs } = {}) {
  const dir = path.dirname(filePath)
  const prefix = emergencyBackupPrefix(filePath)
  let names
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
      stat = await fsImpl.stat(backupPath)
    } catch (err) {
      if (!hasCode(err, "ENOENT")) throw err
      continue
    }
    if (stat?.isFile && !stat.isFile()) continue
    backups.push({ path: backupPath, name, mtimeMs: Number(stat?.mtimeMs) || 0 })
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  return backups
}

async function recoverEmergencyJsonBackup(filePath, { fsImpl = fs, mode } = {}) {
  const backups = await listEmergencyStateBackups(filePath, { fsImpl })
  if (backups.length === 0) return null

  const backup = backups[0]
  let parsed
  try {
    const txt = await fsImpl.readFile(backup.path, "utf8")
    parsed = JSON.parse(txt)
  } catch (err) {
    throw new Error(
      `State file ${filePath} is missing, and emergency backup ${backup.path} could not be loaded (${err?.message || String(err)}). Refusing to start with empty state.`,
      { cause: err },
    )
  }

  try {
    if (typeof fsImpl?.lstat === "function") {
      try {
        await fsImpl.lstat(filePath)
        const err = new Error(`State file ${filePath} read as missing but restore target exists. Refusing to overwrite it.`)
        err.code = "EEXIST"
        throw err
      } catch (err) {
        if (!hasCode(err, "ENOENT")) throw err
      }
    }
    const exclusiveCopyFlag = fsImpl?.constants?.COPYFILE_EXCL ?? fsConstants?.COPYFILE_EXCL
    await fsImpl.copyFile(backup.path, filePath, exclusiveCopyFlag)
    await chmodIfSupportedBestEffort(fsImpl, filePath, mode)
  } catch (err) {
    throw new Error(
      `State file ${filePath} is missing, and emergency backup ${backup.path} could not be restored (${err?.message || String(err)}). Refusing to start with empty state.`,
      { cause: err },
    )
  }
  return parsed
}

async function listStateBackups(filePath, { fsImpl = fs, expectedParentRealPath } = {}) {
  const dir = path.dirname(pathWithExpectedParent(filePath, expectedParentRealPath))
  const prefix = backupPrefix(filePath)
  let names
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  try {
    names = await fsImpl.readdir(dir)
  } catch (err) {
    if (hasCode(err, "ENOENT", "ENOTDIR")) {
      if (expectedParentRealPath) throw parentChangedError(filePath)
      return []
    }
    throw err
  }
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)

  const backups = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const backupPath = path.join(dir, name)
    let stat = null
    await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
    try {
      stat = await fsImpl.stat(backupPath)
    } catch (err) {
      if (!hasCode(err, "ENOENT")) throw err
      continue
    }
    if (stat?.isFile && !stat.isFile()) continue
    backups.push({ path: backupPath, name, mtimeMs: Number(stat?.mtimeMs) || 0 })
  }
  return backups
}

export async function rotateStateFileBackups(filePath, { maxBackups = DEFAULT_STATE_BACKUP_MAX_FILES, fsImpl = fs, expectedParentRealPath } = {}) {
  const keep = Math.max(0, Number.isFinite(Number(maxBackups)) ? Math.trunc(Number(maxBackups)) : DEFAULT_STATE_BACKUP_MAX_FILES)
  const backups = await listStateBackups(filePath, { fsImpl, expectedParentRealPath })
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  const removed = []
  for (const backup of backups.slice(keep)) {
    await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
    await unlinkIfExists(fsImpl, backup.path)
    removed.push(backup.path)
  }
  return { kept: backups.slice(0, keep).map((entry) => entry.path), removed }
}

export async function createStateFileBackup(
  filePath,
  options = {},
) {
  const {
    reason = "state",
    schemaVersion,
    maxBackups = DEFAULT_STATE_BACKUP_MAX_FILES,
    fsImpl = fs,
    now = new Date(),
    mode,
    expectedParentRealPath,
  } = options
  const operationFilePath = pathWithExpectedParent(filePath, expectedParentRealPath)
  const dir = path.dirname(operationFilePath)
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await fsImpl.mkdir(dir, { recursive: true })
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  const versionLabel = schemaVersion == null ? "unknown" : `v${cleanBackupLabel(schemaVersion, "unknown")}`
  const suffix = [backupTimestamp(now), cleanBackupLabel(reason, "state"), versionLabel, crypto.randomBytes(4).toString("hex")].join(".")
  const backupPath = path.join(dir, `${backupPrefix(filePath)}${suffix}`)
  const contents = Object.hasOwn(options, "contents") ? options.contents : await fsImpl.readFile(operationFilePath)
  await fsImpl.writeFile(backupPath, contents, writeFileOptionsForMode(mode))
  await chmodIfSupported(fsImpl, backupPath, mode)
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await rotateStateFileBackups(filePath, { maxBackups, fsImpl, expectedParentRealPath })
  return backupPath
}

async function replaceFileWithoutLosingExisting(fsImpl, sourcePath, targetPath) {
  const backupPath = `${targetPath}.bak.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  let hasBackup = false
  let replaced = false

  try {
    await fsImpl.rename(targetPath, backupPath)
    hasBackup = true
  } catch (err) {
    if (!hasCode(err, "ENOENT")) throw err
  }

  try {
    await fsImpl.rename(sourcePath, targetPath)
    replaced = true
  } catch (err) {
    if (hasBackup) {
      try {
        await fsImpl.rename(backupPath, targetPath)
        hasBackup = false
      } catch {
        // Preserve the backup file if restore fails; losing the previous state is worse.
      }
    }
    throw err
  } finally {
    if (hasBackup && replaced) {
      await unlinkIfExists(fsImpl, backupPath).catch(() => {})
    }
  }
}

async function commitNewFileWithoutOverwrite(fsImpl, sourcePath, targetPath) {
  if (typeof fsImpl?.link === "function") {
    try {
      await fsImpl.link(sourcePath, targetPath)
      return "link"
    } catch (err) {
      if (hasCode(err, "EEXIST", "ENOENT", "ENOTDIR")) throw err
    }
  }
  const exclusiveCopyFlag = fsImpl?.constants?.COPYFILE_EXCL ?? fsConstants?.COPYFILE_EXCL
  if (typeof fsImpl?.copyFile === "function" && exclusiveCopyFlag != null) {
    await fsImpl.copyFile(sourcePath, targetPath, exclusiveCopyFlag)
    return "copy"
  }

  const err = new Error(
    `Cannot safely create '${targetPath}' without overwriting; fs implementation does not support link or exclusive copyFile.`,
  )
  err.code = "ENOTSUP"
  throw err
}

export async function readJsonFile(filePath, { fsImpl = fs, mode } = {}) {
  try {
    const txt = await fsImpl.readFile(filePath, "utf8")
    return JSON.parse(txt)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return recoverEmergencyJsonBackup(filePath, { fsImpl, mode })
    throw err
  }
}

export async function writeJsonFileAtomic(filePath, data, { fsImpl = fs, mode, expectedParentRealPath, overwrite = true, platform = process.platform } = {}) {
  const operationFilePath = pathWithExpectedParent(filePath, expectedParentRealPath)
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await fsImpl.mkdir(path.dirname(operationFilePath), { recursive: true })
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  const tmp = `${operationFilePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  try {
    await writeFileAndSync(fsImpl, tmp, JSON.stringify(data, null, 2) + "\n", { mode, encoding: "utf8" })
    await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
    if (overwrite === false) {
      const commitMethod = await commitNewFileWithoutOverwrite(fsImpl, tmp, operationFilePath)
      if (commitMethod === "copy") await syncFilePath(fsImpl, operationFilePath)
      await chmodIfSupportedBestEffort(fsImpl, operationFilePath, mode)
      await syncParentDirectory(fsImpl, operationFilePath, { platform })
      return
    }
    try {
      await fsImpl.rename(tmp, operationFilePath)
    } catch (err) {
      // Windows may not allow overwrite; preserve the current file before retrying.
      if (hasCode(err, "EEXIST", "EPERM", "EACCES")) {
        await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
        await replaceFileWithoutLosingExisting(fsImpl, tmp, operationFilePath)
        await chmodIfSupportedBestEffort(fsImpl, operationFilePath, mode)
        await syncParentDirectory(fsImpl, operationFilePath, { platform })
        return
      }
      throw err
    }
    await chmodIfSupportedBestEffort(fsImpl, operationFilePath, mode)
    await syncParentDirectory(fsImpl, operationFilePath, { platform })
  } finally {
    await unlinkIfExists(fsImpl, tmp).catch(() => {})
  }
}
