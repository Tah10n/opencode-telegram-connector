import path from "node:path"
import { readJsonFile, writeJsonFileAtomic } from "./fileStore.js"

export const STATE_SCHEMA_VERSION = 1

export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updateOffset: null,
    bindings: {},
    sessionIndex: {},
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
    }
  }

  return defaultState()
}
