import path from "node:path"
import fs from "node:fs/promises"
import { createStateFileBackup, readJsonFile, writeJsonFileAtomic } from "./fileStore.js"
import { loadStateWithMigration, migrateStateIfNeeded, preserveStateBeforeRecovery } from "./backup.js"
import { normalizeModelPreference, storedModelPreference } from "../model-selection.js"
import { isSafeOpenCodeId } from "../opencode/ids.js"

export const STATE_SCHEMA_VERSION = 5
export const DEFAULT_FEED_MODE = "main+changes"
export const DEFAULT_IDEMPOTENCY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 5000
export const DEFAULT_STATE_MIGRATION_BACKUP_MAX_FILES = 5

export class StateSchemaValidationError extends Error {
  constructor(errors, { filePath } = {}) {
    const details = errors.slice(0, 5).join("; ")
    const more = errors.length > 5 ? `; ...and ${errors.length - 5} more` : ""
    const stateHint = "Restore a known-good state backup, move the broken state file aside, or repair the reported sections before restarting."
    super(`State file schema validation failed${filePath ? ` for ${filePath}` : ""}: ${details}${more}. ${stateHint}`)
    this.name = "StateSchemaValidationError"
    this.code = "STATE_SCHEMA_INVALID"
    this.errors = errors
    this.filePath = filePath
  }
}

export function normalizeFeedMode(value) {
  if (value === "main" || value === "main+changes" || value === "verbose") return value
  return DEFAULT_FEED_MODE
}

function schemaValidationError(errors, { filePath } = {}) {
  return new StateSchemaValidationError(errors, { filePath })
}

function migrationOptionsForLoad(filePath) {
  return {
    filePath,
    schemaVersion: STATE_SCHEMA_VERSION,
    assertValidCurrentState,
    createSchemaValidationError: schemaValidationError,
    normalizeBindings,
    normalizeSessionIndex,
    normalizeFeedByContext,
    normalizeModelPrefsByContext,
    normalizePendingPrompts,
    normalizePendingRuntimeOnlineNotice,
    normalizeIdempotencyLedger,
    defaultFeedByContext,
    defaultModelPrefsByContext,
    defaultPendingPrompts,
    defaultIdempotencyLedger,
  }
}

function defaultFeedByContext() {
  return {}
}

function defaultModelPrefsByContext() {
  return {}
}

function defaultPendingPrompts() {
  return {
    permissions: {},
    rejectNotes: {},
    customAnswers: {},
    questionWizards: {},
  }
}

function defaultIdempotencyLedger() {
  return { keys: {} }
}

export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updateOffset: null,
    bindings: {},
    sessionIndex: {},
    feedByContext: defaultFeedByContext(),
    modelPrefsByContext: defaultModelPrefsByContext(),
    pendingPrompts: defaultPendingPrompts(),
    pendingRuntimeOnlineNotice: null,
    idempotency: defaultIdempotencyLedger(),
  }
}

function cloneStateForWrite(state) {
  return JSON.parse(JSON.stringify(state))
}

export function sessionKey(projectAlias, sessionId) {
  return `${projectAlias}:${sessionId}`
}

export function promptKey(projectAlias, promptId, sessionID = "") {
  const session = String(sessionID || "").trim()
  return session ? `${projectAlias}:${session}:${promptId}` : `${projectAlias}:${promptId}`
}

export class StateStore {
  constructor({ filePath, logger, backupMaxFiles = DEFAULT_STATE_MIGRATION_BACKUP_MAX_FILES, writeJsonFileAtomicImpl = writeJsonFileAtomic, createStateFileBackupImpl = createStateFileBackup }) {
    this.filePath = filePath
    this.logger = logger
    this.backupMaxFiles = backupMaxFiles
    this._writeJsonFileAtomic = writeJsonFileAtomicImpl
    this._createStateFileBackup = createStateFileBackupImpl
    this.state = defaultState()
    this._saveTimer = null
    this._writeChain = Promise.resolve()
  }

  async load() {
    let loaded
    try {
      loaded = await readJsonFile(this.filePath)
    } catch (err) {
      this.logger?.error?.("Failed to read state file:", err?.message || String(err))
      throw err
    }
    if (loaded === null) {
      if (!(await stateFileExists(this.filePath))) return this.state
      const err = new StateSchemaValidationError(["state must be an object, not null"], { filePath: this.filePath })
      await this.preserveStateBeforeRecovery(loaded, { reason: "invalid" }).catch((backupErr) => {
        this.logger?.error?.("Failed to preserve invalid state file:", backupErr?.message || String(backupErr))
      })
      throw err
    }

    const state = await loadStateWithMigration({
      loaded,
      filePath: this.filePath,
      logger: this.logger,
      backupMaxFiles: this.backupMaxFiles,
      migrateStateIfNeededImpl: (candidate, options = {}) => migrateStateIfNeeded(candidate, { ...migrationOptionsForLoad(this.filePath), ...options }),
      writeJsonFileAtomicImpl: this._writeJsonFileAtomic,
      createStateFileBackupImpl: this._createStateFileBackup,
      schemaVersion: STATE_SCHEMA_VERSION,
    })

    this.state = state
    return this.state
  }

