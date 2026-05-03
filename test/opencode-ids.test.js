import test from "node:test"
import assert from "node:assert/strict"
import { isSafeOpenCodeId, requireSafeOpenCodeId } from "../src/opencode/ids.js"

test("OpenCode session ids reject callback delimiter pipes", () => {
  assert.equal(isSafeOpenCodeId("abc|def"), false)
  assert.throws(() => requireSafeOpenCodeId("abc|def", "session id"), /pipe/)
})
