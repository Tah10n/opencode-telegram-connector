import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

export const DEFAULT_STATE_BACKUP_MAX_FILES = 5

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

function comparablePath(value) {
  const normalized = path.normalize(String(value || ""))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

async function assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath) {
  if (!expectedParentRealPath || typeof fsImpl?.realpath !== "function") return
  const actual = await fsImpl.realpath(path.dirname(filePath))
  if (comparablePath(actual) !== comparablePath(expectedParentRealPath)) {
    const err = new Error(`Parent directory changed while writing '${filePath}'.`)
    err.code = "EPARENTCHANGED"
    throw err
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
    if (hasCode(err, "ENOENT")) return []
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

async function recoverEmergencyJsonBackup(filePath, { fsImpl = fs } = {}) {
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
    await fsImpl.copyFile(backup.path, filePath)
  } catch (err) {
    throw new Error(
      `State file ${filePath} is missing, and emergency backup ${backup.path} could not be restored (${err?.message || String(err)}). Refusing to start with empty state.`,
      { cause: err },
    )
  }
  return parsed
}

async function listStateBackups(filePath, { fsImpl = fs } = {}) {
  const dir = path.dirname(filePath)
  const prefix = backupPrefix(filePath)
  let names
  try {
    names = await fsImpl.readdir(dir)
  } catch (err) {
    if (hasCode(err, "ENOENT")) return []
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
  return backups
}

export async function rotateStateFileBackups(filePath, { maxBackups = DEFAULT_STATE_BACKUP_MAX_FILES, fsImpl = fs } = {}) {
  const keep = Math.max(0, Number.isFinite(Number(maxBackups)) ? Math.trunc(Number(maxBackups)) : DEFAULT_STATE_BACKUP_MAX_FILES)
  const backups = await listStateBackups(filePath, { fsImpl })
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  const removed = []
  for (const backup of backups.slice(keep)) {
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
  const dir = path.dirname(filePath)
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await fsImpl.mkdir(dir, { recursive: true })
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  const versionLabel = schemaVersion == null ? "unknown" : `v${cleanBackupLabel(schemaVersion, "unknown")}`
  const suffix = [backupTimestamp(now), cleanBackupLabel(reason, "state"), versionLabel, crypto.randomBytes(4).toString("hex")].join(".")
  const backupPath = path.join(dir, `${backupPrefix(filePath)}${suffix}`)
  const contents = Object.hasOwn(options, "contents") ? options.contents : await fsImpl.readFile(filePath)
  await fsImpl.writeFile(backupPath, contents, writeFileOptionsForMode(mode))
  await chmodIfSupported(fsImpl, backupPath, mode)
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await rotateStateFileBackups(filePath, { maxBackups, fsImpl })
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
    await fsImpl.link(sourcePath, targetPath)
    return
  }
  try {
    await fsImpl.stat(targetPath)
    const err = new Error(`Target already exists: ${targetPath}`)
    err.code = "EEXIST"
    throw err
  } catch (err) {
    if (!hasCode(err, "ENOENT")) throw err
  }
  await fsImpl.rename(sourcePath, targetPath)
}

export async function readJsonFile(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf8")
    return JSON.parse(txt)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return recoverEmergencyJsonBackup(filePath)
    throw err
  }
}

export async function writeJsonFileAtomic(filePath, data, { fsImpl = fs, mode, expectedParentRealPath, overwrite = true } = {}) {
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  await fsImpl.mkdir(path.dirname(filePath), { recursive: true })
  await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  await fsImpl.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", writeFileOptionsForMode(mode, "utf8"))
  try {
    await chmodIfSupported(fsImpl, tmp, mode)
    await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
    if (overwrite === false) {
      await commitNewFileWithoutOverwrite(fsImpl, tmp, filePath)
      await chmodIfSupportedBestEffort(fsImpl, filePath, mode)
      return
    }
    try {
      await fsImpl.rename(tmp, filePath)
    } catch (err) {
      // Windows may not allow overwrite; preserve the current file before retrying.
      if (hasCode(err, "EEXIST", "EPERM", "EACCES")) {
        await assertExpectedParentRealPath(fsImpl, filePath, expectedParentRealPath)
        await replaceFileWithoutLosingExisting(fsImpl, tmp, filePath)
        await chmodIfSupportedBestEffort(fsImpl, filePath, mode)
        return
      }
      throw err
    }
    await chmodIfSupportedBestEffort(fsImpl, filePath, mode)
  } finally {
    await unlinkIfExists(fsImpl, tmp).catch(() => {})
  }
}
