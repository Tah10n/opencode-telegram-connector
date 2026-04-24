import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_LIMITS, normalizeLimits, userAttachmentLimitsFromConfig } from "../src/limits.js"

test("normalizeLimits applies defaults and validates configured values", () => {
  assert.deepEqual(normalizeLimits({}, { env: {} }), DEFAULT_LIMITS)
  assert.deepEqual(normalizeLimits({ userAttachmentConfirmBytes: 1, userAttachmentMaxBytes: 2 }, { env: {} }), {
    ...DEFAULT_LIMITS,
    userAttachmentConfirmBytes: 1,
    userAttachmentMaxBytes: 2,
  })
  assert.throws(() => normalizeLimits("bad", { env: {} }), /expected object/)
  assert.throws(() => normalizeLimits([], { env: {} }), /expected object/)
  assert.throws(() => normalizeLimits({ userAttachmentConfirmBytes: 3, userAttachmentMaxBytes: 2 }, { env: {} }), /cannot exceed/)
})

test("userAttachmentLimitsFromConfig returns incoming-file limit shape", () => {
  assert.deepEqual(userAttachmentLimitsFromConfig({ userAttachmentConfirmBytes: 10, userAttachmentMaxBytes: 20 }), {
    confirmBytes: 10,
    maxBytes: 20,
  })
})
