import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { parseDotEnv } from "../src/config/env.js"
import { normalizeConnectorConfig } from "../src/config/file.js"
import { normalizeProjectsConfig } from "../src/config/projects.js"
import { chance, createFuzzRng, fuzzIterations, pick, randomInt, randomString } from "./helpers/fuzz.js"

const ITERATIONS = fuzzIterations("CONFIG_FUZZ_ITERATIONS")
const SAFE_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_-"
const SAFE_VALUE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:/ "
const BASE_DIR = path.resolve("fuzz-config-base")
const CONFIG_FILE = path.join(BASE_DIR, "connector.config.mjs")

function assertOnlyErrorThrows(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    assert.ok(err instanceof Error, `expected thrown value to be an Error, got ${String(err)}`)
    return { ok: false, error: err }
  }
}

function assertRejectsWithError(fn) {
  const result = assertOnlyErrorThrows(fn)
  assert.equal(result.ok, false, "expected generated invalid input to reject")
}

function safeName(rng, prefix = "v") {
  return `${prefix}-${randomString(rng, { minLength: 1, maxLength: 12, alphabet: SAFE_NAME_ALPHABET })}`
}

function safeValue(rng, { minLength = 0, maxLength = 24 } = {}) {
  return randomString(rng, { minLength, maxLength, alphabet: SAFE_VALUE_ALPHABET })
}

function randomValidProjectEntry(rng) {
  const port = randomInt(rng, 1024, 65000)
  const directory = `workspace-${safeName(rng, "dir")}`
  const explicitBaseUrl = chance(rng) ? `http://127.0.0.1:${port}` : ""
  return {
    input: {
      directory,
      port: chance(rng) ? String(port) : port,
      baseUrl: explicitBaseUrl,
      autoStart: chance(rng),
      serverLaunchMode: pick(rng, ["background", "window"]),
      openTuiOnAutoStart: chance(rng),
      openAttachOnNewMode: pick(rng, ["same-window", "new-window"]),
      username: safeValue(rng, { minLength: 1, maxLength: 16 }),
      password: safeValue(rng, { minLength: 1, maxLength: 16 }),
      displayName: safeValue(rng, { minLength: 1, maxLength: 16 }),
    },
    expected: {
      baseUrl: explicitBaseUrl || `http://127.0.0.1:${port}`,
      directory: path.resolve(BASE_DIR, directory),
      port,
    },
  }
}

function randomInvalidProjectsConfig(rng) {
  const alias = safeName(rng, "project")
  switch (randomInt(rng, 0, 8)) {
    case 0:
      return null
    case 1:
      return []
    case 2:
      return { [` ${alias}`]: { baseUrl: "http://127.0.0.1:8787" } }
    case 3:
      return { [`${alias}:bad`]: { baseUrl: "http://127.0.0.1:8787" } }
    case 4:
      return { [alias]: pick(rng, [null, [], safeValue(rng)]) }
    case 5:
      return { [alias]: { directory: "workspace" } }
    case 6:
      return { [alias]: { baseUrl: "http://127.0.0.1:8787", port: pick(rng, [0, 65536, 1.25, "not-a-port"]) } }
    case 7:
      return { [alias]: { baseUrl: "http://127.0.0.1:8787", autoStart: "true" } }
    default:
      return { [alias]: { baseUrl: "http://127.0.0.1:8787", startMode: "legacy" } }
  }
}

function randomJsonishValue(rng, depth = 0) {
  const leaf = () => pick(rng, [
    null,
    undefined,
    "",
    safeValue(rng, { maxLength: 20 }),
    randomInt(rng, -10, 70000),
    randomInt(rng, -10, 70000) + 0.5,
    chance(rng),
  ])
  if (depth > 1) return leaf()
  switch (randomInt(rng, 0, 4)) {
    case 0:
      return leaf()
    case 1:
      return [leaf(), leaf()]
    case 2:
      return { [safeName(rng, "k")]: leaf() }
    case 3:
      return { [safeName(rng, "k")]: randomJsonishValue(rng, depth + 1), [safeName(rng, "k")]: leaf() }
    default:
      return safeValue(rng, { maxLength: 32 })
  }
}

