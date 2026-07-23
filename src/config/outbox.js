export const DEFAULT_OPENCODE_OUTBOX_READ_TIMEOUT_MS = 20_000
export const MIN_OPENCODE_OUTBOX_READ_TIMEOUT_MS = 100
export const MAX_OPENCODE_OUTBOX_READ_TIMEOUT_MS = 120_000

export function normalizeOpenCodeOutboxReadTimeoutMs(value, { fieldName = "opencodeOutboxReadTimeoutMs" } = {}) {
  if (value == null || value === "") return DEFAULT_OPENCODE_OUTBOX_READ_TIMEOUT_MS
  const timeoutMs = typeof value === "number" ? value : Number(String(value).trim())
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < MIN_OPENCODE_OUTBOX_READ_TIMEOUT_MS
    || timeoutMs > MAX_OPENCODE_OUTBOX_READ_TIMEOUT_MS
  ) {
    throw new Error(
      `${fieldName} must be an integer in the range ${MIN_OPENCODE_OUTBOX_READ_TIMEOUT_MS}..${MAX_OPENCODE_OUTBOX_READ_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}
