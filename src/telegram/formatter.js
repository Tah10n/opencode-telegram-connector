// Telegram HTML formatting helpers (ported from the original single-file connector).

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function escapeHtmlAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;")
}

export function formatInlineMarkdownToHtml(text) {
  const s = String(text ?? "")
  const parts = s.split("`")
  let out = ""
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i]
    const isCode = i % 2 === 1
    if (isCode) {
      out += `<code>${escapeHtml(chunk)}</code>`
      continue
    }
    const tokens = []
    const tokenFor = (html) => {
      const idx = tokens.push(html) - 1
      return `\u0000${idx}\u0000`
    }
    let t = chunk
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safeUrl = String(url)
      const safeLabel = String(label)
      if (!/^https?:\/\//i.test(safeUrl)) return tokenFor(escapeHtml(safeLabel))
      if (safeUrl.length > 300) return tokenFor(escapeHtml(safeLabel))
      return tokenFor(`<a href="${escapeHtmlAttr(safeUrl)}">${escapeHtml(safeLabel)}</a>`)
    })
    t = t.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => tokenFor(`<b>${escapeHtml(inner)}</b>`))
    t = t.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, (_, a, inner) => a + tokenFor(`<i>${escapeHtml(inner)}</i>`))
    t = t.replace(/(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g, (_, a, inner) => a + tokenFor(`<i>${escapeHtml(inner)}</i>`))
    t = escapeHtml(t)
    t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)] ?? "")
    out += t
  }
  return out
}

function splitPlainText(text, maxLen) {
  const s = String(text ?? "")
  if (s.length <= maxLen) return [s]

  const nextWholeCharacterIndex = (value, index) => {
    const first = value.charCodeAt(index)
    if (Number.isNaN(first)) return index + 1
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) return index + 2
    }
    return index + 1
  }

  const splitOversizedChunk = (value) => {
    const pieces = []
    let current = ""
    for (let i = 0; i < value.length;) {
      const next = nextWholeCharacterIndex(value, i)
      const token = value.slice(i, next)
      if (current && current.length + token.length > maxLen) {
        pieces.push(current)
        current = ""
      }
      if (!current && token.length > maxLen) {
        pieces.push(token)
      } else {
        current += token
      }
      i = next
    }
    if (current) pieces.push(current)
    return pieces
  }

  const lines = s.split("\n")
  const chunks = []
  let current = ""
  for (const line of lines) {
    const add = (current ? "\n" : "") + line
    if ((current + add).length <= maxLen) {
      current += add
      continue
    }
    if (current) {
      chunks.push(current)
      current = ""
    }
    if (line.length > maxLen) {
      for (const piece of splitOversizedChunk(line)) chunks.push(piece)
    } else {
      current = line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function splitEscapedPlainText(text, maxLen) {
  const chunks = []
  let current = ""
  for (const ch of String(text ?? "")) {
    const escaped = escapeHtml(ch)
    if (current && current.length + escaped.length > maxLen) {
      chunks.push(current)
      current = ""
    }
    current += escaped
  }
  if (current) chunks.push(current)
  return chunks
}

export function formatMarkdownToTelegramHtmlBlocks(markdownText) {
  const s = String(markdownText ?? "")
  const blocks = []

  const pushText = (t) => {
    if (!t) return
    const lines = String(t).split(/\n/)

    // Build chunks on line boundaries to avoid breaking HTML tags.
    let cur = ""
    const flush = () => {
      if (!cur) return
      blocks.push({ type: "text", html: cur })
      cur = ""
    }
    const maxLen = 3900

    for (const lineRaw of lines) {
      // If a single line is too long, split it first (may lose some markdown fidelity,
      // but keeps HTML well-formed and Telegram-parseable).
      const pieces = lineRaw.length > 2000 ? splitPlainText(lineRaw, 2000) : [lineRaw]
      for (const line of pieces) {
        let htmlLine
        const m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/)
        if (m) {
          htmlLine = `<b>${formatInlineMarkdownToHtml(m[1])}</b>`
        } else {
          const b = line.match(/^\s*[-*+]\s+(.*)$/)
          if (b) {
            htmlLine = `• ${formatInlineMarkdownToHtml(b[1])}`
          } else {
            const q = line.match(/^\s*>\s?(.*)$/)
            if (q) {
              htmlLine = `<blockquote>${formatInlineMarkdownToHtml(q[1])}</blockquote>`
            } else {
              htmlLine = formatInlineMarkdownToHtml(line)
            }
          }
        }

        const add = (cur ? "\n" : "") + htmlLine
        if ((cur + add).length <= maxLen) {
          cur += add
        } else {
          flush()
          if (htmlLine.length <= maxLen) {
            cur = htmlLine
          } else {
            // Extreme fallback: avoid HTML entirely for this long line.
            for (const escapedChunk of splitEscapedPlainText(line, maxLen)) {
              blocks.push({ type: "text", html: escapedChunk })
            }
          }
        }
      }
    }
    flush()
  }

  // Handle fenced code blocks.
  const fence = /```([\s\S]*?)```/g
  let last = 0
  for (const m of s.matchAll(fence)) {
    pushText(s.slice(last, m.index))
    const code = m[1] ?? ""

    // Keep <pre><code> blocks well-formed even when chunking.
    const wrapperOpen = `<pre><code>`
    const wrapperClose = `</code></pre>`
    const maxLen = 3900
    const maxRawPerChunk = Math.max(1, Math.floor((maxLen - wrapperOpen.length - wrapperClose.length) / 6))
    const rawChunks = splitPlainText(code.trim(), maxRawPerChunk)
    for (const rawChunk of rawChunks) {
      blocks.push({ type: "text", html: `${wrapperOpen}${escapeHtml(rawChunk)}${wrapperClose}` })
    }
    last = (m.index ?? 0) + m[0].length
  }
  pushText(s.slice(last))

  return blocks
}