  async preserveStateBeforeRecovery(loaded, { reason }) {
    return preserveStateBeforeRecovery(this.filePath, loaded, {
      reason,
      schemaVersion: loaded?.schemaVersion,
      maxBackups: this.backupMaxFiles,
      createStateFileBackupImpl: this._createStateFileBackup,
      logger: this.logger,
    })
  }

  get() {
    return this.state
  }

  getPendingPrompts() {
    return this.state.pendingPrompts
  }

  getPendingRuntimeOnlineNotice() {
    return this.state.pendingRuntimeOnlineNotice || null
  }

  setPendingRuntimeOnlineNotice(record) {
    const normalized = normalizePendingRuntimeOnlineNotice(record)
    if (!normalized) return false
    this.state.pendingRuntimeOnlineNotice = normalized
    this.scheduleSave()
    return true
  }

  clearPendingRuntimeOnlineNotice() {
    const existed = !!this.state.pendingRuntimeOnlineNotice
    this.state.pendingRuntimeOnlineNotice = null
    if (existed) this.scheduleSave()
    return existed
  }

  getPendingPermission(projectAlias, permissionId, sessionID = "") {
    if (!projectAlias || !permissionId) return null
    return findPromptRecord(this.state.pendingPrompts.permissions, projectAlias, permissionId, sessionID)
  }

  getIdempotencyLedger() {
    return this.state.idempotency
  }

  hasIdempotencyKey(key) {
    const normalized = normalizeIdempotencyKey(key)
    if (!normalized) return false
    return !!this.state.idempotency?.keys?.[normalized]
  }

  hasIdempotencyKeyPrefix(prefix) {
    const normalized = normalizeIdempotencyKey(prefix)
    if (!normalized) return false
    return Object.keys(this.state.idempotency?.keys || {}).some((key) => key.startsWith(normalized))
  }

  markIdempotencyKey(key, metadata = {}) {
    const normalized = normalizeIdempotencyKey(key)
    if (!normalized) return false
    this.pruneIdempotency()
    this.state.idempotency.keys[normalized] = normalizeIdempotencyEntry({
      ...metadata,
      createdAt: typeof metadata?.createdAt === "number" ? metadata.createdAt : Date.now(),
    })
    this.scheduleSave()
    return true
  }

  deleteIdempotencyKey(key) {
    const normalized = normalizeIdempotencyKey(key)
    if (!normalized || !this.state.idempotency?.keys?.[normalized]) return false
    delete this.state.idempotency.keys[normalized]
    this.scheduleSave()
    return true
  }

  async markIdempotencyKeyAndFlush(key, metadata = {}) {
    const ok = this.markIdempotencyKey(key, metadata)
    if (ok) await this.flush()
    return ok
  }

  pruneIdempotency({ now = Date.now(), maxAgeMs = DEFAULT_IDEMPOTENCY_MAX_AGE_MS, maxEntries = DEFAULT_IDEMPOTENCY_MAX_ENTRIES } = {}) {
    const ledger = this.state.idempotency?.keys
    if (!ledger || typeof ledger !== "object") return 0
    let removed = 0
    for (const [key, entry] of Object.entries(ledger)) {
      const createdAt = typeof entry?.createdAt === "number" ? entry.createdAt : 0
      if (!createdAt || now - createdAt > maxAgeMs) {
        delete ledger[key]
        removed += 1
      }
    }

    const entries = Object.entries(ledger)
    if (entries.length > maxEntries) {
      entries
        .sort((a, b) => {
          const aCreated = typeof a[1]?.createdAt === "number" ? a[1].createdAt : 0
          const bCreated = typeof b[1]?.createdAt === "number" ? b[1].createdAt : 0
          return aCreated - bCreated
        })
        .slice(0, entries.length - maxEntries)
        .forEach(([key]) => {
          delete ledger[key]
          removed += 1
        })
    }

    if (removed) this.scheduleSave()
    return removed
  }

  getFeedMode(ctxKey) {
    return normalizeFeedMode(this.state.feedByContext?.[ctxKey]?.mode)
  }

  getModelPreference(ctxKey) {
    return normalizeModelPreference(this.state.modelPrefsByContext?.[ctxKey])
  }

  setFeedMode(ctxKey, mode) {
    if (!ctxKey) return
    this.state.feedByContext[ctxKey] = { mode: normalizeFeedMode(mode) }
    this.scheduleSave()
  }

  setModelPreference(ctxKey, value) {
    if (!ctxKey) return
    const stored = storedModelPreference(value)
    if (!stored) {
      this.clearModelPreference(ctxKey)
      return
    }
    this.state.modelPrefsByContext[ctxKey] = stored
    this.scheduleSave()
  }

  clearModelPreference(ctxKey) {
    if (!ctxKey) return false
    const existed = delete this.state.modelPrefsByContext[ctxKey]
    if (existed) this.scheduleSave()
    return existed
  }

