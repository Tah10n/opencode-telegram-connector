import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { envBool, envInt, envOptional, envRequired, loadEnvFromFile, parseDotEnv } from "../src/config/env.js"

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("parseDotEnv handles comments, quotes, and trimming", () => {
  const parsed = parseDotEnv(`
# ignored
PLAIN=value
SPACED =  trimmed value   # comment
DOUBLE="two words" # trailing comment
SINGLE='keep # inside quotes'
EMPTY=
`)

  assert.deepEqual(parsed, {
    PLAIN: "value",
    SPACED: "trimmed value",
    DOUBLE: "two words",
    SINGLE: "keep # inside quotes",
    EMPTY: "",
  })
})

test("loadEnvFromFile loads missing variables without overriding existing ones", async (t) => {
  const dir = await makeTempDir()
  const envFile = path.join(dir, ".env")
  await fs.writeFile(envFile, "KEEP=from-file\nNEW_VALUE=loaded\n", "utf8")

  swapEnv(t, {
    KEEP: "already-set",
    NEW_VALUE: undefined,
  })

  await loadEnvFromFile(envFile)

  assert.equal(process.env.KEEP, "already-set")
  assert.equal(process.env.NEW_VALUE, "loaded")
})

test("env helpers validate required, integer, and boolean values", (t) => {
  swapEnv(t, {
    REQUIRED_VALUE: "hello",
    PORT_VALUE: "4312",
    BAD_PORT_VALUE: "3.14",
    BOOL_TRUE: "yes",
    BOOL_FALSE: "off",
    EMPTY_VALUE: "",
    MISSING_VALUE: undefined,
  })

  assert.equal(envOptional("MISSING_VALUE", "fallback"), "fallback")
  assert.equal(envRequired("REQUIRED_VALUE"), "hello")
  assert.throws(() => envRequired("EMPTY_VALUE"), /Missing env: EMPTY_VALUE/)
  assert.equal(envInt("PORT_VALUE"), 4312)
  assert.equal(envInt("MISSING_VALUE", 99), 99)
  assert.throws(() => envInt("BAD_PORT_VALUE"), /Invalid integer for BAD_PORT_VALUE: 3.14/)
  assert.equal(envBool("BOOL_TRUE"), true)
  assert.equal(envBool("BOOL_FALSE", true), false)
  assert.equal(envBool("MISSING_VALUE", true), true)
})
