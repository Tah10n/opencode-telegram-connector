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

function enoent(filePath) {
  const err = new Error(`not found: ${filePath}`)
  err.code = "ENOENT"
  return err
}

function makeFakePermissionConfigFs({ directories = [], files = {} } = {}) {
  const normalize = (filePath) => path.normalize(filePath)
  const dirs = new Set(directories.map(normalize))
  const fileEntries = new Map(Object.entries(files).map(([filePath, entry]) => [
    normalize(filePath),
    { text: String(entry.text ?? ""), mode: entry.mode, mtimeMs: entry.mtimeMs ?? 0 },
  ]))
  const chmodCalls = []
  let nextMtimeMs = 1

  function statFor(filePath) {
    const key = normalize(filePath)
    if (dirs.has(key)) {
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, mode: 0o755, mtimeMs: 0 }
    }
    const entry = fileEntries.get(key)
    if (entry) {
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: entry.mode, mtimeMs: entry.mtimeMs }
    }
    throw enoent(filePath)
  }

  const fsImpl = {
    async stat(filePath) {
      return statFor(filePath)
    },
    async lstat(filePath) {
      return statFor(filePath)
    },
    async realpath(filePath) {
      return normalize(filePath)
    },
    async mkdir(dirPath) {
      dirs.add(normalize(dirPath))
    },
    async readFile(filePath, encoding) {
      const entry = fileEntries.get(normalize(filePath))
      if (!entry) throw enoent(filePath)
      return encoding ? entry.text : Buffer.from(entry.text, "utf8")
    },
    async writeFile(filePath, contents, options) {
      const key = normalize(filePath)
      const mode = options && typeof options === "object" && "mode" in options ? options.mode : 0o666
      fileEntries.set(key, {
        text: Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents),
        mode,
        mtimeMs: nextMtimeMs++,
      })
    },
    async chmod(filePath, mode) {
      const key = normalize(filePath)
      const entry = fileEntries.get(key)
      if (!entry) throw enoent(filePath)
      entry.mode = mode
      chmodCalls.push({ filePath: key, mode })
    },
    async rename(from, to) {
      const fromKey = normalize(from)
      const entry = fileEntries.get(fromKey)
      if (!entry) throw enoent(from)
      fileEntries.set(normalize(to), entry)
      fileEntries.delete(fromKey)
    },
    async unlink(filePath) {
      const key = normalize(filePath)
      if (!fileEntries.delete(key)) throw enoent(filePath)
    },
    async readdir(dirPath) {
      const dirKey = normalize(dirPath)
      if (!dirs.has(dirKey)) throw enoent(dirPath)
      return Array.from(fileEntries.keys())
        .filter((filePath) => normalize(path.dirname(filePath)) === dirKey)
        .map((filePath) => path.basename(filePath))
    },
  }

  return {
    fsImpl,
    chmodCalls,
    textOf: (filePath) => fileEntries.get(normalize(filePath))?.text,
    setText: (filePath, text) => {
      const entry = fileEntries.get(normalize(filePath))
      if (!entry) throw enoent(filePath)
      entry.text = String(text)
      entry.mtimeMs = nextMtimeMs++
    },
    modeOf: (filePath) => fileEntries.get(normalize(filePath))?.mode,
  }
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

