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
  { reason = "state", schemaVersion, maxBackups = DEFAULT_STATE_BACKUP_MAX_FILES, fsImpl = fs, now = new Date() } = {},
) {
  const dir = path.dirname(filePath)
  await fsImpl.mkdir(dir, { recursive: true })
  const versionLabel = schemaVersion == null ? "unknown" : `v${cleanBackupLabel(schemaVersion, "unknown")}`
  const suffix = [backupTimestamp(now), cleanBackupLabel(reason, "state"), versionLabel, crypto.randomBytes(4).toString("hex")].join(".")
  const backupPath = path.join(dir, `${backupPrefix(filePath)}${suffix}`)
  const contents = await fsImpl.readFile(filePath)
  await fsImpl.writeFile(backupPath, contents)
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

export async function readJsonFile(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf8")
    return JSON.parse(txt)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return recoverEmergencyJsonBackup(filePath)
    throw err
  }
}

export async function writeJsonFileAtomic(filePath, data, { fsImpl = fs } = {}) {
  await fsImpl.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  await fsImpl.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  try {
    await fsImpl.rename(tmp, filePath)
  } catch (err) {
    // Windows may not allow overwrite; preserve the current file before retrying.
    if (hasCode(err, "EEXIST", "EPERM", "EACCES")) {
      await replaceFileWithoutLosingExisting(fsImpl, tmp, filePath)
      return
    }
    throw err
  } finally {
    await unlinkIfExists(fsImpl, tmp).catch(() => {})
  }
}
