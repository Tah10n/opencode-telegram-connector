#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..")
const srcDir = path.join(projectRoot, "src")
const scanRoot = process.argv[2] ? path.resolve(process.argv[2]) : srcDir
const allowedPipeSplitFiles = new Set(["src/connector/callback-data.js"])
const RAW_CALLBACK_LITERAL_RE = /(?:^|[^A-Za-z0-9_$])(?:rt|s|srv|b|feed|m|cf|att|p|q|lang)\|/
const PIPE_JOIN_RE = /\.join\(\s*(["'`])\|\1\s*\)/

function normalizePath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/")
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function codeOnlyText(text) {
  return String(text).split(/\r?\n/).map(codeOnlyLine).join(" ")
}

function stripCommentsPreserveNewlines(text) {
  let out = ""
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  const value = String(text || "")

  for (let index = 0; index < value.length; index++) {
    const ch = value[index]
    const next = value[index + 1]

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false
        out += ch
      } else {
        out += " "
      }
      continue
    }

    if (blockComment) {
      if (ch === "\n") {
        out += ch
      } else if (ch === "*" && next === "/") {
        out += "  "
        index++
        blockComment = false
      } else {
        out += " "
      }
      continue
    }

    if (quote) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === quote) {
        quote = ""
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      escaped = false
      out += ch
    } else if (ch === "/" && next === "/") {
      out += "  "
      index++
      lineComment = true
    } else if (ch === "/" && next === "*") {
      out += "  "
      index++
      blockComment = true
    } else {
      out += ch
    }
  }

  return out
}

function callbackPayloadExpressions(code) {
  const text = String(code || "")
  const re = /\bcallback_data\s*:|\b(?:cb|runtime\.cb)\.pack\s*\(/g
  const expressions = []
  for (const match of text.matchAll(re)) {
    const token = match[0]
    const kind = token.includes("callback_data") ? "callback_data" : "cb.pack"
    const expressionStart = (match.index || 0) + token.length
    const expressionSource = text.slice(expressionStart)
    const leadingWhitespace = expressionSource.match(/^\s*/)?.[0]?.length || 0
    expressions.push({ kind, expressionStart: expressionStart + leadingWhitespace, expression: topLevelExpression(expressionSource) })
  }
  return expressions
}

function rawCallbackPayloadExpression(text) {
  return callbackPayloadExpressions(String(text || ""))[0]?.expression || ""
}

function payloadHasPipeLiteral(expression) {
  return stringLiterals(expression).some((literal) => literal.content.includes("|"))
}

function isEncodedCallbackExpression(expression) {
  return /^\s*(?:packCallback|encodeCallback|pack|cb\.pack|runtime\.cb\.pack)\s*\(/.test(expression)
}

function isEncodedCallbackPayload(payload) {
  return payload.kind === "cb.pack" || (payload.kind === "callback_data" && isEncodedCallbackExpression(payload.expression))
}

function lineColumnAtOffset(text, offset) {
  let line = 1
  let column = 0
  for (let index = 0; index < offset; index++) {
    if (text[index] === "\n") {
      line++
      column = 0
    } else {
      column++
    }
  }
  return { line, column }
}

function rawLiteralKey(lineNumber, column, content) {
  return `${lineNumber}:${column}:${content}`
}

function topLevelExpression(value) {
  const text = String(value || "")
  let depth = 0
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    const next = text[index + 1]

    if (lineComment) {
      if (ch === "\n") lineComment = false
      continue
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        index++
        blockComment = false
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === quote) {
        quote = ""
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      escaped = false
      continue
    }
    if (ch === "/" && next === "/") {
      index++
      lineComment = true
      continue
    }
    if (ch === "/" && next === "*") {
      index++
      blockComment = true
      continue
    }

    if ((ch === "," || ch === "}" || ch === ")") && depth <= 0) return text.slice(0, index).trim()
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
  }
  return text.trim()
}

function isVariableUsedAsCallbackPayload(text, variableName) {
  const name = escapeRegExp(variableName)
  const code = codeOnlyText(text)
  return callbackPayloadExpressions(code).some((payload) => {
    const expression = payload.expression
    if (new RegExp(`^\\s*${name}\\b`).test(expression)) return true
    if (payload.kind === "callback_data" && new RegExp(`\\b(?:packCallback|pack)\\s*\\(\\s*${name}\\b`).test(expression)) return true
    if (payload.kind === "callback_data" && /^\s*(?:packCallback|encodeCallback|pack)\s*\(/.test(expression)) return false
    return new RegExp(`(?:[?:]|\\|\\||&&)\\s*${name}\\b`).test(expression)
  })
}

function stripStringLiteralContent(line) {
  let out = ""
  let quote = ""
  let escaped = false
  for (const ch of line) {
    if (!quote) {
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        escaped = false
        out += " "
      } else {
        out += ch
      }
      continue
    }
    out += " "
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === quote) quote = ""
  }
  return out
}

