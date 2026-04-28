import { makeInlineKeyboard } from "../../telegram/client.js"
import { sessionKey } from "../../state/store.js"
import { classifyBoundaryError } from "../../boundary-errors.js"
import { userAttachmentLimitsFromConfig } from "../../limits.js"
import {
  attachmentConfirmationText,
  attachmentDownloadFailedText,
  attachmentSentText,
  decodeTextAttachment,
  describeTelegramDocument,
  formatAttachmentPrompt,
  shouldConfirmAttachment,
  unsupportedAttachmentText,
} from "../incoming-attachments.js"
import { hashIdempotencyValue } from "../idempotency.js"
import { callbackPacker } from "./shared.js"

const ATTACHMENT_CONFIRMATION_TTL_MS = 30 * 60 * 1000
const MAX_PENDING_ATTACHMENT_CONFIRMATIONS = 200

function normalizeBytes(value) {
  const normalized = Number(value)
  if (Number.isFinite(normalized)) return normalized
  return null
}

export function createAttachmentHandlers({
  runtime,
  config = {},
  store,
  tg,
  cb,
  ocByAlias = {},
  sendToThread,
  recordRetryableOpenCodeFailure,
  resolvePromptOverride,
  userAttachmentLimits,
  isRetryableProjectError,
  canAutoStartProject,
  platform,
  startServerKeyboard,
  formatProjectUnavailable,
  ensureRecentPromptSet,
  hashTextForEcho,
}) {
  const packCallback = callbackPacker(cb)
  const limits = userAttachmentLimits || userAttachmentLimitsFromConfig(config?.limits)
  const pendingAttachmentConfirmations = new Map()
  const pendingAttachmentSends = new Set()

  function attachmentConfirmationKeyboard(token) {
    return makeInlineKeyboard([
      [
        { text: "Send file", callback_data: packCallback(`att|send|${token}`) },
        { text: "Cancel", callback_data: packCallback(`att|cancel|${token}`) },
      ],
      [{ text: "Close", callback_data: packCallback(`att|close|${token}`) }],
    ])
  }

  function closeOnlyKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: packCallback("s|close") }]])
  }

  async function safeInformThread(ctxMeta, text, replyMarkup, options) {
    await sendToThread(ctxMeta, text, replyMarkup, options).catch(() => {})
  }

  async function safeEditMessage(ctxMeta, messageId, text, replyMarkup, options) {
    if (!messageId || !tg?.editMessageText) return
    await tg.editMessageText(ctxMeta.chatId, messageId, text, replyMarkup, options).catch(() => {})
  }

  function bindingMatches(a, b) {
    return !!a && !!b && a.projectAlias === b.projectAlias && a.sessionId === b.sessionId
  }

  function attachmentSendIdempotencyKey(record) {
    return `tg-attachment-send:${hashIdempotencyValue(`${record?.messageKey || ""}:${record?.projectAlias || ""}:${record?.sessionId || ""}`)}`
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function markIdempotencyEntries(entries, { flush = true } = {}) {
    const normalized = entries.filter((entry) => !!entry?.key)
    if (!normalized.length) return false
    if (typeof store?.markIdempotencyKey === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = store.markIdempotencyKey(entry.key, entry.metadata || {}) || marked
      }
      if (marked && flush && typeof store?.flush === "function") await store.flush()
      return marked
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = (await store.markIdempotencyKeyAndFlush(entry.key, entry.metadata || {})) || marked
      }
      return marked
    }
    return false
  }

  function prunePendingAttachmentConfirmations(now = Date.now()) {
    for (const [token, record] of pendingAttachmentConfirmations.entries()) {
      if (!record?.expiresAt || record.expiresAt <= now) pendingAttachmentConfirmations.delete(token)
    }
    while (pendingAttachmentConfirmations.size > MAX_PENDING_ATTACHMENT_CONFIRMATIONS) {
      const oldest = pendingAttachmentConfirmations.keys().next().value
      if (!oldest) break
      pendingAttachmentConfirmations.delete(oldest)
    }
  }

  function rememberPendingAttachmentConfirmation(record) {
    prunePendingAttachmentConfirmations()
    const createdAt = Date.now()
    const token = hashIdempotencyValue(`${record.messageKey}:${record.documentInfo?.fileId}:${createdAt}:${Math.random()}`)
    pendingAttachmentConfirmations.set(token, {
      ...record,
      token,
      createdAt,
      expiresAt: createdAt + ATTACHMENT_CONFIRMATION_TTL_MS,
    })
    prunePendingAttachmentConfirmations(createdAt)
    return token
  }

  async function loadTelegramAttachment(record) {
    if (!tg?.getFile || !tg?.downloadFile) throw new Error("Telegram file download API is not available")
    const file = await tg.getFile(record.documentInfo.fileId)
    const filePath = typeof file?.file_path === "string" ? file.file_path.trim() : ""
    const reportedSize = Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : record.documentInfo.fileSize
    const documentInfo = { ...record.documentInfo, fileSize: reportedSize ?? record.documentInfo.fileSize }
    if (documentInfo.fileSize != null && documentInfo.fileSize > limits.maxBytes) {
      return { outcome: "too_large", documentInfo: { ...documentInfo, reason: "too_large" } }
    }
    if (!filePath) throw new Error("Telegram file path is missing")

    const bytes = await tg.downloadFile(filePath, { maxBytes: limits.maxBytes })
    const byteLength = normalizeBytes(bytes?.byteLength ?? bytes?.length)
    if (byteLength != null && byteLength > limits.maxBytes) {
      return { outcome: "too_large", documentInfo: { ...documentInfo, fileSize: byteLength, reason: "too_large" } }
    }
    let text
    try {
      text = decodeTextAttachment(bytes)
    } catch (err) {
      return { outcome: "unsupported_text", documentInfo, error: err }
    }
    return { outcome: "ok", text, byteLength: byteLength || 0, documentInfo: { ...documentInfo, fileSize: byteLength || 0 } }
  }

  async function sendAttachmentPromptToOpenCode(ctxMeta, binding, record, loaded) {
    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    const promptText = formatAttachmentPrompt({
      prefix,
      caption: record.caption,
      documentInfo: loaded.documentInfo,
      text: loaded.text,
      byteLength: loaded.byteLength,
    })
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
    const promptOverride = resolvePromptOverride ? await resolvePromptOverride(ctxMeta.ctxKey, binding) : null
    await oc.promptAsync(binding.sessionId, promptText, promptOverride || undefined)
    return promptText
  }

  async function requestAttachmentConfirmation(ctxMeta, record, markMessageHandled) {
    const token = rememberPendingAttachmentConfirmation(record)
    await safeInformThread(ctxMeta, attachmentConfirmationText(record.documentInfo, { limits }), attachmentConfirmationKeyboard(token))
    if (markMessageHandled) {
      await markMessageHandled("attachmentConfirmRequested", {
        projectAlias: record.projectAlias,
        sessionId: record.sessionId,
        action: "confirm-required",
      })
    }
    return token
  }

  async function handleAttachmentDocumentMessage(ctxMeta, msg, binding, messageKey, markMessageHandled, options = {}) {
    const documentInfo = describeTelegramDocument(msg.document, { limits })
    const record = {
      ctxKey: ctxMeta.ctxKey,
      projectAlias: binding.projectAlias,
      sessionId: binding.sessionId,
      binding: { projectAlias: binding.projectAlias, sessionId: binding.sessionId },
      messageKey,
      updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
      messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
      caption: typeof msg?.caption === "string" ? msg.caption : "",
      documentInfo,
    }

    if (!documentInfo.supported) {
      await safeInformThread(ctxMeta, unsupportedAttachmentText(documentInfo, { limits }), closeOnlyKeyboard())
      await markMessageHandled("unsupportedAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }

    if (shouldConfirmAttachment(documentInfo, { limits })) {
      await requestAttachmentConfirmation(ctxMeta, record, markMessageHandled)
      return
    }

    let loaded
    try {
      loaded = await loadTelegramAttachment(record)
    } catch (err) {
      const classification = classifyBoundaryError(err, { source: "telegram", operation: "download attachment" })
      await safeInformThread(ctxMeta, attachmentDownloadFailedText(documentInfo), closeOnlyKeyboard())
      if (classification.retryable) throw err
      await markMessageHandled("attachmentDownloadFailed", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }

    if (loaded.outcome === "too_large") {
      await safeInformThread(ctxMeta, unsupportedAttachmentText(loaded.documentInfo, { limits }), closeOnlyKeyboard())
      await markMessageHandled("attachmentTooLarge", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (loaded.outcome === "unsupported_text") {
      await safeInformThread(
        ctxMeta,
        `${unsupportedAttachmentText(documentInfo, { limits })}\nReason: ${loaded.error?.message || "not UTF-8 text"}`,
        closeOnlyKeyboard(),
      )
      await markMessageHandled("unsupportedAttachmentText", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (shouldConfirmAttachment(loaded.documentInfo, { limits })) {
      await requestAttachmentConfirmation(ctxMeta, { ...record, documentInfo: loaded.documentInfo }, markMessageHandled)
      return
    }

    try {
      await sendAttachmentPromptToOpenCode(ctxMeta, binding, record, loaded)
      await markMessageHandled("promptAsyncAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      await safeInformThread(ctxMeta, attachmentSentText(loaded.documentInfo, binding), closeOnlyKeyboard())
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isRetryableProjectError?.(err) && canAutoStartProject?.(alias, { platform })
      if (recordRetryableOpenCodeFailure) {
        recordRetryableOpenCodeFailure(alias, err, {
          operation: "POST /session/:id/prompt_async",
          method: "POST",
          pathname: `/session/${binding.sessionId}/prompt_async`,
        })
      }
      await safeInformThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard?.(alias) : closeOnlyKeyboard())
      if (isRetryableProjectError?.(err)) throw err
    }
  }

  async function handleAttachmentConfirmation(ctxMeta, action, token, { editMessageId } = {}) {
    prunePendingAttachmentConfirmations()
    const record = pendingAttachmentConfirmations.get(token)
    if (record && record.ctxKey !== ctxMeta.ctxKey) {
      return { callbackText: "Wrong thread" }
    }
    if (action === "cancel" || action === "close") {
      if (record) pendingAttachmentConfirmations.delete(token)
      if (action === "cancel") await safeEditMessage(ctxMeta, editMessageId, "Attachment sending cancelled.", closeOnlyKeyboard())
      return { callbackText: action === "cancel" ? "Cancelled" : "Closed" }
    }

    if (!record) {
      await safeEditMessage(ctxMeta, editMessageId, "Attachment confirmation expired. Send the file again.", closeOnlyKeyboard())
      return { callbackText: "Expired" }
    }

    const currentBinding = store.getBinding(ctxMeta.ctxKey)
    if (!bindingMatches(currentBinding, record.binding)) {
      pendingAttachmentConfirmations.delete(token)
      await safeEditMessage(
        ctxMeta,
        editMessageId,
        "Attachment was not sent because this thread's binding changed. Send the file again for the current session.",
        closeOnlyKeyboard(),
      )
      return { callbackText: "Binding changed" }
    }

    const sendKey = attachmentSendIdempotencyKey(record)
    if (hasIdempotencyKey(sendKey)) {
      pendingAttachmentConfirmations.delete(token)
      await safeEditMessage(ctxMeta, editMessageId, "Attachment was already sent to OpenCode.", closeOnlyKeyboard())
      return { callbackText: "Already sent" }
    }
    if (pendingAttachmentSends.has(sendKey)) {
      return { callbackText: "Already sending" }
    }
    pendingAttachmentSends.add(sendKey)

    try {
      let loaded
      try {
        loaded = await loadTelegramAttachment(record)
      } catch (err) {
        const classification = classifyBoundaryError(err, { source: "telegram", operation: "download attachment" })
        await safeInformThread(ctxMeta, attachmentDownloadFailedText(record.documentInfo), closeOnlyKeyboard())
        return { callbackText: classification.retryable ? "Try again" : "Download failed" }
      }

      if (loaded.outcome === "too_large") {
        pendingAttachmentConfirmations.delete(token)
        await safeEditMessage(ctxMeta, editMessageId, unsupportedAttachmentText(loaded.documentInfo, { limits }), closeOnlyKeyboard())
        return { callbackText: "Too large" }
      }
      if (loaded.outcome === "unsupported_text") {
        pendingAttachmentConfirmations.delete(token)
        await safeEditMessage(
          ctxMeta,
          editMessageId,
          `${unsupportedAttachmentText(record.documentInfo, { limits })}\nReason: ${loaded.error?.message || "not UTF-8 text"}`,
          closeOnlyKeyboard(),
        )
        return { callbackText: "Unsupported" }
      }

      try {
        await sendAttachmentPromptToOpenCode(ctxMeta, currentBinding, record, loaded)
      } catch (err) {
        const alias = currentBinding.projectAlias
        const withButton = isRetryableProjectError?.(err) && canAutoStartProject?.(alias, { platform })
        if (recordRetryableOpenCodeFailure) {
          recordRetryableOpenCodeFailure(alias, err, {
            operation: "POST /session/:id/prompt_async",
            method: "POST",
            pathname: `/session/${currentBinding.sessionId}/prompt_async`,
          })
        }
        await safeInformThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard?.(alias) : closeOnlyKeyboard())
        if (isRetryableProjectError?.(err)) return { callbackText: "Temporarily unavailable" }
        throw err
      }

      await markIdempotencyEntries([
        {
          key: sendKey,
          metadata: {
            kind: "telegram-attachment",
            ctxKey: ctxMeta.ctxKey,
            projectAlias: currentBinding.projectAlias,
            sessionId: currentBinding.sessionId,
            operation: "promptAsyncAttachment",
            action: "send-confirmed",
            updateId: record.updateId,
            messageId: record.messageId,
          },
        },
      ])
      pendingAttachmentConfirmations.delete(token)
      await safeEditMessage(ctxMeta, editMessageId, attachmentSentText(loaded.documentInfo, currentBinding), closeOnlyKeyboard())
      return { callbackText: "Sent" }
    } finally {
      pendingAttachmentSends.delete(sendKey)
    }
  }

  return {
    handleAttachmentDocumentMessage,
    handleAttachmentConfirmation,
  }
}
