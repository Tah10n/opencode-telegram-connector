import { makeInlineKeyboard } from "../telegram/client.js"
import { escapeHtml } from "../telegram/formatter.js"
import { ctxKeyFrom } from "../telegram/routing.js"
import { promptKey } from "../state/store.js"
import { isRetryableBoundaryError, isStaleBoundaryError, makeBoundaryError } from "../boundary-errors.js"
import {
  permissionNoteIdempotencyPrefix,
  permissionReplyIdempotencyPrefix,
  promptIdentity,
  questionRejectIdempotencyKey,
  questionReplyIdempotencyKey,
  questionReplyIdempotencyPrefix,
} from "./idempotency.js"
import { callbackPacker } from "./callback-data.js"

export function createPromptHandlers(runtime) {
  const {
    store,
    tg,
    cb,
    ocByAlias,
    promptBaseline,
    prompted,
    questionWizards,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    sendToThread,
    sendBlocksToThread,
    parseCtxKey,
    clampString,
    markProjectUp,
    recordPromptDelivered,
    recordPromptAnswered,
  } = runtime
  const packCallback = callbackPacker(cb)

  const wizardKey = (projectAlias, requestId, sessionID = "") => promptKey(projectAlias, requestId, sessionID)
  const initialPendingPrompts = JSON.parse(JSON.stringify(store.getPendingPrompts?.() || store.get?.().pendingPrompts || {}))
  const getWizard = (projectAlias, requestId, sessionID = "") => {
    if (sessionID) return questionWizards.get(wizardKey(projectAlias, requestId, sessionID)) || null
    return questionWizards.get(wizardKey(projectAlias, requestId)) || [...questionWizards.values()].find((wizard) => wizard?.projectAlias === projectAlias && (wizard?.id || wizard?.request?.id) === requestId) || null
  }
  function persistQuestionWizard(wizard) {
    store.setQuestionWizard(wizardKey(wizard.projectAlias, wizard.request.id, wizard.sessionID), wizard)
  }

  function clearPersistedQuestionWizard(projectAlias, requestId, sessionID = "") {
    store.deleteQuestionWizard(wizardKey(projectAlias, requestId, sessionID))
    if (!sessionID) store.deleteQuestionWizard(wizardKey(projectAlias, requestId))
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  function hasIdempotencyPrefix(prefix) {
    return !!prefix && typeof store?.hasIdempotencyKeyPrefix === "function" && store.hasIdempotencyKeyPrefix(prefix)
  }

  function collectPendingPromptIdentities(projectAlias, pending = store.getPendingPrompts?.() || store.get?.().pendingPrompts || {}) {
    const permissions = new Set()
    const questions = new Set()
    for (const entry of Object.values(pending.permissions || {})) {
      if (entry?.projectAlias === projectAlias) {
        const identity = promptIdentity(entry.permissionId, entry.sessionID)
        if (identity) permissions.add(identity)
      }
    }
    for (const entry of Object.values(pending.rejectNotes || {})) {
      if (entry?.projectAlias === projectAlias) {
        const identity = promptIdentity(entry.permissionId, entry.sessionID)
        if (identity) permissions.add(identity)
      }
    }
    for (const entry of Object.values(pending.questionWizards || {})) {
      if (entry?.projectAlias === projectAlias) {
        const identity = promptIdentity(entry.id || entry.request?.id, entry.sessionID)
        if (identity) questions.add(identity)
      }
    }
    for (const entry of Object.values(pending.customAnswers || {})) {
      if (entry?.projectAlias === projectAlias) {
        const identity = promptIdentity(entry.requestId, entry.sessionID)
        if (identity) questions.add(identity)
      }
    }
    return { permissions, questions }
  }

  async function markIdempotencyKey(key, metadata = {}) {
    if (!key) return false
    if (typeof store?.markIdempotencyKey === "function") {
      return store.markIdempotencyKey(key, metadata)
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      try {
        return await store.markIdempotencyKeyAndFlush(key, metadata)
      } catch (err) {
        throw makeStateDurabilityError(err, "persist question idempotency")
      }
    }
    return false
  }

  async function markIdempotencyEntries(entries = []) {
    for (const entry of entries) {
      if (!entry?.key) continue
      await markIdempotencyKey(entry.key, entry.metadata || {})
    }
  }

  function deleteIdempotencyEntries(entries = []) {
    if (typeof store?.deleteIdempotencyKey !== "function") return
    for (const entry of entries) {
      if (entry?.key) store.deleteIdempotencyKey(entry.key)
    }
  }

  function makeStateDurabilityError(err, operation) {
    return makeBoundaryError({
      source: "state",
      operation,
      kind: "durability",
      outcome: "retryable",
      message: `${operation} failed: ${err?.message || String(err)}`,
      cause: err,
    })
  }

  async function flushDurableState(operation) {
    if (typeof store?.flush !== "function") return
    try {
      await store.flush()
    } catch (err) {
      throw makeStateDurabilityError(err, operation)
    }
  }

  function clearQuestionWizardState(wizard) {
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id, wizard.sessionID))
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
    clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id, wizard.sessionID)
    setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
  }

  async function clearQuestionWizardStateDurably(wizard, operation, { rollbackIdempotencyEntries = [] } = {}) {
    const key = wizardKey(wizard.projectAlias, wizard.request.id, wizard.sessionID)
    const ctxKey = wizard.ctx?.ctxKey
    const hadAwaiting = !!ctxKey && awaitingCustomAnswer.has(ctxKey)
    const previousAwaiting = hadAwaiting ? awaitingCustomAnswer.get(ctxKey) : null

    clearQuestionWizardState(wizard)
    try {
      await flushDurableState(operation)
    } catch (err) {
      questionWizards.set(key, wizard)
      persistQuestionWizard(wizard)
      if (hadAwaiting) setAwaitingCustomAnswerState(ctxKey, previousAwaiting)
      deleteIdempotencyEntries(rollbackIdempotencyEntries)
      throw err
    }
  }

  function setRejectNoteAwaitingState(ctxKey, value) {
    if (value) {
      rejectNoteAwaiting.set(ctxKey, value)
      store.setRejectNoteAwaiting(ctxKey, value)
      return
    }
    rejectNoteAwaiting.delete(ctxKey)
    store.deleteRejectNoteAwaiting(ctxKey)
  }

  function setAwaitingCustomAnswerState(ctxKey, value) {
    if (value) {
      awaitingCustomAnswer.set(ctxKey, value)
      store.setAwaitingCustomAnswer(ctxKey, value)
      return
    }
    awaitingCustomAnswer.delete(ctxKey)
    store.deleteAwaitingCustomAnswer(ctxKey)
  }

  function cloneWizardState(wizard, overrides = {}) {
    return {
      ...wizard,
      answers: Array.isArray(wizard.answers) ? wizard.answers.map((entry) => (Array.isArray(entry) ? [...entry] : [])) : [],
      selectedByIndex:
        wizard.selectedByIndex && typeof wizard.selectedByIndex === "object"
          ? Object.fromEntries(
              Object.entries(wizard.selectedByIndex).map(([idx, selected]) => [idx, Array.isArray(selected) ? [...selected] : []]),
            )
          : {},
      messageIdByIndex:
        wizard.messageIdByIndex && typeof wizard.messageIdByIndex === "object"
          ? { ...wizard.messageIdByIndex }
          : {},
      ...overrides,
    }
  }

  function applyWizardState(target, source) {
    target.index = source.index
    target.answers = source.answers
    target.selectedByIndex = source.selectedByIndex
    target.messageIdByIndex = source.messageIdByIndex
  }

  function renderQuestionStep(projectAlias, req, stepIndex, selectedLabels) {
    const q = req.questions[stepIndex]
    const total = req.questions.length
    const multiple = q.multiple === true
    const allowCustom = q.custom !== false

    const header = q.header ? `${q.header}` : `Question ${stepIndex + 1}/${total}`
    const lines = []
    lines.push(`${header} (${stepIndex + 1}/${total})`)
    lines.push(q.question)
    lines.push("")
    lines.push("Options:")
    q.options.forEach((opt, idx) => {
      const label = String(opt.label)
      const desc = String(opt.description || "").trim()
      const descPart = desc ? ` — ${clampString(desc, 160)}` : ""
      lines.push(`${idx + 1}) ${label}${descPart}`)
    })
    lines.push("")
    lines.push(multiple ? "Select any options, then press Done." : "Select one option.")
    if (allowCustom) lines.push("Or press Type answer.")

    const rows = []
    if (multiple) {
      for (let i = 0; i < q.options.length; i++) {
        const label = String(q.options[i].label)
        const checked = selectedLabels?.has(label)
        const text = `${checked ? "[x]" : "[ ]"} ${clampString(label, 50)}`
        rows.push([{ text, callback_data: packCallback("q", projectAlias, req.sessionID || "", req.id, stepIndex, "t", i) }])
      }
      rows.push([{ text: "Done", callback_data: packCallback("q", projectAlias, req.sessionID || "", req.id, stepIndex, "done") }])
    } else {
      for (let i = 0; i < q.options.length; i++) {
        const label = String(q.options[i].label)
        rows.push([{ text: clampString(label, 60), callback_data: packCallback("q", projectAlias, req.sessionID || "", req.id, stepIndex, "o", i) }])
      }
    }

    const bottomRow = []
    if (allowCustom) bottomRow.push({ text: "Type answer", callback_data: packCallback("q", projectAlias, req.sessionID || "", req.id, stepIndex, "custom") })
    bottomRow.push({ text: "Reject", callback_data: packCallback("q", projectAlias, req.sessionID || "", req.id, "reject") })
    rows.push(bottomRow)

    return { html: escapeHtml(lines.join("\n")), replyMarkup: makeInlineKeyboard(rows) }
  }

  async function sendCurrentQuestionStep(wizard, { editMessageId } = {}) {
    const idx = wizard.index
    const req = wizard.request
    if (!req?.questions?.[idx]) return
    const selectedSet = new Set(wizard.selectedByIndex?.[idx] || [])
    const rendered = renderQuestionStep(wizard.projectAlias, req, idx, selectedSet)
    const { chatId, threadIdOr0 } = wizard.ctx

    if (editMessageId) {
      await tg.editMessageText(chatId, editMessageId, rendered.html, rendered.replyMarkup, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
      wizard.messageIdByIndex[idx] = editMessageId
      return
    }

    const msg = await tg.sendMessage(chatId, rendered.html, rendered.replyMarkup, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      message_thread_id: threadIdOr0 || undefined,
    })
    wizard.messageIdByIndex[idx] = msg?.message_id
  }

  function renderPermissionPrompt(projectAlias, props) {
    return {
      blocks: [
        {
          type: "text",
          html:
            `<b>Permission request</b>\n<code>${escapeHtml(props.id)}</code>\n\n` +
            escapeHtml(`Project: ${projectAlias}`) +
            "\n" +
            escapeHtml(`Permission: ${props.permission}`) +
            (Array.isArray(props.patterns) && props.patterns.length
              ? "\n\n" + escapeHtml("Patterns:\n" + props.patterns.map((p) => `- ${p}`).join("\n"))
              : ""),
        },
      ],
      replyMarkup: makeInlineKeyboard([
        [
          { text: "Allow once", callback_data: packCallback("p", projectAlias, props.sessionID || "", props.id, "once") },
          { text: "Always allow", callback_data: packCallback("p", projectAlias, props.sessionID || "", props.id, "always") },
        ],
        [
          { text: "Reject", callback_data: packCallback("p", projectAlias, props.sessionID || "", props.id, "reject") },
          { text: "Reject with note", callback_data: packCallback("p", projectAlias, props.sessionID || "", props.id, "reject_note") },
        ],
      ]),
    }
  }

  async function sendPermissionPrompt(projectAlias, props, ctxMeta) {
    const rendered = renderPermissionPrompt(projectAlias, props)
    await sendBlocksToThread(ctxMeta, rendered.blocks, rendered.replyMarkup)
  }

  async function sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { resumed = false, sessionID = "" } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send rejection note for ${permissionId} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: packCallback("p", projectAlias, sessionID || "", permissionId, "cancel_note") }]]),
    )
  }

  async function sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, label, { resumed = false, sessionID = "" } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send your answer for: ${label || "question"} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: packCallback("q", projectAlias, sessionID || "", questionId, qIndex, "cancel_custom") }]]),
    )
  }

  async function finishQuestionWizard(wizard, { idempotencyEntries = [] } = {}) {
    const oc = ocByAlias[wizard.projectAlias]
    const replyKey = questionReplyIdempotencyKey(wizard.projectAlias, wizard.sessionID, wizard.request.id, wizard.answers)
    if (hasIdempotencyKey(replyKey)) {
      await markIdempotencyEntries(idempotencyEntries)
      await clearQuestionWizardStateDurably(wizard, "persist duplicate question reply state", { rollbackIdempotencyEntries: idempotencyEntries })
      return { outcome: "duplicate", duplicate: true }
    }
    try {
      await oc.replyQuestion(wizard.request.id, wizard.answers)
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/question/${wizard.request.id}/reply`, method: "POST" })) {
        await markIdempotencyKey(replyKey, {
          kind: "question-reply",
          projectAlias: wizard.projectAlias,
          ctxKey: wizard.ctx?.ctxKey,
          sessionId: wizard.sessionID,
          operation: "replyQuestion",
        })
        await markIdempotencyEntries(idempotencyEntries)
        await clearQuestionWizardStateDurably(wizard, "persist stale question reply state", { rollbackIdempotencyEntries: idempotencyEntries })
        await sendToThread(wizard.ctx, "Question is no longer active.").catch(() => {})
        return { outcome: "stale", stale: true }
      }
      if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/question/${wizard.request.id}/reply`, method: "POST" })) {
        return { outcome: "retryable", retryable: true }
      }
      throw err
    }
    await markIdempotencyKey(replyKey, {
      kind: "question-reply",
      projectAlias: wizard.projectAlias,
      ctxKey: wizard.ctx?.ctxKey,
      sessionId: wizard.sessionID,
      operation: "replyQuestion",
    })
    await markIdempotencyEntries(idempotencyEntries)
    recordPromptAnswered?.(wizard.projectAlias, "question", "ok")
    await clearQuestionWizardStateDurably(wizard, "persist question reply state", { rollbackIdempotencyEntries: idempotencyEntries })
    await sendToThread(wizard.ctx, `Answered: ${wizard.request.id}`).catch(() => {})
    return { outcome: "ok", stale: false }
  }

  async function ensureBaselineLoaded(projectAlias, { populateInitialSnapshot = true } = {}) {
    const base = promptBaseline[projectAlias]
    if (!base || base.loaded) return
    const oc = ocByAlias[projectAlias]
    try {
      const [perms, questions] = await Promise.all([oc.listPermissions(), oc.listQuestions()])
      if (!Array.isArray(perms) || !Array.isArray(questions)) return
      if (populateInitialSnapshot) {
        const pending = collectPendingPromptIdentities(projectAlias)
        const initialPending = collectPendingPromptIdentities(projectAlias, initialPendingPrompts)
        for (const permission of perms) {
          const identity = promptIdentity(permission?.id, permission?.sessionID)
          if (identity && !pending.permissions.has(identity) && !initialPending.permissions.has(identity)) base.permission.add(identity)
        }
        for (const question of questions) {
          const identity = promptIdentity(question?.id, question?.sessionID)
          if (identity && !pending.questions.has(identity) && !initialPending.questions.has(identity)) base.question.add(identity)
        }
      }
      markProjectUp(projectAlias)
      base.loaded = true
    } catch {
      // retry later
    }
  }

  async function handlePermissionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug }) {
    const sessionId = props.sessionID
    logSseDebug(projectAlias, sessionId, `event type=permission.asked id=${props.id}`)
    const resolved = await resolveBoundRoute(projectAlias, sessionId)
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=permission_no_route")
      return false
    }
    const route = resolved.route
    const permissionIdentity = promptIdentity(props.id, props.sessionID)
    if (hasIdempotencyPrefix(permissionReplyIdempotencyPrefix(projectAlias, props.sessionID, props.id)) || hasIdempotencyPrefix(permissionNoteIdempotencyPrefix(projectAlias, props.sessionID, props.id))) return false
    if (prompted[projectAlias].permission.has(permissionIdentity)) return false
    prompted[projectAlias].permission.add(permissionIdentity)
    const ctxMeta = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
    store.setPendingPermission({
      projectAlias,
      permissionId: props.id,
      sessionID: props.sessionID,
      permission: props.permission,
      patterns: Array.isArray(props.patterns) ? props.patterns : [],
      ctx: ctxMeta,
      createdAt: Date.now(),
    })
    try {
      await flushDurableState("persist permission prompt recovery state")
      await sendPermissionPrompt(projectAlias, props, ctxMeta)
      recordPromptDelivered?.(projectAlias, "permission")
    } catch (err) {
      prompted[projectAlias].permission.delete(permissionIdentity)
      throw err
    }
    return true
  }

  async function handleQuestionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug }) {
    const sessionId = props.sessionID
    logSseDebug(projectAlias, sessionId, `event type=question.asked id=${props.id}`)
    const resolved = await resolveBoundRoute(projectAlias, sessionId)
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=question_no_route")
      return false
    }
    const route = resolved.route
    const questionIdentity = promptIdentity(props.id, props.sessionID)
    if (hasIdempotencyPrefix(questionReplyIdempotencyPrefix(projectAlias, props.sessionID, props.id)) || hasIdempotencyKey(questionRejectIdempotencyKey(projectAlias, props.sessionID, props.id))) return false
    if (prompted[projectAlias].question.has(questionIdentity)) return false
    if (!props?.id || !Array.isArray(props.questions) || props.questions.length === 0) return false
    prompted[projectAlias].question.add(questionIdentity)

    const ctx = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
    const wizard = {
      projectAlias,
      id: props.id,
      sessionID: props.sessionID,
      request: props,
      index: 0,
      answers: Array.from({ length: props.questions.length }, () => []),
      selectedByIndex: {},
      messageIdByIndex: {},
      createdAt: Date.now(),
      ctx,
    }
    questionWizards.set(wizardKey(projectAlias, props.id, props.sessionID), wizard)
    persistQuestionWizard(wizard)

    try {
      await flushDurableState("persist question prompt recovery state")
      await sendBlocksToThread(ctx, [
        { type: "text", html: `<b>Question request</b>\n<code>${escapeHtml(props.id)}</code>\n\n${escapeHtml(`Project: ${projectAlias}`)}` },
      ])
      await sendCurrentQuestionStep(wizard)
      recordPromptDelivered?.(projectAlias, "question")
    } catch (err) {
      prompted[projectAlias].question.delete(questionIdentity)
      throw err
    }
    return true
  }

  return {
    wizardKey,
    getWizard,
    persistQuestionWizard,
    clearPersistedQuestionWizard,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    cloneWizardState,
    applyWizardState,
    renderQuestionStep,
    sendCurrentQuestionStep,
    renderPermissionPrompt,
    sendPermissionPrompt,
    sendRejectNotePrompt,
    sendQuestionCustomAnswerPrompt,
    finishQuestionWizard,
    ensureBaselineLoaded,
    handlePermissionAsked,
    handleQuestionAsked,
  }
}
