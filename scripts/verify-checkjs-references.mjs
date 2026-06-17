#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hardReferenceDiagnosticCodes = new Set([
  1192, // Module has no default export.
  2304, // Cannot find name.
  2305, // Module has no exported member.
  2307, // Cannot find module.
  2448, // Block-scoped variable used before its declaration.
  2459, // Module declares a local symbol, but it is not exported.
  2552, // Cannot find name. Did you mean ...
  2613, // Module has no default export. Did you mean to use import ...
  2614, // Module has no exported member. Did you mean to use import ...
  2662, // Cannot find name. Did you mean the static member ...
  2663, // Cannot find name. Did you mean the instance member ...
  2724, // Module has no exported member named ... Did you mean ...
  18004, // No value exists in scope for shorthand property.
])

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/")
}

function relPath(filePath, rootDir) {
  return toPosixPath(path.relative(rootDir, filePath))
}

function flattenDiagnosticMessage(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
}

function diagnosticLocation(diagnostic, rootDir) {
  if (!diagnostic.file || typeof diagnostic.start !== "number") return ""
  const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `${relPath(diagnostic.file.fileName, rootDir)}:${pos.line + 1}:${pos.character + 1}`
}

function formatDiagnostic(diagnostic, rootDir) {
  const location = diagnosticLocation(diagnostic, rootDir)
  const prefix = location ? `${location}: ` : ""
  return `${prefix}TS${diagnostic.code}: ${flattenDiagnosticMessage(diagnostic)}`
}

function parseTsConfig(rootDir) {
  const configPath = path.join(rootDir, "tsconfig.check.json")
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) return { errors: [read.error], fileNames: [], options: {} }
  return ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    rootDir,
    {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
    },
    configPath,
  )
}

export function checkCheckJsReferences({ rootDir = projectRoot, diagnosticCodes = hardReferenceDiagnosticCodes } = {}) {
  const parsed = parseTsConfig(rootDir)
  const configErrors = parsed.errors.map((diagnostic) => formatDiagnostic(diagnostic, rootDir))
  if (configErrors.length) return { ok: false, fileCount: parsed.fileNames.length, diagnostics: configErrors }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
    },
  })
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnosticCodes.has(diagnostic.code))
    .map((diagnostic) => formatDiagnostic(diagnostic, rootDir))

  return {
    ok: diagnostics.length === 0,
    fileCount: parsed.fileNames.length,
    diagnostics,
  }
}

async function main() {
  const result = checkCheckJsReferences()
  if (!result.ok) {
    console.error("CheckJS reference guard failed:")
    for (const diagnostic of result.diagnostics) console.error(`- ${diagnostic}`)
    process.exitCode = 1
    return
  }

  console.log(`CheckJS reference guard passed for ${result.fileCount} files.`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()
