import test from "node:test"
import assert from "node:assert/strict"
import { extractPatchDiffText, extractPatchFileEntries, extractPatchFiles, formatChangedFilesText } from "../src/message-display.js"

test("extractPatchFiles returns unique file list from patch parts", () => {
  const files = extractPatchFiles({
    parts: [
      { type: "patch", files: ["/a/b.txt", "/a/B.txt", "  /c/d.js  "] },
      { type: "patch", files: ["/c/d.js", ""] },
    ],
  })

  assert.deepEqual(files, ["/a/b.txt", "/c/d.js"])
})

test("formatChangedFilesText formats and limits output", () => {
  const text = formatChangedFilesText(["/a/b.txt", "/a/c.txt", "/a/d.txt"], { baseDir: "/a", limit: 2 })
  assert.match(text, /Changed files:/)
  assert.match(text, /- b.txt/)
  assert.match(text, /- c.txt/)
  assert.match(text, /…and 1 more\./)
})

test("extractPatchDiffText reads direct diff content from patch parts", () => {
  const diff = extractPatchDiffText({
    parts: [
      { type: "patch", files: ["/a/b.txt"], diff: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+new" },
      { type: "text", text: "ignored" },
    ],
  })

  assert.match(diff, /--- a\/b\.txt/)
  assert.match(diff, /\+new/)
})

test("extractPatchDiffText falls back to hunk headers and lines", () => {
  const diff = extractPatchDiffText({
    parts: [
      {
        type: "patch",
        hunks: [{ header: "@@ -1 +1 @@", lines: ["-old", "+new"] }],
      },
    ],
  })

  assert.match(diff, /@@ -1 \+1 @@/)
  assert.match(diff, /-old/)
  assert.match(diff, /\+new/)
})

test("extractPatchFileEntries splits unified diffs by file", () => {
  const entries = extractPatchFileEntries({
    parts: [
      {
        type: "patch",
        diff: [
          "diff --git a/src/a.js b/src/a.js",
          "--- a/src/a.js",
          "+++ b/src/a.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "diff --git a/src/b.js b/src/b.js",
          "--- a/src/b.js",
          "+++ b/src/b.js",
          "@@ -2 +2 @@",
          "-left",
          "+right",
        ].join("\n"),
      },
    ],
  })

  assert.deepEqual(entries.map((entry) => entry.file), ["src/a.js", "src/b.js"])
  assert.match(entries[0].diff, /\+new/)
  assert.match(entries[1].diff, /\+right/)
})

test("extractPatchFileEntries keeps file entries without available diff", () => {
  const entries = extractPatchFileEntries({ parts: [{ type: "patch", files: ["a.txt", "b.txt"] }] })

  assert.deepEqual(entries, [{ file: "a.txt", diff: "" }, { file: "b.txt", diff: "" }])
})
