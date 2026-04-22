function toForwardSlashes(p) {
  return String(p || "").replace(/\\/g, "/")
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : ""
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
    const direct = cleanString(part.diff || part.patch || part.text || part.content)
    if (direct) {
      out.push(direct)
      continue
    }

    const hunks = Array.isArray(part.hunks) ? part.hunks : []
    const chunk = hunks
      .map((hunk) => {
        if (typeof hunk === "string") return hunk
        const header = cleanString(hunk?.header)
        const lines = Array.isArray(hunk?.lines) ? hunk.lines.filter((line) => typeof line === "string") : []
        return [header, ...lines].filter(Boolean).join("\n")
      })
      .filter(Boolean)
      .join("\n")
      .trim()
    if (chunk) out.push(chunk)
  }
  return out.join("\n\n").trim()
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
