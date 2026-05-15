#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const srcRoot = path.join(projectRoot, "src")

const fileBudgets = [
  {
    relPath: "src/index.js",
    maxLines: 1300,
    reason: "keep runtime orchestration in dedicated runtime modules",
  },
  {
    relPath: "src/connector/callbacks.js",
    maxLines: 450,
    reason: "keep callback dispatch separate from prompt-specific flows",
  },
  {
    relPath: "src/connector/mirroring.js",
    maxLines: 1200,
    reason: "keep mirroring dispatch separate from delivery/view helpers",
  },
  {
    relPath: "src/opencode/launcher.js",
    maxLines: 240,
    reason: "keep cross-platform launcher orchestration separate from platform internals",
  },
  {
    relPath: "src/opencode/launcher/windows.js",
    maxLines: 80,
    reason: "keep the Windows launcher module as a facade over split internals",
  },
]

const privateModuleRules = [
  {
    target: "src/connector/callbacks/permission-flow.js",
    allowedImporters: ["src/connector/callbacks/permission.js"],
    reason: "permission flow internals must stay behind the permission callback facade",
  },
  {
    target: "src/connector/callbacks/permission-state.js",
    allowedImporters: ["src/connector/callbacks/permission.js", "src/connector/callbacks/permission-flow.js"],
    reason: "permission callback state helpers must stay within the permission callback slice",
  },
  {
    target: "src/connector/callbacks/question-flow.js",
    allowedImporters: ["src/connector/callbacks/question.js"],
    reason: "question flow internals must stay behind the question callback facade",
  },
  {
    target: "src/connector/callbacks/question-state.js",
    allowedImporters: ["src/connector/callbacks/question.js", "src/connector/callbacks/question-flow.js"],
    reason: "question callback state helpers must stay within the question callback slice",
  },
  {
    target: "src/connector/mirroring/assistant-delivery.js",
    allowedImporters: ["src/connector/mirroring.js"],
    reason: "assistant delivery must be composed by the mirroring facade",
  },
  {
    target: "src/connector/mirroring/agent-action-delivery.js",
    allowedImporters: ["src/connector/mirroring.js"],
    reason: "agent action delivery must be composed by the mirroring facade",
  },
  {
    target: "src/connector/mirroring/changed-files-export.js",
    allowedImporters: ["src/connector/mirroring/changed-files-view.js"],
    reason: "changed-files export is private to the changed-files view",
  },
  {
    target: "src/connector/mirroring/changed-files-keyboards.js",
    allowedImporters: ["src/connector/mirroring/changed-files-view.js"],
    reason: "changed-files keyboards are private to the changed-files view",
  },
  {
    target: "src/opencode/launcher/windows-processes.js",
    allowedImporters: ["src/opencode/launcher/windows.js"],
    reason: "Windows process internals must stay behind the Windows launcher facade",
  },
  {
    target: "src/opencode/launcher/windows-start.js",
    allowedImporters: ["src/opencode/launcher/windows.js"],
    reason: "Windows start internals must stay behind the Windows launcher facade",
  },
  {
    target: "src/opencode/launcher/windows-attach.js",
    allowedImporters: ["src/opencode/launcher/windows.js"],
    reason: "Windows attach internals must stay behind the Windows launcher facade",
  },
]

const dependencyRules = [
  {
    importer: /^src\/index\.js$/,
    target: /^src\/runtime\/(?:connector-lifecycle|telegram-context|telegram-loop|tui-session-sync)\.js$/,
    reason: "index.js should depend on runtime/service-wiring.js instead of low-level runtime wiring modules",
  },
  {
    importer: /^src\/runtime\//,
    target: /^src\/connector\/(?:callbacks|commands|mirroring|overview|prompts|prompt-recovery)(?:\.js|\/)/,
    reason: "runtime modules must not depend on Telegram connector feature handlers",
  },
  {
    importer: /^src\/connector\//,
    target: /^src\/runtime\/(?:connector-lifecycle|service-wiring|telegram-context|telegram-loop|tui-session-sync)\.js$/,
    reason: "connector feature handlers must not assemble runtime services",
  },
  {
    importer: /^src\/opencode\//,
    target: /^src\/connector\//,
    reason: "OpenCode integration modules must not depend on Telegram connector handlers",
  },
]

const IMPORT_RE = /^\s*import\s+["']([^"']+)["']|(?:\bfrom\s+|import\s*\(\s*)["']([^"']+)["']/gm

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/")
}

function relPath(filePath) {
  return toPosixPath(path.relative(projectRoot, filePath))
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

function resolveImport(importerRelPath, specifier) {
  if (!specifier.startsWith(".")) return null
  const importerDir = path.posix.dirname(importerRelPath)
  const resolved = path.posix.normalize(path.posix.join(importerDir, specifier))
  return path.posix.extname(resolved) ? resolved : `${resolved}.js`
}

function importsFrom({ relPath: importerRelPath, text }) {
  const imports = []
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2]
    const target = resolveImport(importerRelPath, specifier)
    if (target) imports.push({ specifier, target })
  }
  return imports
}

function checkFileBudgets(fileTexts) {
  const violations = []
  for (const { relPath, maxLines, reason } of fileBudgets) {
    const text = fileTexts.get(relPath)
    if (text == null) {
      violations.push(`${relPath}: missing file budget target`)
      continue
    }
    const lines = text.split(/\r?\n/).length
    if (lines > maxLines) {
      violations.push(`${relPath}: ${lines} lines exceeds ${maxLines}; ${reason}`)
    }
  }
  return violations
}

function checkImports(fileTexts) {
  const violations = []
  const privateModulesByTarget = new Map(privateModuleRules.map((rule) => [rule.target, rule]))
  for (const [importerRelPath, text] of fileTexts.entries()) {
    for (const imported of importsFrom({ relPath: importerRelPath, text })) {
      const privateRule = privateModulesByTarget.get(imported.target)
      if (privateRule && !privateRule.allowedImporters.includes(importerRelPath)) {
        violations.push(`${importerRelPath}: imports ${imported.target}; ${privateRule.reason}`)
      }
      for (const rule of dependencyRules) {
        if (rule.importer.test(importerRelPath) && rule.target.test(imported.target)) {
          violations.push(`${importerRelPath}: imports ${imported.target}; ${rule.reason}`)
        }
      }
    }
  }
  return violations
}

const files = await collectJsFiles(srcRoot)
const fileTexts = new Map()
for (const filePath of files) {
  fileTexts.set(relPath(filePath), await fs.readFile(filePath, "utf8"))
}

const violations = [
  ...checkFileBudgets(fileTexts),
  ...checkImports(fileTexts),
]

if (violations.length) {
  console.error("Architecture guard failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Architecture guard passed for ${files.length} source files.`)
}