function stripCommentContent(line) {
  return line.replace(/\/\/.*$/g, "").replace(/\/\*.*?\*\//g, " ")
}

function codeOnlyLine(line) {
  return stripCommentContent(stripStringLiteralContent(line))
}

function bracketDelta(line) {
  let delta = 0
  for (const ch of codeOnlyLine(line)) {
    if (ch === "(" || ch === "[" || ch === "{") delta++
    if (ch === ")" || ch === "]" || ch === "}") delta--
  }
  return delta
}

function computeScopeInfo(lines) {
  const paths = []
  const openedPaths = []
  const stack = []
  let nextId = 1
  for (const line of lines) {
    const stripped = codeOnlyLine(line)
    const leadingClose = stripped.match(/^\s*}+/)?.[0]?.match(/}/g)?.length || 0
    paths.push(stack.slice(0, Math.max(0, stack.length - leadingClose)))
    const opened = []
    for (const ch of stripped) {
      if (ch === "{") {
        stack.push(nextId++)
        opened.push([...stack])
      }
      if (ch === "}") stack.pop()
    }
    openedPaths.push(opened)
  }
  return { paths, openedPaths }
}

function isIncompleteCallbackPayloadStart(line) {
  return /\bcallback_data\s*:\s*(?:\/\/.*)?$/.test(line) ||
    /\b(?:cb|runtime\.cb)\.pack\s*\(\s*(?:\/\/.*)?$/.test(line)
}

function collectCallbackPayloadWindow(lines, index) {
  const end = lines.length
  let text = ""
  let depth = 0
  for (let i = index; i < end; i++) {
    const line = lines[i]
    text = text ? `${text}\n${line}` : line
    depth += bracketDelta(line)
    if (i === index && depth <= 0 && !isIncompleteCallbackPayloadStart(line) && /[,})]\s*(?:\/\/.*)?$/.test(line.trim()) && !continuesOnNextLine(lines, i)) break
    if (i > index && depth <= 0 && /[,})]\s*(?:\/\/.*)?$/.test(line.trim()) && !continuesOnNextLine(lines, i)) break
  }
  return text
}

function parameterNamesFromFunctionLine(line) {
  const match = line.match(/\bfunction\b[^()]*\(([^)]*)\)\s*{/) || line.match(/(?:[=(:,])\s*(?:async\s+)?\(?\s*([^)=]*)\)?\s*=>\s*{/)
  if (!match) return []
  return parameterNamesFromList(match[1])
}

function parameterNamesFromList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().match(/^([A-Za-z_$][\w$]*)\b/)?.[1] || "")
    .filter(Boolean)
}

