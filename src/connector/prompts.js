import { makeInlineKeyboard } from "../telegram/client.js"
import { escapeHtml } from "../telegram/formatter.js"
import { ctxKeyFrom } from "../telegram/routing.js"
import { isRetryableBoundaryError, isStaleBoundaryError } from "../boundary-errors.js"

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
    recoverPendingPromptsOnStartup,
    markProjectUp,
  } = runtime

  const wizardKey = (projectAlias, requestId) => `${projectAlias}:${requestId}`
  const getWizard = (projectAlias, requestId) => questionWizards.get(wizardKey(projectAlias, requestId)) || null
  function persistQuestionWizard(wizard) {
    store.setQuestionWizard(wizardKey(wizard.projectAlias, wizard.request.id), wizard)
  }

  function clearPersistedQuestionWizard(projectAlias, requestId) {
    store.deleteQuestionWizard(wizardKey(projectAlias, requestId))
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
        rows.push([{ text, callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|t|${i}`) }])
      }
      rows.push([{ text: "Done", callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|done`) }])
    } else {
      for (let i = 0; i < q.options.length; i++) {
        const label = String(q.options[i].label)
        rows.push([{ text: clampString(label, 60), callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|o|${i}`) }])
      }
    }

    const bottomRow = []
    if (allowCustom) bottomRow.push({ text: "Type answer", callback_data: cb.pack(`q|${projectAlias}|${req.id}|${stepIndex}|custom`) })
    bottomRow.push({ text: "Reject", callback_data: cb.pack(`q|${projectAlias}|${req.id}|reject`) })
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
      await tg
        .editMessageText(chatId, editMessageId, rendered.html, rendered.replyMarkup, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => {})
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
          { text: "Allow once", callback_data: cb.pack(`p|${projectAlias}|${props.id}|once`) },
          { text: "Always allow", callback_data: cb.pack(`p|${projectAlias}|${props.id}|always`) },
        ],
        [
          { text: "Reject", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject`) },
          { text: "Reject with note", callback_data: cb.pack(`p|${projectAlias}|${props.id}|reject_note`) },
        ],
      ]),
    }
  }

  async function sendPermissionPrompt(projectAlias, props, ctxMeta) {
    const rendered = renderPermissionPrompt(projectAlias, props)
    await sendBlocksToThread(ctxMeta, rendered.blocks, rendered.replyMarkup)
  }

  async function sendRejectNotePrompt(ctxMeta, projectAlias, permissionId, { resumed = false } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send rejection note for ${permissionId} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`p|${projectAlias}|${permissionId}|cancel_note`) }]]),
    )
  }

  async function sendQuestionCustomAnswerPrompt(ctxMeta, projectAlias, questionId, qIndex, label, { resumed = false } = {}) {
    const prefix = resumed ? "Resumed. " : ""
    await sendToThread(
      ctxMeta,
      `${prefix}Send your answer for: ${label || "question"} (next message will be used).`,
      makeInlineKeyboard([[{ text: "Cancel", callback_data: cb.pack(`q|${projectAlias}|${questionId}|${qIndex}|cancel_custom`) }]]),
    )
  }

  async function finishQuestionWizard(wizard) {
    const oc = ocByAlias[wizard.projectAlias]
    try {
      await oc.replyQuestion(wizard.request.id, wizard.answers)
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/question/${wizard.request.id}/reply`, method: "POST" })) {
        questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
        clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id)
        setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
        await sendToThread(wizard.ctx, "Question is no longer active.").catch(() => {})
        return { outcome: "stale", stale: true }
      }
      if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/question/${wizard.request.id}/reply`, method: "POST" })) {
        return { outcome: "retryable", retryable: true }
      }
      throw err
    }
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
    clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id)
    setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
    await sendToThread(wizard.ctx, `Answered: ${wizard.request.id}`).catch(() => {})
    return { outcome: "ok", stale: false }
  }

  async function ensureBaselineLoaded(projectAlias) {
    const base = promptBaseline[projectAlias]
    if (!base || base.loaded) return
    if (recoverPendingPromptsOnStartup) {
      base.loaded = true
      return
    }
    const oc = ocByAlias[projectAlias]
    try {
      const [perms, questions] = await Promise.all([oc.listPermissions(), oc.listQuestions()])
      if (!Array.isArray(perms) || !Array.isArray(questions)) return
      markProjectUp(projectAlias)
      for (const p of perms) base.permission.add(p.id)
      for (const q of questions) base.question.add(q.id)
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
      return
    }
    const route = resolved.route
    await ensureBaselineLoaded(projectAlias)
    if (!promptBaseline[projectAlias]?.loaded) return
    if (promptBaseline[projectAlias].permission.has(props.id)) return
    if (prompted[projectAlias].permission.has(props.id)) return
    prompted[projectAlias].permission.add(props.id)
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
      await sendPermissionPrompt(projectAlias, props, ctxMeta)
    } catch (err) {
      prompted[projectAlias].permission.delete(props.id)
      throw err
    }
  }

  async function handleQuestionAsked({ projectAlias, props, resolveBoundRoute, logSseDebug }) {
    const sessionId = props.sessionID
    logSseDebug(projectAlias, sessionId, `event type=question.asked id=${props.id}`)
    const resolved = await resolveBoundRoute(projectAlias, sessionId)
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=question_no_route")
      return
    }
    const route = resolved.route
    await ensureBaselineLoaded(projectAlias)
    if (!promptBaseline[projectAlias]?.loaded) return
    if (promptBaseline[projectAlias].question.has(props.id)) return
    if (prompted[projectAlias].question.has(props.id)) return
    if (!props?.id || !Array.isArray(props.questions) || props.questions.length === 0) return
    prompted[projectAlias].question.add(props.id)

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
    questionWizards.set(wizardKey(projectAlias, props.id), wizard)
    persistQuestionWizard(wizard)

    try {
      await sendBlocksToThread(ctx, [
        { type: "text", html: `<b>Question request</b>\n<code>${escapeHtml(props.id)}</code>\n\n${escapeHtml(`Project: ${projectAlias}`)}` },
      ])
      await sendCurrentQuestionStep(wizard)
    } catch (err) {
      prompted[projectAlias].question.delete(props.id)
      throw err
    }
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
