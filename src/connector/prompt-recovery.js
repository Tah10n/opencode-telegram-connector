import { classifyBoundaryError } from "../boundary-errors.js"
import { escapeHtml } from "../telegram/formatter.js"
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

export function createPromptRecovery(runtime) {
  const {
    store,
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
  } = runtime

  const livePromptSnapshotByProject = new Map()

  function isPromptBindingCurrent(ctxKey, projectAlias, sessionID = "") {
    const binding = typeof store?.getBinding === "function" ? store.getBinding(ctxKey) : null
    if (!binding || binding.projectAlias !== projectAlias) return false
    return !sessionID || binding.sessionId === sessionID
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
        const permissions =
          permissionsResult.status === "fulfilled" && Array.isArray(permissionsResult.value)
            ? {
                outcome: "ok",
                ids: new Set(
                  permissionsResult.value.flatMap((entry) => [promptIdentity(entry?.id, entry?.sessionID), promptIdentity(entry?.id)]).filter((id) => typeof id === "string" && id),
                ),
              }
            : {
                outcome: classifySnapshotFailure(permissionsResult.reason, { pathname: "/permission" }),
                ids: null,
              }

        const questions =
          questionsResult.status === "fulfilled" && Array.isArray(questionsResult.value)
            ? {
                outcome: "ok",
                byId: new Map(
                  questionsResult.value
                    .filter((entry) => typeof entry?.id === "string" && entry.id)
                    .flatMap((entry) => [[promptIdentity(entry.id, entry.sessionID), entry], [promptIdentity(entry.id), entry]]),
                ),
              }
            : {
                outcome: classifySnapshotFailure(questionsResult.reason, { pathname: "/question" }),
                byId: null,
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
        hasLedgerPrefix(permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
        hasLedgerPrefix(permissionReplyIdempotencyPrefix(projectAlias, "", permissionId)) ||
        hasLedgerPrefix(permissionNoteIdempotencyPrefix(projectAlias, "", permissionId))
    }

    function hasHandledQuestion(projectAlias, sessionID, questionId) {
      return hasLedgerPrefix(questionReplyIdempotencyPrefix(projectAlias, sessionID, questionId)) ||
        store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, sessionID, questionId)) ||
        hasLedgerPrefix(questionReplyIdempotencyPrefix(projectAlias, "", questionId)) ||
        store.hasIdempotencyKey?.(questionRejectIdempotencyKey(projectAlias, "", questionId))
    }

    function liveHasPrompt(collection, promptId, sessionID) {
      if (sessionID) return collection.has(promptIdentity(promptId, sessionID))
      return collection.has(promptIdentity(promptId))
    }

    function getRecoveredWizard(projectAlias, requestId, sessionID = "") {
      const scopedWizard = questionWizards.get(wizardKey(projectAlias, requestId, sessionID))
      if (scopedWizard || sessionID) return scopedWizard || null
      return questionWizards.get(wizardKey(projectAlias, requestId)) ||
        [...questionWizards.values()].find((wizard) => wizard?.projectAlias === projectAlias && (wizard?.id || wizard?.request?.id) === requestId) ||
        null
    }

    for (const entry of Object.values(pending.permissions || {})) {
      const ctx = entry?.ctx
      if (!entry?.projectAlias || !entry?.permissionId || !ctx?.chatId || !ctx?.ctxKey) continue
      if (!isPromptBindingCurrent(ctx.ctxKey, entry.projectAlias, entry.sessionID)) {
        store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
        await flushStoreIfAvailable()
        summary.permissions.stale += 1
        recordPromptCleanup?.(entry.projectAlias, "stale")
        record(entry.projectAlias, "stale")
        continue
      }
      if (hasHandledPermission(entry.projectAlias, entry.sessionID, entry.permissionId)) {
        store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
        summary.permissions.stale += 1
        recordPromptCleanup?.(entry.projectAlias, "stale")
        record(entry.projectAlias, "stale")
        continue
      }

      const live = await getLivePromptSnapshot(entry.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        if (!liveHasPrompt(permissions.ids, entry.permissionId, entry.sessionID)) {
          store.deletePendingPermission(entry.projectAlias, entry.permissionId, entry.sessionID)
          summary.permissions.stale += 1
          recordPromptCleanup?.(entry.projectAlias, "stale")
          record(entry.projectAlias, "stale")
          continue
        }
        try {
          await sendPermissionPrompt(
            entry.projectAlias,
            {
              id: entry.permissionId,
              sessionID: entry.sessionID,
              permission: entry.permission,
              patterns: Array.isArray(entry.patterns) ? entry.patterns : [],
            },
            ctx,
          )
        } catch {
          summary.permissions.retryable += 1
          record(entry.projectAlias, "retryable")
          continue
        }
        prompted[entry.projectAlias]?.permission.add(promptIdentity(entry.permissionId, entry.sessionID))
        summary.permissions.restored += 1
        record(entry.projectAlias, "restored")
        continue
      }

      summary.permissions[permissions.outcome] += 1
      record(entry.projectAlias, permissions.outcome)
    }

    for (const snapshot of Object.values(pending.questionWizards || {})) {
      const ctx = snapshot?.ctx
      if (!snapshot?.projectAlias || !snapshot?.id || !ctx?.chatId || !ctx?.ctxKey) continue
      if (!isPromptBindingCurrent(ctx.ctxKey, snapshot.projectAlias, snapshot.sessionID)) {
        clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
        await flushStoreIfAvailable()
        summary.questionWizards.stale += 1
        recordPromptCleanup?.(snapshot.projectAlias, "stale")
        record(snapshot.projectAlias, "stale")
        continue
      }
      if (hasHandledQuestion(snapshot.projectAlias, snapshot.sessionID, snapshot.id)) {
        clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
        summary.questionWizards.stale += 1
        recordPromptCleanup?.(snapshot.projectAlias, "stale")
        record(snapshot.projectAlias, "stale")
        continue
      }

      const live = await getLivePromptSnapshot(snapshot.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        const liveQuestion = questions.byId.get(promptIdentity(snapshot.id, snapshot.sessionID)) || (!snapshot.sessionID ? questions.byId.get(promptIdentity(snapshot.id)) : null)
        if (!liveQuestion) {
          clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id, snapshot.sessionID)
          summary.questionWizards.stale += 1
          recordPromptCleanup?.(snapshot.projectAlias, "stale")
          record(snapshot.projectAlias, "stale")
          continue
        }

        const wizard = buildWizardFromSnapshot({ ...snapshot, ctx }, { request: liveQuestion || snapshot.request })
        questionWizards.set(wizardKey(wizard.projectAlias, wizard.id, wizard.sessionID), wizard)
        try {
          await sendBlocksToThread(wizard.ctx, [
            {
              type: "text",
              html: `<b>Question request resumed</b>\n<code>${escapeHtml(wizard.id)}</code>\n\n${escapeHtml(`Project: ${wizard.projectAlias}`)}`,
            },
          ])
          await sendCurrentQuestionStep(wizard)
        } catch {
          summary.questionWizards.retryable += 1
          record(snapshot.projectAlias, "retryable")
          continue
        }
        prompted[snapshot.projectAlias]?.question.add(promptIdentity(snapshot.id, snapshot.sessionID))
        summary.questionWizards.restored += 1
        record(snapshot.projectAlias, "restored")
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
      if (!isPromptBindingCurrent(ctxKey, value.projectAlias, value.sessionID)) {
        setRejectNoteAwaitingState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.rejectNotes.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }
      if (hasHandledPermission(value.projectAlias, value.sessionID, value.permissionId)) {
        setRejectNoteAwaitingState(ctxKey, null)
        summary.rejectNotes.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }

      const live = await getLivePromptSnapshot(value.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        if (!liveHasPrompt(permissions.ids, value.permissionId, value.sessionID)) {
          setRejectNoteAwaitingState(ctxKey, null)
          summary.rejectNotes.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }

        const bindingCtx = parseCtxKey(ctxKey)
        if (bindingCtx?.chatId) {
          try {
            await sendRejectNotePrompt(bindingCtx, value.projectAlias, value.permissionId, { resumed: true, sessionID: value.sessionID })
          } catch {
            summary.rejectNotes.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
        }
        setRejectNoteAwaitingState(ctxKey, value)
        summary.rejectNotes.restored += 1
        record(value.projectAlias, "restored")
        continue
      }

      if (permissions.outcome === "retryable") {
        setRejectNoteAwaitingState(ctxKey, value)
      }

      summary.rejectNotes[permissions.outcome] += 1
      record(value.projectAlias, permissions.outcome)
    }

    for (const [ctxKey, value] of Object.entries(pending.customAnswers || {})) {
      if (!value?.projectAlias || !value?.requestId || !Number.isInteger(value?.qIndex)) continue
      if (!isPromptBindingCurrent(ctxKey, value.projectAlias, value.sessionID)) {
        setAwaitingCustomAnswerState(ctxKey, null)
        await flushStoreIfAvailable()
        summary.customAnswers.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }
      if (hasHandledQuestion(value.projectAlias, value.sessionID, value.requestId)) {
        setAwaitingCustomAnswerState(ctxKey, null)
        summary.customAnswers.stale += 1
        recordPromptCleanup?.(value.projectAlias, "stale")
        record(value.projectAlias, "stale")
        continue
      }

      const live = await getLivePromptSnapshot(value.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        if (!questions.byId.has(promptIdentity(value.requestId, value.sessionID)) && (value.sessionID || !questions.byId.has(promptIdentity(value.requestId)))) {
          setAwaitingCustomAnswerState(ctxKey, null)
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }

        const wizard = getRecoveredWizard(value.projectAlias, value.requestId, value.sessionID)
        const question = wizard?.request?.questions?.[value.qIndex]
        if (!wizard || !question) {
          setAwaitingCustomAnswerState(ctxKey, null)
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }

        const label = wizard.request?.questions?.[value.qIndex]?.header || "question"
        const bindingCtx = parseCtxKey(ctxKey)
        if (bindingCtx?.chatId) {
          try {
            await sendQuestionCustomAnswerPrompt(bindingCtx, value.projectAlias, value.requestId, value.qIndex, label, { resumed: true, sessionID: value.sessionID })
          } catch {
            summary.customAnswers.retryable += 1
            record(value.projectAlias, "retryable")
            continue
          }
        }
        setAwaitingCustomAnswerState(ctxKey, value)
        summary.customAnswers.restored += 1
        record(value.projectAlias, "restored")
        continue
      }

      if (questions.outcome === "retryable") {
        const wizard = getRecoveredWizard(value.projectAlias, value.requestId, value.sessionID)
        const question = wizard?.request?.questions?.[value.qIndex]
        if (wizard && question) {
          setAwaitingCustomAnswerState(ctxKey, value)
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
