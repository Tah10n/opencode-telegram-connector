import { createStateFileBackup } from "./fileStore.js"

function cloneStateForWrite(state) {
  return JSON.parse(JSON.stringify(state))
}

function defaultSchemaValidationError(errors, { filePath } = {}) {
  const err = new Error(
    `State file schema validation failed${filePath ? ` for ${filePath}` : ""}: ${errors.slice(0, 5).join("; ")}. Restore a known-good state backup, move the broken state file aside, or repair the reported sections before restarting.`,
  )
  err.code = "STATE_SCHEMA_INVALID"
  err.errors = errors
  err.filePath = filePath
  return err
}

export async function preserveStateBeforeRecovery(
  filePath,
  loaded,
  {
    reason,
    schemaVersion,
    maxBackups,
    createStateFileBackupImpl = createStateFileBackup,
    logger,
  } = {},
) {
  const backupPath = await createStateFileBackupImpl(filePath, {
    reason,
    schemaVersion,
    maxBackups,
  })
  logger?.warn?.(`Preserved ${reason} state file before recovery:`, backupPath)
  return backupPath
}

export function migratedState(state, { filePath, assertValidCurrentState } = {}) {
  assertValidCurrentState(state, { filePath })
  return { migrated: true, state }
}

export function migrateStateIfNeeded(
  loaded,
  {
    filePath,
    schemaVersion,
    assertValidCurrentState,
    createSchemaValidationError = defaultSchemaValidationError,
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
  } = {},
) {
  // New schema.
  if (loaded && typeof loaded === "object" && loaded.schemaVersion === schemaVersion) {
    assertValidCurrentState(loaded, { filePath })
    return {
      migrated: false,
      state: {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: normalizeBindings(loaded.bindings),
        sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
      },
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 4) {
    return migratedState(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: normalizeBindings(loaded.bindings),
        sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 3) {
    return migratedState(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: normalizeBindings(loaded.bindings),
        sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 2) {
    return migratedState(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: normalizeBindings(loaded.bindings),
        sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
        feedByContext: defaultFeedByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 1) {
    return migratedState(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: normalizeBindings(loaded.bindings),
        sessionIndex: normalizeSessionIndex(loaded.sessionIndex),
        feedByContext: defaultFeedByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  // Best-effort migration from the old single-session state.
  // Old format example: { telegram: { updateOffset, chatId }, opencode: { directory } }
  if (loaded && typeof loaded === "object" && loaded.telegram && typeof loaded.telegram === "object") {
    return migratedState(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.telegram.updateOffset) ? loaded.telegram.updateOffset : null,
        bindings: {},
        sessionIndex: {},
        feedByContext: defaultFeedByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: defaultPendingPrompts(),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  const version = loaded && typeof loaded === "object" ? loaded.schemaVersion : undefined
  throw createSchemaValidationError([`state.schemaVersion is unsupported (${version ?? "missing"})`], { filePath })
}

export async function loadStateWithMigration({
  loaded,
  filePath,
  migrateStateIfNeededImpl,
  logger,
  backupMaxFiles,
  writeJsonFileAtomicImpl,
  createStateFileBackupImpl = createStateFileBackup,
  schemaVersion,
  cloneState = cloneStateForWrite,
}) {
  let result
  try {
    result = migrateStateIfNeededImpl(loaded, { filePath })
  } catch (err) {
    if (err?.code === "STATE_SCHEMA_INVALID") {
      await preserveStateBeforeRecovery(filePath, loaded, {
        reason: "invalid",
        schemaVersion: loaded?.schemaVersion,
        maxBackups: backupMaxFiles,
        createStateFileBackupImpl,
        logger,
      }).catch((backupErr) => {
        logger?.error?.("Failed to preserve invalid state file:", backupErr?.message || String(backupErr))
      })
    }
    throw err
  }

  if (result.migrated) {
    const backupPath = await preserveStateBeforeRecovery(filePath, loaded, {
      reason: "migration",
      schemaVersion: loaded?.schemaVersion,
      maxBackups: backupMaxFiles,
      createStateFileBackupImpl,
      logger,
    })
    const snapshot = cloneState(result.state)
    try {
      await writeJsonFileAtomicImpl(filePath, snapshot)
    } catch (err) {
      logger?.error?.(
        "Failed to persist migrated state; original state file was preserved before migration:",
        backupPath,
        err?.message || String(err),
      )
      throw err
    }
    logger?.info?.("State migrated to schema version", schemaVersion, "backup:", backupPath)
  }

  return result.state
}
