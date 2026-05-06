import test from "node:test"
import assert from "node:assert/strict"
import { callbackPacker, decodeCallbackData, encodeCallback, LEGACY_CALLBACK_PREFIXES, legacyCallbackPrefix } from "../src/connector/callback-data.js"
import { chance, createFuzzRng, fuzzIterations, pick, randomInt, randomString } from "./helpers/fuzz.js"

const ITERATIONS = fuzzIterations("CALLBACK_FUZZ_ITERATIONS")

test("callback codec round-trips delimiter-bearing parts", () => {
  const payload = encodeCallback(["m", "apply", "provider/model|with-pipe", "variant|x"])

  assert.deepEqual(decodeCallbackData(payload), ["m", "apply", "provider/model|with-pipe", "variant|x"])
})

test("callback codec keeps legacy pipe callbacks readable", () => {
  assert.deepEqual(decodeCallbackData("s|demo|ses_1"), ["s", "demo", "ses_1"])
})

test("callback codec rejects unsupported legacy pipe prefixes", () => {
  assert.equal(decodeCallbackData("unknown|demo|ses_1"), null)
  assert.equal(decodeCallbackData("cb|token"), null)
  assert.equal(decodeCallbackData("s"), null)
})

test("callback packer stores encoded JSON array payloads", () => {
  const pack = callbackPacker({ pack: (value) => `packed:${value}` })

  assert.equal(pack("b", "confirm-unbind", "100:7"), `packed:${encodeCallback(["b", "confirm-unbind", "100:7"])}`)
})

test("callback codec fuzzes garbage without throwing", () => {
  const rng = createFuzzRng("callback-garbage")
  const values = [null, undefined, 0, 1, true, false, {}, [], ["s"], Symbol("cb")]
  for (let i = 0; i < ITERATIONS; i++) {
    const value = chance(rng, 0.25) ? pick(rng, values) : randomString(rng, { minLength: 0, maxLength: 160 })
    assert.doesNotThrow(() => decodeCallbackData(value))
    const decoded = decodeCallbackData(value)
    assert.ok(decoded == null || (Array.isArray(decoded) && decoded.every((part) => typeof part === "string")))
  }
})

test("callback codec fuzzes JSON payload round trips", () => {
  const rng = createFuzzRng("callback-json-roundtrip")
  const value = () => pick(rng, [
    null,
    undefined,
    randomInt(rng, -1000, 1000),
    chance(rng),
    randomString(rng, { minLength: 0, maxLength: 48 }),
  ])

  for (let i = 0; i < ITERATIONS; i++) {
    const parts = Array.from({ length: randomInt(rng, 1, 8) }, value)
    assert.deepEqual(decodeCallbackData(encodeCallback(parts)), parts.map((part) => (part == null ? "" : String(part))))
  }
})

test("callback codec fuzzes documented legacy prefixes", () => {
  const rng = createFuzzRng("callback-legacy-prefixes")
  for (let i = 0; i < ITERATIONS; i++) {
    const prefix = pick(rng, LEGACY_CALLBACK_PREFIXES)
    const parts = [prefix]
    for (let j = 0; j < randomInt(rng, 1, 5); j++) {
      parts.push(randomString(rng, { minLength: 0, maxLength: 24, alphabet: "abcdefghijklmnopqrstuvwxyz0123456789_-:." }))
    }
    const payload = parts.join("|")
    assert.equal(legacyCallbackPrefix(payload), prefix)
    assert.deepEqual(decodeCallbackData(payload), parts)
  }
})

test("callback codec fuzzes unsupported pipe prefixes as invalid", () => {
  const rng = createFuzzRng("callback-unsupported-prefixes")
  const supported = new Set(LEGACY_CALLBACK_PREFIXES)
  for (let i = 0; i < ITERATIONS; i++) {
    let prefix = randomString(rng, { minLength: 1, maxLength: 12, alphabet: "abcdefghijklmnopqrstuvwxyz0123456789_-" })
    if (supported.has(prefix)) prefix = `x-${prefix}`
    assert.equal(decodeCallbackData(`${prefix}|${randomString(rng, { minLength: 0, maxLength: 24 })}`), null)
  }
})

test("callback packer fuzzes generated parts through injected packer", () => {
  const rng = createFuzzRng("callback-packer-roundtrip")
  const packedPayloads = []
  const pack = callbackPacker({
    pack: (payload) => {
      packedPayloads.push(payload)
      return `packed:${payload}`
    },
  })

  for (let i = 0; i < ITERATIONS; i++) {
    const parts = Array.from({ length: randomInt(rng, 1, 6) }, () => pick(rng, [
      null,
      undefined,
      randomInt(rng, -100, 100),
      randomString(rng, { minLength: 0, maxLength: 32 }),
    ]))
    const result = pack(parts)
    const payload = packedPayloads.at(-1)

    assert.equal(result, `packed:${payload}`)
    assert.deepEqual(decodeCallbackData(payload), parts.map((part) => (part == null ? "" : String(part))))
  }
})

test("callback codec keeps malformed JSON arrays invalid", () => {
  for (const payload of ["[", "[]", "[1,", "[null] trailing", "[\"ok\""]) assert.equal(decodeCallbackData(payload), null)
})
