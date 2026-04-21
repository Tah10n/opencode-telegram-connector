import test from "node:test"
import assert from "node:assert/strict"
import { formatInlineMarkdownToHtml, formatMarkdownToTelegramHtmlBlocks } from "../src/telegram/formatter.js"

test("formatInlineMarkdownToHtml renders supported markdown and drops unsafe links", () => {
  const html = formatInlineMarkdownToHtml(
    "**bold** *italic* _also_ `code` [ok](https://example.com) [bad](javascript:evil) <tag>",
  )

  assert.match(html, /<b>bold<\/b>/)
  assert.match(html, /<i>italic<\/i>/)
  assert.match(html, /<i>also<\/i>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<a href="https:\/\/example\.com">ok<\/a>/)
  assert.doesNotMatch(html, /javascript:evil/)
  assert.match(html, /bad/)
  assert.match(html, /&lt;tag&gt;/)
})

test("formatMarkdownToTelegramHtmlBlocks keeps headings, quotes, lists, and code fences well-formed", () => {
  const blocks = formatMarkdownToTelegramHtmlBlocks(
    "# Title\n- item **one**\n> quote _ok_\n\n```js\nconst a = 1 < 2\n```",
  )

  assert.equal(blocks.length, 2)
  assert.match(blocks[0].html, /^<b>Title<\/b>/)
  assert.match(blocks[0].html, /• item <b>one<\/b>/)
  assert.match(blocks[0].html, /<blockquote>quote <i>ok<\/i><\/blockquote>/)
  assert.equal(blocks[1].html, "<pre><code>js\nconst a = 1 &lt; 2</code></pre>")
})

test("formatMarkdownToTelegramHtmlBlocks splits long fenced code into Telegram-safe chunks", () => {
  const blocks = formatMarkdownToTelegramHtmlBlocks("```\n" + "a".repeat(5000) + "\n```")

  assert.ok(blocks.length > 1)
  for (const block of blocks) {
    assert.equal(block.type, "text")
    assert.ok(block.html.startsWith("<pre><code>"))
    assert.ok(block.html.endsWith("</code></pre>"))
    assert.ok(block.html.length <= 3900)
  }
})
