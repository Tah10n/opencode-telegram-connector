import { classifyBoundaryError } from "../boundary-errors.js"
import { escapeHtml } from "../telegram/formatter.js"
import { t as translate } from "../i18n/index.js"
import { isSafeOpenCodeId } from "../opencode/ids.js"
import { permissionNoteIdempotencyPrefix, permissionReplyIdempotencyPrefix, promptIdentity, questionReplyIdempotencyPrefix, questionRejectIdempotencyKey } from "./idempotency.js"

function defaultTypeSummary() {
  return { restored: 0, stale: 0, retryable: 0, fatal: 0 }
}

function createSummary() {
  return {
    permissions: defaultTypeSummary(),
    questionWizards: defaultTypeSummary(),
    rejectNotes: defaultTypeSummary(),
    customAnswers: defaultTypeSummary(),
  }
}

function summarizeTotals(summary) {
  return Object.values(summary).reduce(
    (totals, bucket) => ({
      restored: totals.restored + bucket.restored,
      stale: totals.stale + bucket.stale,
      retryable: totals.retryable + bucket.retryable,
      fatal: totals.fatal + bucket.fatal,
    }),
    { restored: 0, stale: 0, retryable: 0, fatal: 0 },
  )
}

function classifySnapshotFailure(err, { pathname }) {
  const classification = classifyBoundaryError(err, {
    source: "opencode",
    operation: `GET ${pathname}`,
    method: "GET",
    pathname,
  })
  return classification.retryable ? "retryable" : "fatal"
}

function buildWizardFromSnapshot(snapshot, { request } = {}) {
  return {
    projectAlias: snapshot.projectAlias,
    id: snapshot.id,
    sessionID: snapshot.sessionID,
    request: request || snapshot.request,
    index: Number.isInteger(snapshot.index) ? snapshot.index : 0,
    answers: Array.isArray(snapshot.answers) ? snapshot.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
    selectedByIndex:
      snapshot.selectedByIndex && typeof snapshot.selectedByIndex === "object"
        ? Object.fromEntries(
            Object.entries(snapshot.selectedByIndex).map(([idx, selected]) => [idx, Array.isArray(selected) ? [...selected] : []]),
          )
        : {},
    messageIdByIndex: {},
    createdAt: typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now(),
    ctx: snapshot.ctx,
  }
}

function buildPromptEntryIndex(entries) {
  const byPromptId = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id || "").trim()
    if (!id) continue
    const list = byPromptId.get(id) || []
    list.push(entry)
    byPromptId.set(id, list)
  }
  return byPromptId
}

function resolveLivePrompt(collection, promptId, sessionID = "") {
  const id = String(promptId || "").trim()
  const expectedSessionID = String(sessionID || "").trim()
  if (!id) return { active: false, sessionID: expectedSessionID, entry: null }

  const hasIdentity = (identity) => collection?.ids?.has?.(identity) || collection?.byId?.has?.(identity)
  const entryForIdentity = (identity) => collection?.byId?.get?.(identity) || null
  if (expectedSessionID) {
    const identity = promptIdentity(id, expectedSessionID)
    return hasIdentity(identity) ? { active: true, sessionID: expectedSessionID, entry: entryForIdentity(identity) } : { active: false, sessionID: expectedSessionID, entry: null }
  }

  const unscopedIdentity = promptIdentity(id)
  if (hasIdentity(unscopedIdentity)) return { active: true, sessionID: "", entry: entryForIdentity(unscopedIdentity) }

  const scopedBySession = new Map()
  for (const entry of collection?.byPromptId?.get?.(id) || []) {
    const liveSessionID = String(entry?.sessionID || "").trim()
    if (!liveSessionID || !isSafeOpenCodeId(liveSessionID)) continue
    scopedBySession.set(liveSessionID, entry)
    if (scopedBySession.size > 1) return { active: false, sessionID: "", entry: null, ambiguous: true }
  }
  if (scopedBySession.size !== 1) return { active: false, sessionID: "", entry: null }
  const [[liveSessionID, entry]] = scopedBySession.entries()
  return { active: true, sessionID: liveSessionID, entry, inferred: true }
}

function withQuestionSession(value, sessionID) {
  const effectiveSessionID = String(sessionID || "").trim()
  if (!effectiveSessionID || value?.sessionID) return value
  const request = value?.request && typeof value.request === "object" ? { ...value.request, sessionID: effectiveSessionID } : value?.request
  return { ...value, sessionID: effectiveSessionID, request }
}

