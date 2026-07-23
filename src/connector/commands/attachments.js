import { makeInlineKeyboard } from "../../telegram/client.js"
import {
  DEFAULT_ATTACHMENT_CONFIRMATION_MAX_AGE_MS,
  DEFAULT_ATTACHMENT_CONFIRMATION_MAX_ENTRIES,
  sessionKey,
} from "../../state/store.js"
import { classifyBoundaryError, makeBoundaryError } from "../../boundary-errors.js"
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
import { t as translate } from "../../i18n/index.js"
import { deliverPromptExactlyOnce, promptDeliveryIdentity, reconcilePromptDeliveryBeforePayload } from "../prompt-delivery.js"

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
  notifyProjectUnavailableForThread,
  markProjectUp,
  formatProjectUnavailable,
  ensureRecentPromptSet,
  hashTextForEcho,
  staleActiveTurnGuard,
  recordPromptDeliveryOutcome,
}) {
  const packCallback = callbackPacker(cb)
  const limits = userAttachmentLimits || userAttachmentLimitsFromConfig(config?.limits)
  const pendingAttachmentSends = new Set()

  function attachmentConfirmationKeyboard(token, locale = "en") {
    return makeInlineKeyboard([
      [
        { text: translate(locale, "common.sendFile"), callback_data: packCallback("att", "send", token) },
        { text: translate(locale, "common.cancel"), callback_data: packCallback("att", "cancel", token) },
      ],
      [{ text: translate(locale, "common.close"), callback_data: packCallback("att", "close", token) }],
    ])
  }

  function closeOnlyKeyboard(locale = "en") {
    return makeInlineKeyboard([[{ text: translate(locale, "common.close"), callback_data: packCallback("s", "close") }]])
  }

  function localeForCtx(ctxMeta = null) {
    return ctxMeta?.locale || config?.i18n?.defaultLocale || "en"
  }

  async function safeInformThread(ctxMeta, text, replyMarkup, options) {
    await sendToThread(ctxMeta, text, replyMarkup, options).catch(() => {})
  }

  async function notifyUnavailableForThread(ctxMeta, alias, err, { locale = localeForCtx(ctxMeta), fallbackReplyMarkup = null } = {}) {
    if (typeof notifyProjectUnavailableForThread === "function") {
      return notifyProjectUnavailableForThread(ctxMeta, alias, err, { locale, platform, fallbackReplyMarkup })
    }
    const withButton = isRetryableProjectError?.(err) && canAutoStartProject?.(alias, { platform })
    const replyMarkup = withButton ? startServerKeyboard?.(alias, { locale }) : fallbackReplyMarkup
    await safeInformThread(ctxMeta, formatProjectUnavailable(alias, err, { locale }), replyMarkup)
    return true
  }

  async function safeEditMessage(ctxMeta, messageId, text, replyMarkup, options) {
    if (!messageId || !tg?.editMessageText) return
    await tg.editMessageText(ctxMeta.chatId, messageId, text, replyMarkup, options).catch(() => {})
  }

  function bindingMatches(a, b) {
    return !!a && !!b && a.projectAlias === b.projectAlias && a.sessionId === b.sessionId
  }

  function attachmentSendIdempotencyKey(token) {
    return `tg-attachment-send:${String(token || "")}`
  }

  function hasIdempotencyKey(key) {
    return !!key && typeof store?.hasIdempotencyKey === "function" && store.hasIdempotencyKey(key)
  }

  async function flushDurableState(operation) {
    if (typeof store?.flush !== "function") return
    try {
      await store.flush()
    } catch (err) {
      throw makeBoundaryError({
        source: "state",
        operation,
        kind: "durability",
        outcome: "retryable",
        message: `${operation} failed: ${err?.message || String(err)}`,
        cause: err,
      })
    }
  }

  async function deleteIdempotencyEntry(key, { flush = true } = {}) {
    if (!key || typeof store?.deleteIdempotencyKey !== "function") return false
    const deleted = store.deleteIdempotencyKey(key)
    if (deleted && flush) await flushDurableState("delete idempotency entry")
    return deleted
  }

  async function markIdempotencyEntries(entries, { flush = true, rollbackOnFlushFailure = false } = {}) {
    const normalized = entries.filter((entry) => !!entry?.key)
    if (!normalized.length) return false
    if (typeof store?.markIdempotencyKey === "function") {
      let marked = false
      for (const entry of normalized) {
        marked = store.markIdempotencyKey(entry.key, entry.metadata || {}) || marked
      }
      if (marked && flush) {
        try {
          await flushDurableState("persist idempotency entries")
        } catch (err) {
          if (rollbackOnFlushFailure) {
            await Promise.all(normalized.map((entry) => deleteIdempotencyEntry(entry.key, { flush: false }).catch(() => false)))
          }
          throw err
        }
      }
      return marked
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      let marked = false
      for (const entry of normalized) {
        try {
          marked = (await store.markIdempotencyKeyAndFlush(entry.key, entry.metadata || {})) || marked
        } catch (err) {
          if (rollbackOnFlushFailure) await deleteIdempotencyEntry(entry.key, { flush: false }).catch(() => false)
          throw makeBoundaryError({
            source: "state",
            operation: "persist idempotency entries",
            kind: "durability",
            outcome: "retryable",
            message: `persist idempotency entries failed: ${err?.message || String(err)}`,
            cause: err,
          })
        }
      }
      return marked
    }
    return false
  }

  function attachmentConfirmationRecords() {
    const state = store?.get?.()
    if (!state) return null
    state.attachmentConfirmations ||= { records: {} }
    state.attachmentConfirmations.records ||= {}
    return state.attachmentConfirmations.records
  }

  function getAttachmentConfirmation(token, { now = Date.now() } = {}) {
    if (typeof store?.getAttachmentConfirmation === "function") {
      return store.getAttachmentConfirmation(token, { now })
    }
    const record = attachmentConfirmationRecords()?.[token]
    return record?.expiresAt > now ? { ...record } : null
  }

  function setAttachmentConfirmation(record) {
    if (typeof store?.setAttachmentConfirmation === "function") {
      return store.setAttachmentConfirmation(record, { maxEntries: DEFAULT_ATTACHMENT_CONFIRMATION_MAX_ENTRIES })
    }
    const records = attachmentConfirmationRecords()
    if (!records) return false
    if (!records[record.token] && Object.keys(records).length >= DEFAULT_ATTACHMENT_CONFIRMATION_MAX_ENTRIES) return false
    records[record.token] = { ...record }
    store.scheduleSave?.()
    return true
  }

  function deleteAttachmentConfirmation(token) {
    if (typeof store?.deleteAttachmentConfirmation === "function") return store.deleteAttachmentConfirmation(token)
    const records = attachmentConfirmationRecords()
    if (!records?.[token]) return false
    delete records[token]
    store.scheduleSave?.()
    return true
  }

  function pruneAttachmentConfirmations(now = Date.now()) {
    if (typeof store?.pruneAttachmentConfirmations === "function") return store.pruneAttachmentConfirmations({ now })
    const records = attachmentConfirmationRecords()
    if (!records) return 0
    let removed = 0
    for (const [token, record] of Object.entries(records)) {
      if (!record?.expiresAt || record.expiresAt <= now) {
        delete records[token]
        removed += 1
      }
    }
    const entries = Object.entries(records)
    if (entries.length > DEFAULT_ATTACHMENT_CONFIRMATION_MAX_ENTRIES) {
      entries
        .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0) || a[0].localeCompare(b[0]))
        .slice(0, entries.length - DEFAULT_ATTACHMENT_CONFIRMATION_MAX_ENTRIES)
        .forEach(([token]) => {
          delete records[token]
          removed += 1
        })
    }
    if (removed) store.scheduleSave?.()
    return removed
  }

  async function deleteAttachmentConfirmationDurably(token, operation) {
    const deleted = deleteAttachmentConfirmation(token)
    if (deleted) await flushDurableState(operation)
    return deleted
  }

  function attachmentConfirmationToken(record) {
    return hashIdempotencyValue([
      record.ctxKey,
      record.projectAlias,
      record.sessionId,
      record.messageId,
      record.updateId,
      record.documentInfo?.fileId,
      record.documentInfo?.fileUniqueId || "",
    ])
  }

  function storedAttachmentConfirmation(record, token, createdAt = Date.now()) {
    return {
      token,
      ctxKey: record.ctxKey,
      chatId: record.chatId,
      threadIdOr0: record.threadIdOr0,
      projectAlias: record.projectAlias,
      sessionId: record.sessionId,
      messageId: record.messageId,
      updateId: record.updateId,
      fileId: record.documentInfo.fileId,
      ...(record.documentInfo.fileUniqueId ? { fileUniqueId: record.documentInfo.fileUniqueId } : {}),
      fileName: record.documentInfo.safeName,
      mimeType: record.documentInfo.mimeType,
      fileSize: record.documentInfo.fileSize,
      caption: record.caption,
      createdAt,
      expiresAt: createdAt + DEFAULT_ATTACHMENT_CONFIRMATION_MAX_AGE_MS,
    }
  }

  function runtimeAttachmentConfirmation(record) {
    return {
      ...record,
      binding: { projectAlias: record.projectAlias, sessionId: record.sessionId },
      documentInfo: {
        supported: true,
        fileId: record.fileId,
        fileUniqueId: record.fileUniqueId || "",
        originalName: record.fileName,
        safeName: record.fileName,
        mimeType: record.mimeType,
        fileSize: record.fileSize,
      },
    }
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

  async function sendAttachmentPromptToOpenCode(ctxMeta, binding, record, loaded, deliveryIdentity) {
    const oc = binding.oc || ocByAlias[binding.projectAlias]
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
    await deliverPromptExactlyOnce({
      store,
      oc,
      identity: deliveryIdentity,
      text: promptText,
      options: promptOverride || undefined,
      recordPromptDeliveryOutcome,
    })
    return promptText
  }

  async function requestAttachmentConfirmation(ctxMeta, record, markMessageHandled) {
    const locale = localeForCtx(ctxMeta)
    if (!Number.isSafeInteger(record.messageId) || !Number.isSafeInteger(record.updateId)) {
      throw makeBoundaryError({
        source: "telegram",
        operation: "persist attachment confirmation",
        kind: "invariant",
        outcome: "fatal",
        message: "Attachment confirmation requires durable Telegram message and update identity",
      })
    }
    const token = attachmentConfirmationToken(record)
    const existing = getAttachmentConfirmation(token)
    if (!existing) {
      const stored = setAttachmentConfirmation(storedAttachmentConfirmation(record, token))
      if (!stored) {
        throw makeBoundaryError({
          source: "state",
          operation: "persist attachment confirmation",
          kind: "backpressure",
          outcome: "retryable",
          message: "Durable attachment confirmation ledger is full; confirmation was not shown",
        })
      }
    }
    await flushDurableState("persist attachment confirmation")
    await sendToThread(ctxMeta, attachmentConfirmationText(record.documentInfo, { limits, locale }), attachmentConfirmationKeyboard(token, locale))
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
    const locale = localeForCtx(ctxMeta)
    const documentInfo = describeTelegramDocument(msg.document, { limits })
    const record = {
      ctxKey: ctxMeta.ctxKey,
      chatId: ctxMeta.chatId,
      threadIdOr0: ctxMeta.threadIdOr0,
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
      await safeInformThread(ctxMeta, unsupportedAttachmentText(documentInfo, { limits, locale }), closeOnlyKeyboard(locale))
      await markMessageHandled("unsupportedAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }

    if (shouldConfirmAttachment(documentInfo, { limits })) {
      await requestAttachmentConfirmation(ctxMeta, record, markMessageHandled)
      return
    }

    const deliveryIdentity = promptDeliveryIdentity({
      kind: "attachment-direct",
      projectAlias: binding.projectAlias,
      sessionId: binding.sessionId,
      chatId: ctxMeta.chatId,
      threadIdOr0: ctxMeta.threadIdOr0,
      messageId: record.messageId,
      updateId: record.updateId,
    })
    const existingDelivery = store.getPromptDelivery?.(deliveryIdentity.key) || store.get?.()?.promptDeliveries?.records?.[deliveryIdentity.key]
    if (!existingDelivery && await staleActiveTurnGuard?.(ctxMeta, binding)) {
      await markMessageHandled("staleActiveTurnAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (existingDelivery) {
      const reconciled = await reconcilePromptDeliveryBeforePayload({
        store,
        oc: binding.oc || ocByAlias[binding.projectAlias],
        identity: deliveryIdentity,
        recordPromptDeliveryOutcome,
      })
      if (reconciled?.accepted) {
        await markMessageHandled(
          "promptAsyncAttachment",
          { projectAlias: binding.projectAlias, sessionId: binding.sessionId },
          { rollbackOnFlushFailure: true },
        )
        await safeInformThread(ctxMeta, attachmentSentText(record.documentInfo, binding, { locale }), closeOnlyKeyboard(locale))
        return
      }
    }

    let loaded
    try {
      loaded = await loadTelegramAttachment(record)
    } catch (err) {
      const classification = classifyBoundaryError(err, { source: "telegram", operation: "download attachment" })
      await safeInformThread(ctxMeta, attachmentDownloadFailedText(documentInfo, { locale }), closeOnlyKeyboard(locale))
      if (classification.retryable) throw err
      await markMessageHandled("attachmentDownloadFailed", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }

    if (loaded.outcome === "too_large") {
      await safeInformThread(ctxMeta, unsupportedAttachmentText(loaded.documentInfo, { limits, locale }), closeOnlyKeyboard(locale))
      await markMessageHandled("attachmentTooLarge", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (loaded.outcome === "unsupported_text") {
      await safeInformThread(
        ctxMeta,
        `${unsupportedAttachmentText(documentInfo, { limits, locale })}\n${translate(locale, "attachments.reason", { reason: loaded.error?.message || "not UTF-8 text" })}`,
        closeOnlyKeyboard(locale),
      )
      await markMessageHandled("unsupportedAttachmentText", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (shouldConfirmAttachment(loaded.documentInfo, { limits })) {
      await requestAttachmentConfirmation(ctxMeta, { ...record, documentInfo: loaded.documentInfo }, markMessageHandled)
      return
    }

    try {
      await sendAttachmentPromptToOpenCode(ctxMeta, binding, record, loaded, deliveryIdentity)
      markProjectUp?.(binding.projectAlias)
    } catch (err) {
      if (err?.source === "state") throw err
      const alias = binding.projectAlias
      if (recordRetryableOpenCodeFailure) {
        recordRetryableOpenCodeFailure(alias, err, {
          operation: "POST /session/:id/prompt_async",
          method: "POST",
          pathname: `/session/${binding.sessionId}/prompt_async`,
        })
      }
      await notifyUnavailableForThread(ctxMeta, alias, err, { locale, fallbackReplyMarkup: closeOnlyKeyboard(locale) })
      if (isRetryableProjectError?.(err)) throw err
      return
    }
    await markMessageHandled(
      "promptAsyncAttachment",
      { projectAlias: binding.projectAlias, sessionId: binding.sessionId },
      { rollbackOnFlushFailure: true },
    )
    await safeInformThread(ctxMeta, attachmentSentText(loaded.documentInfo, binding, { locale }), closeOnlyKeyboard(locale))
  }

  async function handleAttachmentConfirmation(ctxMeta, action, token, { editMessageId } = {}) {
    const locale = localeForCtx(ctxMeta)
    const pruned = pruneAttachmentConfirmations()
    if (pruned) await flushDurableState("persist pruned attachment confirmations")
    const storedRecord = getAttachmentConfirmation(token)
    const record = storedRecord ? runtimeAttachmentConfirmation(storedRecord) : null
    if (record && record.ctxKey !== ctxMeta.ctxKey) {
      return { callbackText: "Wrong thread" }
    }
    if (action === "cancel" || action === "close") {
      if (record) await deleteAttachmentConfirmationDurably(token, "delete cancelled attachment confirmation")
      if (action === "cancel") await safeEditMessage(ctxMeta, editMessageId, translate(locale, "attachments.cancelled"), closeOnlyKeyboard(locale))
      return { callbackText: action === "cancel" ? "Cancelled" : "Closed" }
    }

    if (!record) {
      if (hasIdempotencyKey(attachmentSendIdempotencyKey(token))) {
        await safeEditMessage(ctxMeta, editMessageId, translate(locale, "attachments.alreadySent"), closeOnlyKeyboard(locale))
        return { callbackText: "Already sent" }
      }
      await safeEditMessage(ctxMeta, editMessageId, translate(locale, "attachments.expired"), closeOnlyKeyboard(locale))
      return { callbackText: "Expired" }
    }

    const currentBinding = store.getBinding(ctxMeta.ctxKey)
    if (!bindingMatches(currentBinding, record.binding)) {
      await deleteAttachmentConfirmationDurably(token, "delete rebound attachment confirmation")
      await safeEditMessage(
        ctxMeta,
        editMessageId,
        translate(locale, "attachments.bindingChanged"),
        closeOnlyKeyboard(locale),
      )
      return { callbackText: "Binding changed" }
    }
    if (!ocByAlias[currentBinding.projectAlias]) {
      await deleteAttachmentConfirmationDurably(token, "delete unconfigured attachment confirmation")
      await safeEditMessage(
        ctxMeta,
        editMessageId,
        translate(locale, "commands.boundProjectMissing", { project: currentBinding.projectAlias || "unknown" }),
        closeOnlyKeyboard(locale),
      )
      return { callbackText: "Project missing" }
    }

    const sendKey = attachmentSendIdempotencyKey(token)
    if (pendingAttachmentSends.has(sendKey)) {
      return { callbackText: "Already sending" }
    }
    if (hasIdempotencyKey(sendKey)) {
      await deleteAttachmentConfirmationDurably(token, "delete completed attachment confirmation")
      await safeEditMessage(ctxMeta, editMessageId, translate(locale, "attachments.alreadySent"), closeOnlyKeyboard(locale))
      return { callbackText: "Already sent" }
    }
    const deliveryIdentity = promptDeliveryIdentity({
      kind: "attachment-confirmed",
      projectAlias: currentBinding.projectAlias,
      sessionId: currentBinding.sessionId,
      chatId: ctxMeta.chatId,
      threadIdOr0: ctxMeta.threadIdOr0,
      messageId: record.messageId,
      updateId: record.updateId,
    })
    const existingDelivery = store.getPromptDelivery?.(deliveryIdentity.key) || store.get?.()?.promptDeliveries?.records?.[deliveryIdentity.key]
    if (!existingDelivery && await staleActiveTurnGuard?.(ctxMeta, currentBinding)) {
      return { callbackText: "Agent busy" }
    }
    if (existingDelivery) {
      const reconciled = await reconcilePromptDeliveryBeforePayload({
        store,
        oc: currentBinding.oc || ocByAlias[currentBinding.projectAlias],
        identity: deliveryIdentity,
        recordPromptDeliveryOutcome,
      })
      if (reconciled?.accepted) {
        await markIdempotencyEntries([{
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
        }], { rollbackOnFlushFailure: true })
        await deleteAttachmentConfirmationDurably(token, "delete reconciled attachment confirmation")
        await safeEditMessage(ctxMeta, editMessageId, attachmentSentText(record.documentInfo, currentBinding, { locale }), closeOnlyKeyboard(locale))
        return { callbackText: "Sent" }
      }
    }
    pendingAttachmentSends.add(sendKey)

    try {
      let loaded
      try {
        loaded = await loadTelegramAttachment(record)
      } catch (err) {
        const classification = classifyBoundaryError(err, { source: "telegram", operation: "download attachment" })
        await safeInformThread(ctxMeta, attachmentDownloadFailedText(record.documentInfo, { locale }), closeOnlyKeyboard(locale))
        if (!classification.retryable) await deleteAttachmentConfirmationDurably(token, "delete failed attachment confirmation")
        return { callbackText: classification.retryable ? "Try again" : "Download failed" }
      }

      if (loaded.outcome === "too_large") {
        await deleteAttachmentConfirmationDurably(token, "delete oversized attachment confirmation")
        await safeEditMessage(ctxMeta, editMessageId, unsupportedAttachmentText(loaded.documentInfo, { limits, locale }), closeOnlyKeyboard(locale))
        return { callbackText: "Too large" }
      }
      if (loaded.outcome === "unsupported_text") {
        await deleteAttachmentConfirmationDurably(token, "delete unsupported attachment confirmation")
        await safeEditMessage(
          ctxMeta,
          editMessageId,
          `${unsupportedAttachmentText(record.documentInfo, { limits, locale })}\n${translate(locale, "attachments.reason", { reason: loaded.error?.message || "not UTF-8 text" })}`,
          closeOnlyKeyboard(locale),
        )
        return { callbackText: "Unsupported" }
      }

      try {
        await sendAttachmentPromptToOpenCode(ctxMeta, currentBinding, record, loaded, deliveryIdentity)
        markProjectUp?.(currentBinding.projectAlias)
      } catch (err) {
        if (err?.source === "state") throw err
        const alias = currentBinding.projectAlias
        if (recordRetryableOpenCodeFailure) {
          recordRetryableOpenCodeFailure(alias, err, {
            operation: "POST /session/:id/prompt_async",
            method: "POST",
            pathname: `/session/${currentBinding.sessionId}/prompt_async`,
          })
        }
        await notifyUnavailableForThread(ctxMeta, alias, err, { locale, fallbackReplyMarkup: closeOnlyKeyboard(locale) })
        const classification = classifyBoundaryError(err, { source: "opencode", operation: "send confirmed attachment" })
        if (classification.retryable || isRetryableProjectError?.(err)) throw err
        await deleteAttachmentConfirmationDurably(token, "delete rejected attachment confirmation")
        return { callbackText: "Send failed" }
      }
      // The original Telegram message was already marked when the confirmation
      // UI was sent, so the confirmed action keeps its own replay marker.
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
      ], { rollbackOnFlushFailure: true })
      await deleteAttachmentConfirmationDurably(token, "delete sent attachment confirmation")
      await safeEditMessage(ctxMeta, editMessageId, attachmentSentText(loaded.documentInfo, currentBinding, { locale }), closeOnlyKeyboard(locale))
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
