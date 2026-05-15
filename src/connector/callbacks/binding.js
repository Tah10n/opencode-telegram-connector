import { requireSafeOpenCodeId } from "../../opencode/ids.js"
import { makeInlineKeyboard } from "../../telegram/client.js"

function ignoreError() {}

function canUseBindingAction(ctxMeta, targetCtxKey) {
  return ctxMeta?.chatType === "private" || ctxMeta?.ctxKey === targetCtxKey
}

function describeTargetCtx(ctxKey, parseCtxKey, formatThreadLabel) {
  const parsed = parseCtxKey?.(ctxKey)
  if (!parsed) return ctxKey
  return `chat ${parsed.chatId} / ${formatThreadLabel?.(parsed.threadIdOr0) || `thread ${parsed.threadIdOr0}`}`
}

function unbindConfirmationKeyboard(ctxKey, binding, locale, packCallbackData, t) {
  return makeInlineKeyboard([
    [{ text: t(locale, "operator.removeBinding"), callback_data: packCallbackData("b", "unbind", ctxKey, binding.projectAlias, binding.sessionId) }],
    [{ text: t(locale, "common.close"), callback_data: packCallbackData("b", "close") }],
  ])
}

export async function handleBindingCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  projects,
  ocByAlias,
  parseCtxKey,
  formatThreadLabel,
  answerCallbackQuery,
  closeInteractiveMessage,
  deleteInteractiveMessage,
  handleBindings,
  flushStoreIfAvailable,
  sendToThread,
  commitStateMutation,
  getStartupSession,
  bindCtxToSession,
  packCallbackData,
  t,
  formatProjectUnavailable,
  isStateDurabilityError,
}) {
  const action = parts[1]
  const describe = (ctxKey) => describeTargetCtx(ctxKey, parseCtxKey, formatThreadLabel)
  const confirmKeyboard = (targetCtxKey, binding) => unbindConfirmationKeyboard(targetCtxKey, binding, ctxMeta.locale, packCallbackData, t)

  if (action === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (action === "repair") {
    if (ctxMeta?.chatType !== "private") {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    const summary = store.repairBindingIndex?.() || { changed: false }
    if (summary.changed) await flushStoreIfAvailable()
    await answerCallbackQuery(callbackQuery.id, summary.changed ? "Repaired" : "Already clean")
    if (typeof handleBindings === "function") await handleBindings(ctxMeta).catch(ignoreError)
    return true
  }

  const targetCtxKey = parts[2]
  const targetCtx = parseCtxKey?.(targetCtxKey)
  if (!targetCtxKey || !targetCtx) {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  if (!canUseBindingAction(ctxMeta, targetCtxKey)) {
    await answerCallbackQuery(callbackQuery.id, "Private chat only")
    return true
  }
  const binding = store.getBinding(targetCtxKey)
  if (!binding) {
    await answerCallbackQuery(callbackQuery.id, "Not bound")
    return true
  }

  if (action === "keep") {
    await answerCallbackQuery(callbackQuery.id, "Kept")
    await sendToThread(ctxMeta, t(ctxMeta, "callbacks.bindingKept", { scope: describe(targetCtxKey) })).catch(ignoreError)
    return true
  }
  if (action === "confirm-unbind") {
    await answerCallbackQuery(callbackQuery.id, "Confirm")
    await sendToThread(
      ctxMeta,
      [
        t(ctxMeta, "operator.confirmUnbind"),
        t(ctxMeta, "operator.scope", { scope: describe(targetCtxKey) }),
        t(ctxMeta, "operator.project", { project: binding.projectAlias }),
        t(ctxMeta, "operator.session", { session: binding.sessionId }),
        t(ctxMeta, "operator.unbindNote"),
      ].join("\n"),
      confirmKeyboard(targetCtxKey, binding),
    ).catch(ignoreError)
    return true
  }
  if (action === "unbind") {
    const expectedProjectAlias = parts[3] || ""
    const expectedSessionId = parts[4] || ""
    if (!expectedProjectAlias || !expectedSessionId) {
      await answerCallbackQuery(callbackQuery.id, "Confirm")
      await sendToThread(
        ctxMeta,
        [
          t(ctxMeta, "operator.confirmUnbind"),
          t(ctxMeta, "operator.scope", { scope: describe(targetCtxKey) }),
          t(ctxMeta, "operator.project", { project: binding.projectAlias }),
          t(ctxMeta, "operator.session", { session: binding.sessionId }),
          t(ctxMeta, "operator.unbindNote"),
        ].join("\n"),
        confirmKeyboard(targetCtxKey, binding),
      ).catch(ignoreError)
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      return true
    }
    if (binding.projectAlias !== expectedProjectAlias || binding.sessionId !== expectedSessionId) {
      await answerCallbackQuery(callbackQuery.id, "Binding changed")
      await deleteInteractiveMessage(ctxMeta, msg?.message_id)
      await sendToThread(ctxMeta, t(ctxMeta, "callbacks.bindingChangedForScope", { scope: describe(targetCtxKey) })).catch(ignoreError)
      return true
    }
    const ok = await commitStateMutation(() => store.unbind(targetCtxKey), { shouldCommit: (result) => !!result })
    await answerCallbackQuery(callbackQuery.id, ok ? "Unbound" : "Not bound")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    await sendToThread(ctxMeta, ok ? t(ctxMeta, "callbacks.bindingRemoved", { scope: describe(targetCtxKey) }) : t(ctxMeta, "callbacks.bindingAbsent")).catch(ignoreError)
    return true
  }
  if (action === "rebind" || action === "new") {
    const projectAlias = binding.projectAlias
    const oc = ocByAlias[projectAlias]
    if (!projectAlias || !projects?.[projectAlias] || !oc) {
      await answerCallbackQuery(callbackQuery.id, "Unknown project")
      return true
    }
    try {
      const nextSessionId = action === "rebind"
        ? await getStartupSession(projectAlias, { waitForStart: false, forceRefresh: true })
        : (await oc.createSession(projects?.[projectAlias]?.directory ? { directory: projects[projectAlias].directory } : {}))?.id
      if (!nextSessionId) {
        await answerCallbackQuery(callbackQuery.id, "Unavailable")
        return true
      }
      const safeNextSessionId = requireSafeOpenCodeId(nextSessionId, "session id")
      const targetMeta = { ...targetCtx, ctxKey: targetCtxKey, chatType: ctxMeta.chatType }
      await commitStateMutation(() => bindCtxToSession(targetMeta, projectAlias, safeNextSessionId))
      await answerCallbackQuery(callbackQuery.id, action === "rebind" ? "Rebound" : "Created")
      await sendToThread(
        ctxMeta,
        t(ctxMeta, "callbacks.bindingChangedToSession", {
          action: action === "rebind" ? t(ctxMeta, "callbacks.rebound") : t(ctxMeta, "callbacks.createdAndBound"),
          scope: describe(targetCtxKey),
          project: projectAlias,
          session: safeNextSessionId,
        }),
      ).catch(ignoreError)
    } catch (err) {
      if (isStateDurabilityError(err)) {
        if (action === "new") {
          await answerCallbackQuery(callbackQuery.id, "Action failed")
          await sendToThread(ctxMeta, t(ctxMeta, "callbacks.newSessionPersistFailed")).catch(ignoreError)
          return true
        }
        throw err
      }
      await answerCallbackQuery(callbackQuery.id, "Unavailable")
      await sendToThread(ctxMeta, formatProjectUnavailable(projectAlias, err, { locale: ctxMeta.locale })).catch(ignoreError)
    }
    return true
  }

  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
