import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { createStateFileBackup, readJsonFile, rotateStateFileBackups, writeJsonFileAtomic } from "../src/state/fileStore.js"

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-filestore-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("writeJsonFileAtomic restores the previous file if Windows replacement fails", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map([[filePath, '{"old":true}\n']])
  let tmpPath = null
  let backupPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async rename(from, to) {
      if (from === tmpPath && to === filePath && backupPath == null) {
        const err = new Error("initial rename blocked")
        err.code = "EPERM"
        throw err
      }
      if (from === filePath) {
        backupPath = to
        files.set(to, files.get(from))
        files.delete(from)
        return
      }
      if (from === tmpPath && to === filePath) {
        throw new Error("replace failed")
      }
      if (from === backupPath && to === filePath) {
        files.set(to, files.get(from))
        files.delete(from)
        return
      }
      throw new Error(`Unexpected rename: ${from} -> ${to}`)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await assert.rejects(() => writeJsonFileAtomic(filePath, { next: true }, { fsImpl }), /replace failed/)

  assert.equal(files.get(filePath), '{"old":true}\n')
  assert.equal(files.size, 1)
  assert.ok(backupPath)
})

test("writeJsonFileAtomic replaces an existing file and removes the backup on success", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map([[filePath, '{"old":true}\n']])
  let tmpPath = null
  let backupPath = null
  const unlinkCalls = []

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async rename(from, to) {
      if (from === tmpPath && to === filePath && backupPath == null) {
        const err = new Error("initial rename blocked")
        err.code = "EPERM"
        throw err
      }
      if (from === filePath) {
        backupPath = to
        files.set(to, files.get(from))
        files.delete(from)
        return
      }
      if (from === tmpPath && to === filePath) {
        files.set(to, files.get(from))
        files.delete(from)
        return
      }
      throw new Error(`Unexpected rename: ${from} -> ${to}`)
    },
    async unlink(targetPath) {
      unlinkCalls.push(targetPath)
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl })

  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.size, 1)
  assert.ok(backupPath)
  assert.deepEqual(unlinkCalls, [backupPath, tmpPath])
})

test("writeJsonFileAtomic tolerates a missing target during Windows fallback replacement", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map()
  let tmpPath = null
  let firstTmpRename = true

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async rename(from, to) {
      if (from === tmpPath && to === filePath) {
        if (firstTmpRename) {
          firstTmpRename = false
          const err = new Error("initial rename blocked")
          err.code = "EPERM"
          throw err
        }
        files.set(to, files.get(from))
        files.delete(from)
        return
      }
      if (from === filePath) {
        files.delete(from)
        const err = new Error("gone")
        err.code = "ENOENT"
        throw err
      }
      throw new Error(`Unexpected rename: ${from} -> ${to}`)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl })

  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.size, 1)
})

test("writeJsonFileAtomic honors explicit file modes", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map()
  const modes = new Map()
  const writeCalls = []
  const chmodCalls = []
  let tmpPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents, options) {
      files.set(targetPath, contents)
      if (options && typeof options === "object" && "mode" in options) modes.set(targetPath, options.mode)
      writeCalls.push({ targetPath, options })
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async chmod(targetPath, mode) {
      modes.set(targetPath, mode)
      chmodCalls.push({ targetPath, mode })
    },
    async rename(from, to) {
      files.set(to, files.get(from))
      modes.set(to, modes.get(from))
      files.delete(from)
      modes.delete(from)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
      modes.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, mode: 0o640 })

  assert.deepEqual(writeCalls.map((call) => call.options), [{ encoding: "utf8", mode: 0o640 }])
  assert.deepEqual(chmodCalls, [
    { targetPath: tmpPath, mode: 0o640 },
    { targetPath: filePath, mode: 0o640 },
  ])
  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(modes.get(filePath), 0o640)
})

test("writeJsonFileAtomic treats post-commit target chmod as best effort", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map([[filePath, '{"old":true}\n']])
  const renameCalls = []
  let tmpPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async chmod(targetPath) {
      if (targetPath === filePath) {
        const err = new Error("target chmod denied")
        err.code = "EACCES"
        throw err
      }
    },
    async rename(from, to) {
      renameCalls.push({ from, to })
      if (from !== tmpPath || to !== filePath) throw new Error(`Unexpected fallback rename: ${from} -> ${to}`)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, mode: 0o640 })

  assert.deepEqual(renameCalls, [{ from: tmpPath, to: filePath }])
  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.has(tmpPath), false)
})