test("OpenCode permission config reader and writer prefer opencode.jsonc when both config files exist", async () => {
  const dir = await makeTempDir()
  const jsonPath = path.join(dir, "opencode.json")
  const jsoncPath = path.join(dir, "opencode.jsonc")
  const jsonText = JSON.stringify({ permission: profileToPermissionConfig("suggest"), jsonOnly: true }, null, 2)
  await fs.writeFile(jsonPath, jsonText, "utf8")
  await fs.writeFile(jsoncPath, JSON.stringify({ permission: profileToPermissionConfig("auto-edit"), jsoncOnly: true }, null, 2), "utf8")

  assert.equal(await resolvePermissionConfigPath({ directory: dir }), jsoncPath)
  const readResult = await readOpenCodePermissionConfig({ directory: dir })
  assert.equal(readResult.filePath, jsoncPath)
  assert.equal(readResult.profile, "auto-edit")

  const writeResult = await writeOpenCodePermissionProfile({ directory: dir }, "full-auto", { now: new Date("2026-05-20T00:00:00.000Z") })

  assert.equal(writeResult.ok, true)
  assert.equal(writeResult.filePath, jsoncPath)
  assert.equal(writeResult.profile, "full-auto")
  assert.equal(await fs.readFile(jsonPath, "utf8"), jsonText)
  assert.deepEqual(JSON.parse(await fs.readFile(jsoncPath, "utf8")).permission, profileToPermissionConfig("full-auto"))
  assert.match(path.basename(writeResult.backupPath), /^opencode\.jsonc\.backup\./)
  assert.deepEqual(JSON.parse(await fs.readFile(writeResult.backupPath, "utf8")).permission, profileToPermissionConfig("auto-edit"))
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

test("OpenCode permission config writer does not create implicit configs for missing project directories", async () => {
  const dir = path.join(await makeTempDir(), "missing-project")

  assert.equal(await resolvePermissionConfigPath({ directory: dir }), "")
  const readResult = await readOpenCodePermissionConfig({ directory: dir })
  assert.equal(readResult.status, "unavailable")
  assert.equal(readResult.editable, false)

  const writeResult = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit")
  assert.equal(writeResult.ok, false)
  assert.equal(writeResult.status, "unavailable")
  await assert.rejects(fs.stat(dir), /ENOENT/)
})

test("OpenCode permission config rejects implicit config targets that are not files", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  await fs.mkdir(configPath)

  assert.equal(await resolvePermissionConfigPath({ directory: dir }), "")
  const result = await writeOpenCodePermissionProfile({ directory: dir }, "suggest")

  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
})

test("OpenCode permission config writer skips unchanged profiles without rewriting JSONC", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.jsonc")
  const original = [
    "{",
    "  // keep local comments on no-op profile writes",
    '  "permission": ' + JSON.stringify(profileToPermissionConfig("suggest"), null, 2).replaceAll("\n", "\n  "),
    "}",
    "",
  ].join("\n")
  await fs.writeFile(configPath, original, "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "suggest")

  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.backupPath, "")
  assert.equal(await fs.readFile(configPath, "utf8"), original)
})

test("OpenCode permission config writer rewrites reordered built-in profiles", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  const fullAuto = profileToPermissionConfig("full-auto")
  const reorderedFullAuto = {
    ...Object.fromEntries(Object.entries(fullAuto).filter(([key]) => key !== "*")),
    "*": fullAuto["*"],
  }
  await fs.writeFile(configPath, JSON.stringify({ permission: reorderedFullAuto, custom: true }, null, 2), "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "full-auto", { now: new Date("2026-05-20T00:00:00.000Z") })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.profile, "full-auto")
  const written = JSON.parse(await fs.readFile(configPath, "utf8"))
  assert.equal(JSON.stringify(written.permission), JSON.stringify(profileToPermissionConfig("full-auto")))
  assert.equal(Object.keys(written.permission)[0], "*")
  assert.match(path.basename(result.backupPath), /^opencode\.json\.backup\./)
})

test("OpenCode permission config writer migrates legacy full-auto repo denials", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  const legacyFullAuto = profileToPermissionConfig("full-auto")
  delete legacyFullAuto.repo_clone
  delete legacyFullAuto.repo_overview
  await fs.writeFile(configPath, JSON.stringify({ permission: legacyFullAuto, custom: true }, null, 2), "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "full-auto", { now: new Date("2026-05-20T00:00:00.000Z") })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.profile, "full-auto")
  assert.equal(result.permission.repo_clone, "deny")
  assert.equal(result.permission.repo_overview, "deny")
  assert.match(path.basename(result.backupPath), /^opencode\.json\.backup\./)
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")).permission, profileToPermissionConfig("full-auto"))
  assert.deepEqual(JSON.parse(await fs.readFile(result.backupPath, "utf8")).permission, legacyFullAuto)
})