  scheduleSave(delayMs = 250) {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this.flush().catch(() => {})
    }, delayMs)
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    const snapshot = cloneStateForWrite(this.state)
    const write = this._writeChain.then(() => this._writeJsonFileAtomic(this.filePath, snapshot))
    this._writeChain = write.catch(() => {})
    try {
      await write
    } catch (err) {
      this.logger?.error?.("Failed to write state:", err?.message || String(err))
      throw err
    }
  }

  setUpdateOffset(offset) {
    this.state.updateOffset = offset
    this.scheduleSave()
  }

  getBinding(ctxKey) {
    return this.state.bindings[ctxKey] ?? null
  }

  setPendingPermission(record) {
    if (!record?.projectAlias || !record?.permissionId) return
    this.state.pendingPrompts.permissions[promptKey(record.projectAlias, record.permissionId, record.sessionID)] = {
      projectAlias: record.projectAlias,
      permissionId: record.permissionId,
      sessionID: record.sessionID || "",
      permission: record.permission || "",
      patterns: Array.isArray(record.patterns) ? [...record.patterns] : [],
      ctx: {
        chatId: record?.ctx?.chatId,
        threadIdOr0: record?.ctx?.threadIdOr0 || 0,
        ctxKey: record?.ctx?.ctxKey || "",
      },
      createdAt: typeof record?.createdAt === "number" ? record.createdAt : Date.now(),
    }
    this.scheduleSave()
  }

  deletePendingPermission(projectAlias, permissionId, sessionID = "") {
    if (!projectAlias || !permissionId) return false
    const key = promptKey(projectAlias, permissionId, sessionID)
    let existed = delete this.state.pendingPrompts.permissions[key]
    if (!sessionID) {
      const legacyKey = sessionKey(projectAlias, permissionId)
      existed = delete this.state.pendingPrompts.permissions[legacyKey] || existed
      for (const [entryKey, entry] of Object.entries(this.state.pendingPrompts.permissions)) {
        if (entry?.projectAlias === projectAlias && entry?.permissionId === permissionId) {
          delete this.state.pendingPrompts.permissions[entryKey]
          existed = true
        }
      }
    }
    if (existed) this.scheduleSave()
    return existed
  }

  setRejectNoteAwaiting(ctxKey, value) {
    if (!ctxKey) return
    if (!value) {
      this.deleteRejectNoteAwaiting(ctxKey)
      return
    }
    this.state.pendingPrompts.rejectNotes[ctxKey] = {
      projectAlias: value.projectAlias,
      permissionId: value.permissionId,
      sessionID: value.sessionID || "",
    }
    this.scheduleSave()
  }

  deleteRejectNoteAwaiting(ctxKey) {
    if (!ctxKey) return false
    const existed = delete this.state.pendingPrompts.rejectNotes[ctxKey]
    if (existed) this.scheduleSave()
    return existed
  }

  setAwaitingCustomAnswer(ctxKey, value) {
    if (!ctxKey) return
    if (!value) {
      this.deleteAwaitingCustomAnswer(ctxKey)
      return
    }
    this.state.pendingPrompts.customAnswers[ctxKey] = {
      projectAlias: value.projectAlias,
      requestId: value.requestId,
      sessionID: value.sessionID || "",
      qIndex: value.qIndex,
    }
    this.scheduleSave()
  }

  deleteAwaitingCustomAnswer(ctxKey) {
    if (!ctxKey) return false
    const existed = delete this.state.pendingPrompts.customAnswers[ctxKey]
    if (existed) this.scheduleSave()
    return existed
  }

  setQuestionWizard(key, wizard) {
    if (!key || !wizard) return
    this.state.pendingPrompts.questionWizards[key] = {
      projectAlias: wizard.projectAlias,
      id: wizard.id,
      sessionID: wizard.sessionID,
      request: wizard.request,
      index: wizard.index,
      answers: Array.isArray(wizard.answers) ? wizard.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
      selectedByIndex:
        wizard.selectedByIndex && typeof wizard.selectedByIndex === "object"
          ? Object.fromEntries(
              Object.entries(wizard.selectedByIndex).map(([idx, selected]) => [idx, Array.isArray(selected) ? [...selected] : []]),
            )
          : {},
      createdAt: typeof wizard.createdAt === "number" ? wizard.createdAt : Date.now(),
      ctx: {
        chatId: wizard?.ctx?.chatId,
        threadIdOr0: wizard?.ctx?.threadIdOr0 || 0,
        ctxKey: wizard?.ctx?.ctxKey || "",
      },
    }
    this.scheduleSave()
  }

  deleteQuestionWizard(key) {
    if (!key) return false
    const existed = delete this.state.pendingPrompts.questionWizards[key]
    if (existed) this.scheduleSave()
    return existed
  }

  setBinding(ctxKey, binding, ctxMeta) {
    if (!isSafeProjectAlias(binding?.projectAlias) || !isStoredOpenCodeId(binding?.sessionId)) {
      throw new Error("Invalid binding: expected safe project alias and opencode session id")
    }
    let movedFromCtxKey = ""
    let movedFromRoute = null
    const prev = this.state.bindings[ctxKey]
    if (prev) {
      delete this.state.sessionIndex[sessionKey(prev.projectAlias, prev.sessionId)]
      if (prev.projectAlias !== binding.projectAlias) {
        delete this.state.modelPrefsByContext[ctxKey]
      }
    }

    // If session is already bound elsewhere, move it.
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const existingCtx = this.state.sessionIndex[sk]
    if (existingCtx) {
      const otherKey = `${existingCtx.chatId}:${existingCtx.threadIdOr0}`
      const otherBinding = this.state.bindings[otherKey]
      if (otherKey !== ctxKey && otherBinding?.projectAlias === binding.projectAlias && otherBinding?.sessionId === binding.sessionId) {
        movedFromCtxKey = otherKey
        movedFromRoute = { chatId: existingCtx.chatId, threadIdOr0: existingCtx.threadIdOr0 }
        delete this.state.bindings[otherKey]
        delete this.state.modelPrefsByContext[otherKey]
      }
    }

    this.state.bindings[ctxKey] = {
      projectAlias: binding.projectAlias,
      sessionId: binding.sessionId,
    }
    this.state.sessionIndex[sk] = {
      chatId: ctxMeta.chatId,
      threadIdOr0: ctxMeta.threadIdOr0,
    }
    this.scheduleSave()
    return { movedFromCtxKey, movedFromRoute }
  }

  unbind(ctxKey) {
    const prev = this.state.bindings[ctxKey]
    if (!prev) return false
    delete this.state.bindings[ctxKey]
    delete this.state.sessionIndex[sessionKey(prev.projectAlias, prev.sessionId)]
    delete this.state.modelPrefsByContext[ctxKey]
    this.scheduleSave()
    return true
  }

  repairBindingIndex({ dryRun = false } = {}) {
    const summary = {
      changed: false,
      removedBindings: [],
      removedIndexEntries: [],
      rebuiltIndexEntries: 0,
      conflicts: [],
    }
    const nextSessionIndex = {}
    const nextBindings = {}
    const bindingsBySession = new Map()

    for (const [ctxKey, binding] of Object.entries(this.state.bindings || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const ctx = parseStoredCtxKey(ctxKey)
      if (!ctx || !isSafeProjectAlias(binding?.projectAlias) || !isStoredOpenCodeId(binding?.sessionId)) {
        if (!dryRun) delete this.state.modelPrefsByContext[ctxKey]
        summary.removedBindings.push(ctxKey)
        summary.changed = true
        continue
      }

      const sk = sessionKey(binding.projectAlias, binding.sessionId)
      const entries = bindingsBySession.get(sk) || []
      entries.push({ ctxKey, binding, ctx })
      bindingsBySession.set(sk, entries)
    }

    for (const [sk, entries] of bindingsBySession.entries()) {
      const existing = this.state.sessionIndex?.[sk]
      const existingCtxKey = existing ? `${existing.chatId}:${existing.threadIdOr0}` : ""
      const kept = entries.find((entry) => entry.ctxKey === existingCtxKey) || entries[0]

      nextBindings[kept.ctxKey] = {
        projectAlias: kept.binding.projectAlias,
        sessionId: kept.binding.sessionId,
      }
      nextSessionIndex[sk] = { chatId: kept.ctx.chatId, threadIdOr0: kept.ctx.threadIdOr0 }
      if (!existing || existing.chatId !== kept.ctx.chatId || existing.threadIdOr0 !== kept.ctx.threadIdOr0) {
        summary.rebuiltIndexEntries += 1
        summary.changed = true
      }

      for (const entry of entries) {
        if (entry.ctxKey === kept.ctxKey) continue
        if (!dryRun) delete this.state.modelPrefsByContext[entry.ctxKey]
        summary.removedBindings.push(entry.ctxKey)
        summary.conflicts.push({ sessionKey: sk, keptCtxKey: kept.ctxKey, removedCtxKey: entry.ctxKey })
        summary.changed = true
      }
    }

    for (const sk of Object.keys(this.state.sessionIndex || {})) {
      if (!nextSessionIndex[sk]) {
        summary.removedIndexEntries.push(sk)
        summary.changed = true
      }
    }

    if (summary.changed && !dryRun) {
      this.state.bindings = nextBindings
      this.state.sessionIndex = nextSessionIndex
      this.scheduleSave()
    }
    return summary
  }
}

