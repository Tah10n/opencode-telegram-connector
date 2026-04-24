import path from "node:path"
import { readJsonFile, writeJsonFileAtomic } from "./fileStore.js"
import { normalizeModelPreference, storedModelPreference } from "../model-selection.js"

export const STATE_SCHEMA_VERSION = 5
export const DEFAULT_FEED_MODE = "main+changes"
export const DEFAULT_IDEMPOTENCY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 5000

export function normalizeFeedMode(value) {
  if (value === "main" || value === "main+changes" || value === "verbose") return value
  return DEFAULT_FEED_MODE
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
    idempotency: defaultIdempotencyLedger(),
  }
}

export function sessionKey(projectAlias, sessionId) {
  return `${projectAlias}:${sessionId}`
}

export function promptKey(projectAlias, promptId, sessionID = "") {
  const session = String(sessionID || "").trim()
  return session ? `${projectAlias}:${session}:${promptId}` : `${projectAlias}:${promptId}`
}

export class StateStore {
  constructor({ filePath, logger }) {
    this.filePath = filePath
    this.logger = logger
    this.state = defaultState()
    this._saveTimer = null
    this._writeChain = Promise.resolve()
  }

  async load() {
    const loaded = await readJsonFile(this.filePath).catch((err) => {
      this.logger?.error?.("Failed to read state file, starting fresh:", err?.message || String(err))
      return null
    })
    if (!loaded) return this.state
    this.state = migrateStateIfNeeded(loaded)
    return this.state
  }

  get() {
    return this.state
  }

  getPendingPrompts() {
    return this.state.pendingPrompts
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
      void this.flush()
    }, delayMs)
  }

  async flush() {
    const snapshot = this.state
    this._writeChain = this._writeChain
      .then(() => writeJsonFileAtomic(this.filePath, snapshot))
      .catch((err) => this.logger?.error?.("Failed to write state:", err?.message || String(err)))
    return this._writeChain
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
      if (!ctx || !binding?.projectAlias || !binding?.sessionId) {
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

function migrateStateIfNeeded(loaded) {
  // New schema.
  if (loaded && typeof loaded === "object" && loaded.schemaVersion === STATE_SCHEMA_VERSION) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: normalizeBindings(loaded.bindings),
      sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
      feedByContext: normalizeFeedByContext(loaded.feedByContext),
      modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
      idempotency: normalizeIdempotencyLedger(loaded.idempotency),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 4) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: normalizeBindings(loaded.bindings),
      sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
      feedByContext: normalizeFeedByContext(loaded.feedByContext),
      modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
      idempotency: normalizeIdempotencyLedger(loaded.idempotency),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 3) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: normalizeBindings(loaded.bindings),
      sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
      feedByContext: normalizeFeedByContext(loaded.feedByContext),
      modelPrefsByContext: defaultModelPrefsByContext(),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
      idempotency: defaultIdempotencyLedger(),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 2) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: normalizeBindings(loaded.bindings),
      sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
      feedByContext: defaultFeedByContext(),
      modelPrefsByContext: defaultModelPrefsByContext(),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
      idempotency: defaultIdempotencyLedger(),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 1) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: normalizeBindings(loaded.bindings),
      sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
      feedByContext: defaultFeedByContext(),
      modelPrefsByContext: defaultModelPrefsByContext(),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
      idempotency: defaultIdempotencyLedger(),
    }
  }

  // Best-effort migration from the old single-session state.
  // Old format example: { telegram: { updateOffset, chatId }, opencode: { directory } }
  if (loaded && typeof loaded === "object" && loaded.telegram && typeof loaded.telegram === "object") {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.telegram.updateOffset) ? loaded.telegram.updateOffset : null,
      bindings: {},
      sessionIndex: {},
      feedByContext: defaultFeedByContext(),
      modelPrefsByContext: defaultModelPrefsByContext(),
      pendingPrompts: defaultPendingPrompts(),
      idempotency: defaultIdempotencyLedger(),
    }
  }

  return defaultState()
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

function normalizeBindings(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey, binding]) => {
        if (typeof ctxKey !== "string" || !ctxKey) return false
        if (!binding || typeof binding !== "object") return false
        return typeof binding.projectAlias === "string" && !!binding.projectAlias && typeof binding.sessionId === "string" && !!binding.sessionId
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
        if (typeof key !== "string" || !key) return false
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
      .filter((entry) => entry?.projectAlias && entry?.permissionId)
      .map((entry) => [promptKey(entry.projectAlias, entry.permissionId, entry.sessionID), entry]),
  )
}

function normalizeCtxPromptRecords(value, idField) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey, entry]) => typeof ctxKey === "string" && ctxKey && entry?.projectAlias && entry?.[idField])
      .map(([ctxKey, entry]) => [ctxKey, { ...entry, sessionID: entry.sessionID || "" }]),
  )
}

function normalizeQuestionWizardRecords(value) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.values(value)
      .filter((wizard) => wizard?.projectAlias && (wizard?.id || wizard?.request?.id))
      .map((wizard) => [promptKey(wizard.projectAlias, wizard.id || wizard.request.id, wizard.sessionID), wizard]),
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
