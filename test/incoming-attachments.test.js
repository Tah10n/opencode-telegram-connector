import test from "node:test"
import assert from "node:assert/strict"
import {
  USER_ATTACHMENT_LIMITS,
  decodeTextAttachment,
  describeTelegramDocument,
  formatAttachmentPrompt,
  shouldConfirmAttachment,
  unsupportedMediaKind,
} from "../src/connector/incoming-attachments.js"
import { sanitizeFilename } from "../src/connector/attachment-utils.js"

test("describeTelegramDocument accepts text/code/log files and redacts unsafe filenames", () => {
  const info = describeTelegramDocument({
    file_id: "file_1",
    file_name: "secret-abcdefghijklmnopqrstuvwxyz1234567890.log",
    mime_type: "application/octet-stream",
    file_size: 1200,
  })

  assert.equal(info.supported, true)
  assert.match(info.safeName, /redacted-/)
  assert.match(info.safeName, /\.log$/)
})

test("describeTelegramDocument rejects unsupported media and oversized files", () => {
  assert.equal(describeTelegramDocument({ file_id: "f", file_name: "image.png", mime_type: "image/png", file_size: 10 }).supported, false)
  const tooLarge = describeTelegramDocument({ file_id: "f", file_name: "big.txt", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.maxBytes + 1 })
  assert.equal(tooLarge.supported, false)
  assert.equal(tooLarge.reason, "too_large")
})

test("large supported attachments require confirmation", () => {
  const small = describeTelegramDocument({ file_id: "f", file_name: "a.txt", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes - 1 })
  const large = describeTelegramDocument({ file_id: "f", file_name: "a.txt", mime_type: "text/plain", file_size: USER_ATTACHMENT_LIMITS.confirmBytes })

  assert.equal(shouldConfirmAttachment(small), false)
  assert.equal(shouldConfirmAttachment(large), true)
})

test("decodeTextAttachment accepts UTF-8 and rejects binary content", () => {
  assert.equal(decodeTextAttachment(new TextEncoder().encode("hello")), "hello")
  assert.throws(() => decodeTextAttachment(new Uint8Array([0, 1, 2])), /binary/)
})

test("formatAttachmentPrompt includes caption and sanitized metadata", () => {
  const prompt = formatAttachmentPrompt({
    prefix: "[TG] ",
    caption: "Review this",
    documentInfo: { safeName: "app.js", mimeType: "text/javascript", fileSize: 12 },
    text: "console.log(1)",
    byteLength: 14,
  })

  assert.match(prompt, /^\[TG\] Review this/)
  assert.match(prompt, /Filename: app\.js/)
  assert.match(prompt, /console\.log\(1\)/)
})

test("unsupportedMediaKind identifies non-document Telegram media", () => {
  assert.equal(unsupportedMediaKind({ photo: [{}] }), "photo")
  assert.equal(unsupportedMediaKind({ document: { file_id: "f" }, photo: [{}] }), "")
  assert.match(sanitizeFilename("../../x.txt"), /^x\.txt$/)
})
