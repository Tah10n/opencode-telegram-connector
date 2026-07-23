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

function normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections } = {}) {
  if (typeof normalizeBindingSections === "function") {
    return normalizeBindingSections(loaded?.bindings, loaded?.sessionIndex)
  }
  return {
    bindings: normalizeBindings(loaded?.bindings),
    sessionIndex: normalizeSessionIndex(loaded?.sessionIndex),
  }
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
    mode,
  } = {},
) {
  const backupPath = await createStateFileBackupImpl(filePath, {
    reason,
    schemaVersion,
    maxBackups,
    mode,
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
    normalizeBindingSections,
    normalizeFeedByContext,
    normalizeLocaleByContext,
    normalizeModelPrefsByContext,
    normalizePendingPrompts,
    normalizePendingRuntimeOnlineNotice,
    normalizeIdempotencyLedger,
    normalizeCallbackPayloads,
    normalizeAttachmentConfirmations,
    normalizePromptDeliveries,
    normalizeOutbox,
    defaultFeedByContext,
    defaultLocaleByContext,
    defaultModelPrefsByContext,
    defaultPendingPrompts,
    defaultIdempotencyLedger,
    defaultCallbackPayloads,
    defaultAttachmentConfirmations,
    defaultPromptDeliveries,
    defaultOutbox,
  } = {},
) {
  const finishMigrated = (state, options) => migratedState({
    ...state,
    attachmentConfirmations: state.attachmentConfirmations ?? defaultAttachmentConfirmations(),
    promptDeliveries: state.promptDeliveries ?? defaultPromptDeliveries(),
    outbox: state.outbox ?? defaultOutbox(),
  }, options)

  // New schema.
  if (loaded && typeof loaded === "object" && loaded.schemaVersion === schemaVersion) {
    assertValidCurrentState(loaded, { filePath })
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return {
      migrated: false,
      state: {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: normalizeLocaleByContext(loaded.localeByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: cloneStateForWrite(loaded.callbackPayloads),
        attachmentConfirmations: normalizeAttachmentConfirmations(loaded.attachmentConfirmations),
        promptDeliveries: normalizePromptDeliveries(loaded.promptDeliveries),
        outbox: normalizeOutbox(loaded.outbox),
      },
    }
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 8) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: normalizeLocaleByContext(loaded.localeByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: normalizeCallbackPayloads(loaded.callbackPayloads),
        promptDeliveries: normalizePromptDeliveries(loaded.promptDeliveries),
        outbox: normalizeOutbox(loaded.outbox),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 7) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: normalizeLocaleByContext(loaded.localeByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: normalizeCallbackPayloads(loaded.callbackPayloads),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 6) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: normalizeLocaleByContext(loaded.localeByContext),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: normalizeCallbackPayloads(loaded.callbackPayloads),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 5) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: defaultCallbackPayloads(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 4) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: normalizeModelPrefsByContext(loaded.modelPrefsByContext),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: normalizePendingRuntimeOnlineNotice(loaded.pendingRuntimeOnlineNotice),
        idempotency: normalizeIdempotencyLedger(loaded.idempotency),
        callbackPayloads: defaultCallbackPayloads(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 3) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: normalizeFeedByContext(loaded.feedByContext),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
        callbackPayloads: defaultCallbackPayloads(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 2) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: defaultFeedByContext(),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
        callbackPayloads: defaultCallbackPayloads(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  if (loaded && typeof loaded === "object" && loaded.schemaVersion === 1) {
    const bindingState = normalizeBindingState(loaded, { normalizeBindings, normalizeSessionIndex, normalizeBindingSections })
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.updateOffset) ? loaded.updateOffset : null,
        bindings: bindingState.bindings,
        sessionIndex: bindingState.sessionIndex,
        feedByContext: defaultFeedByContext(),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: normalizePendingPrompts(loaded.pendingPrompts),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
        callbackPayloads: defaultCallbackPayloads(),
      },
      { filePath, assertValidCurrentState },
    )
  }

  // Best-effort migration from the old single-session state.
  // Old format example: { telegram: { updateOffset, chatId }, opencode: { directory } }
  if (loaded && typeof loaded === "object" && loaded.telegram && typeof loaded.telegram === "object") {
    return finishMigrated(
      {
        schemaVersion,
        updateOffset: Number.isInteger(loaded.telegram.updateOffset) ? loaded.telegram.updateOffset : null,
        bindings: {},
        sessionIndex: {},
        feedByContext: defaultFeedByContext(),
        localeByContext: defaultLocaleByContext(),
        modelPrefsByContext: defaultModelPrefsByContext(),
        pendingPrompts: defaultPendingPrompts(),
        pendingRuntimeOnlineNotice: null,
        idempotency: defaultIdempotencyLedger(),
        callbackPayloads: defaultCallbackPayloads(),
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
  mode,
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
        mode,
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
      mode,
    })
    const snapshot = cloneState(result.state)
    try {
      await writeJsonFileAtomicImpl(filePath, snapshot, { mode })
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