test("writeJsonFileAtomic treats post-fallback target chmod as best effort", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map([[filePath, '{"old":true}\n']])
  let tmpPath = null
  let firstRename = true

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async chmod(targetPath) {
      if (targetPath === filePath) {
        const err = new Error("target chmod denied")
        err.code = "EACCES"
        throw err
      }
    },
    async rename(from, to) {
      if (firstRename && from === tmpPath && to === filePath) {
        firstRename = false
        const err = new Error("replace denied")
        err.code = "EPERM"
        throw err
      }
      if (!files.has(from)) throw new Error(`Missing source: ${from}`)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, mode: 0o640 })

  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.has(tmpPath), false)
})

test("writeJsonFileAtomic overwrite false copyFile fallback does not overwrite concurrent targets", async () => {
  const filePath = "C:/tmp/state.json"
  const concurrent = '{"concurrent":true}\n'
  const files = new Map()
  const unlinkCalls = []
  let tmpPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async copyFile(from, to, mode) {
      assert.equal(from, tmpPath)
      assert.equal(to, filePath)
      assert.equal(mode, fsConstants.COPYFILE_EXCL)
      files.set(filePath, concurrent)
      const err = new Error("target exists")
      err.code = "EEXIST"
      throw err
    },
    async stat() {
      throw new Error("stat should not be called")
    },
    async rename() {
      throw new Error("rename should not be called")
    },
    async unlink(targetPath) {
      unlinkCalls.push(targetPath)
      files.delete(targetPath)
    },
  }

  await assert.rejects(() => writeJsonFileAtomic(filePath, { next: true }, { fsImpl, overwrite: false }), (err) => err.code === "EEXIST")

  assert.equal(files.get(filePath), concurrent)
  assert.equal(files.has(tmpPath), false)
  assert.deepEqual(unlinkCalls, [tmpPath])
})

test("writeJsonFileAtomic overwrite false falls back to exclusive copy when hard links are unsupported", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map()
  let tmpPath = null
  const linkError = new Error("hard links unsupported")
  linkError.code = "ENOTSUP"

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async link() {
      throw linkError
    },
    async copyFile(from, to, mode) {
      assert.equal(from, tmpPath)
      assert.equal(to, filePath)
      assert.equal(mode, fsConstants.COPYFILE_EXCL)
      files.set(to, files.get(from))
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, overwrite: false })

  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.has(tmpPath), false)
})

test("writeJsonFileAtomic overwrite false falls back to exclusive copy when hard links are denied", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map()
  let tmpPath = null
  const linkError = new Error("hard link denied by filesystem policy")
  linkError.code = "EPERM"

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async link() {
      throw linkError
    },
    async copyFile(from, to, mode) {
      assert.equal(from, tmpPath)
      assert.equal(to, filePath)
      assert.equal(mode, fsConstants.COPYFILE_EXCL)
      files.set(to, files.get(from))
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, overwrite: false })

  assert.equal(files.get(filePath), '{\n  "next": true\n}\n')
  assert.equal(files.has(tmpPath), false)
})

test("writeJsonFileAtomic overwrite false does not copy after hard link target conflicts", async () => {
  const filePath = "C:/tmp/state.json"
  const concurrent = '{"concurrent":true}\n'
  const files = new Map()
  const unlinkCalls = []
  let tmpPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async link(from, to) {
      assert.equal(from, tmpPath)
      assert.equal(to, filePath)
      files.set(filePath, concurrent)
      const err = new Error("target exists")
      err.code = "EEXIST"
      throw err
    },
    async copyFile() {
      throw new Error("copyFile should not be called after EEXIST")
    },
    async unlink(targetPath) {
      unlinkCalls.push(targetPath)
      files.delete(targetPath)
    },
  }

  await assert.rejects(() => writeJsonFileAtomic(filePath, { next: true }, { fsImpl, overwrite: false }), (err) => err.code === "EEXIST")

  assert.equal(files.get(filePath), concurrent)
  assert.equal(files.has(tmpPath), false)
  assert.deepEqual(unlinkCalls, [tmpPath])
})

