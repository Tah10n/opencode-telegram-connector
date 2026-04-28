import test from "node:test"
import assert from "node:assert/strict"
import {
  extractPatchDiffText,
  extractPatchFileEntries,
  extractPatchFiles,
  extractSummaryFileDiffEntries,
  formatChangedFilesText,
  formatFileDiffEntriesPatch,
} from "../src/message-display.js"

test("extractPatchFiles returns unique file list from patch parts", () => {
  const files = extractPatchFiles({
    parts: [
      { type: "patch", files: ["/a/b.txt", "/a/B.txt", "  /c/d.js  "] },
      { type: "patch", files: ["/c/d.js", ""] },
    ],
  })

  assert.deepEqual(files, ["/a/b.txt", "/c/d.js"])
})

test("extractPatchFiles infers files from patch diff text", () => {
  const files = extractPatchFiles({
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
          "@@ -1 +1 @@",
          "-left",
          "+right",
        ].join("\n"),
      },
    ],
  })

  assert.deepEqual(files, ["src/a.js", "src/b.js"])
})

test("extractPatchFiles infers files from header-only multi-file diffs", () => {
  const files = extractPatchFiles({
    parts: [
      {
        type: "patch",
        diff: [
          "--- a/src/a.js",
          "+++ b/src/a.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "--- a/src/b.js",
          "+++ b/src/b.js",
          "@@ -1 +1 @@",
          "-left",
          "+right",
        ].join("\n"),
      },
    ],
  })

  assert.deepEqual(files, ["src/a.js", "src/b.js"])
})

test("extractPatchFiles infers files from Index-style multi-file diffs", () => {
  const files = extractPatchFiles({
    parts: [
      {
        type: "patch",
        diff: [
          "Index: src/a.js",
          "--- src/a.js",
          "+++ src/a.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "Index: src/b.js",
          "--- src/b.js",
          "+++ src/b.js",
          "@@ -1 +1 @@",
          "-left",
          "+right",
        ].join("\n"),
      },
    ],
  })

  assert.deepEqual(files, ["src/a.js", "src/b.js"])
})

test("extractPatchFiles infers files from Index-only sections", () => {
  const files = extractPatchFiles({
    parts: [
      {
        type: "patch",
        diff: [
          "Index: src/a.bin",
          "Binary files differ",
          "Index: src/b.bin",
          "Binary files differ",
        ].join("\n"),
      },
    ],
  })

  assert.deepEqual(files, ["src/a.bin", "src/b.bin"])
})

test("extractPatchFiles infers deleted files from the old path", () => {
  const files = extractPatchFiles({
    parts: [{ type: "patch", diff: "--- src/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old" }],
  })

  assert.deepEqual(files, ["src/old.js"])
})

test("extractPatchFiles prefers explicit files over inferred diff paths", () => {
  const files = extractPatchFiles({
    parts: [
      {
        type: "patch",
        files: ["/repo/src/app.js"],
        diff: "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new",
      },
    ],
  })

  assert.deepEqual(files, ["/repo/src/app.js"])
})

test("extractPatchFiles uses a generic file label when diff has no file headers", () => {
  const files = extractPatchFiles({
    parts: [{ type: "patch", diff: "@@ -1 +1 @@\n-old\n+new" }],
  })

  assert.deepEqual(files, ["changed-file"])
})

test("extractPatchFiles does not infer file names from hunk content", () => {
  const files = extractPatchFiles({
    parts: [{ type: "patch", diff: "@@ -1,2 +1,2 @@\n--- removed heading\n+++ added heading" }],
  })

  assert.deepEqual(files, ["changed-file"])
})

test("extractPatchFiles does not infer hunk content before another hunk", () => {
  const files = extractPatchFiles({
    parts: [{ type: "patch", diff: "@@ -1 +1 @@\n--- README.md\n+++ README.md\n@@ -10 +10 @@\n-next\n+next" }],
  })

  assert.deepEqual(files, ["changed-file"])
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

test("extractPatchFileEntries splits header-only diffs by file", () => {
  const entries = extractPatchFileEntries({
    parts: [
      {
        type: "patch",
        diff: [
          "--- a/src/a.js",
          "+++ b/src/a.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "--- a/src/b.js",
          "+++ b/src/b.js",
          "@@ -1 +1 @@",
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

test("extractPatchFileEntries splits Index-style diffs by file", () => {
  const entries = extractPatchFileEntries({
    parts: [
      {
        type: "patch",
        diff: [
          "Index: src/a.js",
          "--- src/a.js",
          "+++ src/a.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "Index: src/b.js",
          "--- src/b.js",
          "+++ src/b.js",
          "@@ -1 +1 @@",
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

test("extractPatchFileEntries labels Index-only sections", () => {
  const entries = extractPatchFileEntries({
    parts: [{ type: "patch", diff: "Index: src/a.bin\nBinary files differ\nIndex: src/b.bin\nBinary files differ" }],
  })

  assert.deepEqual(entries.map((entry) => entry.file), ["src/a.bin", "src/b.bin"])
})

test("extractPatchFileEntries keeps file entries without available diff", () => {
  const entries = extractPatchFileEntries({ parts: [{ type: "patch", files: ["a.txt", "b.txt"] }] })

  assert.deepEqual(entries, [{ file: "a.txt", diff: "" }, { file: "b.txt", diff: "" }])
})

test("extractPatchFileEntries does not label headerless hunks from content", () => {
  const entries = extractPatchFileEntries({
    parts: [{ type: "patch", diff: "@@ -1,2 +1,2 @@\n--- removed heading\n+++ added heading" }],
  })

  assert.deepEqual(entries.map((entry) => entry.file), ["changed-file"])
})

test("extractPatchFileEntries keeps hunk content before another hunk in one generic entry", () => {
  const entries = extractPatchFileEntries({
    parts: [{ type: "patch", diff: "@@ -1 +1 @@\n--- README.md\n+++ README.md\n@@ -10 +10 @@\n-next\n+next" }],
  })

  assert.deepEqual(entries.map((entry) => entry.file), ["changed-file"])
  assert.equal(entries.length, 1)
})

test("extractSummaryFileDiffEntries reads current opencode user summary diffs", () => {
  const entries = extractSummaryFileDiffEntries({
    info: {
      summary: {
        diffs: [
          { file: "src/app.js", patch: "Index: src/app.js\n--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-old\n+new" },
        ],
      },
    },
  })

  assert.deepEqual(entries.map((entry) => entry.file), ["src/app.js"])
  assert.match(formatFileDiffEntriesPatch(entries), /\+new/)
})