test("OpenCode permission config writer preserves existing config mode for rewrites and backups", async () => {
  const projectDir = process.platform === "win32" ? "C:/repo/project" : "/repo/project"
  const configPath = path.join(projectDir, "opencode.json")
  const { fsImpl, modeOf } = makeFakePermissionConfigFs({
    directories: [projectDir],
    files: {
      [configPath]: {
        text: JSON.stringify({ permission: profileToPermissionConfig("suggest"), custom: true }, null, 2),
        mode: 0o640,
      },
    },
  })

  const result = await writeOpenCodePermissionProfile({ directory: projectDir }, "auto-edit", {
    fsImpl,
    now: new Date("2026-05-20T00:00:00.000Z"),
  })

  assert.equal(result.ok, true)
  assert.equal(result.filePath, configPath)
  assert.equal(modeOf(configPath), 0o640)
  assert.equal(modeOf(result.backupPath), 0o640)
})

test("OpenCode permission config writer creates new configs with conservative mode", async () => {
  const projectDir = process.platform === "win32" ? "C:/repo/project" : "/repo/project"
  const configPath = path.join(projectDir, "opencode.json")
  const { fsImpl, modeOf, textOf } = makeFakePermissionConfigFs({ directories: [projectDir] })

  const result = await writeOpenCodePermissionProfile({ directory: projectDir }, "suggest", { fsImpl })

  assert.equal(result.ok, true)
  assert.equal(result.filePath, configPath)
  assert.equal(modeOf(configPath), 0o600)
  assert.deepEqual(JSON.parse(textOf(configPath)).permission, profileToPermissionConfig("suggest"))
})

test("OpenCode permission config writer skips reset when config is already default", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.jsonc")
  const original = [
    "{",
    "  // existing config without a permission override",
    '  "custom": true',
    "}",
    "",
  ].join("\n")
  await fs.writeFile(configPath, original, "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "reset")

  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.backupPath, "")
  assert.equal(result.profile, "opencode-default")
  assert.equal(await fs.readFile(configPath, "utf8"), original)
})

test("OpenCode permission config writer removes explicit null permission on reset", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  await fs.writeFile(configPath, JSON.stringify({ permission: null, custom: true }, null, 2), "utf8")

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "reset", { now: new Date("2026-05-20T00:00:00.000Z") })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.profile, "opencode-default")
  assert.equal(result.permission, undefined)
  assert.match(path.basename(result.backupPath), /^opencode\.json\.backup\./)
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), { custom: true })
  const backup = JSON.parse(await fs.readFile(result.backupPath, "utf8"))
  assert.equal(Object.hasOwn(backup, "permission"), true)
  assert.equal(backup.permission, null)
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

test("OpenCode permission config does not infer local paths from foreign project directories", async () => {
  const foreignDirectory = process.platform === "win32" ? "/srv/workspaces/app" : "C:/Workspaces/App"
  const explicitConfigPath = path.join(await makeTempDir(), "opencode.json")

  assert.equal(await resolvePermissionConfigPath({ directory: foreignDirectory }), "")
  assert.equal(await resolvePermissionConfigPath({ directory: foreignDirectory, permissionConfigPath: explicitConfigPath }), explicitConfigPath)
  assert.equal((await readOpenCodePermissionConfig({ directory: foreignDirectory })).status, "unavailable")
})