export function resolveDefaultStatePath({ cwd } = {}) {
  return path.resolve(cwd || process.cwd(), ".data", "state.json")
}

async function stateFileExists(filePath) {
  try {
    await fs.stat(filePath)
    return true
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false
    throw err
  }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pathKey(key) {
  return `[${JSON.stringify(key)}]`
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function isSafeProjectAlias(value) {
  return isNonEmptyString(value) && !String(value).includes(":")
}

function isStoredOpenCodeId(value) {
  return typeof value === "string" && value === value.trim() && isSafeOpenCodeId(value)
}

function isOptionalStoredOpenCodeId(value) {
  return value == null || value === "" || isStoredOpenCodeId(value)
}

function parseStoredSessionKey(key) {
  if (!isNonEmptyString(key)) return null
  const parts = String(key).split(":")
  if (parts.length !== 2) return null
  const [projectAlias, sessionId] = parts
  if (!isSafeProjectAlias(projectAlias) || !isStoredOpenCodeId(sessionId)) return null
  return { projectAlias, sessionId }
}

function validateProjectAlias(value, statePath, errors) {
  if (!isSafeProjectAlias(value)) {
    errors.push(`${statePath} must be a non-empty string without ':'`)
    return false
  }
  return true
}

function validateStoredOpenCodeId(value, statePath, errors) {
  if (!isStoredOpenCodeId(value)) {
    errors.push(`${statePath} must be a non-empty safe opencode id without whitespace, colon, or URL path/query separators`)
    return false
  }
  return true
}

function validateOptionalStoredOpenCodeId(value, statePath, errors) {
  if (!isOptionalStoredOpenCodeId(value)) {
    errors.push(`${statePath} must be a safe opencode id without whitespace, colon, or URL path/query separators when present`)
    return false
  }
  return true
}

function isOptionalString(value) {
  return value == null || typeof value === "string"
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

function pushRecordError(errors, value, statePath) {
  if (!isRecord(value)) {
    errors.push(`${statePath} must be an object`)
    return false
  }
  return true
}

function assertValidCurrentState(state, { filePath } = {}) {
  const errors = validateCurrentState(state)
  if (errors.length) throw new StateSchemaValidationError(errors, { filePath })
}

function validateCurrentState(state) {
  const errors = []
  if (!pushRecordError(errors, state, "state")) return errors
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) errors.push(`state.schemaVersion must be ${STATE_SCHEMA_VERSION}`)
  if (!(state.updateOffset === null || Number.isInteger(state.updateOffset))) errors.push("state.updateOffset must be null or an integer")
  validateBindingsSection(state.bindings, errors)
  validateSessionIndexSection(state.sessionIndex, errors)
  validateFeedByContextSection(state.feedByContext, errors)
  validateModelPrefsByContextSection(state.modelPrefsByContext, errors)
  validatePendingPromptsSection(state.pendingPrompts, errors)
  validatePendingRuntimeOnlineNoticeSection(state.pendingRuntimeOnlineNotice, errors)
  validateIdempotencySection(state.idempotency, errors)
  return errors
}

function validateCtxKey(value, statePath, errors) {
  if (!isNonEmptyString(value) || !parseStoredCtxKey(value)) {
    errors.push(`${statePath} must be a Telegram context key like "chatId:threadIdOr0"`)
    return false
  }
  return true
}

function validateBindingsSection(value, errors) {
  if (!pushRecordError(errors, value, "state.bindings")) return
  for (const [ctxKey, binding] of Object.entries(value)) {
    validateCtxKey(ctxKey, `state.bindings${pathKey(ctxKey)}`, errors)
    if (!pushRecordError(errors, binding, `state.bindings${pathKey(ctxKey)}`)) continue
    validateProjectAlias(binding.projectAlias, `state.bindings${pathKey(ctxKey)}.projectAlias`, errors)
    validateStoredOpenCodeId(binding.sessionId, `state.bindings${pathKey(ctxKey)}.sessionId`, errors)
  }
}

function validateSessionIndexSection(value, errors) {
  if (!pushRecordError(errors, value, "state.sessionIndex")) return
  for (const [key, route] of Object.entries(value)) {
    if (!parseStoredSessionKey(key)) errors.push(`state.sessionIndex${pathKey(key)} key must be a safe project/session key`)
    if (!pushRecordError(errors, route, `state.sessionIndex${pathKey(key)}`)) continue
    if (!Number.isInteger(route.chatId)) errors.push(`state.sessionIndex${pathKey(key)}.chatId must be an integer`)
    if (!Number.isInteger(route.threadIdOr0) || route.threadIdOr0 < 0) errors.push(`state.sessionIndex${pathKey(key)}.threadIdOr0 must be a non-negative integer`)
  }
}

function validateFeedByContextSection(value, errors) {
  if (!pushRecordError(errors, value, "state.feedByContext")) return
  for (const [ctxKey, settings] of Object.entries(value)) {
    validateCtxKey(ctxKey, `state.feedByContext${pathKey(ctxKey)}`, errors)
    if (!pushRecordError(errors, settings, `state.feedByContext${pathKey(ctxKey)}`)) continue
    if (!(settings.mode === "main" || settings.mode === "main+changes" || settings.mode === "verbose")) {
      errors.push(`state.feedByContext${pathKey(ctxKey)}.mode must be one of main, main+changes, verbose`)
    }
  }
}

function validateModelPrefsByContextSection(value, errors) {
  if (!pushRecordError(errors, value, "state.modelPrefsByContext")) return
  for (const [ctxKey, pref] of Object.entries(value)) {
    validateCtxKey(ctxKey, `state.modelPrefsByContext${pathKey(ctxKey)}`, errors)
    if (!pushRecordError(errors, pref, `state.modelPrefsByContext${pathKey(ctxKey)}`)) continue
    if (pref.mode === "project-default") continue
    if (pref.mode !== "custom") {
      errors.push(`state.modelPrefsByContext${pathKey(ctxKey)}.mode must be project-default or custom`)
      continue
    }
    if (!pushRecordError(errors, pref.model, `state.modelPrefsByContext${pathKey(ctxKey)}.model`)) continue
    if (!isNonEmptyString(pref.model.providerID)) errors.push(`state.modelPrefsByContext${pathKey(ctxKey)}.model.providerID must be a non-empty string`)
    if (!isNonEmptyString(pref.model.modelID)) errors.push(`state.modelPrefsByContext${pathKey(ctxKey)}.model.modelID must be a non-empty string`)
    if (!isOptionalString(pref.variant)) errors.push(`state.modelPrefsByContext${pathKey(ctxKey)}.variant must be a string when present`)
  }
}

function validatePendingPromptsSection(value, errors) {
  if (!pushRecordError(errors, value, "state.pendingPrompts")) return
  validatePendingPermissions(value.permissions, errors)
  validateCtxPromptRecordsSection(value.rejectNotes, "rejectNotes", "permissionId", errors)
  validateCtxPromptRecordsSection(value.customAnswers, "customAnswers", "requestId", errors)
  validateQuestionWizards(value.questionWizards, errors)
}

function validatePromptCtx(value, statePath, errors, { required = false } = {}) {
  if (value == null) {
    if (required) errors.push(`${statePath} must be an object`)
    return
  }
  if (!pushRecordError(errors, value, statePath)) return
  if (!Number.isInteger(value.chatId)) errors.push(`${statePath}.chatId must be an integer`)
  if (!Number.isInteger(value.threadIdOr0) || value.threadIdOr0 < 0) errors.push(`${statePath}.threadIdOr0 must be a non-negative integer`)
  validateCtxKey(value.ctxKey, `${statePath}.ctxKey`, errors)
}

function validatePendingPermissions(value, errors) {
  if (!pushRecordError(errors, value, "state.pendingPrompts.permissions")) return
  for (const [key, entry] of Object.entries(value)) {
    const statePath = `state.pendingPrompts.permissions${pathKey(key)}`
    if (!isNonEmptyString(key)) errors.push(`${statePath} key must be non-empty`)
    if (!pushRecordError(errors, entry, statePath)) continue
    validateProjectAlias(entry.projectAlias, `${statePath}.projectAlias`, errors)
    if (!isNonEmptyString(entry.permissionId)) errors.push(`${statePath}.permissionId must be a non-empty string`)
    validateOptionalStoredOpenCodeId(entry.sessionID, `${statePath}.sessionID`, errors)
    if (!isOptionalString(entry.permission)) errors.push(`${statePath}.permission must be a string when present`)
    if (entry.patterns != null && (!Array.isArray(entry.patterns) || entry.patterns.some((pattern) => typeof pattern !== "string"))) {
      errors.push(`${statePath}.patterns must be an array of strings when present`)
    }
    if (entry.createdAt != null && !isFiniteNumber(entry.createdAt)) errors.push(`${statePath}.createdAt must be a finite number when present`)
    validatePromptCtx(entry.ctx, `${statePath}.ctx`, errors, { required: true })
  }
}

function validateCtxPromptRecordsSection(value, sectionName, idField, errors) {
  const sectionPath = `state.pendingPrompts.${sectionName}`
  if (!pushRecordError(errors, value, sectionPath)) return
  for (const [ctxKey, entry] of Object.entries(value)) {
    const statePath = `${sectionPath}${pathKey(ctxKey)}`
    validateCtxKey(ctxKey, statePath, errors)
    if (!pushRecordError(errors, entry, statePath)) continue
    validateProjectAlias(entry.projectAlias, `${statePath}.projectAlias`, errors)
    if (!isNonEmptyString(entry[idField])) errors.push(`${statePath}.${idField} must be a non-empty string`)
    validateOptionalStoredOpenCodeId(entry.sessionID, `${statePath}.sessionID`, errors)
    if (sectionName === "customAnswers" && !Number.isInteger(entry.qIndex)) errors.push(`${statePath}.qIndex must be an integer`)
  }
}

function validateQuestionWizards(value, errors) {
  if (!pushRecordError(errors, value, "state.pendingPrompts.questionWizards")) return
  for (const [key, wizard] of Object.entries(value)) {
    const statePath = `state.pendingPrompts.questionWizards${pathKey(key)}`
    if (!isNonEmptyString(key)) errors.push(`${statePath} key must be non-empty`)
    if (!pushRecordError(errors, wizard, statePath)) continue
    validateProjectAlias(wizard.projectAlias, `${statePath}.projectAlias`, errors)
    if (!isNonEmptyString(wizard.id) && !isNonEmptyString(wizard.request?.id)) errors.push(`${statePath}.id or .request.id must be a non-empty string`)
    validateOptionalStoredOpenCodeId(wizard.sessionID, `${statePath}.sessionID`, errors)
    if (!pushRecordError(errors, wizard.request, `${statePath}.request`)) {
      // request shape reported above
    } else {
      if (!isNonEmptyString(wizard.request.id)) errors.push(`${statePath}.request.id must be a non-empty string`)
      if (!Array.isArray(wizard.request.questions)) errors.push(`${statePath}.request.questions must be an array`)
    }
    if (!Number.isInteger(wizard.index)) errors.push(`${statePath}.index must be an integer`)
    if (!Array.isArray(wizard.answers) || wizard.answers.some((entry) => !Array.isArray(entry))) errors.push(`${statePath}.answers must be an array of arrays`)
    if (!pushRecordError(errors, wizard.selectedByIndex, `${statePath}.selectedByIndex`)) {
      // selectedByIndex shape reported above
    } else {
      for (const [idx, selected] of Object.entries(wizard.selectedByIndex)) {
        if (!Array.isArray(selected)) errors.push(`${statePath}.selectedByIndex${pathKey(idx)} must be an array`)
      }
    }
    if (wizard.createdAt != null && !isFiniteNumber(wizard.createdAt)) errors.push(`${statePath}.createdAt must be a finite number when present`)
    validatePromptCtx(wizard.ctx, `${statePath}.ctx`, errors, { required: true })
  }
}

function validateIdempotencySection(value, errors) {
  if (!pushRecordError(errors, value, "state.idempotency")) return
  if (!pushRecordError(errors, value.keys, "state.idempotency.keys")) return
  for (const [key, entry] of Object.entries(value.keys)) {
    const statePath = `state.idempotency.keys${pathKey(key)}`
    if (!normalizeIdempotencyKey(key)) errors.push(`${statePath} key must be a non-empty string up to 512 characters`)
    if (!pushRecordError(errors, entry, statePath)) continue
    if (!isFiniteNumber(entry.createdAt)) errors.push(`${statePath}.createdAt must be a finite number`)
    for (const field of ["kind", "projectAlias", "ctxKey", "sessionId", "operation", "action"]) {
      if (!isOptionalString(entry[field])) errors.push(`${statePath}.${field} must be a string when present`)
    }
    if (entry.updateId != null && !Number.isInteger(entry.updateId)) errors.push(`${statePath}.updateId must be an integer when present`)
    if (entry.messageId != null && !Number.isInteger(entry.messageId)) errors.push(`${statePath}.messageId must be an integer when present`)
  }
}

function validatePendingRuntimeOnlineNoticeSection(value, errors) {
  if (value == null) return
  if (!pushRecordError(errors, value, "state.pendingRuntimeOnlineNotice")) return
  if (value.kind !== "restart") errors.push("state.pendingRuntimeOnlineNotice.kind must be restart")
  if (!Number.isInteger(value.chatId)) errors.push("state.pendingRuntimeOnlineNotice.chatId must be an integer")
  if (value.createdAt != null && !isFiniteNumber(value.createdAt)) errors.push("state.pendingRuntimeOnlineNotice.createdAt must be a finite number when present")
}

function normalizePendingPrompts(value) {
  const base = defaultPendingPrompts()
  if (!value || typeof value !== "object") return base
  return {
    permissions: normalizePendingPermissionRecords(value.permissions),
    rejectNotes: normalizeCtxPromptRecords(value.rejectNotes, "permissionId"),
    customAnswers: normalizeCtxPromptRecords(value.customAnswers, "requestId"),
    questionWizards: normalizeQuestionWizardRecords(value.questionWizards),
  }
}

function normalizePendingRuntimeOnlineNotice(value) {
  if (!value || typeof value !== "object") return null
  if (value.kind !== "restart" || !Number.isInteger(value.chatId)) return null
  return {
    kind: "restart",
    chatId: value.chatId,
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : Date.now(),
  }
}

function normalizeBindings(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey, binding]) => {
        if (typeof ctxKey !== "string" || !ctxKey) return false
        if (!binding || typeof binding !== "object") return false
        return isSafeProjectAlias(binding.projectAlias) && isStoredOpenCodeId(binding.sessionId)
      })
      .map(([ctxKey, binding]) => [ctxKey, { projectAlias: binding.projectAlias, sessionId: binding.sessionId }]),
  )
}

