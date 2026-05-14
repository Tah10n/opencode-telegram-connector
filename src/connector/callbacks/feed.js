import { normalizeFeedMode } from "../../state/store.js"
import { callbackToast } from "../callback-toast.js"

function ignoreError() {}

export async function handleFeedCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  answerCallbackQuery,
  closeInteractiveMessage,
  commitStateMutation,
  renderFeedSettings,
  feedModeLabel,
  t,
}) {
  const rawMode = parts[1]
  if (rawMode === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }
  if (rawMode === "settings") {
    await answerCallbackQuery(callbackQuery.id, "Feed")
    await renderFeedSettings(ctxMeta, { editMessageId: msg?.message_id }).catch(ignoreError)
    return true
  }
  if (rawMode !== "main" && rawMode !== "main+changes" && rawMode !== "verbose") {
    await answerCallbackQuery(callbackQuery.id, "Invalid")
    return true
  }
  const mode = normalizeFeedMode(rawMode)
  await commitStateMutation(() => store.setFeedMode(ctxMeta.ctxKey, mode))
  await answerCallbackQuery(callbackQuery.id, callbackToast("feedValue", { value: feedModeLabel(mode, ctxMeta.locale) }))
  await renderFeedSettings(ctxMeta, {
    editMessageId: msg?.message_id,
    noticeText: t(ctxMeta, "callbacks.feedChanged", { mode: feedModeLabel(mode, ctxMeta.locale) }),
  }).catch(ignoreError)
  return true
}
