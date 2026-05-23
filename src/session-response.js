export function sessionItemsFromResponse(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []

  for (const key of ["items", "sessions", "data"]) {
    if (Array.isArray(value[key])) return value[key]
  }
  return []
}
