import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const includeRoots = ["src", "test"]
const includeFiles = ["index.mjs"]
const extensions = new Set([".js", ".mjs"])

async function collectFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)))
      continue
    }
    if (extensions.has(path.extname(entry.name))) files.push(entryPath)
  }
  return files
}

async function main() {
  const files = []
  for (const relativeFile of includeFiles) {
    files.push(path.join(projectRoot, relativeFile))
  }
  for (const relativeDir of includeRoots) {
    files.push(...(await collectFiles(path.join(projectRoot, relativeDir))))
  }

  const uniqueFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b))
  for (const filePath of uniqueFiles) {
    execFileSync(process.execPath, ["--check", filePath], { stdio: "inherit" })
  }

  console.log(`Syntax check passed for ${uniqueFiles.length} files.`)
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