function randomConnectorShape(rng) {
  if (chance(rng, 0.2)) return pick(rng, [null, [], safeValue(rng), randomInt(rng, -5, 5)])

  const raw = {}
  const maybe = (name, value) => {
    if (chance(rng, 0.65)) raw[name] = value
  }

  maybe("cwd", chance(rng) ? `cwd-${safeName(rng)}` : randomJsonishValue(rng))
  maybe("stateFile", chance(rng) ? `state-${safeName(rng)}.json` : randomJsonishValue(rng))
  maybe("defaultProject", randomJsonishValue(rng))
  maybe("tgPrefix", randomJsonishValue(rng))
  maybe("echoFilterMode", pick(rng, ["recent", "prefix", "bad-mode", randomJsonishValue(rng)]))
  maybe("mirrorTuiUserMessages", randomJsonishValue(rng))
  maybe("allowInsecureHttp", randomJsonishValue(rng))
  maybe("logFormat", randomJsonishValue(rng))
  maybe("activeTurnStaleMs", randomJsonishValue(rng))
  maybe("healthServer", randomJsonishValue(rng))
  maybe("opencodeWatchdog", randomJsonishValue(rng))
  maybe("i18n", randomJsonishValue(rng))
  maybe("limits", randomJsonishValue(rng))
  maybe("telegram", chance(rng) ? {
    botToken: randomJsonishValue(rng),
    allowedUserId: randomJsonishValue(rng),
  } : randomJsonishValue(rng))

  if (chance(rng, 0.45)) {
    const { input } = randomValidProjectEntry(rng)
    raw.projects = { [safeName(rng, "project")]: input }
  } else {
    maybe("projects", randomInvalidProjectsConfig(rng))
  }

  return raw
}

test("parseDotEnv fuzzes bounded random text without non-Error throws", () => {
  const rng = createFuzzRng("parse-dotenv-random-text")
  for (let i = 0; i < ITERATIONS; i++) {
    const text = randomString(rng, { minLength: 0, maxLength: 256 })
    const result = assertOnlyErrorThrows(() => parseDotEnv(text))
    if (result.ok) assert.equal(typeof result.value, "object")
  }
})

test("parseDotEnv generated assignments parse predictably", () => {
  const rng = createFuzzRng("parse-dotenv-valid-assignments")
  for (let i = 0; i < ITERATIONS; i++) {
    const expected = {}
    const lines = ["# generated dotenv"]
    const count = randomInt(rng, 1, 6)
    for (let entry = 0; entry < count; entry++) {
      const key = safeName(rng, "ENV").toUpperCase().replaceAll("-", "_")
      const value = safeValue(rng, { maxLength: 18 }).trim()
      expected[key] = value
      if (chance(rng)) lines.push(`${key}=${value} # trailing comment`)
      else lines.push(`${key}=\"${value}\" # preserved inside quotes`)
    }
    lines.push("ignored-without-equals")
    assert.deepEqual(parseDotEnv(lines.join("\n")), expected)
  }
})

test("normalizeProjectsConfig generated valid configs normalize predictably", () => {
  const rng = createFuzzRng("projects-valid")
  for (let i = 0; i < ITERATIONS; i++) {
    const alias = safeName(rng, "project")
    const { input, expected } = randomValidProjectEntry(rng)
    const normalized = normalizeProjectsConfig({ [alias]: input }, { baseDir: BASE_DIR })

    assert.deepEqual(normalized, {
      [alias]: {
        baseUrl: expected.baseUrl,
        directory: expected.directory,
        port: expected.port,
        autoStart: input.autoStart,
        serverLaunchMode: input.serverLaunchMode,
        openTuiOnAutoStart: input.openTuiOnAutoStart,
        openAttachOnNewMode: input.openAttachOnNewMode,
        username: String(input.username),
        password: String(input.password),
        displayName: String(input.displayName),
      },
    })
  }
})

test("normalizeProjectsConfig generated invalid configs reject with Error", () => {
  const rng = createFuzzRng("projects-invalid")
  for (let i = 0; i < ITERATIONS; i++) {
    const raw = randomInvalidProjectsConfig(rng)
    assertRejectsWithError(() => normalizeProjectsConfig(raw, { baseDir: BASE_DIR, sourceLabel: "fuzz" }))
  }
})

test("normalizeConnectorConfig generated object shapes normalize or reject with Error", () => {
  const rng = createFuzzRng("connector-shapes")
  for (let i = 0; i < ITERATIONS; i++) {
    const raw = randomConnectorShape(rng)
    const result = assertOnlyErrorThrows(() => normalizeConnectorConfig(raw, { configFilePath: CONFIG_FILE }))
    if (!result.ok) continue

    assert.equal(typeof result.value, "object")
    assert.equal(result.value.baseDir, BASE_DIR)
    assert.equal(result.value.configFilePath, CONFIG_FILE)
    assert.equal(typeof result.value.config, "object")
    assert.ok(path.isAbsolute(result.value.config.cwd))
  }
})
