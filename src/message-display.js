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
    const match = line.match(/^\+\+\+\s+(.+)$/)
    if (match) return stripDiffPrefix(match[1].split(/\t/)[0])
  }
  for (const line of lines) {
    const match = line.match(/^---\s+(.+)$/)
    if (match) return stripDiffPrefix(match[1].split(/\t/)[0])
  }
  return ""
}

function splitUnifiedDiffByFile(diffText) {
  const lines = String(diffText || "").split("\n")
  const sections = []
  let current = []
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      sections.push(current.join("\n").trim())
      current = []
    }
    current.push(line)
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
    for (const f of files) {
      if (typeof f !== "string") continue
      const v = f.trim()
      if (!v) continue
      out.push(v)
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
