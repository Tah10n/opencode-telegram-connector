#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..")
const srcDir = path.join(projectRoot, "src")
const scanRoot = process.argv[2] ? path.resolve(process.argv[2]) : srcDir
const allowedPipeSplitFiles = new Set(["src/connector/callback-data.js"])
const RAW_CALLBACK_LITERAL_RE = /(?:^|[^A-Za-z0-9_$])(?:rt|s|srv|b|feed|m|cf|att|p|q)\|/

function normalizePath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/")
}

async function collectJsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath)
  }
  return files
}

function findCallbackDataViolations({ relPath, text }) {
  const violations = []
  const lines = text.split(/\r?\n/)
  const literalsByStartLine = new Map()
  for (const literal of stringLiterals(text)) {
    const existing = literalsByStartLine.get(literal.startLine) ?? []
    existing.push(literal)
    literalsByStartLine.set(literal.startLine, existing)
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    const literals = literalsByStartLine.get(lineNumber) ?? []
    const hasRawPipeLiteral = literals.some((literal) => literal.content.includes("|"))
    const hasRawCallbackLiteral = literals.some((literal) => RAW_CALLBACK_LITERAL_RE.test(literal.content))
    if (/\bcallback_data\s*:/.test(line) && hasRawPipeLiteral) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-delimited callback_data", line })
    } else if (/\b(?:cb|runtime\.cb)\.pack\s*\(/.test(line) && hasRawPipeLiteral) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-delimited cb.pack payload", line })
    } else if (hasRawCallbackLiteral) {
      violations.push({ relPath, lineNumber, reason: "raw callback payload literal", line })
    }
    if (!allowedPipeSplitFiles.has(relPath) && /\.split\(\s*["']\|["']\s*\)/.test(line)) {
      violations.push({ relPath, lineNumber, reason: "pipe split outside callback codec", line })
    }
  }
  return violations
}

function stringLiterals(text) {
  const literals = []
  let line = 1
  let quote = ""
  let escaped = false
  let current = ""
  let startLine = 1
  for (const ch of text) {
    if (!quote) {
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        escaped = false
        current = ""
        startLine = line
      }
      if (ch === "\n") line++
      continue
    }
    if (escaped) {
      current += ch
      escaped = false
      if (ch === "\n") line++
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === quote) {
      literals.push({ content: current, startLine })
      quote = ""
      current = ""
      continue
    }
    current += ch
    if (ch === "\n") line++
  }
  return literals
}

const files = await collectJsFiles(scanRoot)
const violations = []
for (const filePath of files) {
  const relPath = normalizePath(filePath)
  const text = await fs.readFile(filePath, "utf8")
  violations.push(...findCallbackDataViolations({ relPath, text }))
}

if (violations.length) {
  console.error("Callback data guard failed. Use callbackPacker()/encodeCallback() instead of raw pipe-delimited callback payloads.")
  for (const violation of violations) {
    console.error(`- ${violation.relPath}:${violation.lineNumber}: ${violation.reason}`)
    console.error(`  ${violation.line.trim()}`)
  }
  process.exitCode = 1
} else {
  console.log(`Callback data guard passed for ${files.length} files.`)
}
