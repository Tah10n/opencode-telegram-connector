import { makeInlineKeyboard } from "../../telegram/client.js"

function ignoreError() {}

export async function handleRuntimeCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  tg,
  store,
  runtime,
  answerCallbackQuery,
  closeInteractiveMessage,
  deleteInteractiveMessage,
  flushStoreIfAvailable,
  requestRuntimeShutdown,
  scheduleRuntimeShutdown,
  packCallbackData,
  t,
}) {
  const action = parts[1]
  const runtimeCloseKeyboard = (locale = "en") => makeInlineKeyboard([[{ text: t(locale, "common.close"), callback_data: packCallbackData("rt", "close") }]])
  const runtimeConfirmationKeyboard = (targetAction, locale = "en") => {
    const label = targetAction === "restart" ? t(locale, "callbacks.confirmRestart") : t(locale, "callbacks.confirmStop")
    return makeInlineKeyboard([
      [{ text: label, callback_data: packCallbackData("rt", targetAction) }],
      [{ text: t(locale, "common.cancel"), callback_data: packCallbackData("rt", "cancel") }],
    ])
  }
  const runtimeConfirmationText = (targetAction) => {
    if (targetAction === "restart") return t(ctxMeta, "callbacks.runtimeConfirmRestart")
    return t(ctxMeta, "callbacks.runtimeConfirmStop")
  }
  const requestRuntimeShutdownSoon = (targetAction) => {
    const run = () =>
      Promise.resolve(requestRuntimeShutdown({ action: targetAction })).catch((err) => {
        runtime.logger?.error?.("Runtime shutdown request failed:", err?.message || String(err))
      })
    try {
      if (typeof scheduleRuntimeShutdown === "function") {
        scheduleRuntimeShutdown(run)
        return
      }
      const timer = setTimeout(run, 50)
      timer.unref?.()
    } catch (err) {
      runtime.logger?.error?.("Failed to schedule runtime shutdown request:", err?.message || String(err))
    }
  }
  const persistRuntimeRestartNotice = async () => {
    if (typeof store?.setPendingRuntimeOnlineNotice !== "function") return
    try {
      store.setPendingRuntimeOnlineNotice({ kind: "restart", chatId: ctxMeta.chatId, createdAt: Date.now() })
      await flushStoreIfAvailable()
    } catch (err) {
      runtime.logger?.error?.("Failed to persist runtime restart notice:", err?.message || String(err))
    }
  }

  if (ctxMeta?.chatType !== "private") {
    await answerCallbackQuery(callbackQuery.id, "Private chat only")
    return true
  }
  if (action === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (action === "cancel") {
    await answerCallbackQuery(callbackQuery.id, "Cancelled")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    return true
  }
  if (action === "confirm-stop" || action === "confirm-restart") {
    const targetAction = action === "confirm-restart" ? "restart" : "stop"
    await answerCallbackQuery(callbackQuery.id, targetAction === "restart" ? "Confirm restart" : "Confirm stop")
    if (msg?.message_id && typeof tg.editMessageText === "function") {
      await tg
        .editMessageText(ctxMeta.chatId, msg.message_id, runtimeConfirmationText(targetAction), runtimeConfirmationKeyboard(targetAction, ctxMeta.locale))
        .catch(ignoreError)
    }
    return true
  }
  if (action === "stop" || action === "restart") {
    if (typeof requestRuntimeShutdown !== "function") {
      await answerCallbackQuery(callbackQuery.id, "Unavailable")
      if (msg?.message_id && typeof tg.editMessageText === "function") {
        await tg.editMessageText(ctxMeta.chatId, msg.message_id, t(ctxMeta, "callbacks.runtimeShutdownUnavailable"), runtimeCloseKeyboard(ctxMeta.locale)).catch(ignoreError)
      }
      return true
    }
    await answerCallbackQuery(callbackQuery.id, action === "restart" ? "Restarting…" : "Stopping…")
    await deleteInteractiveMessage(ctxMeta, msg?.message_id)
    if (action === "restart") await persistRuntimeRestartNotice()
    requestRuntimeShutdownSoon(action)
    return true
  }
  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
