import { normalizeOpenCodeOutboxReadTimeoutMs } from "./outbox.js"

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function validateRuntimeConfigForStart(config) {
  if (!isPlainObject(config)) throw new Error("config is required")
  if (!isPlainObject(config.telegram)) throw new Error("config.telegram is required")
  if (typeof config.telegram.botToken !== "string" || !config.telegram.botToken.trim()) {
    throw new Error("config.telegram.botToken is required")
  }
  if (!Number.isInteger(config.telegram.allowedUserId)) {
    throw new Error("config.telegram.allowedUserId must be an integer")
  }
  normalizeOpenCodeOutboxReadTimeoutMs(config.opencodeOutboxReadTimeoutMs, {
    fieldName: "config.opencodeOutboxReadTimeoutMs",
  })
  if (!isPlainObject(config.projects)) {
    throw new Error("config.projects is required and must be an object")
  }
  const entries = Object.entries(config.projects)
  if (entries.length === 0) throw new Error("config.projects must contain at least one project")
  for (const [alias, project] of entries) {
    if (!isPlainObject(project)) throw new Error(`config.projects.${alias} must be an object`)
    if (typeof project.baseUrl !== "string" || !project.baseUrl.trim()) {
      throw new Error(`config.projects.${alias}.baseUrl is required`)
    }
  }
}