test("OpenCode permission config rejects unsafe explicit config paths", async () => {
  const root = await makeTempDir()
  const projectDir = path.join(root, "project")
  const outsideDir = path.join(root, "outside")
  await fs.mkdir(projectDir)
  await fs.mkdir(outsideDir)

  assert.equal(await resolvePermissionConfigPath({
    directory: projectDir,
    permissionConfigPath: path.join(projectDir, "opencode.remote.json"),
  }), "")
  assert.equal(await resolvePermissionConfigPath({
    directory: projectDir,
    permissionConfigPath: path.join(outsideDir, "opencode.json"),
  }), "")
  const foreignExplicitPath = process.platform === "win32" ? "/srv/project/opencode.json" : "C:/Project/opencode.json"
  assert.equal(await resolvePermissionConfigPath({
    directory: projectDir,
    permissionConfigPath: foreignExplicitPath,
  }), "")

  const writeResult = await writeOpenCodePermissionProfile({
    directory: projectDir,
    permissionConfigPath: path.join(outsideDir, "opencode.json"),
  }, "suggest")
  assert.equal(writeResult.ok, false)
  assert.equal(writeResult.status, "unavailable")
  await assert.rejects(fs.readFile(path.join(outsideDir, "opencode.json"), "utf8"), /ENOENT/)
})

test("OpenCode permission config allows explicit local paths for same-platform remote directories", async () => {
  const root = await makeTempDir()
  const missingRemoteDirectory = path.join(root, "remote-on-another-host")
  const localConfigDir = path.join(root, "local-config")
  await fs.mkdir(localConfigDir)
  const explicitConfigPath = path.join(localConfigDir, "opencode.json")

  assert.equal(await resolvePermissionConfigPath({
    directory: missingRemoteDirectory,
    permissionConfigPath: explicitConfigPath,
    permissionControl: { remoteDirectory: true },
  }), explicitConfigPath)

  const result = await writeOpenCodePermissionProfile({
    directory: missingRemoteDirectory,
    permissionConfigPath: explicitConfigPath,
    permissionControl: { remoteDirectory: true },
  }, "suggest")
  assert.equal(result.ok, true)
  assert.equal(result.filePath, explicitConfigPath)
  assert.deepEqual(JSON.parse(await fs.readFile(explicitConfigPath, "utf8")).permission, profileToPermissionConfig("suggest"))
  await assert.rejects(fs.stat(missingRemoteDirectory), /ENOENT/)
})

test("OpenCode permission config rejects missing local project directories without remote marker", async () => {
  const root = await makeTempDir()
  const missingProjectDirectory = path.join(root, "typo-local-project")
  const localConfigDir = path.join(root, "local-config")
  await fs.mkdir(localConfigDir)
  const explicitConfigPath = path.join(localConfigDir, "opencode.json")

  assert.equal(await resolvePermissionConfigPath({
    directory: missingProjectDirectory,
    permissionConfigPath: explicitConfigPath,
  }), "")

  const result = await writeOpenCodePermissionProfile({
    directory: missingProjectDirectory,
    permissionConfigPath: explicitConfigPath,
  }, "suggest")
  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  await assert.rejects(fs.readFile(explicitConfigPath, "utf8"), /ENOENT/)
})

test("OpenCode permission config rejects explicit paths when project directory is a local file", async () => {
  const root = await makeTempDir()
  const projectFile = path.join(root, "project-file")
  const outsideDir = path.join(root, "outside")
  await fs.writeFile(projectFile, "not a directory", "utf8")
  await fs.mkdir(outsideDir)
  const explicitConfigPath = path.join(outsideDir, "opencode.json")

  assert.equal(await resolvePermissionConfigPath({
    directory: projectFile,
    permissionConfigPath: explicitConfigPath,
  }), "")

  const result = await writeOpenCodePermissionProfile({
    directory: projectFile,
    permissionConfigPath: explicitConfigPath,
  }, "suggest")
  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  await assert.rejects(fs.readFile(explicitConfigPath, "utf8"), /ENOENT/)
})

