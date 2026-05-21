import test from "node:test"
import assert from "node:assert/strict"
import {
  detectPermissionProfile,
  normalizePermissionProfileId,
  permissionProfileLabel,
  profileToPermissionConfig,
} from "../src/opencode/permissions-profile.js"

test("permissions profiles map Codex-like modes to OpenCode permission config", () => {
  const suggest = profileToPermissionConfig("suggest")
  assert.equal(suggest["*"], "ask")
  assert.equal(suggest.read["*"], "allow")
  assert.equal(suggest.read["*.env"], "deny")
  assert.equal(suggest.glob, "allow")
  assert.equal(suggest.grep, "allow")
  assert.equal(suggest.list, "allow")
  assert.equal(suggest.edit, "ask")
  assert.equal(suggest.bash, "ask")
  assert.equal(suggest.task, "ask")
  assert.equal(suggest.repo_clone, "ask")
  assert.equal(suggest.repo_overview, "ask")

  const autoEdit = profileToPermissionConfig("auto-edit")
  assert.equal(autoEdit.edit, "allow")
  assert.equal(autoEdit.todowrite, "allow")
  assert.equal(autoEdit.bash, "ask")
  assert.equal(autoEdit.task, "ask")
  assert.equal(autoEdit.codesearch, "ask")
  assert.equal(autoEdit.repo_clone, "ask")
  assert.equal(autoEdit.repo_overview, "ask")

  const fullAuto = profileToPermissionConfig("full-auto")
  assert.equal(fullAuto["*"], "allow")
  assert.equal(fullAuto.edit, "allow")
  assert.equal(fullAuto.bash, "allow")
  assert.equal(fullAuto.task, "allow")
  assert.equal(fullAuto.webfetch, "deny")
  assert.equal(fullAuto.websearch, "deny")
  assert.equal(fullAuto.repo_clone, "deny")
  assert.equal(fullAuto.repo_overview, "deny")
  assert.equal(fullAuto.codesearch, "deny")
  assert.equal(fullAuto.external_directory, "deny")
  assert.equal(fullAuto.doom_loop, "ask")
})

test("permissions profile detection distinguishes defaults and custom configs", () => {
  assert.equal(detectPermissionProfile(undefined), "opencode-default")
  assert.equal(detectPermissionProfile(null), "opencode-default")
  assert.equal(detectPermissionProfile(profileToPermissionConfig("suggest")), "suggest")
  assert.equal(detectPermissionProfile({ "*": "ask", edit: "allow" }), "custom")
})

test("permissions profile detection accepts equivalent legacy configs without repo tools", () => {
  for (const profileId of ["suggest", "auto-edit"]) {
    const permission = profileToPermissionConfig(profileId)
    delete permission.repo_clone
    delete permission.repo_overview

    assert.equal(detectPermissionProfile(permission), profileId)
  }
})

test("permissions profile detection rejects legacy full-auto without denied repo tools", () => {
  const permission = profileToPermissionConfig("full-auto")
  delete permission.repo_clone
  delete permission.repo_overview

  assert.equal(detectPermissionProfile(permission), "custom")
})

test("permissions profile detection rejects mismatched repo tool values", () => {
  for (const key of ["repo_clone", "repo_overview"]) {
    const permission = profileToPermissionConfig("suggest")
    permission[key] = "deny"

    assert.equal(detectPermissionProfile(permission), "custom")
  }
})

test("permissions profile normalization accepts Telegram-friendly aliases", () => {
  assert.equal(normalizePermissionProfileId("auto_edit"), "auto-edit")
  assert.equal(normalizePermissionProfileId("fullauto"), "full-auto")
  assert.equal(normalizePermissionProfileId("readonly"), "suggest")
  assert.equal(normalizePermissionProfileId("default", { includeReset: true }), "reset")
  assert.equal(permissionProfileLabel("full-auto"), "Full Auto")
})
