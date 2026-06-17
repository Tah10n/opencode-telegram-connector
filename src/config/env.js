import fs from "node:fs/promises"

export function parseDotEnv(text) {
  const out = {}
  const lines = String(text ?? "").split(/\r?\n/)
  for (const rawLine of lines) {
    let line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart()
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    out[key] = parseDotEnvValue(line.slice(eq + 1))
  }
  return out
}

function parseDotEnvValue(rawValue) {
  const value = String(rawValue ?? "").trim()
  if (!value) return ""
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    let out = ""
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i]
      if (quote === '"' && ch === "\\" && i + 1 < value.length) {
        const next = value[i + 1]
        if (next === "n") out += "\n"
        else if (next === "r") out += "\r"
        else if (next === "t") out += "\t"
        else if (next === '"' || next === "\\") out += next
        else out += `\\${next}`
        i += 1
        continue
      }
      if (ch === quote) {
        const rest = value.slice(i + 1).trim()
        if (!rest || rest.startsWith("#")) return out
        return `${out}${stripUnquotedComment(rest)}`
      }
      out += ch
    }
    return out
  }
  return stripUnquotedComment(value)
}

function stripUnquotedComment(value) {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd()
    }
  }
  return value.trim()
}

export async function loadEnvFromFile(envFilePath, { required = false } = {}) {
  if (!envFilePath) return
  try {
    const content = await fs.readFile(envFilePath, "utf8")
    const parsed = parseDotEnv(content)
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] == null || process.env[k] === "") process.env[k] = v
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT" && !required) return
    throw err
  }
}

export function envOptional(name, fallback = undefined) {
  const v = process.env[name]
  if (v == null || v === "") return fallback
  return v
}

export function envRequired(name) {
  const v = process.env[name]
  if (v == null || v === "") throw new Error(`Missing env: ${name}`)
  return v
}

export function envInt(name, fallback = undefined) {
  const raw = envOptional(name)
  if (raw == null) {
    if (fallback !== undefined) return fallback
    return undefined
  }
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new Error(`Invalid integer for ${name}: ${raw}`)
  return n
}

export function envBool(name, fallback = false) {
  const raw = envOptional(name)
  if (raw == null) return fallback
  const v = raw.trim().toLowerCase()
  if (["1", "true", "yes", "y", "on"].includes(v)) return true
  if (["0", "false", "no", "n", "off"].includes(v)) return false
  throw new Error(`Invalid boolean for ${name}: ${raw}`)
}