test("OpenCode permission config rejects explicit paths escaping project dir through symlinks", async (t) => {
  const root = await makeTempDir()
  const projectDir = path.join(root, "project")
  const outsideDir = path.join(root, "outside")
  const linkDir = path.join(projectDir, "linked-config")
  await fs.mkdir(projectDir)
  await fs.mkdir(outsideDir)
  try {
    await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir")
  } catch (err) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(err?.code)) {
      t.skip(`symlinks unavailable: ${err.code}`)
      return
    }
    throw err
  }

  const explicitConfigPath = path.join(linkDir, "opencode.json")
  assert.equal(await resolvePermissionConfigPath({
    directory: projectDir,
    permissionConfigPath: explicitConfigPath,
  }), "")

  const result = await writeOpenCodePermissionProfile({
    directory: projectDir,
    permissionConfigPath: explicitConfigPath,
  }, "suggest")
  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  await assert.rejects(fs.readFile(path.join(outsideDir, "opencode.json"), "utf8"), /ENOENT/)
})

test("OpenCode permission config rejects explicit symlink targets reported by lstat", async () => {
  const projectDir = process.platform === "win32" ? "C:/repo/project" : "/repo/project"
  const configPath = process.platform === "win32" ? "C:/repo/project/opencode.json" : "/repo/project/opencode.json"
  const fsImpl = {
    stat: async (filePath) => {
      if (filePath === projectDir || filePath === path.dirname(configPath)) return { isDirectory: () => true }
      if (filePath === configPath) return { isFile: () => true }
      const err = new Error("not found")
      err.code = "ENOENT"
      throw err
    },
    lstat: async (filePath) => {
      if (filePath === configPath) return { isSymbolicLink: () => true, isFile: () => false }
      return { isSymbolicLink: () => false, isDirectory: () => true }
    },
    realpath: async (filePath) => filePath,
  }

  assert.equal(await resolvePermissionConfigPath({
    directory: projectDir,
    permissionConfigPath: configPath,
  }, { fsImpl }), "")
})

test("OpenCode permission config revalidates target symlinks before writes", async () => {
  const projectDir = process.platform === "win32" ? "C:/repo/project" : "/repo/project"
  const configPath = process.platform === "win32" ? "C:/repo/project/opencode.json" : "/repo/project/opencode.json"
  let afterInitialRead = false
  let writeCalls = 0
  const fsImpl = {
    stat: async (filePath) => {
      if (filePath === projectDir || filePath === path.dirname(configPath)) return { isDirectory: () => true }
      if (filePath === configPath) return { isFile: () => true }
      const err = new Error("not found")
      err.code = "ENOENT"
      throw err
    },
    lstat: async (filePath) => {
      if (filePath === configPath) {
        return afterInitialRead
          ? { isSymbolicLink: () => true, isFile: () => false }
          : { isSymbolicLink: () => false, isFile: () => true }
      }
      return { isSymbolicLink: () => false, isDirectory: () => true }
    },
    realpath: async (filePath) => filePath,
    async readFile(filePath) {
      if (filePath !== configPath) throw new Error(`unexpected read: ${filePath}`)
      afterInitialRead = true
      return JSON.stringify({ permission: profileToPermissionConfig("suggest") }, null, 2)
    },
    writeFile: async () => { writeCalls += 1; throw new Error("write should not be called") },
    mkdir: async () => { throw new Error("mkdir should not be called") },
    copyFile: async () => { throw new Error("copyFile should not be called") },
    readdir: async () => { throw new Error("readdir should not be called") },
    rename: async () => { throw new Error("rename should not be called") },
    unlink: async () => { throw new Error("unlink should not be called") },
  }

  const result = await writeOpenCodePermissionProfile({
    directory: projectDir,
    permissionConfigPath: configPath,
  }, "auto-edit", { fsImpl })
  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  assert.equal(writeCalls, 0)
})

test("OpenCode permission config reader reports invalid JSONC without overwriting it", async () => {
  const dir = await makeTempDir()
  const configPath = path.join(dir, "opencode.json")
  await fs.writeFile(configPath, "{ invalid json", "utf8")

  const readResult = await readOpenCodePermissionConfig({ directory: dir })

  assert.equal(readResult.ok, false)
  assert.equal(readResult.editable, false)
  assert.equal(readResult.status, "invalid")
  assert.match(readResult.error.message, /Failed to parse OpenCode config/)

  const writeResult = await writeOpenCodePermissionProfile({ directory: dir }, "suggest")
  assert.equal(writeResult.ok, false)
  assert.equal(writeResult.status, "invalid")
  assert.equal(await fs.readFile(configPath, "utf8"), "{ invalid json")
})