function requestWithSession(request, sessionID) {
  const effectiveSessionID = String(sessionID || "").trim()
  if (!request || typeof request !== "object" || !effectiveSessionID || request.sessionID) return request
  return { ...request, sessionID: effectiveSessionID }
}

export function createPromptRecovery(runtime) {
  const {
    store,
    config,
    ocByAlias,
    prompted,
    questionWizards,
    wizardKey,
    parseCtxKey,
    sendBlocksToThread,
    sendPermissionPrompt,
    sendCurrentQuestionStep,
    sendRejectNotePrompt,
    sendQuestionCustomAnswerPrompt,
    clearPersistedQuestionWizard,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    markProjectUp,
    recordPromptRecovery,
    recordPromptCleanup,
    resolveBoundRoute,
  } = runtime

  const livePromptSnapshotByProject = new Map()

  function routeCtxKey(route) {
    if (route?.chatId == null) return ""
    return `${route.chatId}:${route.threadIdOr0 || 0}`
  }

  async function isPromptBindingCurrent(ctxKey, projectAlias, sessionID = "") {
    const binding = typeof store?.getBinding === "function" ? store.getBinding(ctxKey) : null
    if (!binding || binding.projectAlias !== projectAlias) return false
    if (!sessionID || binding.sessionId === sessionID) return true
    if (typeof resolveBoundRoute !== "function") return false
    const resolved = await resolveBoundRoute(projectAlias, sessionID)
    return binding.sessionId === resolved?.boundSessionId && routeCtxKey(resolved?.route) === ctxKey
  }

  async function promptBindingStatus(ctxKey, projectAlias, sessionID = "") {
    try {
      return (await isPromptBindingCurrent(ctxKey, projectAlias, sessionID)) ? "current" : "stale"
    } catch (err) {
      const classification = classifyBoundaryError(err)
      if (classification.retryable) return "retryable"
      throw err
    }
  }

  async function flushStoreIfAvailable() {
    if (typeof store?.flush === "function") await store.flush()
  }

  async function getLivePromptSnapshot(projectAlias) {
    if (!projectAlias || !ocByAlias[projectAlias]) {
      return {
        permissions: { outcome: "fatal", ids: null },
        questions: { outcome: "fatal", byId: null },
      }
    }

    let promise = livePromptSnapshotByProject.get(projectAlias)
    if (!promise) {
      const oc = ocByAlias[projectAlias]
      promise = Promise.allSettled([oc.listPermissions(), oc.listQuestions()]).then(([permissionsResult, questionsResult]) => {
        const permissionEntries = permissionsResult.status === "fulfilled" && Array.isArray(permissionsResult.value) ? permissionsResult.value : []
        const questionEntries = questionsResult.status === "fulfilled" && Array.isArray(questionsResult.value) ? questionsResult.value : []
        const permissions =
          permissionsResult.status === "fulfilled" && Array.isArray(permissionsResult.value)
            ? {
                outcome: "ok",
                ids: new Set(
                  permissionEntries.map((entry) => promptIdentity(entry?.id, entry?.sessionID)).filter((id) => typeof id === "string" && id),
                ),
                byPromptId: buildPromptEntryIndex(permissionEntries),
              }
            : {
                outcome: classifySnapshotFailure(permissionsResult.reason, { pathname: "/permission" }),
                ids: null,
                byPromptId: null,
              }

        const questions =
          questionsResult.status === "fulfilled" && Array.isArray(questionsResult.value)
            ? {
                outcome: "ok",
                byId: new Map(
                  questionEntries
                    .filter((entry) => typeof entry?.id === "string" && entry.id)
                    .map((entry) => [promptIdentity(entry.id, entry.sessionID), entry]),
                ),
                byPromptId: buildPromptEntryIndex(questionEntries),
              }
            : {
                outcome: classifySnapshotFailure(questionsResult.reason, { pathname: "/question" }),
                byId: null,
                byPromptId: null,
              }

        if (permissions.outcome === "ok" || questions.outcome === "ok") {
          markProjectUp(projectAlias)
        }
        return { permissions, questions }
      })
      livePromptSnapshotByProject.set(projectAlias, promise)
    }
    return promise
  }

  async function restorePendingPromptState() {
    const summary = createSummary()
    const pending = store.getPendingPrompts?.() || store.get().pendingPrompts || {}

    function record(projectAlias, outcome) {
      recordPromptRecovery?.(projectAlias, outcome)
    }

    function hasLedgerPrefix(prefix) {
      return !!prefix && typeof store?.hasIdempotencyKeyPrefix === "function" && store.hasIdempotencyKeyPrefix(prefix)
    }

    function hasHandledPermission(projectAlias, sessionID, permissionId) {
      return hasLedgerPrefix(permissionReplyIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
        hasLedgerPrefix(permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId))
    }

    function hasHandledQuestion(projectAlias, sessionID, questionId) {
      return hasLedgerPrefix(questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId)) ||
        store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, sessionID, questionId))
    }

    function uniquePendingPromptSession(records, projectAlias, promptId) {
      const sessions = new Set()
      for (const entry of Object.values(records || {})) {
        if (entry?.projectAlias !== projectAlias) continue
        const entryId = entry?.permissionId || entry?.id || entry?.request?.id
        if (entryId !== promptId) continue
        sessions.add(String(entry.sessionID || "").trim())
      }
      return sessions.size === 1 ? [...sessions][0] : ""
    }

    function effectivePendingValueSession(value, records, promptId) {
      return String(value?.sessionID || "").trim() || uniquePendingPromptSession(records, value?.projectAlias, promptId)
    }

    function withEffectiveSession(value, sessionID) {
      return sessionID && !value?.sessionID ? { ...value, sessionID } : value
    }

    async function materializeRecoveredPermission(entry, sessionID) {
      const effectiveEntry = withEffectiveSession(entry, sessionID)
      if (sessionID && !entry?.sessionID) {
        store.setPendingPermission?.(effectiveEntry)
        store.deletePendingPermission?.(entry.projectAlias, entry.permissionId, "")
        await flushStoreIfAvailable()
      }
      return effectiveEntry
    }

    async function materializeRecoveredQuestionWizard(snapshot, wizard, sessionID) {
      if (sessionID && !snapshot?.sessionID) {
        store.setQuestionWizard?.(wizardKey(wizard.projectAlias, wizard.id, sessionID), wizard)
        clearPersistedQuestionWizard(wizard.projectAlias, wizard.id, "")
        await flushStoreIfAvailable()
      }
    }

    async function materializeAwaitingState(ctxKey, setter, value, sessionID) {
      const effectiveValue = withEffectiveSession(value, sessionID)
      if (sessionID && !value?.sessionID) {
        setter(ctxKey, effectiveValue)
        await flushStoreIfAvailable()
      }
      return effectiveValue
    }

    function getRecoveredWizard(projectAlias, requestId, sessionID = "") {
      const expectedSessionID = String(sessionID || "").trim()
      const wizard = questionWizards.get(wizardKey(projectAlias, requestId, expectedSessionID)) || null
      if (!wizard) return null
      return String(wizard.sessionID || "").trim() === expectedSessionID ? wizard : null
    }

    async function materializeLegacyWizard(projectAlias, requestId, sessionID) {
      const effectiveSessionID = String(sessionID || "").trim()
      if (!effectiveSessionID) return null
      const legacy = getRecoveredWizard(projectAlias, requestId, "")
      if (!legacy) return null
      legacy.sessionID = effectiveSessionID
      if (legacy.request && typeof legacy.request === "object") legacy.request = { ...legacy.request, sessionID: effectiveSessionID }
      questionWizards.delete(wizardKey(projectAlias, requestId, ""))
      questionWizards.set(wizardKey(projectAlias, requestId, effectiveSessionID), legacy)
      store.setQuestionWizard?.(wizardKey(projectAlias, requestId, effectiveSessionID), legacy)
      clearPersistedQuestionWizard(projectAlias, requestId, "")
      await flushStoreIfAvailable()
      return legacy
    }

    for (const entry of Object.values(pending.permissions || {})) {
      const ctx = entry?.ctx
      if (!entry?.projectAlias || !entry?.permissionId || !ctx?.chatId || !ctx?.ctxKey) continue
      if (entry.sessionID) {
        const bindingStatus = await promptBindingStatus(ctx.ctxKey, entry.projectAlias, entry.sessionID)
        if (bindingStatus === "retryable") {
          summary.permissions.retryable += 1
          record(entry.projectAlias, "retryable")
          continue
        }
        if (bindingStatus !== "current") {
          store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
          await flushStoreIfAvailable()
          summary.permissions.stale += 1
          recordPromptCleanup?.(entry.projectAlias, "stale")
          record(entry.projectAlias, "stale")
          continue
        }
        if (hasHandledPermission(entry.projectAlias, entry.sessionID, entry.permissionId)) {
          store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
          await flushStoreIfAvailable()
          summary.permissions.stale += 1
          recordPromptCleanup?.(entry.projectAlias, "stale")
          record(entry.projectAlias, "stale")
          continue
        }
      }
      const live = await getLivePromptSnapshot(entry.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        const livePrompt = resolveLivePrompt(permissions, entry.permissionId, entry.sessionID)
        if (!livePrompt.active) {
          store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
          await flushStoreIfAvailable()
          summary.permissions.stale += 1
          recordPromptCleanup?.(entry.projectAlias, "stale")
          record(entry.projectAlias, "stale")
          continue
        }
        const effectiveSessionID = livePrompt.sessionID
        if (!entry.sessionID) {
          const bindingStatus = await promptBindingStatus(ctx.ctxKey, entry.projectAlias, effectiveSessionID)
          if (bindingStatus === "retryable") {
            summary.permissions.retryable += 1
            record(entry.projectAlias, "retryable")
            continue
          }
          if (bindingStatus !== "current") {
            store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
            await flushStoreIfAvailable()
            summary.permissions.stale += 1
            recordPromptCleanup?.(entry.projectAlias, "stale")
            record(entry.projectAlias, "stale")
            continue
          }
          if (hasHandledPermission(entry.projectAlias, effectiveSessionID, entry.permissionId)) {
            store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
            await flushStoreIfAvailable()
            summary.permissions.stale += 1
            recordPromptCleanup?.(entry.projectAlias, "stale")
            record(entry.projectAlias, "stale")
            continue
          }
        }
        const effectiveEntry = await materializeRecoveredPermission(entry, effectiveSessionID)
        try {
          await sendPermissionPrompt(
            effectiveEntry.projectAlias,
            {
              id: effectiveEntry.permissionId,
              sessionID: effectiveEntry.sessionID,
              permission: effectiveEntry.permission,
              patterns: Array.isArray(effectiveEntry.patterns) ? effectiveEntry.patterns : [],
            },
            ctx,
          )
        } catch {
          summary.permissions.retryable += 1
          record(entry.projectAlias, "retryable")
            continue
          }
        prompted[effectiveEntry.projectAlias]?.permission.add(promptIdentity(effectiveEntry.permissionId, effectiveEntry.sessionID))
        summary.permissions.restored += 1
        record(effectiveEntry.projectAlias, "restored")
        continue
      }

      const bindingStatus = await promptBindingStatus(ctx.ctxKey, entry.projectAlias, entry.sessionID)
      if (bindingStatus === "retryable") {
        summary.permissions.retryable += 1
        record(entry.projectAlias, "retryable")
        continue
      }
      if (bindingStatus !== "current") {
        store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
        await flushStoreIfAvailable()
        summary.permissions.stale += 1
        recordPromptCleanup?.(entry.projectAlias, "stale")
        record(entry.projectAlias, "stale")
        continue
      }
      if (hasHandledPermission(entry.projectAlias, entry.sessionID, entry.permissionId)) {
        store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
        await flushStoreIfAvailable()
        summary.permissions.stale += 1
        recordPromptCleanup?.(entry.projectAlias, "stale")
        record(entry.projectAlias, "stale")
        continue
      }

      summary.permissions[permissions.outcome] += 1
      record(entry.projectAlias, permissions.outcome)
    }

    for (const snapshot of Object.values(pending.questionWizards || {})) {
      const ctx = snapshot?.ctx
      if (!snapshot?.projectAlias || !snapshot?.id || !ctx?.chatId || !ctx?.ctxKey) continue
      if (snapshot.sessionID) {
        const bindingStatus = await promptBindingStatus(ctx.ctxKey, snapshot.projectAlias, snapshot.sessionID)
        if (bindingStatus === "retryable") {
          questionWizards.set(wizardKey(snapshot.projectAlias, snapshot.id, snapshot.sessionID), buildWizardFromSnapshot({ ...snapshot, ctx }))
          summary.questionWizards.retryable += 1
          record(snapshot.projectAlias, "retryable")
          continue
        }
        if (bindingStatus !== "current") {
          clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
          await flushStoreIfAvailable()
          summary.questionWizards.stale += 1
          recordPromptCleanup?.(snapshot.projectAlias, "stale")
          record(snapshot.projectAlias, "stale")
          continue
        }
        if (hasHandledQuestion(snapshot.projectAlias, snapshot.sessionID, snapshot.id)) {
          clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
          await flushStoreIfAvailable()
          summary.questionWizards.stale += 1
          recordPromptCleanup?.(snapshot.projectAlias, "stale")
          record(snapshot.projectAlias, "stale")
          continue
        }
      }
      const live = await getLivePromptSnapshot(snapshot.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        const livePrompt = resolveLivePrompt(questions, snapshot.id, snapshot.sessionID)
        if (!livePrompt.active) {
          clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
          await flushStoreIfAvailable()
          summary.questionWizards.stale += 1
          recordPromptCleanup?.(snapshot.projectAlias, "stale")
          record(snapshot.projectAlias, "stale")
          continue
        }
        const effectiveSessionID = livePrompt.sessionID
        if (!snapshot.sessionID) {
          const bindingStatus = await promptBindingStatus(ctx.ctxKey, snapshot.projectAlias, effectiveSessionID)
          if (bindingStatus === "retryable") {
            const retryableSnapshot = withQuestionSession({ ...snapshot, ctx }, effectiveSessionID)
            questionWizards.set(wizardKey(retryableSnapshot.projectAlias, retryableSnapshot.id, retryableSnapshot.sessionID), buildWizardFromSnapshot(retryableSnapshot))
            summary.questionWizards.retryable += 1
            record(snapshot.projectAlias, "retryable")
            continue
          }
          if (bindingStatus !== "current") {
            clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
            await flushStoreIfAvailable()
            summary.questionWizards.stale += 1
            recordPromptCleanup?.(snapshot.projectAlias, "stale")
            record(snapshot.projectAlias, "stale")
            continue
          }
          if (hasHandledQuestion(snapshot.projectAlias, effectiveSessionID, snapshot.id)) {
            clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
            await flushStoreIfAvailable()
            summary.questionWizards.stale += 1
            recordPromptCleanup?.(snapshot.projectAlias, "stale")
            record(snapshot.projectAlias, "stale")
            continue
          }
        }

        const effectiveSnapshot = withQuestionSession({ ...snapshot, ctx }, effectiveSessionID)
        const wizard = buildWizardFromSnapshot(effectiveSnapshot, { request: requestWithSession(livePrompt.entry || snapshot.request, effectiveSessionID) })
        questionWizards.set(wizardKey(wizard.projectAlias, wizard.id, wizard.sessionID), wizard)
        await materializeRecoveredQuestionWizard(snapshot, wizard, effectiveSessionID)
        try {
          const locale = wizard.ctx?.locale || config?.i18n?.defaultLocale || "en"
          await sendBlocksToThread(wizard.ctx, [
            {
              type: "text",
              html: `<b>${escapeHtml(translate(locale, "prompts.questionRequestResumed"))}</b>\n<code>${escapeHtml(wizard.id)}</code>\n\n${escapeHtml(translate(locale, "prompts.project", { project: wizard.projectAlias }))}`,
            },
          ])
          await sendCurrentQuestionStep(wizard)
        } catch {
          summary.questionWizards.retryable += 1
          record(snapshot.projectAlias, "retryable")
            continue
          }
        prompted[snapshot.projectAlias]?.question.add(promptIdentity(snapshot.id, effectiveSessionID))
        summary.questionWizards.restored += 1
        record(snapshot.projectAlias, "restored")
        continue
      }

      const bindingStatus = await promptBindingStatus(ctx.ctxKey, snapshot.projectAlias, snapshot.sessionID)
      if (bindingStatus === "retryable") {
        questionWizards.set(wizardKey(snapshot.projectAlias, snapshot.id, snapshot.sessionID), buildWizardFromSnapshot({ ...snapshot, ctx }))
        summary.questionWizards.retryable += 1
        record(snapshot.projectAlias, "retryable")
        continue
      }
      if (bindingStatus !== "current") {
        clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
        await flushStoreIfAvailable()
        summary.questionWizards.stale += 1
        recordPromptCleanup?.(snapshot.projectAlias, "stale")
        record(snapshot.projectAlias, "stale")
        continue
      }
      if (hasHandledQuestion(snapshot.projectAlias, snapshot.sessionID, snapshot.id)) {
        clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
        await flushStoreIfAvailable()
        summary.questionWizards.stale += 1
        recordPromptCleanup?.(snapshot.projectAlias, "stale")
        record(snapshot.projectAlias, "stale")
        continue
      }

      if (questions.outcome === "retryable") {
        prompted[snapshot.projectAlias]?.question.add(promptIdentity(snapshot.id, snapshot.sessionID))
        questionWizards.set(
          wizardKey(snapshot.projectAlias, snapshot.id, snapshot.sessionID),
          buildWizardFromSnapshot({ ...snapshot, ctx }),
        )
      }

      summary.questionWizards[questions.outcome] += 1
      record(snapshot.projectAlias, questions.outcome)
    }

    for (const [ctxKey, value] of Object.entries(pending.rejectNotes || {})) {
      if (!value?.projectAlias || !value?.permissionId) continue
      const initialSessionID = effectivePendingValueSession(value, pending.permissions, value.permissionId)
      if (initialSessionID) {
        const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, initialSessionID)
        if (bindingStatus === "retryable") {
          setRejectNoteAwaitingState(ctxKey, withEffectiveSession(value, initialSessionID))
          summary.rejectNotes.retryable += 1
          record(value.projectAlias, "retryable")
          continue
        }
        if (bindingStatus !== "current") {
          setRejectNoteAwaitingState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.rejectNotes.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
        if (hasHandledPermission(value.projectAlias, initialSessionID, value.permissionId)) {
          setRejectNoteAwaitingState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.rejectNotes.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
      }
      const live = await getLivePromptSnapshot(value.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        const livePrompt = resolveLivePrompt(permissions, value.permissionId, initialSessionID)
        if (!livePrompt.active) {
          setRejectNoteAwaitingState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.rejectNotes.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
        const effectiveSessionID = livePrompt.sessionID
        if (!initialSessionID) {
          const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, effectiveSessionID)
          if (bindingStatus === "retryable") {
            setRejectNoteAwaitingState(ctxKey, withEffectiveSession(value, effectiveSessionID))
            summary.rejectNotes.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
          if (bindingStatus !== "current") {
            setRejectNoteAwaitingState(ctxKey, null)
            await flushStoreIfAvailable()
            summary.rejectNotes.stale += 1
            recordPromptCleanup?.(value.projectAlias, "stale")
            record(value.projectAlias, "stale")
            continue
          }
          if (hasHandledPermission(value.projectAlias, effectiveSessionID, value.permissionId)) {
            setRejectNoteAwaitingState(ctxKey, null)
            await flushStoreIfAvailable()
            summary.rejectNotes.stale += 1
            recordPromptCleanup?.(value.projectAlias, "stale")
            record(value.projectAlias, "stale")
            continue
          }
        }
        const effectiveValue = await materializeAwaitingState(ctxKey, setRejectNoteAwaitingState, value, effectiveSessionID)

        const bindingCtx = parseCtxKey(ctxKey)
        if (bindingCtx?.chatId) {
          try {
            await sendRejectNotePrompt(bindingCtx, value.projectAlias, value.permissionId, { resumed: true, sessionID: effectiveSessionID })
          } catch {
            summary.rejectNotes.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
        }
        setRejectNoteAwaitingState(ctxKey, effectiveValue)
        summary.rejectNotes.restored += 1
        record(value.projectAlias, "restored")
        continue
      }

      const effectiveSessionID = effectivePendingValueSession(value, pending.permissions, value.permissionId)
      const effectiveValue = withEffectiveSession(value, effectiveSessionID)
      const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, effectiveSessionID)
      if (bindingStatus === "retryable") {
        setRejectNoteAwaitingState(ctxKey, effectiveValue)
        summary.rejectNotes.retryable += 1
        record(value.projectAlias, "retryable")
        continue
      }
      if (bindingStatus !== "current") {
        setRejectNoteAwaitingState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.rejectNotes.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }
      if (hasHandledPermission(value.projectAlias, effectiveSessionID, value.permissionId)) {
        setRejectNoteAwaitingState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.rejectNotes.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }

      if (permissions.outcome === "retryable") {
        setRejectNoteAwaitingState(ctxKey, effectiveValue)
      }

      summary.rejectNotes[permissions.outcome] += 1
      record(value.projectAlias, permissions.outcome)
    }

    for (const [ctxKey, value] of Object.entries(pending.customAnswers || {})) {
      if (!value?.projectAlias || !value?.requestId || !Number.isInteger(value?.qIndex)) continue
      const initialSessionID = effectivePendingValueSession(value, pending.questionWizards, value.requestId)
      if (initialSessionID) {
        const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, initialSessionID)
        if (bindingStatus === "retryable") {
          setAwaitingCustomAnswerState(ctxKey, withEffectiveSession(value, initialSessionID))
          summary.customAnswers.retryable += 1
          record(value.projectAlias, "retryable")
          continue
        }
        if (bindingStatus !== "current") {
          setAwaitingCustomAnswerState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
        if (hasHandledQuestion(value.projectAlias, initialSessionID, value.requestId)) {
          setAwaitingCustomAnswerState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
      }
      const live = await getLivePromptSnapshot(value.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        const livePrompt = resolveLivePrompt(questions, value.requestId, initialSessionID)
        if (!livePrompt.active) {
          setAwaitingCustomAnswerState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
        const effectiveSessionID = livePrompt.sessionID
        if (!initialSessionID) {
          const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, effectiveSessionID)
          if (bindingStatus === "retryable") {
            setAwaitingCustomAnswerState(ctxKey, withEffectiveSession(value, effectiveSessionID))
            summary.customAnswers.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
          if (bindingStatus !== "current") {
            setAwaitingCustomAnswerState(ctxKey, null)
            await flushStoreIfAvailable()
            summary.customAnswers.stale += 1
            recordPromptCleanup?.(value.projectAlias, "stale")
            record(value.projectAlias, "stale")
            continue
          }
          if (hasHandledQuestion(value.projectAlias, effectiveSessionID, value.requestId)) {
            setAwaitingCustomAnswerState(ctxKey, null)
            await flushStoreIfAvailable()
            summary.customAnswers.stale += 1
            recordPromptCleanup?.(value.projectAlias, "stale")
            record(value.projectAlias, "stale")
            continue
          }
        }

        const wizard = getRecoveredWizard(value.projectAlias, value.requestId, effectiveSessionID) || (await materializeLegacyWizard(value.projectAlias, value.requestId, effectiveSessionID))
        const question = wizard?.request?.questions?.[value.qIndex]
        if (!wizard || !question) {
          setAwaitingCustomAnswerState(ctxKey, null)
          await flushStoreIfAvailable()
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }
        const effectiveValue = await materializeAwaitingState(ctxKey, setAwaitingCustomAnswerState, value, effectiveSessionID)

        const label = wizard.request?.questions?.[value.qIndex]?.header || "question"
        const bindingCtx = parseCtxKey(ctxKey)
        if (bindingCtx?.chatId) {
          try {
            await sendQuestionCustomAnswerPrompt(bindingCtx, value.projectAlias, value.requestId, value.qIndex, label, { resumed: true, sessionID: effectiveSessionID })
          } catch {
            summary.customAnswers.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
        }
        setAwaitingCustomAnswerState(ctxKey, effectiveValue)
        summary.customAnswers.restored += 1
        record(value.projectAlias, "restored")
        continue
      }

      const effectiveSessionID = effectivePendingValueSession(value, pending.questionWizards, value.requestId)
      const effectiveValue = withEffectiveSession(value, effectiveSessionID)
      const bindingStatus = await promptBindingStatus(ctxKey, value.projectAlias, effectiveSessionID)
      if (bindingStatus === "retryable") {
        setAwaitingCustomAnswerState(ctxKey, effectiveValue)
        summary.customAnswers.retryable += 1
        record(value.projectAlias, "retryable")
        continue
      }
      if (bindingStatus !== "current") {
        setAwaitingCustomAnswerState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.customAnswers.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }
      if (hasHandledQuestion(value.projectAlias, effectiveSessionID, value.requestId)) {
        setAwaitingCustomAnswerState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.customAnswers.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }

      if (questions.outcome === "retryable") {
        const wizard = getRecoveredWizard(value.projectAlias, value.requestId, effectiveSessionID)
        const question = wizard?.request?.questions?.[value.qIndex]
        if (wizard && question) {
          setAwaitingCustomAnswerState(ctxKey, effectiveValue)
        }
      }

      summary.customAnswers[questions.outcome] += 1
      record(value.projectAlias, questions.outcome)
    }

    return { ...summary, totals: summarizeTotals(summary) }
  }

  return {
    getLivePromptSnapshot,
    restorePendingPromptState,
  }
}
