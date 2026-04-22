import test from "node:test"
import assert from "node:assert/strict"
import { writeJsonFileAtomic } from "../src/state/fileStore.js"

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
