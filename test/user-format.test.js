import test from "node:test"
import assert from "node:assert/strict"
import { TELEGRAM_SAFE_MESSAGE_MAX_LEN } from "../src/telegram/client.js"
import { formatUserMirrorBlocks } from "../src/connector/mirroring/user-format.js"

test("formatUserMirrorBlocks keeps the prepended label inside checkpointable Telegram blocks", () => {
  const text = `${"a".repeat(1949)}\n${"b".repeat(1949)}`
  const blocks = formatUserMirrorBlocks(text)

  assert.ok(blocks.length > 1)
  assert.match(blocks[0].html, /^<i>User:<\/i>/)
  assert.ok(blocks.every((block) => block.type !== "text" || block.html.length <= TELEGRAM_SAFE_MESSAGE_MAX_LEN))
})
