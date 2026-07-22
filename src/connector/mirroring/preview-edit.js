export function isTerminalPreviewEditError(err) {
  if (Number(err?.status) !== 400) return false
  return /message (?:to edit not found|can(?:not|'t) be edited)/i.test(String(err?.message || ""))
}

export async function editPreviewOrNull(edit) {
  try {
    return await edit()
  } catch (err) {
    if (!isTerminalPreviewEditError(err)) throw err
    return null
  }
}
