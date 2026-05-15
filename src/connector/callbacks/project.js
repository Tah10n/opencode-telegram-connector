function ignoreError() {}

function canUseProjectControl(store, ctxMeta, projectAlias) {
  if (ctxMeta?.chatType === "private") return true
  return store.getBinding(ctxMeta?.ctxKey)?.projectAlias === projectAlias
}

function canUseProjectBind(store, ctxMeta, projectAlias) {
  if (ctxMeta?.chatType === "private") return true
  const binding = store.getBinding(ctxMeta?.ctxKey)
  return !binding || binding.projectAlias === projectAlias
}

export async function handleProjectCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  projects,
  runtime,
  answerCallbackQuery,
  closeInteractiveMessage,
  handleProjects,
  ensureProjectStarted,
  handleBindCommand,
  flushStoreIfAvailable,
  sendToThread,
  formatProjectUnavailable,
  validateProject,
  canAutoStartProject,
  platform,
  startServerKeyboard,
  renderProjectSessions,
  t,
}) {
  if (parts[1] === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (parts[1] === "projects") {
    if (typeof handleProjects !== "function") {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Projects")
    await handleProjects(ctxMeta).catch(ignoreError)
    return true
  }
  const projectAlias = parts[1]
  const action = parts[2]
  if (!projectAlias || !projects?.[projectAlias]) {
    await answerCallbackQuery(callbackQuery.id, "Unknown project")
    return true
  }
  if (action === "start") {
    if (!canUseProjectControl(store, ctxMeta, projectAlias)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Starting…")
    void ensureProjectStarted(projectAlias, ctxMeta)
    return true
  }
  if (action === "bind") {
    if (!canUseProjectBind(store, ctxMeta, projectAlias)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    if (typeof handleBindCommand !== "function") {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Binding…")
    await handleBindCommand(ctxMeta, [projectAlias]).then(() => flushStoreIfAvailable()).catch(async (err) => {
      runtime.logger?.error?.("Failed to bind project from callback:", err?.message || String(err))
      await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
    })
    return true
  }
  if (action === "health") {
    if (!canUseProjectControl(store, ctxMeta, projectAlias)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Checking…")
    try {
      await validateProject(projectAlias)
      await sendToThread(ctxMeta, t(ctxMeta, "callbacks.healthOnline", { project: projectAlias })).catch(ignoreError)
    } catch (err) {
      const replyMarkup = canAutoStartProject?.(projectAlias, { platform }) ? startServerKeyboard?.(projectAlias) : null
      await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale }), replyMarkup).catch(ignoreError)
    }
    return true
  }
  if (action === "sessions") {
    await answerCallbackQuery(callbackQuery.id, "Sessions")
    await renderProjectSessions(ctxMeta, projectAlias, { editMessageId: msg?.message_id }).catch(async (err) => {
      runtime.logger?.error?.("Failed to render project sessions:", err?.message || String(err))
      await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
    })
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
