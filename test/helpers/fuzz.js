const DEFAULT_SEED = "telegram-connector-fuzz-v1"

function parsePositiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function hashSeed(seed) {
  let hash = 2166136261
  for (const ch of String(seed)) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function fuzzIterations(envName, { defaultIterations = 128, ciIterations = 64, maxIterations = 5000, ciMaxIterations = 256 } = {}) {
  const fallback = process.env.CI ? ciIterations : defaultIterations
  const requested = parsePositiveInteger(process.env[envName]) ?? fallback
  const max = process.env.CI ? ciMaxIterations : maxIterations
  return Math.min(requested, max)
}

export function createFuzzRng(label, { seed = process.env.FUZZ_SEED || DEFAULT_SEED } = {}) {
  let state = hashSeed(`${seed}:${label}`) || 0x6d2b79f5
  return {
    seed,
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

export function randomInt(rng, min, max) {
  return min + Math.floor(rng.next() * (max - min + 1))
}

export function pick(rng, values) {
  return values[randomInt(rng, 0, values.length - 1)]
}

export function chance(rng, probability = 0.5) {
  return rng.next() < probability
}

export function randomString(rng, { minLength = 0, maxLength = 32, alphabet } = {}) {
  const chars = alphabet || "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:/|[]{}\\\"' #\n\r\t"
  const length = randomInt(rng, minLength, maxLength)
  let out = ""
  for (let i = 0; i < length; i++) out += chars[randomInt(rng, 0, chars.length - 1)]
  return out
}