test("OpenCode permission config reader reports access-denied files as unavailable", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const configPath = path.join(dir, "opencode.json")
  const fake = makeFakePermissionConfigFs({
    directories: [dir],
    files: { [configPath]: { text: JSON.stringify({ permission: profileToPermissionConfig("suggest") }) } },
  })
  const fsImpl = {
    ...fake.fsImpl,
    async readFile(filePath, encoding) {
      if (path.normalize(filePath) === path.normalize(configPath) && encoding === "utf8") {
        const err = new Error("permission denied")
        err.code = "EACCES"
        throw err
      }
      return fake.fsImpl.readFile(filePath, encoding)
    },
  }

  const readResult = await readOpenCodePermissionConfig({ directory: dir }, { fsImpl })
  assert.equal(readResult.ok, false)
  assert.equal(readResult.editable, false)
  assert.equal(readResult.status, "unavailable")
  assert.equal(readResult.reason, "access-denied")
  assert.equal(readResult.filePath, configPath)

  const writeResult = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })
  assert.equal(writeResult.ok, false)
  assert.equal(writeResult.status, "unavailable")
  assert.equal(writeResult.reason, "access-denied")
  assert.equal(writeResult.filePath, configPath)
})

test("OpenCode permission config writer aborts when the file changes before write", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const configPath = path.join(dir, "opencode.json")
  const original = JSON.stringify({ permission: profileToPermissionConfig("suggest"), keep: true }, null, 2)
  const concurrent = JSON.stringify({ permission: profileToPermissionConfig("full-auto"), concurrent: true }, null, 2)
  const fake = makeFakePermissionConfigFs({
    directories: [dir],
    files: { [configPath]: { text: original, mode: 0o600 } },
  })
  let configReads = 0
  const fsImpl = {
    ...fake.fsImpl,
    async readFile(filePath, encoding) {
      const value = await fake.fsImpl.readFile(filePath, encoding)
      if (path.normalize(filePath) === path.normalize(configPath) && encoding === "utf8") {
        configReads += 1
        if (configReads === 1) fake.setText(configPath, concurrent)
      }
      return value
    },
  }

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "changed")
  assert.equal(fake.textOf(configPath), concurrent)
})

test("OpenCode permission config writer reports access-denied backup writes", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const configPath = path.join(dir, "opencode.json")
  const original = JSON.stringify({ permission: profileToPermissionConfig("suggest"), keep: true }, null, 2)
  const fake = makeFakePermissionConfigFs({
    directories: [dir],
    files: { [configPath]: { text: original, mode: 0o600 } },
  })
  const fsImpl = {
    ...fake.fsImpl,
    async writeFile(filePath, contents, options) {
      if (path.basename(filePath).startsWith("opencode.json.backup.")) {
        const err = new Error("backup denied")
        err.code = "EACCES"
        throw err
      }
      return fake.fsImpl.writeFile(filePath, contents, options)
    },
  }

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })

  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  assert.equal(result.reason, "access-denied")
  assert.equal(fake.textOf(configPath), original)
})

test("OpenCode permission config writer preserves access-denied from locked re-read", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const configPath = path.join(dir, "opencode.json")
  const original = JSON.stringify({ permission: profileToPermissionConfig("suggest"), keep: true }, null, 2)
  const fake = makeFakePermissionConfigFs({
    directories: [dir],
    files: { [configPath]: { text: original, mode: 0o600 } },
  })
  let dirStatCalls = 0
  const fsImpl = {
    ...fake.fsImpl,
    async stat(filePath) {
      if (path.normalize(filePath) === path.normalize(dir)) {
        dirStatCalls += 1
        if (dirStatCalls >= 2) {
          const err = new Error("directory denied")
          err.code = "EACCES"
          throw err
        }
      }
      return fake.fsImpl.stat(filePath)
    },
  }

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })

  assert.equal(result.ok, false)
  assert.equal(result.status, "unavailable")
  assert.equal(result.reason, "access-denied")
  assert.equal(result.filePath, configPath)
  assert.equal(fake.textOf(configPath), original)
})

