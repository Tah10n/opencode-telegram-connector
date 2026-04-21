import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

export async function readJsonFile(filePath) {
  try {
    const txt = await fs.readFile(filePath, "utf8")
    return JSON.parse(txt)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null
    throw err
  }
}

export async function writeJsonFileAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    // Windows may not allow overwrite; try replace.
    if (err && typeof err === "object" && "code" in err) {
      if (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EACCES") {
        try {
          await fs.unlink(filePath)
        } catch {}
        await fs.rename(tmp, filePath)
        return
      }
    }
    throw err
  }
}