function parseStoredCtxKey(ctxKey) {
  const match = String(ctxKey || "").match(/^(-?\d+):(\d+)$/)
  if (!match) return null
  return { chatId: Number(match[1]), threadIdOr0: Number(match[2]) }
}

function normalizeSessionIndex(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, route]) => {
        if (!parseStoredSessionKey(key)) return false
        if (!route || typeof route !== "object") return false
        return Number.isFinite(route.chatId) && Number.isInteger(route.threadIdOr0)
      })
      .map(([key, route]) => [key, { chatId: route.chatId, threadIdOr0: route.threadIdOr0 }]),
  )
}

function findPromptRecord(records, projectAlias, promptId, sessionID = "") {
  if (!records || typeof records !== "object") return null
  const direct = records[promptKey(projectAlias, promptId, sessionID)]
  if (direct) return direct
  if (!sessionID) {
    const legacy = records[sessionKey(projectAlias, promptId)]
    if (legacy) return legacy
  }
  return Object.values(records).find((entry) => {
    if (entry?.projectAlias !== projectAlias) return false
    const entryId = entry?.permissionId || entry?.id || entry?.request?.id
    if (entryId !== promptId) return false
    return sessionID ? entry?.sessionID === sessionID : true
  }) || null
}

function normalizePendingPermissionRecords(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.values(value)
      .filter((entry) => isSafeProjectAlias(entry?.projectAlias) && entry?.permissionId && isOptionalStoredOpenCodeId(entry?.sessionID))
      .map((entry) => [
        promptKey(entry.projectAlias, entry.permissionId, entry.sessionID),
        {
          ...entry,
          sessionID: entry.sessionID || "",
          patterns: Array.isArray(entry.patterns) ? entry.patterns.filter((pattern) => typeof pattern === "string") : [],
        },
      ]),
  )
}

