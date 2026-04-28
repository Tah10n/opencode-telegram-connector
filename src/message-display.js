function toForwardSlashes(p) {
  return String(p || "").replace(/\\/g, "/")
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function patchPartText(part) {
  const direct = cleanString(part?.diff || part?.patch || part?.text || part?.content)
  if (direct) return direct

  const hunks = Array.isArray(part?.hunks) ? part.hunks : []
  return hunks
    .map((hunk) => {
      if (typeof hunk === "string") return hunk
      const header = cleanString(hunk?.header)
      const lines = Array.isArray(hunk?.lines) ? hunk.lines.filter((line) => typeof line === "string") : []
      return [header, ...lines].filter(Boolean).join("\n")
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function stripDiffPrefix(value) {
  const text = cleanString(value)
  if (!text || text === "/dev/null") return ""
  return text.replace(/^(?:a|b)\//, "")
}

function inferFileFromDiffSection(section) {
  const lines = String(section || "").split("\n")
  for (const line of lines) {
    const match = line.match(/^diff --git\s+a\/(.*?)\s+b\/(.*?)\s*$/)
    if (match) return stripDiffPrefix(match[2] || match[1])
  }
  for (const line of lines) {
    const match = line.match(/^Index:\s+(.+)$/)
    if (match) {
      const file = stripDiffPrefix(match[1].split(/\t/)[0])
      if (file) return file
    }
  }
  const hunkState = { oldRemaining: 0, newRemaining: 0 }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!hasActiveUnifiedHunk(hunkState) && isUnifiedFileHeaderPair(lines, index)) {
      const oldPath = diffHeaderPath(line, "---")
      const newPath = diffHeaderPath(lines[index + 1], "+++")
      return newPath || oldPath
    }
    const hunk = parseUnifiedHunkHeader(line)
    if (hunk) {
      hunkState.oldRemaining = hunk.oldRemaining
      hunkState.newRemaining = hunk.newRemaining
      continue
    }
    consumeUnifiedHunkLine(hunkState, line)
  }
  return ""
}

function rawDiffHeaderPath(line, marker) {
  const re = marker === "---" ? /^---\s+(.+)$/ : /^\+\+\+\s+(.+)$/
  const match = String(line || "").match(re)
  if (!match) return ""
  return match[1].split(/\t/)[0].trim()
}

function diffHeaderPath(line, marker) {
  return stripDiffPrefix(rawDiffHeaderPath(line, marker))
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
  const oldPath = stripDiffPrefix(rawOldPath)
  const newPath = stripDiffPrefix(rawNewPath)
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
}

function normalizeOpenCodeFileDiffEntries(diffs) {
  const list = Array.isArray(diffs) ? diffs : []
  const entries = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const diff = cleanString(item.patch || item.diff || item.text || item.content)
    const rawFile = cleanString(item.file || item.path || item.filename)
    if (!diff && !rawFile) continue
    const file = rawFile || inferFileFromDiffSection(diff) || "changed-file"
    entries.push({ file, diff })
  }
  return entries
}

function splitUnifiedDiffByFile(diffText) {
  const lines = String(diffText || "").split("\n")
  const sections = []
  let current = []
  let currentHasFileBody = false
  const hunkState = { oldRemaining: 0, newRemaining: 0 }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const startsExplicitSection = line.startsWith("diff --git ") || line.startsWith("Index: ")
    const startsHeaderPairSection = !hasActiveUnifiedHunk(hunkState) && currentHasFileBody && isUnifiedFileHeaderPair(lines, index)
    if ((startsExplicitSection || startsHeaderPairSection) && current.length) {
      sections.push(current.join("\n").trim())
      current = []
      currentHasFileBody = false
      hunkState.oldRemaining = 0
      hunkState.newRemaining = 0
    }
    current.push(line)
    const hunk = parseUnifiedHunkHeader(line)
    if (hunk) {
      hunkState.oldRemaining = hunk.oldRemaining
      hunkState.newRemaining = hunk.newRemaining
    } else {
      consumeUnifiedHunkLine(hunkState, line)
    }
    if (isUnifiedFileHeaderPair(lines, index)
      || line.startsWith("@@")
      || line.startsWith("Binary files ")
      || line.startsWith("GIT binary patch")) {
      currentHasFileBody = true
    }
  }
  if (current.length) sections.push(current.join("\n").trim())
  return sections.filter(Boolean)
}

export function extractPatchFiles(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const out = []
  for (const part of parts) {
    if (!part || part.type !== "patch") continue
    const files = Array.isArray(part.files) ? part.files : []
    let hasExplicitFile = false
    for (const f of files) {
      if (typeof f !== "string") continue
      const v = f.trim()
      if (!v) continue
      hasExplicitFile = true
      out.push(v)
    }
    const diffText = patchPartText(part)
    if (!diffText || hasExplicitFile) continue
    const sections = splitUnifiedDiffByFile(diffText)
    const inferred = (sections.length ? sections : [diffText])
      .map((section) => inferFileFromDiffSection(section))
      .filter(Boolean)
    if (inferred.length) {
      out.push(...inferred)
    } else if (!hasExplicitFile) {
      out.push("changed-file")
    }
  }
  // Preserve order but de-duplicate.
  const seen = new Set()
  const uniq = []
  for (const f of out) {
    const k = f.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(f)
  }
  return uniq
}

export function extractPatchDiffText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const out = []
  for (const part of parts) {
    if (!part || part.type !== "patch") continue
    const chunk = patchPartText(part)
    if (chunk) out.push(chunk)
  }
  return out.join("\n\n").trim()
}

