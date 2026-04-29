import test from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, formatInlineMarkdownToHtml, formatMarkdownToTelegramHtmlBlocks } from "../src/telegram/formatter.js"

function assertNoDanglingSurrogates(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(i + 1 < text.length, "high surrogate must have a following code unit")
      const next = text.charCodeAt(i + 1)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "high surrogate must be followed by low surrogate")
      i += 1
      continue
    }
    assert.ok(code < 0xdc00 || code > 0xdfff, "low surrogate must follow a high surrogate")
  }
}

test("escapeHtml escapes special Telegram HTML characters", () => {
  assert.equal(escapeHtml('<a "b" & c>'), "&lt;a &quot;b&quot; &amp; c&gt;")
})

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

test("formatInlineMarkdownToHtml escapes href attributes and drops overlong URLs", () => {
  const overlongUrl = `https://example.com/${"a".repeat(320)}`
  const html = formatInlineMarkdownToHtml(
    `[safe](https://example.com/path?x=1&y=o'h) [long](${overlongUrl})`,
  )

  assert.match(html, /<a href="https:\/\/example\.com\/path\?x=1&amp;y=o&#39;h">safe<\/a>/)
  assert.doesNotMatch(html, /<a href="https:\/\/example\.com\/a{20}/)
  assert.match(html, /long/)
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

test("formatMarkdownToTelegramHtmlBlocks falls back to escaped plain text for extreme long lines", () => {
  const blocks = formatMarkdownToTelegramHtmlBlocks(`intro\n${"<".repeat(2001)}`)

  assert.ok(blocks.length >= 2)
  assert.equal(blocks[0].html, "intro")
  const body = blocks.slice(1).map((block) => block.html).join("")
  assert.equal(body, "&lt;".repeat(2001))
  for (const block of blocks) {
    assert.ok(block.html.length <= 3900)
    assert.doesNotMatch(block.html, /&(?:l|lt)$/)
  }
})

test("formatMarkdownToTelegramHtmlBlocks does not split escaped entities", () => {
  const blocks = formatMarkdownToTelegramHtmlBlocks(`a${"<".repeat(2000)}&`)

  assert.ok(blocks.length > 1)
  assert.equal(blocks.map((block) => block.html).join(""), `a${"&lt;".repeat(2000)}&amp;`)
  for (const block of blocks) {
    assert.ok(block.html.length <= 3900)
    assert.doesNotMatch(block.html, /&(?:a|am|amp|l|lt)$/)
  }
})

test("formatMarkdownToTelegramHtmlBlocks keeps long emoji lines on surrogate-pair boundaries", () => {
  const emoji = "😀"
  const blocks = formatMarkdownToTelegramHtmlBlocks(emoji.repeat(1100))

  assert.deepEqual(blocks, [{ type: "text", html: `${emoji.repeat(1000)}\n${emoji.repeat(100)}` }])
  for (const block of blocks) {
    assert.ok(block.html.length <= 3900)
    assertNoDanglingSurrogates(block.html)
  }
})

test("formatMarkdownToTelegramHtmlBlocks splits fenced code across mixed line lengths", () => {
  const code = `${"a".repeat(600)}\n${"b".repeat(100)}\n${"c".repeat(700)}`
  const blocks = formatMarkdownToTelegramHtmlBlocks(`\
\`\`\`\n${code}\n\`\`\``)

  assert.ok(blocks.length >= 3)
  for (const block of blocks) {
    assert.equal(block.type, "text")
    assert.ok(block.html.startsWith("<pre><code>"))
    assert.ok(block.html.endsWith("</code></pre>"))
    assert.ok(block.html.length <= 3900)
  }
})