function normalizeCtxPromptRecords(value, idField) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey, entry]) => typeof ctxKey === "string" && ctxKey && isSafeProjectAlias(entry?.projectAlias) && entry?.[idField] && isOptionalStoredOpenCodeId(entry?.sessionID))
      .map(([ctxKey, entry]) => [ctxKey, { ...entry, sessionID: entry.sessionID || "" }]),
  )
}

function normalizeQuestionWizardRecords(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.values(value)
      .filter((wizard) => isSafeProjectAlias(wizard?.projectAlias) && (wizard?.id || wizard?.request?.id) && isOptionalStoredOpenCodeId(wizard?.sessionID))
      .map((wizard) => {
        const id = wizard.id || wizard.request.id
        return [
          promptKey(wizard.projectAlias, id, wizard.sessionID),
          {
            ...wizard,
            id,
            sessionID: wizard.sessionID || "",
            request:
              wizard.request && typeof wizard.request === "object"
                ? { ...wizard.request, id: wizard.request.id || id, questions: Array.isArray(wizard.request.questions) ? wizard.request.questions : [] }
                : { id, questions: [] },
            index: Number.isInteger(wizard.index) ? wizard.index : 0,
            answers: Array.isArray(wizard.answers) ? wizard.answers.map((entry) => (Array.isArray(entry) ? entry : [])) : [],
            selectedByIndex:
              wizard.selectedByIndex && typeof wizard.selectedByIndex === "object"
                ? Object.fromEntries(Object.entries(wizard.selectedByIndex).filter(([, selected]) => Array.isArray(selected)))
                : {},
          },
        ]
      }),
  )
}

