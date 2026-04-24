import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
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

test("readJsonFile returns null for missing files and surfaces parse errors", async () => {
  const dir = await makeTempDir()
  const missingPath = path.join(dir, "missing.json")
  const invalidPath = path.join(dir, "invalid.json")
  await fs.writeFile(invalidPath, "{ nope", "utf8")

  assert.equal(await readJsonFile(missingPath), null)
  await assert.rejects(() => readJsonFile(invalidPath), /Expected property name|Unexpected token/)
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
