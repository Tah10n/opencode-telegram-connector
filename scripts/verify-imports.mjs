#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoots = ["src", "test", "scripts"]
const rootFiles = ["index.mjs", "connector.config.example.mjs"]

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/")
}

function relPath(filePath) {
  return toPosixPath(path.relative(projectRoot, filePath))
}

function relPathFrom(filePath, rootDir) {
  return toPosixPath(path.relative(rootDir, filePath))
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function collectModuleFiles(dirPath) {
  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return []
    throw err
  }
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectModuleFiles(fullPath)))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      files.push(fullPath)
    }
  }
  return files
}

function candidateTargets(importerPath, specifier) {
  if (!specifier.startsWith(".")) return []
  return [path.resolve(path.dirname(importerPath), specifier)]
}

async function resolveRelativeImport(importerPath, specifier) {
  const candidates = candidateTargets(importerPath, specifier)
  if (!candidates.length) return true
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return true
  }
  return false
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
}

export function collectRelativeImportSpecifiers(text, filePath = "module.js") {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const specifiers = []

  function addModuleSpecifier(node) {
    if (node?.moduleSpecifier && isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addModuleSpecifier(node)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && isStringLiteralLike(arg)) specifiers.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers.filter((specifier) => specifier.startsWith("."))
}

async function collectGuardFiles(rootDir) {
  const files = []
  for (const sourceRoot of sourceRoots) {
    files.push(...(await collectModuleFiles(path.join(rootDir, sourceRoot))))
  }
  for (const file of rootFiles) {
    const fullPath = path.join(rootDir, file)
    if (await fileExists(fullPath)) files.push(fullPath)
  }
  return files
}

export async function checkRelativeImports({ rootDir = projectRoot } = {}) {
  const files = await collectGuardFiles(rootDir)
  const violations = []
  for (const filePath of files) {
    const text = await fs.readFile(filePath, "utf8")
    for (const specifier of collectRelativeImportSpecifiers(text, filePath)) {
      if (!(await resolveRelativeImport(filePath, specifier))) {
        violations.push(`${relPathFrom(filePath, rootDir)}: missing relative import target ${JSON.stringify(specifier)}`)
      }
    }
  }

  return { ok: violations.length === 0, fileCount: files.length, violations }
}

async function main() {
  const result = await checkRelativeImports()

  if (!result.ok) {
    console.error("Import guard failed:")
    for (const violation of result.violations) console.error(`- ${violation}`)
    process.exitCode = 1
    return
  }

  console.log(`Import guard passed for ${result.fileCount} module files.`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()