test("OpenCode permission config writer aborts when parent realpath changes", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const changedDir = path.join(await makeTempDir(), "project-link-target")
  const configPath = path.join(dir, "opencode.json")
  const original = JSON.stringify({ permission: profileToPermissionConfig("suggest"), keep: true }, null, 2)
  const fake = makeFakePermissionConfigFs({
    directories: [dir],
    files: { [configPath]: { text: original, mode: 0o600 } },
  })
  let parentRealpathCalls = 0
  let writeCalls = 0
  const fsImpl = {
    ...fake.fsImpl,
    async realpath(filePath) {
      if (path.normalize(filePath) === path.normalize(dir)) {
        parentRealpathCalls += 1
        return parentRealpathCalls >= 3 ? changedDir : dir
      }
      return fake.fsImpl.realpath(filePath)
    },
    async writeFile(filePath, contents, options) {
      writeCalls += 1
      return fake.fsImpl.writeFile(filePath, contents, options)
    },
  }

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "changed")
  assert.equal(fake.textOf(configPath), original)
  assert.equal(writeCalls, 0)
})

test("OpenCode permission config writer does not overwrite concurrently created configs", async () => {
  const dir = path.join(await makeTempDir(), "project")
  const configPath = path.join(dir, "opencode.json")
  const concurrent = JSON.stringify({ permission: profileToPermissionConfig("full-auto"), concurrent: true }, null, 2)
  const fake = makeFakePermissionConfigFs({ directories: [dir] })
  const fsImpl = {
    ...fake.fsImpl,
    async link(from, to) {
      assert.match(path.basename(from), /^opencode\.json\.tmp\./)
      if (path.normalize(to) === path.normalize(configPath)) {
        await fake.fsImpl.writeFile(configPath, concurrent, { mode: 0o600 })
        const err = new Error("target exists")
        err.code = "EEXIST"
        throw err
      }
      throw new Error(`Unexpected copy target: ${to}`)
    },
  }

  const result = await writeOpenCodePermissionProfile({ directory: dir }, "auto-edit", { fsImpl })

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.reason, "changed")
  assert.equal(fake.textOf(configPath), concurrent)
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

test("OpenCode permission config reader does not probe files for disabled projects", async () => {
  let statCalls = 0
  const fsImpl = {
    stat: async () => {
      statCalls += 1
      const err = new Error("blocked")
      err.code = "EACCES"
      throw err
    },
  }

  const disabled = await readOpenCodePermissionConfig({
    directory: "C:/blocked",
    permissionControl: { enabled: false },
  }, { fsImpl })

  assert.equal(disabled.ok, false)
  assert.equal(disabled.editable, false)
  assert.equal(disabled.status, "disabled")
  assert.equal(statCalls, 0)
})

test("OpenCode permission config writer does not probe or write disabled projects", async () => {
  let fsCalls = 0
  const fsImpl = {
    stat: async () => { fsCalls += 1; throw new Error("stat should not be called") },
    readFile: async () => { fsCalls += 1; throw new Error("readFile should not be called") },
    writeFile: async () => { fsCalls += 1; throw new Error("writeFile should not be called") },
    mkdir: async () => { fsCalls += 1; throw new Error("mkdir should not be called") },
  }

  const disabled = await writeOpenCodePermissionProfile({
    directory: process.platform === "win32" ? "C:/blocked" : "/blocked",
    permissionConfigPath: process.platform === "win32" ? "C:/blocked/opencode.json" : "/blocked/opencode.json",
    permissionControl: { enabled: false },
  }, "suggest", { fsImpl })

  assert.equal(disabled.ok, false)
  assert.equal(disabled.editable, false)
  assert.equal(disabled.status, "disabled")
  assert.equal(fsCalls, 0)
})
