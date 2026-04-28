import test from "node:test"
import assert from "node:assert/strict"
import { decorateUnifiedDiffText, formatUnifiedDiffHtml } from "../src/telegram/diff-formatter.js"

test("decorateUnifiedDiffText prefixes unified diff line types", () => {
  const diff = [
    "diff --git a/src/example.js b/src/example.js",
    "Index: src/example.js",
    "index 1111111..2222222 100644",
    "--- a/src/example.js",
    "+++ b/src/example.js",
    "@@ -1,2 +1,2 @@",
    " context line",
    "-old line",
    "+new line",
    "rename from src/old-example.js",
  ].join("\n")

  assert.deepEqual(decorateUnifiedDiffText(diff).split("\n"), [
    "📄 src/example.js",
    "📄 src/example.js",
    "ℹ️ index 1111111..2222222 100644",
    "📍 --- a/src/example.js",
    "📍 +++ b/src/example.js",
    "🔎 @@ -1,2 +1,2 @@",
    "⚪  context line",
    "🔴 -old line",
    "🟢 +new line",
    "ℹ️ rename from src/old-example.js",
  ])
})

test("decorateUnifiedDiffText keeps +++ and --- as diff metadata", () => {
  const decorated = decorateUnifiedDiffText("--- a/file.txt\n+++ b/file.txt\n-old\n+new")

  assert.match(decorated, /^📍 --- a\/file\.txt/m)
  assert.match(decorated, /^📍 \+\+\+ b\/file\.txt/m)
  assert.doesNotMatch(decorated, /^🔴 --- a\/file\.txt/m)
  assert.doesNotMatch(decorated, /^🟢 \+\+\+ b\/file\.txt/m)
  assert.match(decorated, /^🔴 -old/m)
  assert.match(decorated, /^🟢 \+new/m)
})

test("decorateUnifiedDiffText treats +++ and --- inside hunks as changed lines", () => {
  const decorated = decorateUnifiedDiffText("--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n--- removed heading\n+++ added heading")

  assert.match(decorated, /^📍 --- a\/file\.txt/m)
  assert.match(decorated, /^📍 \+\+\+ b\/file\.txt/m)
  assert.match(decorated, /^🔴 --- removed heading/m)
  assert.match(decorated, /^🟢 \+\+\+ added heading/m)
})

test("decorateUnifiedDiffText keeps +++ and --- hunk content before another hunk as changes", () => {
  const decorated = decorateUnifiedDiffText("@@ -1 +1 @@\n--- README.md\n+++ README.md\n@@ -10 +10 @@\n-next\n+next")

  assert.match(decorated, /^🔴 --- README\.md/m)
  assert.match(decorated, /^🟢 \+\+\+ README\.md/m)
  assert.doesNotMatch(decorated, /^📍 --- README\.md/m)
  assert.doesNotMatch(decorated, /^📍 \+\+\+ README\.md/m)
})

test("decorateUnifiedDiffText resets hunk state between joined file diffs", () => {
  const decorated = decorateUnifiedDiffText([
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -1 +1 @@",
    "-left",
    "+right",
  ].join("\n"))

  assert.match(decorated, /^📍 --- a\/two\.txt/m)
  assert.match(decorated, /^📍 \+\+\+ b\/two\.txt/m)
  assert.doesNotMatch(decorated, /^🔴 --- a\/two\.txt/m)
  assert.doesNotMatch(decorated, /^🟢 \+\+\+ b\/two\.txt/m)
  assert.match(decorated, /^🔴 -left/m)
  assert.match(decorated, /^🟢 \+right/m)
})

test("decorateUnifiedDiffText recognizes header-only multi-file diffs without blank separators", () => {
  const decorated = decorateUnifiedDiffText([
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -1 +1 @@",
    "-left",
    "+right",
  ].join("\n"))

  assert.match(decorated, /^📍 --- a\/two\.txt/m)
  assert.match(decorated, /^📍 \+\+\+ b\/two\.txt/m)
  assert.doesNotMatch(decorated, /^🔴 --- a\/two\.txt/m)
  assert.doesNotMatch(decorated, /^🟢 \+\+\+ b\/two\.txt/m)
  assert.match(decorated, /^🔴 -left/m)
  assert.match(decorated, /^🟢 \+right/m)
})

test("formatUnifiedDiffHtml escapes title and diff content with Telegram-safe tags", () => {
  const html = formatUnifiedDiffHtml([
    "diff --git a/<file>.js b/<file>.js",
    "--- a/<file>.js",
    "+++ b/<file>.js",
    "@@ -1 +1 @@",
    "-<old & broken>",
    "+<new & fixed>",
  ].join("\n"), { title: 'Diff <Title> & "quotes"' })

  assert.match(html, /^<b>Diff &lt;Title&gt; &amp; &quot;quotes&quot;<\/b>$/m)
  assert.match(html, /^<i>🟢 added · 🔴 removed · ⚪ context · 🔎 hunk<\/i>$/m)
  assert.match(html, /<pre><code>[\s\S]*<\/code><\/pre>/)
  assert.match(html, /📄 &lt;file&gt;\.js/)
  assert.match(html, /📍 --- a\/&lt;file&gt;\.js/)
  assert.match(html, /📍 \+\+\+ b\/&lt;file&gt;\.js/)
  assert.match(html, /🔴 -&lt;old &amp; broken&gt;/)
  assert.match(html, /🟢 \+&lt;new &amp; fixed&gt;/)
  assert.doesNotMatch(html, /<span\b/i)
  assert.doesNotMatch(html, /\bstyle=/i)
})