function normalizeIdempotencyKey(key) {
  const normalized = typeof key === "string" ? key.trim() : ""
  if (!normalized || normalized.length > 512) return ""
  return normalized
}

function normalizeMetadataString(value, maxLength = 200) {
  if (value == null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function normalizeIdempotencyEntry(value) {
  const createdAt = typeof value?.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now()
  const entry = { createdAt }
  for (const [name, maxLength] of [
    ["kind", 80],
    ["projectAlias", 120],
    ["ctxKey", 80],
    ["sessionId", 160],
    ["operation", 120],
    ["action", 80],
  ]) {
    const text = normalizeMetadataString(value?.[name], maxLength)
    if (text) entry[name] = text
  }
  if (Number.isInteger(value?.updateId)) entry.updateId = value.updateId
  if (Number.isInteger(value?.messageId)) entry.messageId = value.messageId
  return entry
}

function normalizeIdempotencyLedger(value) {
  const source = value?.keys && typeof value.keys === "object" ? value.keys : value && typeof value === "object" ? value : {}
  const entries = Object.entries(source)
    .filter(([key]) => !!normalizeIdempotencyKey(key))
    .map(([key, entry]) => [normalizeIdempotencyKey(key), normalizeIdempotencyEntry(entry)])
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(-DEFAULT_IDEMPOTENCY_MAX_ENTRIES)
  return { keys: Object.fromEntries(entries) }
}

function normalizeFeedByContext(value) {
  if (!value || typeof value !== "object") return defaultFeedByContext()
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey]) => typeof ctxKey === "string" && ctxKey)
      .map(([ctxKey, settings]) => [ctxKey, { mode: normalizeFeedMode(settings?.mode) }]),
  )
}

function normalizeModelPrefsByContext(value) {
  if (!value || typeof value !== "object") return defaultModelPrefsByContext()
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey]) => typeof ctxKey === "string" && ctxKey)
      .map(([ctxKey, pref]) => [ctxKey, storedModelPreference(pref)])
      .filter(([, pref]) => !!pref),
  )
}
