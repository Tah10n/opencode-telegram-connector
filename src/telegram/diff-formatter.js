import { escapeHtml } from "./formatter.js"

const DEFAULT_DIFF_TITLE = "Changed files diff"
const DIFF_LEGEND = "🟢 added · 🔴 removed · ⚪ context · 🔎 hunk"

function trimDiffPathPrefix(path) {
  return String(path || "")
    .replace(/^"|"$/g, "")
    .replace(/^[ab]\//, "")
}

function formatDiffGitHeader(line) {
  const match = String(line).match(/^diff --git\s+(\S+)\s+(\S+)\s*$/)
  if (!match) return `📄 ${line}`
  const oldPath = trimDiffPathPrefix(match[1])
  const newPath = trimDiffPathPrefix(match[2])
  return `📄 ${newPath || oldPath || line}`
}

function rawDiffHeaderPath(line, marker) {
  const re = marker === "---" ? /^---\s+(.+)$/ : /^\+\+\+\s+(.+)$/
  const match = String(line || "").match(re)
  if (!match) return ""
  return match[1].split(/\t/)[0].trim()
}

function diffHeaderPath(line, marker) {
  return trimDiffPathPrefix(rawDiffHeaderPath(line, marker))
}

function hasDiffPathMarker(rawPath) {
  const path = String(rawPath || "").trim()
  return path === "/dev/null"
    || /^(?:a|b|\.{1,2})\//.test(path)
    || path.includes("/")
    || path.includes("\\")
    || /\.[^/\\\s]+$/.test(path)
}

function isPlausibleFileHeaderPathPair(lines, index) {
  const rawOldPath = rawDiffHeaderPath(lines[index], "---")
  const rawNewPath = rawDiffHeaderPath(lines[index + 1], "+++")
  const oldPath = trimDiffPathPrefix(rawOldPath)
  const newPath = trimDiffPathPrefix(rawNewPath)
  if (!oldPath && !newPath) return false
  if (oldPath && newPath && oldPath === newPath) return true
  return hasDiffPathMarker(rawOldPath) || hasDiffPathMarker(rawNewPath)
}

function isUnifiedFileHeaderPair(lines, index) {
  if (!isPlausibleFileHeaderPathPair(lines, index)) return false
  const oldPath = diffHeaderPath(lines[index], "---")
  const newPath = diffHeaderPath(lines[index + 1], "+++")
  if (!oldPath && !newPath) return false
  const after = String(lines[index + 2] || "")
  return after.startsWith("@@")
    || after.startsWith("Binary files ")
    || after.startsWith("GIT binary patch")
    || after.startsWith("literal ")
    || after.startsWith("delta ")
}

function parseUnifiedHunkHeader(line) {
  const match = String(line || "").match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
  if (!match) return null
  return {
    oldRemaining: match[2] == null ? 1 : Number(match[2]),
    newRemaining: match[4] == null ? 1 : Number(match[4]),
  }
}

function hasActiveUnifiedHunk(state) {
  return state.oldRemaining > 0 || state.newRemaining > 0
}

function consumeUnifiedHunkLine(state, line) {
  if (!hasActiveUnifiedHunk(state)) return
  const marker = String(line || "")[0]
  if (marker === " ") {
    state.oldRemaining = Math.max(0, state.oldRemaining - 1)
    state.newRemaining = Math.max(0, state.newRemaining - 1)
  } else if (marker === "-") {
    state.oldRemaining = Math.max(0, state.oldRemaining - 1)
  } else if (marker === "+") {
    state.newRemaining = Math.max(0, state.newRemaining - 1)
  }
  if (!hasActiveUnifiedHunk(state)) state.inHunk = false
}

function decorateUnifiedDiffLine(line, state, lines, index) {
  if (line === "") {
    state.inHunk = false
    return ""
  }
  if (line.startsWith("diff --git ")) {
    state.inHunk = false
    return formatDiffGitHeader(line)
  }
  if (line.startsWith("Index: ")) {
    state.inHunk = false
    return `📄 ${line.slice("Index: ".length).trim() || line}`
  }
  if (!hasActiveUnifiedHunk(state) && isUnifiedFileHeaderPair(lines, index)) {
    state.inHunk = false
    state.fileHeaderContinuation = true
    return `📍 ${line}`
  }
  if (state.fileHeaderContinuation && line.startsWith("+++ ")) {
    state.fileHeaderContinuation = false
    return `📍 ${line}`
  }
  if (line.startsWith("@@")) {
    const hunk = parseUnifiedHunkHeader(line)
    if (hunk) {
      state.oldRemaining = hunk.oldRemaining
      state.newRemaining = hunk.newRemaining
    }
    state.inHunk = true
    return `🔎 ${line}`
  }
  if (!state.inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) return `📍 ${line}`
  if (line.startsWith("+")) {
    consumeUnifiedHunkLine(state, line)
    return `🟢 ${line}`
  }
  if (line.startsWith("-")) {
    consumeUnifiedHunkLine(state, line)
    return `🔴 ${line}`
  }
  if (line.startsWith("\\ No newline")) return `↩ ${line}`
  if (
    line.startsWith("index ")
    || line.startsWith("new file mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ")
    || line.startsWith("similarity index ")
    || line.startsWith("dissimilarity index ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
  ) {
    return `ℹ️ ${line}`
  }
  consumeUnifiedHunkLine(state, line)
  return `⚪ ${line}`
}

export function decorateUnifiedDiffText(diffText) {
  const state = { inHunk: false, fileHeaderContinuation: false, oldRemaining: 0, newRemaining: 0 }
  const lines = String(diffText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
  return lines
    .map((line, index) => decorateUnifiedDiffLine(line, state, lines, index))
    .join("\n")
}

export function formatUnifiedDiffHtml(diffText, { title = DEFAULT_DIFF_TITLE } = {}) {
  const decoratedDiff = decorateUnifiedDiffText(diffText)
  return [
    `<b>${escapeHtml(title || DEFAULT_DIFF_TITLE)}</b>`,
    `<i>${escapeHtml(DIFF_LEGEND)}</i>`,
    `<pre><code>${escapeHtml(decoratedDiff)}</code></pre>`,
  ].join("\n")
}
