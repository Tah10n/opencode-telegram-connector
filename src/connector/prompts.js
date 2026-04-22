import { makeInlineKeyboard } from "../telegram/client.js"
import { escapeHtml } from "../telegram/formatter.js"
import { ctxKeyFrom } from "../telegram/routing.js"

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
  const livePromptSnapshotByProject = new Map()

  function isMissingPromptError(err) {
    const message = String(err?.message || err || "")
    return /\b404\b/.test(message) || /not found/i.test(message)
  }

  async function getLivePromptSnapshot(projectAlias) {
    if (!projectAlias || !ocByAlias[projectAlias]) return null
    let promise = livePromptSnapshotByProject.get(projectAlias)
    if (!promise) {
      const oc = ocByAlias[projectAlias]
      promise = Promise.all([oc.listPermissions().catch(() => null), oc.listQuestions().catch(() => null)]).then(([permissions, questions]) => {
        const permissionIds = Array.isArray(permissions)
          ? new Set(permissions.map((entry) => entry?.id).filter((id) => typeof id === "string" && id))
          : null
        const questionsById = Array.isArray(questions)
          ? new Map(
              questions
                .filter((entry) => typeof entry?.id === "string" && entry.id)
                .map((entry) => [entry.id, entry]),
            )
          : null
        if (!permissionIds && !questionsById) return null
        markProjectUp(projectAlias)
        return { permissionIds, questionsById }
      })
      livePromptSnapshotByProject.set(projectAlias, promise)
    }
    return promise
  }

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

  async function restorePendingPromptState() {
    const pending = store.getPendingPrompts?.() || store.get().pendingPrompts || {}

    for (const entry of Object.values(pending.permissions || {})) {
      const ctx = entry?.ctx
      if (!entry?.projectAlias || !entry?.permissionId || !ctx?.chatId || !ctx?.ctxKey) continue
      const live = await getLivePromptSnapshot(entry.projectAlias).catch(() => null)
      if (live?.permissionIds && !live.permissionIds.has(entry.permissionId)) {
        store.deletePendingPermission(entry.projectAlias, entry.permissionId)
        continue
      }
      prompted[entry.projectAlias]?.permission.add(entry.permissionId)
      await sendPermissionPrompt(
        entry.projectAlias,
        {
          id: entry.permissionId,
          sessionID: entry.sessionID,
          permission: entry.permission,
          patterns: Array.isArray(entry.patterns) ? entry.patterns : [],
        },
        ctx,
      ).catch(() => {})
    }

    for (const snapshot of Object.values(pending.questionWizards || {})) {
      const ctx = snapshot?.ctx
      if (!snapshot?.projectAlias || !snapshot?.id || !ctx?.chatId || !ctx?.ctxKey) continue
      const live = await getLivePromptSnapshot(snapshot.projectAlias).catch(() => null)
      const liveQuestion = live?.questionsById?.get(snapshot.id)
      if (live?.questionsById && !liveQuestion) {
        clearPersistedQuestionWizard(snapshot.projectAlias, snapshot.id)
        continue
      }
      prompted[snapshot.projectAlias]?.question.add(snapshot.id)
      const wizard = {
        projectAlias: snapshot.projectAlias,
        id: snapshot.id,
        sessionID: snapshot.sessionID,
        request: liveQuestion || snapshot.request,
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
        ctx,
      }
      questionWizards.set(wizardKey(wizard.projectAlias, wizard.id), wizard)
      await sendBlocksToThread(wizard.ctx, [
        { type: "text", html: `<b>Question request resumed</b>\n<code>${escapeHtml(wizard.id)}</code>\n\n${escapeHtml(`Project: ${wizard.projectAlias}`)}` },
      ]).catch(() => {})
      await sendCurrentQuestionStep(wizard).catch(() => {})
    }

    for (const [ctxKey, value] of Object.entries(pending.rejectNotes || {})) {
      if (!value?.projectAlias || !value?.permissionId) continue
      const live = await getLivePromptSnapshot(value.projectAlias).catch(() => null)
      if (live?.permissionIds && !live.permissionIds.has(value.permissionId)) {
        setRejectNoteAwaitingState(ctxKey, null)
        continue
      }
      setRejectNoteAwaitingState(ctxKey, value)
      const bindingCtx = parseCtxKey(ctxKey)
      if (bindingCtx?.chatId) await sendRejectNotePrompt(bindingCtx, value.projectAlias, value.permissionId, { resumed: true }).catch(() => {})
    }

    for (const [ctxKey, value] of Object.entries(pending.customAnswers || {})) {
      if (!value?.projectAlias || !value?.requestId || !Number.isInteger(value?.qIndex)) continue
      const live = await getLivePromptSnapshot(value.projectAlias).catch(() => null)
      if (live?.questionsById && !live.questionsById.has(value.requestId)) {
        setAwaitingCustomAnswerState(ctxKey, null)
        continue
      }
      const wizard = getWizard(value.projectAlias, value.requestId)
      const question = wizard?.request?.questions?.[value.qIndex]
      if (!wizard || !question) {
        setAwaitingCustomAnswerState(ctxKey, null)
        continue
      }

      setAwaitingCustomAnswerState(ctxKey, value)
      const label = wizard?.request?.questions?.[value.qIndex]?.header || "question"
      const bindingCtx = parseCtxKey(ctxKey)
      if (bindingCtx?.chatId) {
        await sendQuestionCustomAnswerPrompt(bindingCtx, value.projectAlias, value.requestId, value.qIndex, label, { resumed: true }).catch(
          () => {},
        )
      }
    }
  }

  async function finishQuestionWizard(wizard) {
    const oc = ocByAlias[wizard.projectAlias]
    try {
      await oc.replyQuestion(wizard.request.id, wizard.answers)
    } catch (err) {
      if (!isMissingPromptError(err)) throw err
      questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
      clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id)
      setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
      await sendToThread(wizard.ctx, "Question is no longer active.").catch(() => {})
      return { stale: true }
    }
    questionWizards.delete(wizardKey(wizard.projectAlias, wizard.request.id))
    clearPersistedQuestionWizard(wizard.projectAlias, wizard.request.id)
    setAwaitingCustomAnswerState(wizard.ctx.ctxKey, null)
    await sendToThread(wizard.ctx, `Answered: ${wizard.request.id}`).catch(() => {})
    return { stale: false }
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
    await sendPermissionPrompt(projectAlias, props, ctxMeta)
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
    prompted[projectAlias].question.add(props.id)
    if (!props?.id || !Array.isArray(props.questions) || props.questions.length === 0) return

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

    await sendBlocksToThread(ctx, [
      { type: "text", html: `<b>Question request</b>\n<code>${escapeHtml(props.id)}</code>\n\n${escapeHtml(`Project: ${projectAlias}`)}` },
    ])
    await sendCurrentQuestionStep(wizard)
  }

  return {
    wizardKey,
    getWizard,
    persistQuestionWizard,
    clearPersistedQuestionWizard,
    isMissingPromptError,
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
    restorePendingPromptState,
    finishQuestionWizard,
    ensureBaselineLoaded,
    handlePermissionAsked,
    handleQuestionAsked,
  }
}
