import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const verifyScript = fileURLToPath(new URL("../scripts/verify-callback-data.mjs", import.meta.url))

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-callback-guard-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("callback data guard rejects raw callback payload literals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = `s|${projectAlias}|${sessionId}`\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw callback payload literal/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard rejects line-wrapped raw callback payload literals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = `s|${projectAlias}|${\n  sessionId\n}`\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw callback payload literal/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard allows encoded callback usage", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "good.js"), "const button = { callback_data: packCallback(\"s\", projectAlias, sessionId) }\n", "utf8")

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})
