import { normalizeModelReference } from "../../model-selection.js"
import { callbackToast } from "../callback-toast.js"

function ignoreError() {}

export async function handleModelCallback({
  parts,
  callbackQuery,
  ctxMeta,
  msg,
  store,
  answerCallbackQuery,
  closeInteractiveMessage,
  commitStateMutation,
  renderModelSettings,
  setThreadModelPreference,
}) {
  const action = parts[1]
  if (action === "close") {
    await closeInteractiveMessage(callbackQuery.id, ctxMeta, msg?.message_id)
    return true
  }

  const binding = store.getBinding(ctxMeta.ctxKey)
  if (!binding) {
    await answerCallbackQuery(callbackQuery.id, "Not bound")
    return true
  }

  if (action === "settings") {
    await answerCallbackQuery(callbackQuery.id, "Model")
    await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
    return true
  }

  if (action === "root" || action === "back") {
    await answerCallbackQuery(callbackQuery.id, "Back")
    await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
    return true
  }

  if (action === "provider") {
    const providerId = parts[2]
    if (!providerId) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Pick model")
    await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id, selectedProviderId: providerId }).catch(ignoreError)
    return true
  }

  if (action === "set") {
    const nextMode = parts[2]
    let setResult = null
    if (nextMode === "inherit") {
      setResult = await commitStateMutation(() => setThreadModelPreference(ctxMeta, binding, null), { shouldCommit: (result) => result?.ok !== false })
      await answerCallbackQuery(callbackQuery.id, setResult?.callbackToast || setResult?.callbackText || callbackToast("modelInherit"))
    } else if (nextMode === "project-default") {
      setResult = await commitStateMutation(() => setThreadModelPreference(ctxMeta, binding, { mode: "project-default" }), { shouldCommit: (result) => result?.ok !== false })
      if (!setResult?.ok) {
        await answerCallbackQuery(callbackQuery.id, setResult?.callbackToast || setResult?.callbackText || "Unavailable")
        await renderModelSettings(ctxMeta, { binding, editMessageId: msg?.message_id }).catch(ignoreError)
        return true
      }
      await answerCallbackQuery(callbackQuery.id, setResult.callbackToast || setResult.callbackText || callbackToast("modelProjectDefault"))
    } else {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    await renderModelSettings(ctxMeta, {
      binding,
      editMessageId: msg?.message_id,
      ...(setResult?.noticeText ? { noticeText: setResult.noticeText } : {}),
    }).catch(ignoreError)
    return true
  }

  if (action === "pick" || action === "model") {
    const modelKey = parts[2]
    if (!modelKey) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const selectedModel = normalizeModelReference(modelKey)
    if (!selectedModel) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    await answerCallbackQuery(callbackQuery.id, "Pick variant")
    await renderModelSettings(ctxMeta, {
      binding,
      editMessageId: msg?.message_id,
      selectedProviderId: selectedModel.providerID,
      selectedModelKey: modelKey,
    }).catch(ignoreError)
    return true
  }

  if (action === "apply") {
    const modelKey = parts[2]
    const variantToken = parts[3]
    if (!modelKey || variantToken == null) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    if (!normalizeModelReference(modelKey)) {
      await answerCallbackQuery(callbackQuery.id, "Invalid")
      return true
    }
    const variant = variantToken === "~" ? "" : variantToken
    const result = await commitStateMutation(() => setThreadModelPreference(ctxMeta, binding, { mode: "custom", model: modelKey, variant }), {
      shouldCommit: (mutationResult) => mutationResult?.ok !== false,
    })
    await answerCallbackQuery(callbackQuery.id, result?.callbackToast || result?.callbackText || callbackToast("modelValue", { value: variant ? `${modelKey} ${variant}` : modelKey }))
    await renderModelSettings(ctxMeta, {
      binding,
      editMessageId: msg?.message_id,
      ...(result?.noticeText ? { noticeText: result.noticeText } : {}),
    }).catch(ignoreError)
    return true
  }

  await answerCallbackQuery(callbackQuery.id, "Invalid")
  return true
}