function parameterNamesFromConciseArrowLine(line) {
  const match = line.match(/(?:[=(:,])\s*(?:async\s+)?\(?\s*([^)=]*)\)?\s*=>\s*\(?\s*{?/) 
  if (!match || /=>\s*{/.test(line)) return []
  return parameterNamesFromList(match[1])
}

function parameterInfoFromSignature(lines, startIndex, scopePaths, openedScopePaths, maxLines = 12) {
  const firstLine = lines[startIndex]
  if (!/\bfunction\b[^()]*\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(?|=>/.test(firstLine)) return null

  let text = ""
  for (let index = startIndex; index < Math.min(lines.length, startIndex + maxLines); index++) {
    text = text ? `${text}\n${lines[index]}` : lines[index]
    const functionMatch = text.match(/\bfunction\b[^()]*\(([\s\S]*?)\)\s*{/) || text.match(/(?:[=(:,])\s*(?:async\s+)?\(?\s*([\s\S]*?)\)?\s*=>\s*{/)
    if (functionMatch) {
      const bodyLine = firstOpenedScopeLine(openedScopePaths, startIndex, index)
      const scopePath = bodyLine == null ? null : openedScopePaths[bodyLine]?.[0]
      return scopePath ? { names: parameterNamesFromList(functionMatch[1]), scopePath, lineNumber: startIndex + 1 } : null
    }

    const conciseArrowMatch = text.match(/(?:[=(:,])\s*(?:async\s+)?\(?\s*([\s\S]*?)\)?\s*=>\s*\(?\s*{?/)
    if (conciseArrowMatch && /=>/.test(text) && !/=>\s*{/.test(text)) {
      return {
        names: parameterNamesFromList(conciseArrowMatch[1]),
        scopePath: scopePaths[startIndex] || [],
        lineNumber: startIndex + 1,
        endLine: expressionEndLine(lines, startIndex),
      }
    }
  }
  return null
}

function firstOpenedScopeLine(openedScopePaths, startIndex, endIndex) {
  for (let index = startIndex; index <= endIndex; index++) {
    if (openedScopePaths[index]?.[0]) return index
  }
  return null
}

function expressionEndLine(lines, startIndex) {
  let depth = 0
  for (let index = startIndex; index < lines.length; index++) {
    depth += bracketDelta(lines[index])
    if (depth <= 0) return index + 1
  }
  return lines.length
}

function nextCodeLine(lines, index) {
  for (let i = index + 1; i < lines.length; i++) {
    const line = codeOnlyLine(lines[i]).trim()
    if (line) return line
  }
  return ""
}

function continuesOnNextLine(lines, index) {
  const current = codeOnlyLine(lines[index]).trim()
  const next = nextCodeLine(lines, index)
  const continuationTokens = ["?", ":", ".", "||", "&&", "??", "+", "*", "/", "%", ",", "-"]
  return continuationTokens.some((token) => current.endsWith(token) || next.startsWith(token))
}

function addAssignment(assignments, name, entry) {
  const entries = assignments.get(name) ?? []
  entries.push(entry)
  assignments.set(name, entries)
}

function assignmentInitializerName(entry) {
  const text = codeOnlyText(entry?.text || "")
  const eq = text.indexOf("=")
  if (eq === -1) return ""
  return topLevelExpression(text.slice(eq + 1)).match(/^([A-Za-z_$][\w$]*)$/)?.[1] || ""
}

function assignmentInitializerExpression(entry) {
  const text = codeOnlyText(entry?.text || "")
  const eq = text.indexOf("=")
  if (eq === -1) return ""
  return topLevelExpression(text.slice(eq + 1))
}

function expressionUsesTaintedAlias(expression, alias) {
  const name = escapeRegExp(alias)
  return new RegExp(`(?:^|[?:]|\\|\\||&&|\\?\\?)\\s*${name}\\b`).test(expression)
}

function propagatePipeJoinAliases(assignments) {
  let changed = true
  while (changed) {
    changed = false
    for (const entries of assignments.values()) {
      for (const entry of entries) {
        if (entry.isPipeJoined) continue
        const alias = assignmentInitializerName(entry)
        const expression = assignmentInitializerExpression(entry)
        const aliases = alias ? [alias] : [...assignments.keys()].filter((name) => expressionUsesTaintedAlias(expression, name))
        if (aliases.length === 0) continue
        const hasTaintedSource = aliases.some((name) => latestAssignmentBefore(assignments, name, entry.lineNumber, entry.scopePath)?.isPipeJoined === true)
        if (hasTaintedSource) {
          entry.isPipeJoined = true
          changed = true
        }
      }
    }
  }
}

function collectVariableAssignments(lines, scopePaths, openedScopePaths) {
  const assignments = new Map()
  const pendingAssignments = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    const signatureInfo = parameterInfoFromSignature(lines, index, scopePaths, openedScopePaths)
    const functionParameterNames = signatureInfo?.names || []
    if (signatureInfo && functionParameterNames.length) {
      for (const name of functionParameterNames) {
        addAssignment(assignments, name, {
          lineNumber: signatureInfo.lineNumber,
          ...(signatureInfo.endLine ? { endLine: signatureInfo.endLine } : {}),
          line,
          text: "",
          scopePath: signatureInfo.scopePath,
          isPipeJoined: false,
        })
      }
    }
    if (functionParameterNames.length === 0) {
      for (const name of parameterNamesFromConciseArrowLine(line)) {
        addAssignment(assignments, name, {
          lineNumber,
          endLine: expressionEndLine(lines, index),
          line,
          text: "",
          scopePath: scopePaths[index] || [],
          isPipeJoined: false,
        })
      }
    }
    const assignmentMatch = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)
    if (assignmentMatch) {
      const afterEquals = codeOnlyLine(line).slice(line.indexOf("=") + 1).trim()
      pendingAssignments.push({ name: assignmentMatch[1], lineNumber, text: "", depth: 0, incompleteStart: afterEquals === "" })
    } else {
      const reassignmentMatch = codeOnlyLine(line).match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*(?!=|>)/)
      if (reassignmentMatch) {
        const afterEquals = codeOnlyLine(line).slice(line.indexOf("=") + 1).trim()
        pendingAssignments.push({ name: reassignmentMatch[1], lineNumber, text: "", depth: 0, incompleteStart: afterEquals === "" })
      }
    }

    for (let pendingIndex = pendingAssignments.length - 1; pendingIndex >= 0; pendingIndex--) {
      const pendingAssignment = pendingAssignments[pendingIndex]
      pendingAssignment.text = pendingAssignment.text ? `${pendingAssignment.text}\n${line}` : line
      pendingAssignment.depth += bracketDelta(line)
      if (
        pendingAssignment.depth <= 0 &&
        !(pendingAssignment.incompleteStart && lineNumber === pendingAssignment.lineNumber) &&
        !continuesOnNextLine(lines, index)
      ) {
        addAssignment(assignments, pendingAssignment.name, {
          lineNumber: pendingAssignment.lineNumber,
          line: lines[pendingAssignment.lineNumber - 1],
          text: pendingAssignment.text,
          scopePath: scopePaths[pendingAssignment.lineNumber - 1] || [],
          isPipeJoined: PIPE_JOIN_RE.test(pendingAssignment.text),
        })
        pendingAssignments.splice(pendingIndex, 1)
      }
    }
  }

  propagatePipeJoinAliases(assignments)
  return assignments
}

function isScopeVisible(assignmentScopePath, currentScopePath) {
  if (assignmentScopePath.length > currentScopePath.length) return false
  return assignmentScopePath.every((id, index) => id === currentScopePath[index])
}

function latestAssignmentBefore(assignments, variableName, lineNumber, scopePath) {
  const entries = [...(assignments.get(variableName) ?? [])].sort((a, b) => a.lineNumber - b.lineNumber)
  let latest = null
  for (const entry of entries) {
    if (entry.lineNumber > lineNumber) break
    if (entry.endLine != null && lineNumber > entry.endLine) continue
    if (!isScopeVisible(entry.scopePath, scopePath)) continue
    latest = entry
  }
  return latest
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
  const scanText = stripCommentsPreserveNewlines(text)
  const lines = scanText.split(/\r?\n/)
  const originalLines = text.split(/\r?\n/)
  const literalsByStartLine = new Map()
  for (const literal of stringLiterals(scanText)) {
    const existing = literalsByStartLine.get(literal.startLine) ?? []
    existing.push(literal)
    literalsByStartLine.set(literal.startLine, existing)
  }
  const { paths: scopePaths, openedPaths } = computeScopeInfo(lines)
  const assignments = collectVariableAssignments(lines, scopePaths, openedPaths)
  const encodedRawLiteralKeys = new Set()

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!/\bcallback_data\s*:|\b(?:cb|runtime\.cb)\.pack\s*\(/.test(line)) continue
    const callbackPayloadWindow = collectCallbackPayloadWindow(lines, index)
    for (const payload of callbackPayloadExpressions(callbackPayloadWindow)) {
      if (!isEncodedCallbackPayload(payload)) continue
      for (const literal of stringLiterals(payload.expression)) {
        if (!RAW_CALLBACK_LITERAL_RE.test(literal.content)) continue
        const position = lineColumnAtOffset(callbackPayloadWindow, payload.expressionStart + literal.startOffset)
        encodedRawLiteralKeys.add(rawLiteralKey(index + position.line, position.column, literal.content))
      }
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const originalLine = originalLines[index] ?? line
    const lineNumber = index + 1
    const literals = literalsByStartLine.get(lineNumber) ?? []
    const hasRawCallbackLiteral = literals.some((literal) => (
      RAW_CALLBACK_LITERAL_RE.test(literal.content) &&
      !encodedRawLiteralKeys.has(rawLiteralKey(lineNumber, literal.startColumn, literal.content))
    ))
    const startsCallbackPayload = /\bcallback_data\s*:|\b(?:cb|runtime\.cb)\.pack\s*\(/.test(line)
    const callbackPayloadWindow = startsCallbackPayload ? collectCallbackPayloadWindow(lines, index) : line
    const callbackPayloads = startsCallbackPayload ? callbackPayloadExpressions(callbackPayloadWindow) : []
    const pipeJoinedVariableUsed = startsCallbackPayload
      ? [...assignments.keys()].find((name) => {
        if (!isVariableUsedAsCallbackPayload(callbackPayloadWindow, name)) return false
        return latestAssignmentBefore(assignments, name, lineNumber, scopePaths[index] || [])?.isPipeJoined === true
      })
      : ""
    if (startsCallbackPayload && callbackPayloads.some((payload) => PIPE_JOIN_RE.test(payload.expression))) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-joined callback payload", line: originalLine })
    } else if (callbackPayloads.some((payload) => payload.kind === "callback_data" && !isEncodedCallbackExpression(payload.expression) && payloadHasPipeLiteral(payload.expression))) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-delimited callback_data", line: originalLine })
    } else if (callbackPayloads.some((payload) => payload.kind === "cb.pack" && PIPE_JOIN_RE.test(payload.expression))) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-delimited cb.pack payload", line: originalLine })
    } else if (pipeJoinedVariableUsed) {
      violations.push({ relPath, lineNumber, reason: "raw pipe-joined callback payload", line: originalLine })
    } else if (hasRawCallbackLiteral) {
      violations.push({ relPath, lineNumber, reason: "raw callback payload literal", line: originalLine })
    }
    if (!allowedPipeSplitFiles.has(relPath) && /\.split\(\s*["']\|["']\s*\)/.test(line)) {
      violations.push({ relPath, lineNumber, reason: "pipe split outside callback codec", line: originalLine })
    }
  }
  return violations
}

function stringLiterals(text) {
  const literals = []
  let line = 1
  let column = 0
  let quote = ""
  let escaped = false
  let current = ""
  let startLine = 1
  let startColumn = 0
  let startOffset = 0
  const value = String(text || "")
  for (let offset = 0; offset < value.length; offset++) {
    const ch = value[offset]
    if (!quote) {
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
        escaped = false
        current = ""
        startLine = line
        startColumn = column
        startOffset = offset
      }
      if (ch === "\n") {
        line++
        column = 0
      } else {
        column++
      }
      continue
    }
    if (escaped) {
      current += ch
      escaped = false
      if (ch === "\n") {
        line++
        column = 0
      } else {
        column++
      }
      continue
    }
    if (ch === "\\") {
      escaped = true
      column++
      continue
    }
    if (ch === quote) {
      literals.push({ content: current, startLine, startColumn, startOffset, endOffset: offset })
      quote = ""
      current = ""
      column++
      continue
    }
    current += ch
    if (ch === "\n") {
      line++
      column = 0
    } else {
      column++
    }
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