test("writeJsonFileAtomic uses the verified real parent for final writes", async () => {
  const logicalDir = path.normalize("C:/link/project")
  const realDir = path.normalize("C:/real/project")
  const filePath = path.join(logicalDir, "state.json")
  const stablePath = path.join(realDir, "state.json")
  const files = new Map()
  let tmpPath = null

  const fsImpl = {
    async realpath(targetPath) {
      if (path.normalize(targetPath) === logicalDir) return realDir
      throw new Error(`Unexpected realpath: ${targetPath}`)
    },
    async mkdir(targetPath) {
      assert.equal(path.normalize(targetPath), realDir)
    },
    async writeFile(targetPath, contents) {
      assert.ok(path.normalize(targetPath).startsWith(`${stablePath}.tmp.`))
      tmpPath = targetPath
      files.set(targetPath, contents)
    },
    async rename(from, to) {
      assert.equal(from, tmpPath)
      assert.equal(path.normalize(to), stablePath)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async unlink(targetPath) {
      files.delete(targetPath)
    },
  }

  await writeJsonFileAtomic(filePath, { next: true }, { fsImpl, expectedParentRealPath: realDir })

  assert.equal(files.get(stablePath), '{\n  "next": true\n}\n')
  assert.equal(files.has(filePath), false)
  assert.equal(files.has(tmpPath), false)
})

test("writeJsonFileAtomic overwrite false fails closed without exclusive create primitives", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map()
  const unlinkCalls = []
  let tmpPath = null

  const fsImpl = {
    async mkdir() {},
    async writeFile(targetPath, contents) {
      files.set(targetPath, contents)
      if (targetPath !== filePath) tmpPath = targetPath
    },
    async stat() {
      throw new Error("stat should not be called")
    },
    async rename() {
      throw new Error("rename should not be called")
    },
    async unlink(targetPath) {
      unlinkCalls.push(targetPath)
      files.delete(targetPath)
    },
  }

  await assert.rejects(
    () => writeJsonFileAtomic(filePath, { next: true }, { fsImpl, overwrite: false }),
    (err) => err.code === "ENOTSUP" && /does not support link or exclusive copyFile/.test(err.message),
  )

  assert.equal(files.has(filePath), false)
  assert.equal(files.has(tmpPath), false)
  assert.deepEqual(unlinkCalls, [tmpPath])
})

test("readJsonFile returns null for missing files and surfaces parse errors", async () => {
  const dir = await makeTempDir()
  const missingPath = path.join(dir, "missing.json")
  const missingParentPath = path.join(dir, "missing-parent", "state.json")
  const invalidPath = path.join(dir, "invalid.json")
  await fs.writeFile(invalidPath, "{ nope", "utf8")

  assert.equal(await readJsonFile(missingPath), null)
  assert.equal(await readJsonFile(missingParentPath), null)
  await assert.rejects(() => readJsonFile(invalidPath), /Expected property name|Unexpected token/)
})

test("readJsonFile restores an emergency bak file when the canonical state is missing", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const backupPath = `${filePath}.bak.123456.abcdef123456`
  await fs.writeFile(backupPath, JSON.stringify({ schemaVersion: 5, updateOffset: 42 }, null, 2), "utf8")

  const loaded = await readJsonFile(filePath)

  assert.deepEqual(loaded, { schemaVersion: 5, updateOffset: 42 })
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { schemaVersion: 5, updateOffset: 42 })
})

test("readJsonFile refuses emergency restore when the missing state path still exists", async () => {
  const filePath = "C:/tmp/state.json"
  const backupPath = `${filePath}.bak.123456.abcdef123456`
  const files = new Map([[backupPath, JSON.stringify({ schemaVersion: 5 })]])
  let copyCalled = false

  const fsImpl = {
    async readdir(targetPath) {
      assert.equal(path.normalize(targetPath), path.normalize("C:/tmp"))
      return [path.basename(backupPath)]
    },
    async stat(targetPath) {
      assert.equal(path.normalize(targetPath), path.normalize(backupPath))
      return { isFile: () => true, mtimeMs: 1 }
    },
    async readFile(targetPath) {
      if (targetPath === filePath) {
        const err = new Error("dangling symlink target missing")
        err.code = "ENOENT"
        throw err
      }
      if (path.normalize(targetPath) === path.normalize(backupPath)) return files.get(backupPath)
      throw new Error(`Unexpected readFile: ${targetPath}`)
    },
    async lstat(targetPath) {
      assert.equal(targetPath, filePath)
      return { isSymbolicLink: () => true }
    },
    async copyFile() {
      copyCalled = true
      throw new Error("copyFile should not be called")
    },
  }

  await assert.rejects(
    () => readJsonFile(filePath, { fsImpl }),
    /read as missing but restore target exists.*Refusing to start with empty state/,
  )
  assert.equal(copyCalled, false)
})