export function extractPatchFileEntries(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const entries = []
  for (const part of parts) {
    if (!part || part.type !== "patch") continue
    const files = Array.isArray(part.files) ? part.files.map(cleanString).filter(Boolean) : []
    const diffText = patchPartText(part)
    if (!diffText) {
      for (const file of files) entries.push({ file, diff: "" })
      continue
    }

    const sections = splitUnifiedDiffByFile(diffText)
    if (sections.length > 1) {
      sections.forEach((section, index) => {
        entries.push({ file: inferFileFromDiffSection(section) || files[index] || `file-${index + 1}`, diff: section })
      })
      continue
    }

    if (files.length <= 1) {
      entries.push({ file: files[0] || inferFileFromDiffSection(diffText) || "changed-file", diff: diffText })
      continue
    }

    if (sections.length === files.length) {
      sections.forEach((section, index) => entries.push({ file: files[index], diff: section }))
      continue
    }

    entries.push({ file: files[0] || inferFileFromDiffSection(diffText) || "changed-file", diff: diffText })
    for (const file of files.slice(1)) entries.push({ file, diff: "" })
  }

  const byFile = new Map()
  for (const entry of entries) {
    const file = cleanString(entry.file)
    if (!file) continue
    const key = file.toLowerCase()
    const previous = byFile.get(key)
    if (!previous) {
      byFile.set(key, { file, diff: cleanString(entry.diff) })
    } else if (cleanString(entry.diff)) {
      previous.diff = [previous.diff, cleanString(entry.diff)].filter(Boolean).join("\n\n")
    }
  }
  return [...byFile.values()]
}

export function extractSummaryFileDiffEntries(message) {
  return normalizeOpenCodeFileDiffEntries(message?.info?.summary?.diffs || message?.summary?.diffs)
}

export function formatFileDiffEntriesPatch(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => cleanString(entry?.diff))
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export function formatChangedFilesText(files, { baseDir, limit = 10 } = {}) {
  const list = Array.isArray(files) ? files : []
  if (list.length === 0) return ""

  const base = baseDir ? toForwardSlashes(baseDir).replace(/\/+$/, "") : ""
  const normalized = list.map((f) => {
    const fp = toForwardSlashes(f)
    if (!base) return fp
    // Case-insensitive prefix match (Windows-friendly). For non-Windows this is still acceptable for display.
    const b = base.toLowerCase()
    const x = fp.toLowerCase()
    if (x === b) return fp
    if (x.startsWith(b + "/")) return fp.slice(base.length + 1)
    return fp
  })

  const shown = normalized.slice(0, limit)
  const lines = ["Changed files:"]
  for (const f of shown) lines.push(`- ${f}`)
  if (normalized.length > limit) lines.push(`…and ${normalized.length - limit} more.`)
  return lines.join("\n")
}
