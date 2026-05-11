import path from "node:path"

const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/

function rawDirectory(value) {
  const raw = String(value ?? "").trim()
  return raw || ""
}

function isWindowsUncAbsolutePath(value) {
  const normalized = value.replace(/\\/g, "/")
  if (!normalized.startsWith("//")) return false
  const parts = normalized.slice(2).split("/").filter(Boolean)
  return parts.length >= 2
}

function isWindowsDriveAbsolutePath(value) {
  return WINDOWS_DRIVE_ABSOLUTE_RE.test(value)
}

function isPosixAbsolutePath(value) {
  return value.startsWith("/") && !isWindowsUncAbsolutePath(value)
}

function stripTrailingDirectorySlashes(value, rootLength) {
  let end = value.length
  while (end > rootLength && value[end - 1] === "/") end -= 1
  return value.slice(0, end)
}

function uncRootLength(value) {
  if (!value.startsWith("//")) return 0
  const serverEnd = value.indexOf("/", 2)
  if (serverEnd === -1) return value.length
  const shareEnd = value.indexOf("/", serverEnd + 1)
  return shareEnd === -1 ? value.length : shareEnd
}

function normalizeWindowsAbsolutePath(value) {
  const normalized = path.win32.normalize(value).replace(/\\/g, "/")
  const rootLength = normalized.startsWith("//") ? uncRootLength(normalized) : 3
  return stripTrailingDirectorySlashes(normalized, rootLength)
}

function normalizePosixAbsolutePath(value) {
  return stripTrailingDirectorySlashes(path.posix.normalize(value), 1)
}

/**
 * Build a lexical, path-flavor-aware representation of an OpenCode directory.
 *
 * This intentionally does not use the connector host platform to interpret
 * absolute paths: `/srv/App` is a POSIX path even when the connector runs on
 * Windows, while `C:/Repo/App` and `//server/share/App` are Windows-flavor
 * paths on every host. Windows-flavor comparisons are case-insensitive;
 * POSIX comparisons are case-sensitive.
 *
 * @param {unknown} value
 * @returns {{ flavor: "posix" | "windows-drive" | "windows-unc" | "relative", path: string, key: string } | null}
 */
export function canonicalDirectoryPath(value) {
  const raw = rawDirectory(value)
  if (!raw) return null

  if (isWindowsUncAbsolutePath(raw)) {
    const normalized = normalizeWindowsAbsolutePath(raw)
    return { flavor: "windows-unc", path: normalized, key: normalized.toLowerCase() }
  }

  if (isWindowsDriveAbsolutePath(raw)) {
    const normalized = normalizeWindowsAbsolutePath(raw)
    return { flavor: "windows-drive", path: normalized, key: normalized.toLowerCase() }
  }

  if (isPosixAbsolutePath(raw)) {
    const normalized = normalizePosixAbsolutePath(raw)
    return { flavor: "posix", path: normalized, key: normalized }
  }

  return { flavor: "relative", path: raw, key: raw }
}

/**
 * Normalize a configured project directory without rewriting foreign absolute
 * paths through the connector host platform. Relative paths remain local and
 * are resolved against the config base directory, preserving existing local
 * auto-start behavior.
 *
 * @param {unknown} value
 * @param {{ baseDir?: string }} [options]
 * @returns {string | undefined}
 */
export function normalizeConfiguredDirectory(value, { baseDir } = {}) {
  const raw = rawDirectory(value)
  if (!raw) return undefined

  const canonical = canonicalDirectoryPath(raw)
  if (canonical && canonical.flavor !== "relative") return canonical.path
  return path.resolve(baseDir || process.cwd(), raw)
}

/**
 * Compare OpenCode project directories using the directory path flavor instead
 * of the connector host platform.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function directoriesMatch(left, right) {
  const leftPath = canonicalDirectoryPath(left)
  const rightPath = canonicalDirectoryPath(right)
  return !!leftPath && !!rightPath && leftPath.flavor === rightPath.flavor && leftPath.key === rightPath.key
}
