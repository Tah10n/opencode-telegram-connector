import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

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
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null
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
