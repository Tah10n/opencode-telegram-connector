import path from "node:path"
import { readJsonFile, writeJsonFileAtomic } from "./fileStore.js"

export const STATE_SCHEMA_VERSION = 3
export const DEFAULT_FEED_MODE = "main+changes"

export function normalizeFeedMode(value) {
  if (value === "main" || value === "main+changes" || value === "verbose") return value
  return DEFAULT_FEED_MODE
}

function defaultFeedByContext() {
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

export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updateOffset: null,
    bindings: {},
    sessionIndex: {},
    feedByContext: defaultFeedByContext(),
    pendingPrompts: defaultPendingPrompts(),
  }
}

export function sessionKey(projectAlias, sessionId) {
  return `${projectAlias}:${sessionId}`
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

  getFeedMode(ctxKey) {
    return normalizeFeedMode(this.state.feedByContext?.[ctxKey]?.mode)
  }

  setFeedMode(ctxKey, mode) {
    if (!ctxKey) return
    this.state.feedByContext[ctxKey] = { mode: normalizeFeedMode(mode) }
    this.scheduleSave()
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
    this.state.pendingPrompts.permissions[sessionKey(record.projectAlias, record.permissionId)] = {
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

  deletePendingPermission(projectAlias, permissionId) {
    if (!projectAlias || !permissionId) return false
    const key = sessionKey(projectAlias, permissionId)
    const existed = delete this.state.pendingPrompts.permissions[key]
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
    const prev = this.state.bindings[ctxKey]
    if (prev) {
      delete this.state.sessionIndex[sessionKey(prev.projectAlias, prev.sessionId)]
    }

    // If session is already bound elsewhere, move it.
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const existingCtx = this.state.sessionIndex[sk]
    if (existingCtx) {
      const otherKey = `${existingCtx.chatId}:${existingCtx.threadIdOr0}`
      delete this.state.bindings[otherKey]
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
  }

  unbind(ctxKey) {
    const prev = this.state.bindings[ctxKey]
    if (!prev) return false
    delete this.state.bindings[ctxKey]
    delete this.state.sessionIndex[sessionKey(prev.projectAlias, prev.sessionId)]
    this.scheduleSave()
    return true
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
      bindings: loaded.bindings && typeof loaded.bindings === "object" ? loaded.bindings : {},
      sessionIndex: loaded.sessionIndex && typeof loaded.sessionIndex === "object" ? loaded.sessionIndex : {},
      feedByContext: normalizeFeedByContext(loaded.feedByContext),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 2) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: loaded.bindings && typeof loaded.bindings === "object" ? loaded.bindings : {},
      sessionIndex: loaded.sessionIndex && typeof loaded.sessionIndex === "object" ? loaded.sessionIndex : {},
      feedByContext: defaultFeedByContext(),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 1) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
      bindings: loaded.bindings && typeof loaded.bindings === "object" ? loaded.bindings : {},
      sessionIndex: loaded.sessionIndex && typeof loaded.sessionIndex === "object" ? loaded.sessionIndex : {},
      feedByContext: defaultFeedByContext(),
      pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
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
      pendingPrompts: defaultPendingPrompts(),
    }
  }

  return defaultState()
}

function normalizePendingPrompts(value) {
  const base = defaultPendingPrompts()
  if (!value || typeof value !== "object") return base
  return {
    permissions: value.permissions && typeof value.permissions === "object" ? value.permissions : {},
    rejectNotes: value.rejectNotes && typeof value.rejectNotes === "object" ? value.rejectNotes : {},
    customAnswers: value.customAnswers && typeof value.customAnswers === "object" ? value.customAnswers : {},
    questionWizards: value.questionWizards && typeof value.questionWizards === "object" ? value.questionWizards : {},
  }
}

function normalizeFeedByContext(value) {
  if (!value || typeof value !== "object") return defaultFeedByContext()
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ctxKey]) => typeof ctxKey === "string" && ctxKey)
      .map(([ctxKey, settings]) => [ctxKey, { mode: normalizeFeedMode(settings?.mode) }]),
  )
}
