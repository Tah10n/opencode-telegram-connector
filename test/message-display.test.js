import test from "node:test"
import assert from "node:assert/strict"
import { extractPatchFiles, formatChangedFilesText } from "../src/message-display.js"

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
