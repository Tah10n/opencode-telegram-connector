import { classifyBoundaryError } from "../boundary-errors.js"
import { escapeHtml } from "../telegram/formatter.js"

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
                  permissionsResult.value.map((entry) => entry?.id).filter((id) => typeof id === "string" && id),
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
                    .map((entry) => [entry.id, entry]),
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

    for (const entry of Object.values(pending.permissions || {})) {
      const ctx = entry?.ctx
      if (!entry?.projectAlias || !entry?.permissionId || !ctx?.chatId || !ctx?.ctxKey) continue

      const live = await getLivePromptSnapshot(entry.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        if (!permissions.ids.has(entry.permissionId)) {
          store.deletePendingPermission(entry.projectAlias, entry.permissionId)
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
        prompted[entry.projectAlias]?.permission.add(entry.permissionId)
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

      const live = await getLivePromptSnapshot(snapshot.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        const liveQuestion = questions.byId.get(snapshot.id)
        if (!liveQuestion) {
          clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id)
          summary.questionWizards.stale += 1
          recordPromptCleanup?.(snapshot.projectAlias, "stale")
          record(snapshot.projectAlias, "stale")
          continue
        }

        const wizard = buildWizardFromSnapshot({ ...snapshot, ctx }, { request: liveQuestion || snapshot.request })
        questionWizards.set(wizardKey(wizard.projectAlias, wizard.id), wizard)
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
        prompted[snapshot.projectAlias]?.question.add(snapshot.id)
        summary.questionWizards.restored += 1
        record(snapshot.projectAlias, "restored")
        continue
      }

      if (questions.outcome === "retryable") {
        prompted[snapshot.projectAlias]?.question.add(snapshot.id)
        questionWizards.set(
          wizardKey(snapshot.projectAlias, snapshot.id),
          buildWizardFromSnapshot({ ...snapshot, ctx }),
        )
      }

      summary.questionWizards[questions.outcome] += 1
      record(snapshot.projectAlias, questions.outcome)
    }

    for (const [ctxKey, value] of Object.entries(pending.rejectNotes || {})) {
      if (!value?.projectAlias || !value?.permissionId) continue

      const live = await getLivePromptSnapshot(value.projectAlias)
      const permissions = live.permissions
      if (permissions.outcome === "ok") {
        if (!permissions.ids.has(value.permissionId)) {
          setRejectNoteAwaitingState(ctxKey, null)
          summary.rejectNotes.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }

        const bindingCtx = parseCtxKey(ctxKey)
        if (bindingCtx?.chatId) {
          try {
            await sendRejectNotePrompt(bindingCtx, value.projectAlias, value.permissionId, { resumed: true })
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

      const live = await getLivePromptSnapshot(value.projectAlias)
      const questions = live.questions
      if (questions.outcome === "ok") {
        if (!questions.byId.has(value.requestId)) {
          setAwaitingCustomAnswerState(ctxKey, null)
          summary.customAnswers.stale += 1
          recordPromptCleanup?.(value.projectAlias, "stale")
          record(value.projectAlias, "stale")
          continue
        }

        const wizard = questionWizards.get(wizardKey(value.projectAlias, value.requestId)) || null
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
            await sendQuestionCustomAnswerPrompt(bindingCtx, value.projectAlias, value.requestId, value.qIndex, label, { resumed: true })
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
        const wizard = questionWizards.get(wizardKey(value.projectAlias, value.requestId)) || null
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
