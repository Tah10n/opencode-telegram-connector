import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { profileToPermissionConfig } from "../src/opencode/permissions-profile.js"
import {
  readOpenCodePermissionConfig,
  resolvePermissionConfigPath,
  writeOpenCodePermissionProfile,
} from "../src/opencode/permissions-config.js"

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-permissions-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("OpenCode permission config reader prefers existing opencode.jsonc and parses JSONC", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.jsonc")
  await fs.writeFile(
    configPath,
    [
      "{",
      "  // local OpenCode config",
      '  "permission": {',
      '    "*": "ask",',
      '    "edit": "allow",',
      "  },",
      "}",
    ].join("\n"),
    "utf8",
  )

  assert.equal(await resolvePermissionConfigPath({ directory: dir }), configPath)
  const result = await readOpenCodePermissionConfig({ directory: dir })

  assert.equal(result.ok, true)
  assert.equal(result.status, "ok")
  assert.equal(result.filePath, configPath)
  assert.deepEqual(result.permission, { "*": "ask", edit: "allow" })
  assert.equal(result.profile, "custom")
})

test("OpenCode permission config writer creates config when missing", async () => {
  const dir = await makeTempDir()
  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit")

  assert.equal(result.ok, true)
  assert.equal(result.filePath, path.join(dir, "opencode.json"))
  assert.equal(result.profile, "auto-edit")
  const written = JSON.parse(await fs.readFile(result.filePath, "utf8"))
  assert.equal(written.$schema, "https://opencode.ai/config.json")
  assert.deepEqual(written.permission, profileToPermissionConfig("auto-edit"))
})

test("OpenCode permission config writer backs up existing config and resets to default", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  await fs.writeFile(configPath, JSON.stringify({ permission: profileToPermissionConfig("suggest"), custom: true }, null, 2), "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "reset", { now: new Date("2026-05-20T00:00:00.000Z") })

  assert.equal(result.ok, true)
  assert.equal(result.profile, "opencode-default")
  assert.match(path.basename(result.backupPath), /^opencode\.json\.backup\./)
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), { custom: true })
  const backup = JSON.parse(await fs.readFile(result.backupPath, "utf8"))
  assert.deepEqual(backup.permission, profileToPermissionConfig("suggest"))
})

test("OpenCode permission config writer does not create a missing config on reset", async () => {
  const dir = await makeTempDir()
  const result = await writeOpenCodePermissionProfile({ directory: dir }, "reset")

  assert.equal(result.ok, true)
  assert.equal(result.status, "missing")
  assert.equal(result.profile, "opencode-default")
  await assert.rejects(fs.readFile(path.join(dir, "opencode.json"), "utf8"), /ENOENT/)
})

test("OpenCode permission config reader reports unavailable and disabled projects", async () => {
  assert.deepEqual(await readOpenCodePermissionConfig({ baseUrl: "http://127.0.0.1:4312" }), {
    ok: false,
    editable: false,
    status: "unavailable",
    filePath: "",
    config: null,
    permission: undefined,
    profile: "custom",
  })

  const disabled = await readOpenCodePermissionConfig({ directory: await makeTempDir(), permissionControl: { enabled: false } })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.editable, false)
  assert.equal(disabled.status, "disabled")
})