test("readJsonFile restores emergency backups with exclusive create semantics", async () => {
  const filePath = "C:/tmp/state.json"
  const backupPath = `${filePath}.bak.123456.abcdef123456`
  const files = new Map([[backupPath, JSON.stringify({ schemaVersion: 5 })]])
  const copyCalls = []

  const fsImpl = {
    async readdir(targetPath) {
      assert.equal(path.normalize(targetPath), path.normalize("C:/tmp"))
      return [path.basename(backupPath)]
    },
    async stat(targetPath) {
      assert.equal(path.normalize(targetPath), path.normalize(backupPath))
      return { isFile: () => true, mtimeMs: 1 }
    },
    async readFile(targetPath) {
      if (targetPath === filePath) {
        const err = new Error("state missing")
        err.code = "ENOENT"
        throw err
      }
      if (path.normalize(targetPath) === path.normalize(backupPath)) return files.get(backupPath)
      throw new Error(`Unexpected readFile: ${targetPath}`)
    },
    async lstat(targetPath) {
      assert.equal(targetPath, filePath)
      const err = new Error("not found")
      err.code = "ENOENT"
      throw err
    },
    async copyFile(sourcePath, targetPath, flags) {
      copyCalls.push({ sourcePath, targetPath, flags })
      const err = new Error("concurrent state file creation")
      err.code = "EEXIST"
      throw err
    },
  }

  await assert.rejects(
    () => readJsonFile(filePath, { fsImpl }),
    /could not be restored.*concurrent state file creation.*Refusing to start with empty state/,
  )
  assert.deepEqual(copyCalls, [{ sourcePath: path.normalize(backupPath), targetPath: filePath, flags: fsConstants.COPYFILE_EXCL }])
})

test("readJsonFile fails closed when only an invalid emergency bak exists", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  const backupPath = `${filePath}.bak.123456.abcdef123456`
  await fs.writeFile(backupPath, "{not-json", "utf8")

  await assert.rejects(() => readJsonFile(filePath), /emergency backup.*could not be loaded.*Refusing to start with empty state/)
  await assert.rejects(() => fs.readFile(filePath, "utf8"), /ENOENT/)
})

test("createStateFileBackup copies state files and rotates old backups", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, '{"schemaVersion":1}\n', "utf8")

  const backup1 = await createStateFileBackup(filePath, { reason: "migration", schemaVersion: 1, maxBackups: 2, now: new Date("2026-01-01T00:00:00.000Z") })
  await fs.writeFile(filePath, '{"schemaVersion":2}\n', "utf8")
  const backup2 = await createStateFileBackup(filePath, { reason: "migration", schemaVersion: 2, maxBackups: 2, now: new Date("2026-01-01T00:00:01.000Z") })
  await fs.writeFile(filePath, '{"schemaVersion":3}\n', "utf8")
  const backup3 = await createStateFileBackup(filePath, { reason: "migration", schemaVersion: 3, maxBackups: 2, now: new Date("2026-01-01T00:00:02.000Z") })

  assert.equal(await fs.readFile(backup2, "utf8"), '{"schemaVersion":2}\n')
  assert.equal(await fs.readFile(backup3, "utf8"), '{"schemaVersion":3}\n')
  await assert.rejects(() => fs.readFile(backup1, "utf8"), /ENOENT/)
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup."))
  assert.equal(backups.length, 2)
})

test("createStateFileBackup honors explicit file modes", async () => {
  const filePath = "C:/tmp/state.json"
  const files = new Map([[filePath, "{\"schemaVersion\":1}\n"]])
  const modes = new Map()
  const writeCalls = []
  const chmodCalls = []

  const fsImpl = {
    async mkdir() {},
    async readFile(targetPath) {
      if (!files.has(targetPath)) {
        const err = new Error("not found")
        err.code = "ENOENT"
        throw err
      }
      return files.get(targetPath)
    },
    async writeFile(targetPath, contents, options) {
      files.set(targetPath, contents)
      if (options && typeof options === "object" && "mode" in options) modes.set(targetPath, options.mode)
      writeCalls.push({ targetPath, options })
    },
    async chmod(targetPath, mode) {
      modes.set(targetPath, mode)
      chmodCalls.push({ targetPath, mode })
    },
    async readdir() {
      return []
    },
    async unlink(targetPath) {
      files.delete(targetPath)
      modes.delete(targetPath)
    },
  }

  const backupPath = await createStateFileBackup(filePath, { fsImpl, mode: 0o600, now: new Date("2026-01-01T00:00:00.000Z") })

  assert.deepEqual(writeCalls, [{ targetPath: backupPath, options: { mode: 0o600 } }])
  assert.deepEqual(chmodCalls, [{ targetPath: backupPath, mode: 0o600 }])
  assert.equal(files.get(backupPath), files.get(filePath))
  assert.equal(modes.get(backupPath), 0o600)
})

