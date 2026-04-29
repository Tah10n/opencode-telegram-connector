import fs from "node:fs/promises"

export function parseDotEnv(text) {
  const out = {}
  const lines = String(text ?? "").split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    const match = value.match(/^(['"])(.*?)\1(\s*#.*)?$/)
    if (match) {
      value = match[2]
    } else {
      const hash = value.indexOf("#")
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    out[key] = value
  }
  return out
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
  const v = raw.toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on"
}
