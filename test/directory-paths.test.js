import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { canonicalDirectoryPath, directoriesMatch, normalizeConfiguredDirectory } from "../src/directory-paths.js"

test("canonicalDirectoryPath preserves POSIX case on every connector platform", () => {
  assert.deepEqual(canonicalDirectoryPath("/srv/App/"), {
    flavor: "posix",
    path: "/srv/App",
    key: "/srv/App",
  })
  assert.equal(directoriesMatch("/srv/App", "/srv/App/"), true)
  assert.equal(directoriesMatch("/srv/App", "/srv/app"), false)
})

test("canonicalDirectoryPath treats Windows drive paths as case-insensitive", () => {
  assert.deepEqual(canonicalDirectoryPath("C:/Repo/App/"), {
    flavor: "windows-drive",
    path: "C:/Repo/App",
    key: "c:/repo/app",
  })
  assert.equal(directoriesMatch("C:/Repo/App", "c:\\repo\\app\\"), true)
  assert.equal(directoriesMatch("C:/Repo/App", "D:/Repo/App"), false)
})

test("canonicalDirectoryPath treats UNC paths as case-insensitive Windows paths", () => {
  assert.deepEqual(canonicalDirectoryPath("//Server/Share/App/"), {
    flavor: "windows-unc",
    path: "//Server/Share/App",
    key: "//server/share/app",
  })
  assert.equal(directoriesMatch("//Server/Share/App", "\\\\server\\share\\app\\"), true)
  assert.equal(directoriesMatch("//Server/Share/App", "//server/other/App"), false)
})

test("directoriesMatch keeps path flavors isolated", () => {
  assert.equal(directoriesMatch("/srv/App", "C:/srv/App"), false)
  assert.equal(directoriesMatch("/Server/Share/App", "//Server/Share/App"), false)
})

test("normalizeConfiguredDirectory resolves only relative configured paths", () => {
  const baseDir = path.resolve("workspace", "configs")

  assert.equal(normalizeConfiguredDirectory("./repo", { baseDir }), path.resolve(baseDir, "repo"))
  assert.equal(normalizeConfiguredDirectory("/srv/App", { baseDir }), "/srv/App")
  assert.equal(normalizeConfiguredDirectory("C:/Repo/App", { baseDir }), "C:/Repo/App")
  assert.equal(normalizeConfiguredDirectory("//Server/Share/App", { baseDir }), "//Server/Share/App")
})