test("rotateStateFileBackups can remove all backups when max is zero", async () => {
  const dir = await makeTempDir()
  const filePath = path.join(dir, "state.json")
  await fs.writeFile(filePath, "{}\n", "utf8")
  await createStateFileBackup(filePath, { reason: "invalid", maxBackups: 3 })
  await createStateFileBackup(filePath, { reason: "migration", maxBackups: 3 })

  const result = await rotateStateFileBackups(filePath, { maxBackups: 0 })

  assert.equal(result.kept.length, 0)
  assert.equal(result.removed.length, 2)
  const backups = (await fs.readdir(dir)).filter((name) => name.startsWith("state.json.backup."))
  assert.equal(backups.length, 0)
})

test("rotateStateFileBackups aborts before listing when expected parent changes", async () => {
  const logicalDir = path.normalize("C:/link/project")
  const realDir = path.normalize("C:/real/project")
  const changedDir = path.normalize("C:/other/project")
  const filePath = path.join(logicalDir, "state.json")
  let readdirCalls = 0

  const fsImpl = {
    async realpath(targetPath) {
      if (path.normalize(targetPath) === logicalDir) return changedDir
      throw new Error(`Unexpected realpath: ${targetPath}`)
    },
    async readdir() {
      readdirCalls += 1
      throw new Error("readdir should not be called")
    },
  }

  await assert.rejects(
    () => rotateStateFileBackups(filePath, { fsImpl, expectedParentRealPath: realDir }),
    (err) => err.code === "EPARENTCHANGED",
  )
  assert.equal(readdirCalls, 0)
})

test("rotateStateFileBackups aborts before unlink when expected parent changes after listing", async () => {
  const logicalDir = path.normalize("C:/link/project")
  const realDir = path.normalize("C:/real/project")
  const changedDir = path.normalize("C:/other/project")
  const filePath = path.join(logicalDir, "state.json")
  const backupName = "state.json.backup.2026-01-01T00-00-00-000Z.state.v1.abcdef12"
  let parentChanged = false
  let unlinkCalls = 0

  const fsImpl = {
    async realpath(targetPath) {
      if (path.normalize(targetPath) === logicalDir) return parentChanged ? changedDir : realDir
      throw new Error(`Unexpected realpath: ${targetPath}`)
    },
    async readdir(targetPath) {
      assert.equal(path.normalize(targetPath), realDir)
      return [backupName]
    },
    async stat(targetPath) {
      assert.equal(path.normalize(targetPath), path.join(realDir, backupName))
      parentChanged = true
      return { isFile: () => true, mtimeMs: 1 }
    },
    async unlink() {
      unlinkCalls += 1
      throw new Error("unlink should not be called after parent change")
    },
  }

  await assert.rejects(
    () => rotateStateFileBackups(filePath, { maxBackups: 0, fsImpl, expectedParentRealPath: realDir }),
    (err) => err.code === "EPARENTCHANGED",
  )
  assert.equal(unlinkCalls, 0)
})

test("rotateStateFileBackups fails closed if verified parent disappears before listing", async () => {
  const logicalDir = path.normalize("C:/link/project")
  const realDir = path.normalize("C:/real/project")
  const filePath = path.join(logicalDir, "state.json")

  const fsImpl = {
    async realpath(targetPath) {
      if (path.normalize(targetPath) === logicalDir) return realDir
      throw new Error(`Unexpected realpath: ${targetPath}`)
    },
    async readdir(targetPath) {
      assert.equal(path.normalize(targetPath), realDir)
      const err = new Error("verified parent disappeared")
      err.code = "ENOENT"
      throw err
    },
  }

  await assert.rejects(
    () => rotateStateFileBackups(filePath, { fsImpl, expectedParentRealPath: realDir }),
    (err) => err.code === "EPARENTCHANGED",
  )
})
