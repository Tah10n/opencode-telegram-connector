import test from "node:test"
import assert from "node:assert/strict"
import { callbackPacker, decodeCallbackData, encodeCallback } from "../src/connector/callback-data.js"

test("callback codec round-trips delimiter-bearing parts", () => {
  const payload = encodeCallback(["m", "apply", "provider/model|with-pipe", "variant|x"])

  assert.deepEqual(decodeCallbackData(payload), ["m", "apply", "provider/model|with-pipe", "variant|x"])
})

test("callback codec keeps legacy pipe callbacks readable", () => {
  assert.deepEqual(decodeCallbackData("s|demo|ses_1"), ["s", "demo", "ses_1"])
})

test("callback packer stores encoded JSON array payloads", () => {
  const pack = callbackPacker({ pack: (value) => `packed:${value}` })

  assert.equal(pack("b", "confirm-unbind", "100:7"), `packed:${encodeCallback(["b", "confirm-unbind", "100:7"])}`)
})
