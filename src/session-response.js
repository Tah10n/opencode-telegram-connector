/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function sessionItemsFromResponse(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []

  const record = /** @type {Record<string, unknown>} */ (value)
  for (const key of ["items", "sessions", "data"]) {
    if (Array.isArray(record[key])) return record[key]
  }
  return []
}
