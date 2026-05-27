import { callbackToast } from "../callback-toast.js"
import { normalizePermissionProfileId, PERMISSION_RESET_ID } from "../../opencode/permissions-profile.js"

function isPrivateChat(ctxMeta) {
  return ctxMeta?.chatType === "private"
}

export async function handlePermissionsControlCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  answerCallbackQuery,
  closeInteractiveMessage,
  renderPermissionSettings,
  renderPermissionDetails,
  renderFullAutoConfirmation,
  applyPermissionProfile,
}) {
  const action = parts[1]
  if (action === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }

  if (action === "project" || action === "settings") {
    const projectAlias = parts[2] || ""
    await answerCallbackQuery(callbackQuery.id, callbackToast("permissions"))
    await renderPermissionSettings(ctxMeta, { projectAlias, editMessageId: msg?.message_id })
    return true
  }

  if (action === "view") {
    const projectAlias = parts[2] || ""
    if (!projectAlias) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    if (!isPrivateChat(ctxMeta)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, callbackToast("permissions"))
    await renderPermissionDetails(ctxMeta, projectAlias, { editMessageId: msg?.message_id })
    return true
  }

  if (action === "confirm") {
    const projectAlias = parts[2] || ""
    const profileId = normalizePermissionProfileId(parts[3])
    if (!projectAlias || profileId !== "full-auto") {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    if (!isPrivateChat(ctxMeta)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Confirm")
    await renderFullAutoConfirmation(ctxMeta, projectAlias, { editMessageId: msg?.message_id })
    return true
  }

  if (action === "set" || action === "apply" || action === "reset") {
    const projectAlias = parts[2] || ""
    const requestedProfile = action === "reset" ? PERMISSION_RESET_ID : normalizePermissionProfileId(parts[3], { includeReset: true })
    if (!projectAlias || !requestedProfile) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    if (!isPrivateChat(ctxMeta)) {
      await answerCallbackQuery(callbackQuery.id, "Private chat only")
      return true
    }
    if (requestedProfile === "full-auto" && action !== "apply") {
      await answerCallbackQuery(callbackQuery.id, "Confirm")
      await renderFullAutoConfirmation(ctxMeta, projectAlias, { editMessageId: msg?.message_id })
      return true
    }
    await answerCallbackQuery(callbackQuery.id, callbackToast("permissionsApplying"))
    await applyPermissionProfile(ctxMeta, projectAlias, requestedProfile, { editMessageId: msg?.message_id })
    return true
  }

  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
