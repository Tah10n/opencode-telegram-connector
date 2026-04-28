import { makeInlineKeyboard } from "../telegram/client.js"
import { parseSessionReference, findSessionByShareUrl } from "../session-ref.js"
import { formatSessionButtonLabel, formatSessionsListText, normalizeSessionsList } from "../session-list.js"
import { sanitizeBaseUrlForDisplay } from "../url-utils.js"
import { sessionKey } from "../state/store.js"
import { getLaunchSupport } from "../opencode/launcher.js"
import { isSafeOpenCodeId, normalizeOpenCodeId, requireSafeOpenCodeId } from "../opencode/ids.js"
import { hashIdempotencyValue, permissionNoteIdempotencyKey, telegramMessageIdempotencyKey } from "./idempotency.js"
import {
  collectModelCandidates,
  commonVariantsForModel,
  configuredModelInfo,
  formatModelLabel,
  modelKeyOf,
  modelSourceLabel,
  normalizeModelPreference,
  normalizeModelReference,
  normalizeVariant,
  pickMostRecentSessionModelInfo,
} from "../model-selection.js"
import { classifyBoundaryError, isRetryableBoundaryError, isStaleBoundaryError } from "../boundary-errors.js"
import { userAttachmentLimitsFromConfig } from "../limits.js"
import {
  attachmentConfirmationText,
  attachmentDownloadFailedText,
  attachmentSentText,
  decodeTextAttachment,
  describeTelegramDocument,
  formatAttachmentPrompt,
  shouldConfirmAttachment,
  unsupportedAttachmentText,
  unsupportedMediaKind,
  unsupportedMediaText,
} from "./incoming-attachments.js"

function helpText({ scopeLabel = "this thread", defaultProject = "", isBound = false } = {}) {
  const next = isBound
    ? "Next: use the buttons below for Sessions, New, Feed, Model, or Unbind."
    : `Next: tap Projects, or send ${defaultProject ? `/bind ${defaultProject}` : "/bind <projectAlias>"}.`
  return [
    "Telegram connector help:",
    `Scope: ${scopeLabel}`,
    next,
    defaultProject && !isBound ? `Default project hint: ${defaultProject}` : "",
    "",
    "Thread commands:",
    "/bind <projectAlias> — bind this chat/thread",
    "/new [title] — create a session for this thread",
    "/use <sessionId|shareLink> — switch this thread",
    "/sessions — recent sessions for this thread's project",
    "/model — model override for this thread",
    "/feed — Telegram feed mode for this thread",
    "/status — current binding for this thread",
    "/unbind — remove this thread's binding after confirmation",
    "",
    "Operator commands:",
    "/projects — project overview",
    "/runtime or /health — private chat only",
    "/bindings — private chat only",
    "/abort, /sendlast, /cancel",
  ].filter((line) => line !== "").join("\n")
}

export function createCommandHandlers(runtime) {
  const {
    store,
    projects,
    ocByAlias,
    startupSessionByProject,
    config,
    logger,
    platform,
    tg,
    getStartupSession,
    openAttachWindowFn,
    openAttachWindowWindowsFn,
    validateProject,
    bindCtxToSession,
    primeTuiActiveSessionFollow,
    recordProjectHealthFailure,
    sendToThread,
    parseCtxKey,
    formatThreadLabel,
    getProjectSseStatus,
    renderFeedSettings,
    feedModeLabel,
    getFeedMode,
    deliverAssistantText,
    extractAssistantDisplayText,
    lastAssistantBySession,
    canAutoStartProject,
    isRetryableProjectError,
    startServerKeyboard,
    ensureRecentPromptSet,
    hashTextForEcho,
    formatProjectUnavailable,
    buildProjectsOverviewText,
    buildProjectsOverviewKeyboard,
    isCommand,
    parseCommand,
    rejectNoteAwaiting,
    awaitingCustomAnswer,
    bindAliasAwaiting,
    getWizard,
    cloneWizardState,
    applyWizardState,
    persistQuestionWizard,
    finishQuestionWizard,
    sendCurrentQuestionStep,
    setRejectNoteAwaitingState,
    setAwaitingCustomAnswerState,
    recordPromptAnswered,
    buildRuntimeStatusLines,
    buildGlobalRuntimeStatusLines,
  } = runtime

  const pendingAttachmentConfirmations = new Map()
  const pendingAttachmentSends = new Set()
  const ATTACHMENT_CONFIRMATION_TTL_MS = 30 * 60 * 1000
  const MAX_PENDING_ATTACHMENT_CONFIRMATIONS = 200
  const userAttachmentLimits = userAttachmentLimitsFromConfig(config?.limits)

  function recordRetryableOpenCodeFailure(projectAlias, err, context) {
    if (!projectAlias || !isRetryableProjectError(err)) return
    recordProjectHealthFailure?.(projectAlias, err, context)
  }

  async function resolveStartupSession(alias, { forceRefresh = false } = {}) {
    return getStartupSession(alias, { waitForStart: false, forceRefresh }).catch(() => null)
  }

  async function resolveValidStartupSession(alias, oc) {
    let startupSid = startupSessionByProject[alias] || (await resolveStartupSession(alias))
    if (startupSid && !normalizeSafeSessionId(startupSid)) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      logger.warn?.(`[${alias}] ignored invalid cached startup session id`)
      startupSid = null
    }
    if (!startupSid) return null

    try {
      await oc.getSession(startupSid)
      return requireSessionIdFromBackend(startupSid, "startup session id")
    } catch (err) {
      if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
      startupSid = await resolveStartupSession(alias, { forceRefresh: true })
      if (startupSid && !normalizeSafeSessionId(startupSid)) {
        if (startupSessionByProject[alias] === startupSid) delete startupSessionByProject[alias]
        logger.warn?.(`[${alias}] ignored invalid refreshed startup session id`)
        startupSid = null
      }
      if (!startupSid) throw err
      await oc.getSession(startupSid)
      return requireSessionIdFromBackend(startupSid, "startup session id")
    }
  }

  async function safeInformThread(ctxMeta, text, replyMarkup, options) {
    await sendToThread(ctxMeta, text, replyMarkup, options).catch(() => {})
  }

  async function safeEditMessage(ctxMeta, messageId, text, replyMarkup, options) {
    if (!messageId || !tg?.editMessageText) return
    await tg.editMessageText(ctxMeta.chatId, messageId, text, replyMarkup, options).catch(() => {})
  }

  function normalizeSafeSessionId(value) {
    const id = normalizeOpenCodeId(value)
    return id && isSafeOpenCodeId(id) ? id : ""
  }

  function requireSessionIdFromBackend(value, context) {
    return requireSafeOpenCodeId(value, context || "session id")
  }

  function invalidSessionReferenceText() {
    return "Invalid session id. Use a session id without spaces or URL path/query characters, or provide a supported OpenCode share link."
  }

  function threadScopeLabel(ctxMeta) {
    if (!ctxMeta?.chatId) return "this thread"
    return `chat ${ctxMeta.chatId} / ${formatThreadLabel(ctxMeta.threadIdOr0)}`
  }

  function configuredDefaultProject() {
    const alias = String(config?.defaultProject || "").trim()
    return alias && projects?.[alias] ? alias : ""
  }

  function unboundGuidanceText(ctxMeta, reason = "This thread is not bound yet.") {
    const def = configuredDefaultProject()
    return [
      reason,
      `Scope: ${threadScopeLabel(ctxMeta)}`,
      `Next: tap Projects${def ? `, tap Bind ${def}, or send /bind ${def}` : ", then bind a project with /bind <projectAlias>"}.`,
      def ? `Default project hint: ${def}` : "Use /projects to see available aliases.",
    ].join("\n")
  }

  function unboundGuidanceKeyboard() {
    const rows = []
    const def = configuredDefaultProject()
    if (def) rows.push([{ text: `Bind ${def}`, callback_data: runtime.cb.pack(`srv|${def}|bind`) }])
    rows.push([{ text: "Projects", callback_data: runtime.cb.pack("srv|projects") }])
    rows.push([{ text: "Close", callback_data: runtime.cb.pack("srv|close") }])
    return makeInlineKeyboard(rows)
  }

  function boundThreadActionsKeyboard(ctxMeta) {
    return makeInlineKeyboard([
      [
        { text: "Sessions", callback_data: runtime.cb.pack("s|refresh") },
        { text: "New", callback_data: runtime.cb.pack("s|new") },
      ],
      [
        { text: "Feed", callback_data: runtime.cb.pack("feed|settings") },
        { text: "Model", callback_data: runtime.cb.pack("m|settings") },
      ],
      [
        { text: "Unbind", callback_data: runtime.cb.pack(`b|confirm-unbind|${ctxMeta.ctxKey}`) },
        { text: "Close", callback_data: runtime.cb.pack("s|close") },
      ],
    ])
  }

  function closeOnlyKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: runtime.cb.pack("s|close") }]])
  }

  function runtimeControlsKeyboard() {
    return makeInlineKeyboard([
      [
        { text: "Restart", callback_data: runtime.cb.pack("rt|confirm-restart") },
        { text: "Stop", callback_data: runtime.cb.pack("rt|confirm-stop") },
      ],
      [{ text: "Close", callback_data: runtime.cb.pack("rt|close") }],
    ])
  }

  function attachmentConfirmationKeyboard(token) {
    return makeInlineKeyboard([
      [
        { text: "Send file", callback_data: runtime.cb.pack(`att|send|${token}`) },
        { text: "Cancel", callback_data: runtime.cb.pack(`att|cancel|${token}`) },
      ],
      [{ text: "Close", callback_data: runtime.cb.pack(`att|close|${token}`) }],
    ])
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

  function attachmentSendIdempotencyKey(record) {
    return `tg-attachment-send:${hashIdempotencyValue(`${record?.messageKey || ""}:${record?.projectAlias || ""}:${record?.sessionId || ""}`)}`
  }

  function bindingMatches(a, b) {
    return !!a && !!b && a.projectAlias === b.projectAlias && a.sessionId === b.sessionId
  }

  function unbindConfirmationText(ctxMeta, binding) {
    return [
      "Confirm unbind for this thread:",
      `Scope: ${threadScopeLabel(ctxMeta)}`,
      `Project: ${binding.projectAlias}`,
      `Session: ${binding.sessionId}`,
      "This only removes the Telegram binding; it does not delete the opencode session.",
    ].join("\n")
  }

  function unbindConfirmationKeyboard(ctxKey, binding) {
    return makeInlineKeyboard([
      [{ text: "Remove this thread binding", callback_data: runtime.cb.pack(`b|unbind|${ctxKey}|${binding.projectAlias}|${binding.sessionId}`) }],
      [{ text: "Close", callback_data: runtime.cb.pack("b|close") }],
    ])
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

  async function loadTelegramAttachment(record) {
    if (!tg?.getFile || !tg?.downloadFile) throw new Error("Telegram file download API is not available")
    const file = await tg.getFile(record.documentInfo.fileId)
    const filePath = typeof file?.file_path === "string" ? file.file_path.trim() : ""
    const reportedSize = Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : record.documentInfo.fileSize
    const documentInfo = { ...record.documentInfo, fileSize: reportedSize ?? record.documentInfo.fileSize }
    if (documentInfo.fileSize != null && documentInfo.fileSize > userAttachmentLimits.maxBytes) {
      return { outcome: "too_large", documentInfo: { ...documentInfo, reason: "too_large" } }
    }
    if (!filePath) throw new Error("Telegram file path is missing")

    const bytes = await tg.downloadFile(filePath, { maxBytes: userAttachmentLimits.maxBytes })
    const byteLength = bytes?.byteLength ?? bytes?.length ?? 0
    if (byteLength > userAttachmentLimits.maxBytes) {
      return { outcome: "too_large", documentInfo: { ...documentInfo, fileSize: byteLength, reason: "too_large" } }
    }
    let text
    try {
      text = decodeTextAttachment(bytes)
    } catch (err) {
      return { outcome: "unsupported_text", documentInfo, error: err }
    }
    return { outcome: "ok", text, byteLength, documentInfo: { ...documentInfo, fileSize: byteLength } }
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
    const promptOverride = await resolvePromptOverride(ctxMeta.ctxKey, binding)
    await oc.promptAsync(binding.sessionId, promptText, promptOverride || undefined)
    return promptText
  }

  async function requestAttachmentConfirmation(ctxMeta, record, markMessageHandled) {
    const token = rememberPendingAttachmentConfirmation(record)
    await sendToThread(ctxMeta, attachmentConfirmationText(record.documentInfo, { limits: userAttachmentLimits }), attachmentConfirmationKeyboard(token))
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
    const documentInfo = describeTelegramDocument(msg.document, { limits: userAttachmentLimits })
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
      await sendToThread(ctxMeta, unsupportedAttachmentText(documentInfo, { limits: userAttachmentLimits }), closeOnlyKeyboard())
      await markMessageHandled("unsupportedAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }

    if (shouldConfirmAttachment(documentInfo, { limits: userAttachmentLimits })) {
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
      await sendToThread(ctxMeta, unsupportedAttachmentText(loaded.documentInfo, { limits: userAttachmentLimits }), closeOnlyKeyboard())
      await markMessageHandled("attachmentTooLarge", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (loaded.outcome === "unsupported_text") {
      await sendToThread(ctxMeta, `${unsupportedAttachmentText(documentInfo, { limits: userAttachmentLimits })}\nReason: ${loaded.error?.message || "not UTF-8 text"}`, closeOnlyKeyboard())
      await markMessageHandled("unsupportedAttachmentText", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      return
    }
    if (shouldConfirmAttachment(loaded.documentInfo, { limits: userAttachmentLimits })) {
      await requestAttachmentConfirmation(ctxMeta, { ...record, documentInfo: loaded.documentInfo }, markMessageHandled)
      return
    }

    try {
      await sendAttachmentPromptToOpenCode(ctxMeta, binding, record, loaded)
      await markMessageHandled("promptAsyncAttachment", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
      await safeInformThread(ctxMeta, attachmentSentText(loaded.documentInfo, binding), closeOnlyKeyboard())
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isRetryableProjectError(err) && canAutoStartProject(alias, { platform })
      recordRetryableOpenCodeFailure(alias, err, {
        operation: "POST /session/:id/prompt_async",
        method: "POST",
        pathname: `/session/${binding.sessionId}/prompt_async`,
      })
      await safeInformThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : closeOnlyKeyboard())
      if (isRetryableProjectError(err)) throw err
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
        await safeEditMessage(ctxMeta, editMessageId, unsupportedAttachmentText(loaded.documentInfo, { limits: userAttachmentLimits }), closeOnlyKeyboard())
        return { callbackText: "Too large" }
      }
      if (loaded.outcome === "unsupported_text") {
        pendingAttachmentConfirmations.delete(token)
        await safeEditMessage(
          ctxMeta,
          editMessageId,
          `${unsupportedAttachmentText(record.documentInfo, { limits: userAttachmentLimits })}\nReason: ${loaded.error?.message || "not UTF-8 text"}`,
          closeOnlyKeyboard(),
        )
        return { callbackText: "Unsupported" }
      }

      try {
        await sendAttachmentPromptToOpenCode(ctxMeta, currentBinding, record, loaded)
      } catch (err) {
        const alias = currentBinding.projectAlias
        const withButton = isRetryableProjectError(err) && canAutoStartProject(alias, { platform })
        recordRetryableOpenCodeFailure(alias, err, {
          operation: "POST /session/:id/prompt_async",
          method: "POST",
          pathname: `/session/${currentBinding.sessionId}/prompt_async`,
        })
        await safeInformThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : closeOnlyKeyboard())
        if (isRetryableProjectError(err)) return { callbackText: "Temporarily unavailable" }
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

  function normalizeEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
    if (typeof value === "string") {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function compareMessageRecency(a, b) {
    const aTime = sessionModelTimestamp(a)
    const bTime = sessionModelTimestamp(b)
    if (aTime != null && bTime != null) return bTime - aTime
    if (aTime != null) return -1
    if (bTime != null) return 1
    return 0
  }

  function sessionModelTimestamp(message) {
    const time = message?.info?.time || message?.time || {}
    return (
      normalizeEpochMs(time.completed) ?? normalizeEpochMs(time.updated) ?? normalizeEpochMs(time.created) ?? normalizeEpochMs(time.started) ?? null
    )
  }

  function getModelPreference(ctxKey) {
    return normalizeModelPreference(store.getModelPreference?.(ctxKey))
  }

  function setModelPreference(ctxKey, value) {
    store.setModelPreference?.(ctxKey, value)
  }

  async function resolveSessionModelInfo(projectAlias, sessionId) {
    const oc = ocByAlias[projectAlias]
    if (!oc?.listMessages || !sessionId) return null
    const messages = await oc.listMessages(sessionId).catch(() => null)
    return pickMostRecentSessionModelInfo(messages)
  }

  async function resolveConfiguredModelInfo(projectAlias) {
    const oc = ocByAlias[projectAlias]
    const directory = projects?.[projectAlias]?.directory
    if (!oc?.getConfig) return null
    const configInfo = await oc.getConfig({ directory }).catch(() => null)
    return configuredModelInfo(configInfo)
  }

  async function resolveEffectiveModelState(ctxKey, binding, { sessionModelInfo, configuredInfo } = {}) {
    if (!binding?.projectAlias) return { label: "", source: "unknown", model: null, variant: "", preference: { mode: "inherit" } }

    const preference = getModelPreference(ctxKey)
    if (preference.mode === "custom") {
      return {
        ...preference,
        label: formatModelLabel(preference.model, preference.variant),
        source: "thread-custom",
        preference,
      }
    }

    if (preference.mode === "project-default") {
      const resolvedConfiguredInfo = configuredInfo ?? (await resolveConfiguredModelInfo(binding.projectAlias))
      if (resolvedConfiguredInfo?.label) {
        return { ...resolvedConfiguredInfo, source: "thread-project-default", preference }
      }
    }

    const resolvedSessionInfo = sessionModelInfo ?? (await resolveSessionModelInfo(binding.projectAlias, binding.sessionId))
    if (resolvedSessionInfo?.label) {
      return { ...resolvedSessionInfo, source: "session-history", preference }
    }

    const resolvedConfiguredInfo = configuredInfo ?? (await resolveConfiguredModelInfo(binding.projectAlias))
    if (resolvedConfiguredInfo?.label) {
      return { ...resolvedConfiguredInfo, source: "project-default", preference }
    }

    return { label: "", source: "unknown", model: null, variant: "", preference }
  }

  async function resolvePromptOverride(ctxKey, binding) {
    const effectiveState = await resolveEffectiveModelState(ctxKey, binding)
    if (!effectiveState?.model || (effectiveState.source !== "thread-custom" && effectiveState.source !== "thread-project-default")) {
      return null
    }
    return {
      model: effectiveState.model,
      ...(effectiveState.variant ? { variant: effectiveState.variant } : {}),
    }
  }

  function moveConflictNote(result) {
    if (!result?.movedFromRoute) return ""
    return `Note: this session was already bound to chat ${result.movedFromRoute.chatId} / ${formatThreadLabel(result.movedFromRoute.threadIdOr0)} and was moved to this thread.`
  }

  function bindingHealthLabel(health) {
    if (health?.status === "ok") return "ok"
    if (health?.status === "stale" && health.reason === "project-missing") return "stale: project missing"
    if (health?.status === "stale" && health.reason === "session-missing") return "stale: session missing"
    if (health?.status === "unreachable") return "unreachable"
    return "unknown"
  }

  async function resolveBindingHealth(ctxKey, binding) {
    if (!binding?.projectAlias || !binding?.sessionId) return { status: "stale", reason: "malformed", ctxKey }
    if (!projects?.[binding.projectAlias] || !ocByAlias?.[binding.projectAlias]) return { status: "stale", reason: "project-missing", ctxKey }

    try {
      await validateProject(binding.projectAlias)
    } catch (err) {
      return { status: "unreachable", reason: "project-unreachable", ctxKey, retryable: isRetryableProjectError(err) }
    }

    const oc = ocByAlias[binding.projectAlias]
    if (typeof oc?.getSession !== "function") return { status: "unknown", reason: "session-check-unavailable", ctxKey }
    try {
      await oc.getSession(binding.sessionId)
      return { status: "ok", ctxKey }
    } catch (err) {
      if (isStaleBoundaryError(err, { source: "opencode", pathname: `/session/${binding.sessionId}`, method: "GET" })) {
        return { status: "stale", reason: "session-missing", ctxKey }
      }
      return { status: "unreachable", reason: "session-check-failed", ctxKey, retryable: isRetryableProjectError(err) }
    }
  }

  async function resolveBindingHealthMap(entries) {
    const pairs = await Promise.all(entries.map(async (entry) => [entry.ctxKey, await resolveBindingHealth(entry.ctxKey, entry.binding)]))
    return Object.fromEntries(pairs)
  }

  function bindingRepairKeyboard(entries, { includeRepair = false } = {}) {
    const rows = []
    for (const entry of entries) {
      const ctxKey = entry.ctxKey
      const projectAlias = entry.binding?.projectAlias
      const projectKnown = !!projects?.[projectAlias]
      rows.push([{ text: `Remove ${ctxKey}`, callback_data: runtime.cb.pack(`b|confirm-unbind|${ctxKey}`) }])
      if (projectKnown) {
        rows.push([
          { text: `Rebind startup ${ctxKey}`, callback_data: runtime.cb.pack(`b|rebind|${ctxKey}`) },
          { text: `New session ${ctxKey}`, callback_data: runtime.cb.pack(`b|new|${ctxKey}`) },
        ])
      }
      rows.push([{ text: `Keep ${ctxKey}`, callback_data: runtime.cb.pack(`b|keep|${ctxKey}`) }])
    }
    if (includeRepair) rows.push([{ text: "Repair index", callback_data: runtime.cb.pack("b|repair") }])
    rows.push([{ text: "Close", callback_data: runtime.cb.pack("b|close") }])
    return makeInlineKeyboard(rows)
  }

  function appendMoveConflict(lines, result) {
    const note = moveConflictNote(result)
    if (note) lines.push(note)
    return lines
  }

  function appendEffectiveModelLines(lines, effectiveState) {
    if (!effectiveState?.label) return lines
    lines.push(`Model: ${effectiveState.label}`)
    if (effectiveState.source && effectiveState.source !== "unknown") {
      lines.push(`Source: ${modelSourceLabel(effectiveState.source)}`)
    }
    return lines
  }

  async function buildSessionSwitchText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [
      `Changed: this thread now uses session ${sessionId}.`,
      `Project: ${projectAlias}`,
      `Session: ${sessionId}`,
    ]
    if (ctxKey) lines.push(`Feed: ${feedModeLabel(getFeedMode(ctxKey))}`)
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  async function buildNewSessionText(projectAlias, sessionId, { ctxKey } = {}) {
    const lines = [
      `Changed: this thread now uses new session ${sessionId}.`,
      `Project: ${projectAlias}`,
      `Session: ${sessionId}`,
    ]
    if (ctxKey) lines.push(`Feed: ${feedModeLabel(getFeedMode(ctxKey))}`)
    const effectiveState = await resolveEffectiveModelState(ctxKey, { projectAlias, sessionId })
    return appendEffectiveModelLines(lines, effectiveState).join("\n")
  }

  function modelModeLabel(preference, effectiveState) {
    if (preference?.mode === "project-default") {
      return effectiveState?.source === "thread-project-default" ? "Project default override" : "Project default override (unavailable)"
    }
    if (preference?.mode === "custom") return "Custom override"
    return "Inherit"
  }

  function chunkEntries(items, size) {
    const chunks = []
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
    return chunks
  }

  function trimString(value) {
    return typeof value === "string" ? value.trim() : ""
  }

  function formatProviderChoiceLabel(provider) {
    const providerId = trimString(provider?.id)
    const providerName = trimString(provider?.name)
    if (!providerId) return providerName || "unknown"
    if (!providerName || providerName.toLowerCase() === providerId.toLowerCase()) return providerId
    return `${providerName} (${providerId})`
  }

  function formatModelChoiceLabel(entry) {
    const modelId = trimString(entry?.model?.modelID)
    const modelName = trimString(entry?.name)
    if (!modelId) return modelName || "unknown"
    if (!modelName || modelName.toLowerCase() === modelId.toLowerCase()) return modelId
    return `${modelName} (${modelId})`
  }

  async function resolveModelProviderCatalog(projectAlias, ...fallbackEntries) {
    const oc = ocByAlias[projectAlias]
    const providersInfo = await oc?.getConfigProviders?.().catch(() => null)
    const providerMap = new Map()

    function ensureProvider(providerId, providerName = "") {
      const normalizedProviderId = trimString(providerId)
      if (!normalizedProviderId) return null
      const existing = providerMap.get(normalizedProviderId)
      if (existing) {
        if (providerName && (!existing.name || existing.name === existing.id)) existing.name = providerName
        return existing
      }
      const created = {
        id: normalizedProviderId,
        name: trimString(providerName) || normalizedProviderId,
        modelByKey: new Map(),
      }
      providerMap.set(normalizedProviderId, created)
      return created
    }

    function addModel(providerId, providerName, modelValue, modelName = "") {
      const model = normalizeModelReference(modelValue)
      if (!model) return
      const provider = ensureProvider(model.providerID || providerId, providerName)
      if (!provider) return
      const key = modelKeyOf(model)
      if (!key || provider.modelByKey.has(key)) return
      provider.modelByKey.set(key, {
        key,
        model,
        name: trimString(modelName) || trimString(model.modelID),
      })
    }

    if (Array.isArray(providersInfo?.providers)) {
      for (const providerEntry of providersInfo.providers) {
        const providerId = trimString(providerEntry?.id || providerEntry?.providerID || providerEntry?.providerId || providerEntry?.provider)
        if (!providerId) continue
        const providerName = trimString(providerEntry?.name)
        ensureProvider(providerId, providerName)

        const models = providerEntry?.models
        if (Array.isArray(models)) {
          for (const modelEntry of models) {
            addModel(providerId, providerName, modelEntry, modelEntry?.name || modelEntry?.id || modelEntry?.modelID || modelEntry?.modelId)
          }
          continue
        }

        if (models && typeof models === "object") {
          for (const [modelId, modelEntry] of Object.entries(models)) {
            const normalizedModel =
              normalizeModelReference(modelEntry) ||
              normalizeModelReference({
                providerID: providerId,
                modelID: trimString(modelEntry?.id || modelEntry?.modelID || modelEntry?.modelId || modelId),
              })
            addModel(providerId, providerName, normalizedModel, modelEntry?.name || modelId)
          }
        }
      }
    }

    for (const candidate of collectModelCandidates(...fallbackEntries)) {
      addModel(candidate.model?.providerID, candidate.model?.providerID, candidate.model, candidate.model?.modelID)
    }

    return [...providerMap.values()]
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: [...provider.modelByKey.values()].sort((a, b) => {
          const byName = formatModelChoiceLabel(a).localeCompare(formatModelChoiceLabel(b))
          if (byName !== 0) return byName
          return a.key.localeCompare(b.key)
        }),
      }))
      .filter((provider) => provider.models.length > 0)
      .sort((a, b) => {
        const byName = formatProviderChoiceLabel(a).localeCompare(formatProviderChoiceLabel(b))
        if (byName !== 0) return byName
        return a.id.localeCompare(b.id)
      })
  }

  function buildModelSettingsText({ binding, preference, effectiveState, configuredInfo, sessionModelInfo, providerCatalog, selectedProviderId, selectedModelKey }) {
    const lines = [
      "Model for this thread:",
      `Project: ${binding.projectAlias}`,
      `Session: ${binding.sessionId}`,
      `Mode: ${modelModeLabel(preference, effectiveState)}`,
      `Active: ${effectiveState?.label || "unknown"}`,
    ]

    if (effectiveState?.source && effectiveState.source !== "unknown") {
      lines.push(`Source: ${modelSourceLabel(effectiveState.source)}`)
    }

    lines.push(`Project default: ${configuredInfo?.label || "unknown"}`)
    if (sessionModelInfo?.label) lines.push(`Last session model: ${sessionModelInfo.label}`)

    lines.push("")
    if (selectedModelKey) {
      lines.push(`Pick a variant for: ${selectedModelKey}`)
      lines.push("Use 'No variant' to keep only provider/model.")
    } else if (selectedProviderId) {
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      lines.push(`Pick a model from provider: ${selectedProvider ? formatProviderChoiceLabel(selectedProvider) : selectedProviderId}`)
    } else {
      lines.push("Pick a mode, then choose a provider below.")
      if (!providerCatalog.length) lines.push("No providers discovered automatically. Use a typed /model command if needed.")
    }
    lines.push("Typed forms: /model default, /model reset, /model <provider/model> [variant]")

    return lines.join("\n")
  }

  async function setThreadModelPreference(ctxMeta, binding, nextPreference) {
    const preference = normalizeModelPreference(nextPreference)

    if (preference.mode === "project-default") {
      const configuredInfo = await resolveConfiguredModelInfo(binding.projectAlias)
      if (!configuredInfo?.model) {
        return {
          ok: false,
          callbackText: "No project default",
          message: "Project default model is not configured for this project.",
        }
      }
      setModelPreference(ctxMeta.ctxKey, preference)
      return { ok: true, callbackText: "Model: project default", noticeText: "Changed: this thread now uses the project default model override." }
    }

    if (preference.mode === "custom") {
      setModelPreference(ctxMeta.ctxKey, preference)
      return {
        ok: true,
        callbackText: preference.variant ? `Model: ${formatModelLabel(preference.model, preference.variant)}` : `Model: ${formatModelLabel(preference.model)}`,
        noticeText: `Changed: this thread now uses ${formatModelLabel(preference.model, preference.variant)}.`,
      }
    }

    setModelPreference(ctxMeta.ctxKey, null)
    return { ok: true, callbackText: "Model: inherit", noticeText: "Changed: this thread now inherits its model from session/project defaults." }
  }

  function modelSettingsKeyboard({ preference, providerCatalog, selectedProviderId, selectedModelKey }) {
    const currentCustomModelKey = preference.mode === "custom" ? modelKeyOf(preference.model) : ""
    const currentCustomProviderId = preference.mode === "custom" ? trimString(preference.model?.providerID) : ""

    if (selectedModelKey) {
      const selectedModel = normalizeModelReference(selectedModelKey)
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      const rows = []
      const currentVariant = preference.mode === "custom" && currentCustomModelKey === selectedModelKey ? normalizeVariant(preference.variant) : ""
      rows.push([
        {
          text: `${preference.mode === "custom" && currentCustomModelKey === selectedModelKey && !currentVariant ? "✓ " : ""}No variant`,
          callback_data: runtime.cb.pack(`m|apply|${selectedModelKey}|~`),
        },
      ])
      for (const chunk of chunkEntries(commonVariantsForModel(selectedModel), 3)) {
        rows.push(
          chunk.map((variant) => ({
            text: `${currentVariant === variant ? "✓ " : ""}${variant}`,
            callback_data: runtime.cb.pack(`m|apply|${selectedModelKey}|${variant}`),
          })),
        )
      }
      rows.push([
        { text: "Back", callback_data: runtime.cb.pack(`m|provider|${selectedProvider?.id || selectedModel?.providerID || selectedProviderId}`) },
        { text: "Close", callback_data: runtime.cb.pack("m|close") },
      ])
      return makeInlineKeyboard(rows)
    }

    if (selectedProviderId) {
      const selectedProvider = providerCatalog.find((provider) => provider.id === selectedProviderId)
      const rows = []
      for (const candidate of selectedProvider?.models || []) {
        const prefix = currentCustomModelKey === candidate.key ? "✓ " : ""
        rows.push([{ text: `${prefix}${formatModelChoiceLabel(candidate)}`, callback_data: runtime.cb.pack(`m|model|${candidate.key}`) }])
      }
      rows.push([
        { text: "Back", callback_data: runtime.cb.pack("m|root") },
        { text: "Close", callback_data: runtime.cb.pack("m|close") },
      ])
      return makeInlineKeyboard(rows)
    }

    const rows = [
      [
        { text: `${preference.mode === "inherit" ? "✓ " : ""}Inherit`, callback_data: runtime.cb.pack("m|set|inherit") },
        {
          text: `${preference.mode === "project-default" ? "✓ " : ""}Project default`,
          callback_data: runtime.cb.pack("m|set|project-default"),
        },
      ],
    ]

    for (const provider of providerCatalog) {
      const prefix = currentCustomProviderId === provider.id ? "✓ " : ""
      rows.push([{ text: `${prefix}${formatProviderChoiceLabel(provider)}`, callback_data: runtime.cb.pack(`m|provider|${provider.id}`) }])
    }

    rows.push([{ text: "Close", callback_data: runtime.cb.pack("m|close") }])
    return makeInlineKeyboard(rows)
  }

  async function renderModelSettings(ctxMeta, { binding, editMessageId, selectedProviderId, selectedModelKey, noticeText = "" } = {}) {
    const currentBinding = binding || store.getBinding(ctxMeta.ctxKey)
    if (!currentBinding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, "Model settings need a bound thread."), unboundGuidanceKeyboard())
      return
    }

    const preference = getModelPreference(ctxMeta.ctxKey)
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(currentBinding.projectAlias),
      resolveSessionModelInfo(currentBinding.projectAlias, currentBinding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, currentBinding, { configuredInfo, sessionModelInfo })
    const providerCatalog = await resolveModelProviderCatalog(
      currentBinding.projectAlias,
      preference.mode === "custom" ? preference.model : null,
      sessionModelInfo?.model,
      configuredInfo?.model,
    )
    const requestedModelKey = selectedModelKey && modelKeyOf(selectedModelKey) ? modelKeyOf(selectedModelKey) : ""
    const requestedModel = requestedModelKey ? normalizeModelReference(requestedModelKey) : null
    const normalizedSelectedModelKey =
      requestedModelKey && requestedModel
        ? providerCatalog.some((provider) => provider.id === requestedModel.providerID && provider.models.some((entry) => entry.key === requestedModelKey))
          ? requestedModelKey
          : ""
        : ""
    const normalizedSelectedProviderId =
      trimString(selectedProviderId) && providerCatalog.some((provider) => provider.id === trimString(selectedProviderId))
        ? trimString(selectedProviderId)
        : normalizedSelectedModelKey && requestedModel && providerCatalog.some((provider) => provider.id === requestedModel.providerID)
          ? requestedModel.providerID
          : ""
    const settingsText = buildModelSettingsText({
      binding: currentBinding,
      preference,
      effectiveState,
      configuredInfo,
      sessionModelInfo,
      providerCatalog,
      selectedProviderId: normalizedSelectedProviderId,
      selectedModelKey: normalizedSelectedModelKey,
    })
    const text = noticeText ? `${noticeText}\n\n${settingsText}` : settingsText
    const replyMarkup = modelSettingsKeyboard({
      preference,
      providerCatalog,
      selectedProviderId: normalizedSelectedProviderId,
      selectedModelKey: normalizedSelectedModelKey,
    })

    if (editMessageId) {
      await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function handleModelCommand(ctxMeta, argv) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, "Model changes need a bound thread."), unboundGuidanceKeyboard())
      return
    }

    const modelArg = String(argv?.[0] || "").trim()
    const variantArg = normalizeVariant(argv?.[1])
    if (!modelArg) {
      await renderModelSettings(ctxMeta, { binding })
      return
    }

    const normalized = modelArg.toLowerCase()
    if (normalized === "reset" || normalized === "inherit") {
      const result = await setThreadModelPreference(ctxMeta, binding, null)
      await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
      return
    }

    if (normalized === "default" || normalized === "project-default" || normalized === "project_default") {
      const result = await setThreadModelPreference(ctxMeta, binding, { mode: "project-default" })
      if (!result.ok) {
        await sendToThread(ctxMeta, result.message)
        return
      }
      await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
      return
    }

    const model = normalizeModelReference(modelArg)
    const reservedVariant = ["reset", "inherit", "default", "project-default", "project_default"].includes(String(variantArg || "").toLowerCase())
    if (reservedVariant) {
      await sendToThread(ctxMeta, "Usage: /model\n/model default\n/model reset\n/model <provider/model> [variant]")
      return
    }
    if (!model) {
      await sendToThread(ctxMeta, "Usage: /model\n/model default\n/model reset\n/model <provider/model> [variant]")
      return
    }

    const result = await setThreadModelPreference(ctxMeta, binding, { mode: "custom", model, variant: variantArg })
    await renderModelSettings(ctxMeta, { binding, noticeText: result.noticeText })
  }

  async function resolveLatestAssistantReply(projectAlias, sessionId) {
    const oc = ocByAlias[projectAlias]
    if (!oc?.listMessages || !sessionId) return null
    const messages = await oc.listMessages(sessionId).catch(() => null)
    if (!Array.isArray(messages) || messages.length === 0) return null

    const candidates = messages
      .filter((message) => {
        const info = message?.info || message || {}
        if (info?.role !== "assistant") return false
        if (!runtime.mirrorCompaction && (info?.mode === "compaction" || info?.agent === "compaction")) return false
        return true
      })
      .sort(compareMessageRecency)

    for (const candidate of candidates) {
      const info = candidate?.info || candidate || {}
      const messageId = String(info?.id || "").trim()
      let message = candidate
      let text = extractAssistantDisplayText(projectAlias, message)
      if ((!text || !text.trim()) && messageId) {
        const fetched = await oc.getMessage(sessionId, messageId).catch(() => null)
        if (fetched) {
          message = fetched
          text = extractAssistantDisplayText(projectAlias, message)
        }
      }
      if (!text || !text.trim()) continue
      return { messageId: messageId || "sendlast", sessionId, text }
    }

    return null
  }

  function sessionsKeyboard(projectAlias, sessions, { currentSessionId, startupSessionId, limit = 10 } = {}) {
    const normalized = normalizeSessionsList(sessions).slice(0, limit)
    const rows = normalized.map((session) => [
      {
        text: formatSessionButtonLabel(session, { currentSessionId, startupSessionId }),
        callback_data: runtime.cb.pack(`s|${projectAlias}|${session.id}`),
      },
    ])
    rows.push([
      { text: "Refresh", callback_data: runtime.cb.pack("s|refresh") },
      { text: "New", callback_data: runtime.cb.pack("s|new") },
      { text: "Close", callback_data: runtime.cb.pack("s|close") },
    ])
    return makeInlineKeyboard(rows)
  }

  function closeKeyboard(callbackData = "s|close") {
    return makeInlineKeyboard([[{ text: "Close", callback_data: runtime.cb.pack(callbackData) }]])
  }

  async function renderSessionsList(ctxMeta, { binding, editMessageId } = {}) {
    const oc = ocByAlias[binding.projectAlias]
    const sessions = await oc.listSessions({ directory: projects?.[binding.projectAlias]?.directory, limit: 10 })
    const [configuredInfo, sessionModelInfo] = await Promise.all([
      resolveConfiguredModelInfo(binding.projectAlias),
      resolveSessionModelInfo(binding.projectAlias, binding.sessionId),
    ])
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding, { configuredInfo, sessionModelInfo })
    runtime.markProjectUp(binding.projectAlias)
    const text = formatSessionsListText(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      currentSessionModelLabel: effectiveState?.label,
      currentSessionModelSourceLabel:
        effectiveState?.source && effectiveState.source !== "unknown" ? modelSourceLabel(effectiveState.source) : "",
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    const replyMarkup = sessionsKeyboard(binding.projectAlias, sessions, {
      currentSessionId: binding.sessionId,
      startupSessionId: startupSessionByProject[binding.projectAlias],
    })
    if (editMessageId) {
      await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function renderProjectSessions(ctxMeta, projectAlias, { editMessageId } = {}) {
    if (!projectAlias || !projects?.[projectAlias]) {
      await safeInformThread(ctxMeta, "Unknown project.")
      return
    }
    const existing = store.getBinding(ctxMeta.ctxKey)
    if (ctxMeta?.chatType !== "private" && existing?.projectAlias !== projectAlias) {
      await safeInformThread(ctxMeta, "Use project session actions only in a private chat unless this thread is bound to that project.")
      return
    }
    const startupSid = startupSessionByProject[projectAlias] || (await resolveStartupSession(projectAlias)) || ""
    if (existing?.projectAlias !== projectAlias) {
      const oc = ocByAlias[projectAlias]
      const sessions = await oc.listSessions({ directory: projects?.[projectAlias]?.directory, limit: 10 })
      runtime.markProjectUp(projectAlias)
      const text = `${formatSessionsListText(projectAlias, sessions, { startupSessionId: startupSid })}\n\nViewing only. Bind the target chat/thread to switch sessions with buttons.`
        .replace("Tap a button below to switch:\n\n", "")
        .replace("Use /new to create one or /use <sessionId> to switch.", "Bind the target chat/thread to this project before creating or switching sessions from Telegram.")
        .replace("Use /use <sessionId> to switch.", "Use /bind <projectAlias> in the target chat/thread, then /use <sessionId> to switch.")
      const replyMarkup = closeKeyboard("srv|close")
      if (editMessageId) {
        await runtime.tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
        return
      }
      await sendToThread(ctxMeta, text, replyMarkup)
      return
    }
    await renderSessionsList(ctxMeta, {
      binding: { projectAlias, sessionId: existing.sessionId || startupSid },
      editMessageId,
    })
  }

  async function handleBindCommand(ctxMeta, argv) {
    const alias = argv[0]
    if (!alias) {
      await sendToThread(ctxMeta, "Usage: /bind <projectAlias>")
      return
    }
    try {
      await validateProject(alias)
      const oc = ocByAlias[alias]

      const existing = store.getBinding(ctxMeta.ctxKey)
      if (existing && existing.projectAlias === alias && existing.sessionId) {
        await sendToThread(ctxMeta, `Already bound: ${alias} / ${existing.sessionId}`)
        return
      }
      const startupSid = await resolveValidStartupSession(alias, oc)
      if (startupSid) {
        const bindResult = await bindCtxToSession(ctxMeta, alias, startupSid)
        await sendToThread(ctxMeta, appendMoveConflict([`Bound to project '${alias}' (startup session): ${startupSid}`], bindResult).join("\n"))
      } else {
        const created = await oc.createSession({})
        const createdId = requireSessionIdFromBackend(created?.id, "created session id")
        logger.info(`[${alias}] created session for bind:`, createdId)
        startupSessionByProject[alias] = createdId
        const bindResult = await bindCtxToSession(ctxMeta, alias, createdId)
        await sendToThread(ctxMeta, appendMoveConflict([`Bound to project '${alias}' with new session: ${createdId}`], bindResult).join("\n"))
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err)).catch(() => {})
    }
  }

  async function handleNewCommand(ctxMeta, title) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Creating a session needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const p = projects[binding.projectAlias]
      const attachOnNewMode = String(p?.openAttachOnNewMode || "same-window")
      const created = await oc.createSession({ title: title || undefined })
      const createdId = requireSessionIdFromBackend(created?.id, "created session id")
      logger.info(`[${binding.projectAlias}] /new created session:`, createdId)

      let tuiSwitchErr = null
      const canRequestTuiSwitch = attachOnNewMode === "same-window" && typeof oc?.selectTuiSession === "function"
      if (canRequestTuiSwitch) {
        await oc
          .selectTuiSession(createdId, { timeoutMs: 2500 })
          .then(() => {
            logger.info(`[${binding.projectAlias}] requested TUI switch to session:`, createdId)
          })
          .catch((err) => {
            tuiSwitchErr = err
            logger.info(
              `[${binding.projectAlias}] failed to request TUI switch (same-window) for session=${createdId}: ${err?.message || String(err)}`,
            )
          })
      }

      let activeSessionSyncUnsupported = false
      if (attachOnNewMode === "same-window" && !tuiSwitchErr && typeof oc?.getActiveTuiSession === "function") {
        await oc.getActiveTuiSession({ timeoutMs: 1500 }).catch((err) => {
          if (err?.isBoundaryError === true && err.status === 404) {
            activeSessionSyncUnsupported = true
            logger.info(`[${binding.projectAlias}] /tui/active-session is unavailable; same-window /new will bind immediately without TUI auto-follow.`)
          }
        })
      }

      const sameWindowSwitchFailed = attachOnNewMode === "same-window" && (!canRequestTuiSwitch || !!tuiSwitchErr)
      if (attachOnNewMode === "same-window") {
        const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, createdId)
        primeTuiActiveSessionFollow?.(binding.projectAlias, ctxMeta, binding.sessionId, { pendingTargetSessionId: createdId })

        const lines = [await buildNewSessionText(binding.projectAlias, createdId, { ctxKey: ctxMeta.ctxKey })]
        if (sameWindowSwitchFailed) {
          lines.push(
            `Note: Could not switch the existing TUI automatically in same-window mode. Telegram is already using the new session; switch or reattach the TUI manually if needed.`,
          )
        } else {
          lines.push(`Requested same-window TUI switch to session: ${createdId}.`)
        }
        if (activeSessionSyncUnsupported) {
          lines.push(
            `Note: This opencode server does not expose active TUI session tracking; Telegram is already using the new session, but future TUI-only switches will not be followed automatically.`,
          )
        }
        await sendToThread(ctxMeta, appendMoveConflict(lines, bindResult).join("\n"))
      } else {
        const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, createdId)
        await sendToThread(ctxMeta, appendMoveConflict([await buildNewSessionText(binding.projectAlias, createdId, { ctxKey: ctxMeta.ctxKey })], bindResult).join("\n"))
      }

      if (attachOnNewMode === "new-window") {
        const launchSupport = getLaunchSupport({ project: p, platform })
        const openAttach = openAttachWindowFn || openAttachWindowWindowsFn
        if (launchSupport.canOpenAttachWindow && openAttach) {
          await openAttach({ directory: p.directory, baseUrl: p.baseUrl, sessionId: createdId, platform }).catch((err) => {
            logger.error("Failed to open attach window:", binding.projectAlias, err?.message || String(err))
          })
        } else {
          logger.info(`[${binding.projectAlias}] openAttachOnNewMode=new-window is configured, but no attach-window launcher is available on platform=${platform}.`)
        }
      } else if (attachOnNewMode === "same-window") {
        logger.info(`[${binding.projectAlias}] /new created ${createdId}; openAttachOnNewMode=same-window (no new window spawned).`)
      }
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleUseCommand(ctxMeta, sessionId) {
    const sessionRef = parseSessionReference(sessionId)
    if (!sessionRef) {
      await safeInformThread(ctxMeta, "Usage: /use <sessionId|shareLink>")
      return
    }
    if (sessionRef.type === "invalid-link") {
      await safeInformThread(
        ctxMeta,
        "Unsupported link. Use an OpenCode share link like https://opncd.ai/share/<share-id> (or https://opncd.ai/s/<share-id>) or a raw session id.",
      )
      return
    }
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Switching sessions needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    const oc = ocByAlias[binding.projectAlias]

    async function listSessionsForShareLookup(projectAlias) {
      return ocByAlias[projectAlias].listSessions({ directory: projects?.[projectAlias]?.directory })
    }

    try {
      let targetSessionId = sessionRef.sessionId
      if (sessionRef.type === "session-id") {
        targetSessionId = normalizeSafeSessionId(targetSessionId)
        if (!targetSessionId) {
          await safeInformThread(ctxMeta, invalidSessionReferenceText())
          return
        }
      }
      if (sessionRef.type === "share-link") {
        const currentSessions = await listSessionsForShareLookup(binding.projectAlias)
        const currentMatch = findSessionByShareUrl(currentSessions, sessionRef.shareUrl)
        if (currentMatch?.id) {
          targetSessionId = normalizeSafeSessionId(currentMatch.id)
          if (!targetSessionId) {
            await safeInformThread(ctxMeta, "Share link resolved to an invalid session id; refusing to bind it.")
            return
          }
        } else {
          let mismatch = null
          const otherLookupErrors = []
          for (const alias of Object.keys(projects)) {
            if (alias === binding.projectAlias) continue
            try {
              const otherSessions = await listSessionsForShareLookup(alias)
              const otherMatch = findSessionByShareUrl(otherSessions, sessionRef.shareUrl)
              if (otherMatch?.id) {
                mismatch = { projectAlias: alias, sessionId: normalizeSafeSessionId(otherMatch.id) || String(otherMatch.id) }
                break
              }
            } catch (err) {
              logger.warn(`Failed to check share link against project '${alias}':`, err?.message || String(err))
              otherLookupErrors.push(alias)
            }
          }

          if (mismatch) {
            await safeInformThread(
              ctxMeta,
              `This share link belongs to project '${mismatch.projectAlias}' (session: ${mismatch.sessionId}), but this thread is bound to '${binding.projectAlias}'. Use /bind ${mismatch.projectAlias} first.`,
            )
            return
          }

          if (otherLookupErrors.length) {
            await safeInformThread(
              ctxMeta,
              `Share link was not found in project '${binding.projectAlias}', but these project lookups failed: ${otherLookupErrors.join(", ")}. The link may belong to one of them; try again when those projects are available.`,
            )
            return
          }

          await safeInformThread(
            ctxMeta,
            `Share link not found in project '${binding.projectAlias}'. It may belong to a different project or may not be shared on this server.`,
          )
          return
        }
      }

      targetSessionId = normalizeSafeSessionId(targetSessionId)
      if (!targetSessionId) {
        await safeInformThread(ctxMeta, invalidSessionReferenceText())
        return
      }
      await oc.getSession(targetSessionId)
      const bindResult = await bindCtxToSession(ctxMeta, binding.projectAlias, targetSessionId)
      await sendToThread(ctxMeta, appendMoveConflict([await buildSessionSwitchText(binding.projectAlias, targetSessionId, { ctxKey: ctxMeta.ctxKey })], bindResult).join("\n"))
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleSessions(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Session list needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    try {
      await renderSessionsList(ctxMeta, { binding })
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleAbort(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Abort needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    try {
      const aborted = await oc.abortSession(binding.sessionId)
      runtime.markProjectUp(binding.projectAlias)
      await sendToThread(
        ctxMeta,
        aborted === false ? `No active run to abort for session: ${binding.sessionId}` : `Abort requested for session: ${binding.sessionId}`,
      )
    } catch (err) {
      await sendToThread(ctxMeta, formatProjectUnavailable(binding.projectAlias, err)).catch(() => {})
    }
  }

  async function handleWhere(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Status needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    const health = await resolveBindingHealth(ctxMeta.ctxKey, binding)
    const startupSessionId = startupSessionByProject[binding.projectAlias] || "unknown"
    const sseStatus = getProjectSseStatus(binding.projectAlias)
    const baseUrl = sanitizeBaseUrlForDisplay(projects?.[binding.projectAlias]?.baseUrl) || "unknown"
    const feedMode = feedModeLabel(getFeedMode(ctxMeta.ctxKey))
    const effectiveState = await resolveEffectiveModelState(ctxMeta.ctxKey, binding)
    const runtimeLines = buildRuntimeStatusLines?.(binding.projectAlias) || []
    const replyMarkup = health.status === "ok"
      ? boundThreadActionsKeyboard(ctxMeta)
      : makeInlineKeyboard([
        ...boundThreadActionsKeyboard(ctxMeta).inline_keyboard.slice(0, 2),
        ...bindingRepairKeyboard([{ ctxKey: ctxMeta.ctxKey, binding, health }]).inline_keyboard,
      ])
    await sendToThread(
      ctxMeta,
      appendEffectiveModelLines(
        [
          `Project: ${binding.projectAlias}`,
          `Session: ${binding.sessionId}`,
          `Startup session: ${startupSessionId}`,
          `Feed: ${feedMode}`,
          `SSE: ${sseStatus}`,
          `Base URL: ${baseUrl}`,
          `Binding health: ${bindingHealthLabel(health)}`,
          ...runtimeLines,
        ],
        effectiveState,
      ).join("\n"),
      replyMarkup,
    )
  }

  async function handleRuntime(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, "Use /runtime only in a private chat with the bot. Runtime state can include project aliases and operational details.")
      return
    }
    const lines = buildGlobalRuntimeStatusLines?.() || ["Runtime status is unavailable."]
    await sendToThread(ctxMeta, ["Runtime:", ...lines].join("\n"), runtimeControlsKeyboard())
  }

  async function handleFeed(ctxMeta, { editMessageId } = {}) {
    await renderFeedSettings(ctxMeta, { editMessageId })
  }

  async function handleBindings(ctxMeta) {
    if (ctxMeta?.chatType !== "private") {
      await safeInformThread(ctxMeta, "Use /bindings only in a private chat with the bot. Bindings contain sensitive session IDs.")
      return
    }
    const entries = Object.entries(store.get().bindings || {})
      .map(([ctxKey, binding]) => ({ ctxKey, binding, ctx: parseCtxKey(ctxKey) }))
      .sort((a, b) => {
        const byChat = runtime.compareNumbers(a.ctx?.chatId ?? 0, b.ctx?.chatId ?? 0)
        if (byChat !== 0) return byChat
        const byThread = runtime.compareNumbers(a.ctx?.threadIdOr0 ?? 0, b.ctx?.threadIdOr0 ?? 0)
        if (byThread !== 0) return byThread
        return a.ctxKey.localeCompare(b.ctxKey)
      })

    if (!entries.length) {
      await safeInformThread(ctxMeta, "No bindings.")
      return
    }

    const repairPreview = store.repairBindingIndex?.({ dryRun: true })
    const healthByCtx = await resolveBindingHealthMap(entries)

    const lines = ["Bindings:"]
    for (const entry of entries) {
      const scope = entry.ctx ? `chat ${entry.ctx.chatId} / ${formatThreadLabel(entry.ctx.threadIdOr0)}` : entry.ctxKey
      const current = entry.ctxKey === ctxMeta.ctxKey ? " (current)" : ""
      lines.push(`- ${scope}${current} -> ${entry.binding.projectAlias} / ${entry.binding.sessionId} [${bindingHealthLabel(healthByCtx[entry.ctxKey])}]`)
    }
    if (repairPreview?.changed) {
      lines.push(
        `Index repair available: removedBindings=${repairPreview.removedBindings?.length || 0} removedIndex=${repairPreview.removedIndexEntries?.length || 0} rebuilt=${repairPreview.rebuiltIndexEntries || 0}`,
      )
    }
    await sendToThread(ctxMeta, lines.join("\n"), bindingRepairKeyboard(entries, { includeRepair: true }))
  }

  async function handleSendLast(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await safeInformThread(ctxMeta, unboundGuidanceText(ctxMeta, "Sending the last assistant reply needs a bound thread."), unboundGuidanceKeyboard())
      return
    }
    const oc = ocByAlias[binding.projectAlias]
    if (!oc) {
      await safeInformThread(ctxMeta, `Unknown project: ${binding.projectAlias}`)
      return
    }
    const sk = sessionKey(binding.projectAlias, binding.sessionId)
    const latest = await resolveLatestAssistantReply(binding.projectAlias, binding.sessionId)
    if (latest) {
      lastAssistantBySession.set(sk, latest)
      await deliverAssistantText(ctxMeta, binding.projectAlias, latest.sessionId, latest.messageId, latest.text)
      return
    }

    const last = lastAssistantBySession.get(sk)
    const messageId = last?.messageId
    const messageSessionId = last?.sessionId || binding.sessionId
    let text = typeof last?.text === "string" ? last.text : ""

    if (messageId) {
      const msg = await oc.getMessage(messageSessionId, messageId).catch(() => null)
      if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        // ignore
      } else {
        const fetched = extractAssistantDisplayText(binding.projectAlias, msg)
        if (fetched && fetched.trim()) text = fetched
      }
    }

    if (!text || !text.trim()) {
      await safeInformThread(ctxMeta, "No assistant message yet.")
      return
    }
    await deliverAssistantText(ctxMeta, binding.projectAlias, messageSessionId, messageId || "sendlast", text)
  }

  async function handleProjects(ctxMeta) {
    const aliases = Object.keys(projects)
    await Promise.allSettled(aliases.map((a) => resolveStartupSession(a, { forceRefresh: true })))
    const currentBinding = store.getBinding(ctxMeta.ctxKey)
    const lines = [buildProjectsOverviewText({
      startupSessionByProject,
      formatThreadLabel,
      previewLimit: 3,
      showBindingScopes: ctxMeta?.chatType === "private",
    })]
    if (ctxMeta?.chatType === "private") {
      const entries = Object.entries(store.get().bindings || {}).map(([ctxKey, binding]) => ({ ctxKey, binding }))
      const healthByCtx = await resolveBindingHealthMap(entries)
      const byProject = new Map()
      for (const entry of entries) {
        const alias = entry.binding?.projectAlias || "unknown"
        const bucket = byProject.get(alias) || { ok: 0, stale: 0, unreachable: 0, unknown: 0 }
        const status = healthByCtx[entry.ctxKey]?.status || "unknown"
        if (Object.hasOwn(bucket, status)) bucket[status] += 1
        else bucket.unknown += 1
        byProject.set(alias, bucket)
      }
      if (byProject.size) {
        lines.push("Binding health:")
        for (const [alias, bucket] of [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`- ${alias}: ok=${bucket.ok} stale=${bucket.stale} unreachable=${bucket.unreachable} unknown=${bucket.unknown}`)
        }
      }
    }
    const replyMarkup = buildProjectsOverviewKeyboard?.({
      platform,
      showProjectControls: ctxMeta?.chatType === "private",
      showSessions: ctxMeta?.chatType === "private",
      showBindControls: ctxMeta?.chatType === "private" || !currentBinding,
      currentBinding,
    })
    await sendToThread(ctxMeta, lines.join("\n"), replyMarkup)
  }

  async function handleUnbind(ctxMeta) {
    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, "This thread is already unbound."), unboundGuidanceKeyboard())
      return
    }
    await sendToThread(ctxMeta, unbindConfirmationText(ctxMeta, binding), unbindConfirmationKeyboard(ctxMeta.ctxKey, binding))
  }

  async function handleTelegramMessage(msg, options = {}) {
    if (!runtime.isAllowedUser(msg?.from)) return
    const ctxMeta = runtime.ctxMetaFromMessage(msg)
    if (!ctxMeta.chatId) return

    const text = typeof msg?.text === "string" ? msg.text : ""
    const hasText = !!text.trim()
    const hasDocument = !!msg?.document
    const mediaKind = unsupportedMediaKind(msg)
    if (!hasText && !hasDocument && !mediaKind) return

    const messageKey = telegramMessageIdempotencyKey(ctxMeta, msg)
    if (hasIdempotencyKey(messageKey)) return

    async function markMessageHandled(operation, metadata = {}) {
      await markIdempotencyEntries([
        {
          key: messageKey,
          metadata: {
            kind: "telegram-message",
            ctxKey: ctxMeta.ctxKey,
            operation,
            updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
            messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
            ...metadata,
          },
        },
      ])
    }

    const awaitingQ = awaitingCustomAnswer.get(ctxMeta.ctxKey)
    if (awaitingQ) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This question expects a text answer. Send text or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("questionNonText", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const wizard = getWizard(awaitingQ.projectAlias, awaitingQ.requestId, awaitingQ.sessionID)
      if (!wizard || wizard.index !== awaitingQ.qIndex) {
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await sendToThread(ctxMeta, "Question is no longer active.")
        await markMessageHandled("customAnswerStale", { projectAlias: awaitingQ.projectAlias })
        return
      }
      const nextWizard = cloneWizardState(wizard)
      nextWizard.answers[awaitingQ.qIndex] = [text]
      const nextIndex = awaitingQ.qIndex + 1
      if (nextIndex >= wizard.request.questions.length) {
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        const result = await finishQuestionWizard(wizard)
        if (result?.outcome === "retryable") {
          await sendToThread(ctxMeta, "Question answer is temporarily unavailable. Send the answer again or /cancel.").catch(() => {})
          return
        }
        await markMessageHandled("replyQuestion", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })
      } else {
        nextWizard.index = nextIndex
        await sendCurrentQuestionStep(nextWizard)
        applyWizardState(wizard, nextWizard)
        persistQuestionWizard(wizard)
        setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        await store.flush?.()
        await markMessageHandled("questionNextStep", { projectAlias: awaitingQ.projectAlias, sessionId: wizard.sessionID })
      }
      return
    }

    const awaiting = rejectNoteAwaiting.get(ctxMeta.ctxKey)
    if (awaiting) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This permission flow expects a text rejection note. Send text or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("permissionNoteNonText", { projectAlias: awaiting.projectAlias })
        return
      }
      const oc = ocByAlias[awaiting.projectAlias]
      const noteKey = permissionNoteIdempotencyKey(awaiting.projectAlias, awaiting.sessionID, awaiting.permissionId, text)
      if (hasIdempotencyKey(noteKey)) {
        store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
        setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        await markMessageHandled("replyPermissionNote", { projectAlias: awaiting.projectAlias })
        await sendToThread(ctxMeta, "Rejection note already sent.").catch(() => {})
        return
      }
      try {
        await oc.replyPermission(awaiting.permissionId, { reply: "reject", message: text })
      } catch (err) {
        if (isStaleBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await markIdempotencyEntries([
            {
              key: noteKey,
              metadata: {
                kind: "permission-note",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermission",
                action: "reject_note",
              },
            },
            {
              key: messageKey,
              metadata: {
                kind: "telegram-message",
                projectAlias: awaiting.projectAlias,
                ctxKey: ctxMeta.ctxKey,
                operation: "replyPermissionNote",
                updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
                messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
              },
            },
          ], { flush: false })
          store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
          setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
          await store.flush?.()
          await sendToThread(ctxMeta, "Permission request is no longer active.").catch(() => {})
          return
        }
        if (isRetryableBoundaryError(err, { source: "opencode", pathname: `/permission/${awaiting.permissionId}/reply`, method: "POST" })) {
          await sendToThread(ctxMeta, "Permission reply is temporarily unavailable. Send the note again or /cancel.").catch(() => {})
          return
        }
        throw err
      }
      await markIdempotencyEntries([
        {
          key: noteKey,
          metadata: {
            kind: "permission-note",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermission",
            action: "reject_note",
          },
        },
        {
          key: messageKey,
          metadata: {
            kind: "telegram-message",
            projectAlias: awaiting.projectAlias,
            ctxKey: ctxMeta.ctxKey,
            operation: "replyPermissionNote",
            updateId: Number.isInteger(options?.updateId) ? options.updateId : undefined,
            messageId: Number.isInteger(msg?.message_id) ? msg.message_id : undefined,
          },
        },
      ], { flush: false })
      recordPromptAnswered?.(awaiting.projectAlias, "permission", "ok")
      store.deletePendingPermission(awaiting.projectAlias, awaiting.permissionId, awaiting.sessionID)
      setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
      await store.flush?.()
      await sendToThread(ctxMeta, "Rejection note sent.").catch(() => {})
      return
    }

    const awaitingBind = bindAliasAwaiting.get(ctxMeta.ctxKey)
    if (awaitingBind) {
      if (!hasText) {
        await sendToThread(ctxMeta, "This bind flow expects a project alias as text. Send an alias or /cancel.", closeOnlyKeyboard())
        await markMessageHandled("bindAliasNonText")
        return
      }
      if (isCommand(text)) {
        const { cmd, argv } = parseCommand(text)
        if (!cmd) return
        if (cmd === "/cancel") {
          bindAliasAwaiting.delete(ctxMeta.ctxKey)
          await sendToThread(ctxMeta, "Cancelled.")
          await markMessageHandled("bindAliasCancel")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
      } else {
        const alias = String(text).trim().split(/\s+/)[0]
        if (!alias) {
          await sendToThread(ctxMeta, "Send project alias (e.g. 'myproj') or /cancel.")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, [alias])
        await markMessageHandled("bindAlias", { projectAlias: alias })
        return
      }
    }

    if (hasText && isCommand(text)) {
      const { cmd, args, argv } = parseCommand(text)
      if (!cmd) return
      if (cmd === "/cancel") {
        const hadBind = bindAliasAwaiting.delete(ctxMeta.ctxKey)
        const hadRejectNote = rejectNoteAwaiting.has(ctxMeta.ctxKey)
        const hadCustomAnswer = awaitingCustomAnswer.has(ctxMeta.ctxKey)
        if (hadRejectNote) setRejectNoteAwaitingState(ctxMeta.ctxKey, null)
        if (hadCustomAnswer) setAwaitingCustomAnswerState(ctxMeta.ctxKey, null)
        const cancelled = hadBind || hadRejectNote || hadCustomAnswer
        await sendToThread(ctxMeta, cancelled ? "Cancelled." : "Nothing to cancel.")
        await markMessageHandled("cancel")
        return
      }
      if (cmd === "/help" || cmd === "/start") {
        const binding = store.getBinding(ctxMeta.ctxKey)
        await sendToThread(
          ctxMeta,
          helpText({ scopeLabel: threadScopeLabel(ctxMeta), defaultProject: configuredDefaultProject(), isBound: !!binding }),
          binding ? boundThreadActionsKeyboard(ctxMeta) : unboundGuidanceKeyboard(),
        )
        await markMessageHandled(cmd)
        return
      }
      if (cmd === "/bind") {
        if (!argv?.[0]) {
          bindAliasAwaiting.set(ctxMeta.ctxKey, { startedAt: Date.now() })
          await sendToThread(ctxMeta, `${unboundGuidanceText(ctxMeta, "Send a project alias for this thread, or tap a button below.")}\nYou can /cancel.`, unboundGuidanceKeyboard())
          await markMessageHandled("bindPrompt")
          return
        }
        bindAliasAwaiting.delete(ctxMeta.ctxKey)
        await handleBindCommand(ctxMeta, argv)
        await markMessageHandled("bind", { projectAlias: argv[0] })
        return
      }
      if (cmd === "/new") {
        await handleNewCommand(ctxMeta, args)
        await markMessageHandled("new")
        return
      }
      if (cmd === "/use") {
        await handleUseCommand(ctxMeta, argv[0])
        await markMessageHandled("use")
        return
      }
      if (cmd === "/sessions") {
        await handleSessions(ctxMeta)
        await markMessageHandled("sessions")
        return
      }
      if (cmd === "/model") {
        await handleModelCommand(ctxMeta, argv)
        await markMessageHandled("model")
        return
      }
      if (cmd === "/feed") {
        await handleFeed(ctxMeta)
        await markMessageHandled("feed")
        return
      }
      if (cmd === "/status") {
        await handleWhere(ctxMeta)
        await markMessageHandled("status")
        return
      }
      if (cmd === "/runtime" || cmd === "/health") {
        await handleRuntime(ctxMeta)
        await markMessageHandled("runtime")
        return
      }
      if (cmd === "/bindings") {
        await handleBindings(ctxMeta)
        await markMessageHandled("bindings")
        return
      }
      if (cmd === "/abort") {
        await handleAbort(ctxMeta)
        await markMessageHandled("abort")
        return
      }
      if (cmd === "/sendlast") {
        await handleSendLast(ctxMeta)
        await markMessageHandled("sendlast")
        return
      }
      if (cmd === "/projects") {
        await handleProjects(ctxMeta)
        await markMessageHandled("projects")
        return
      }
      if (cmd === "/unbind") {
        await handleUnbind(ctxMeta)
        await markMessageHandled("unbind")
        return
      }
      await sendToThread(ctxMeta, "Unknown command. Use /help.")
      await markMessageHandled("unknownCommand")
      return
    }

    const binding = store.getBinding(ctxMeta.ctxKey)
    if (!binding) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta), unboundGuidanceKeyboard())
      await markMessageHandled("unbound")
      return
    }

    if (hasDocument) {
      await handleAttachmentDocumentMessage(ctxMeta, msg, binding, messageKey, markMessageHandled, options)
      return
    }

    if (mediaKind) {
      await sendToThread(ctxMeta, unsupportedMediaText(mediaKind, { limits: userAttachmentLimits }), closeOnlyKeyboard())
      await markMessageHandled("unsupportedMedia", { projectAlias: binding.projectAlias, sessionId: binding.sessionId, action: mediaKind })
      return
    }

    if (!hasText) return

    const oc = ocByAlias[binding.projectAlias]
    const prefix = config.tgPrefix ?? "[TG] "
    try {
      const promptText = `${prefix}${text}`
      const sk = sessionKey(binding.projectAlias, binding.sessionId)
      ensureRecentPromptSet(sk).add(hashTextForEcho(promptText))
      const promptOverride = await resolvePromptOverride(ctxMeta.ctxKey, binding)
      await oc.promptAsync(binding.sessionId, promptText, promptOverride || undefined)
      await markMessageHandled("promptAsync", { projectAlias: binding.projectAlias, sessionId: binding.sessionId })
    } catch (err) {
      const alias = binding.projectAlias
      const withButton = isRetryableProjectError(err) && canAutoStartProject(alias, { platform })
      recordRetryableOpenCodeFailure(alias, err, {
        operation: "POST /session/:id/prompt_async",
        method: "POST",
        pathname: `/session/${binding.sessionId}/prompt_async`,
      })
      await sendToThread(ctxMeta, formatProjectUnavailable(alias, err), withButton ? startServerKeyboard(alias) : null).catch(() => {})
      if (isRetryableProjectError(err)) throw err
    }
  }

  return {
    renderSessionsList,
    renderModelSettings,
    handleBindCommand,
    handleNewCommand,
    handleUseCommand,
    handleSessions,
    handleModelCommand,
    handleAbort,
    handleWhere,
    handleRuntime,
    handleFeed,
    handleBindings,
    handleSendLast,
    handleProjects,
    renderProjectSessions,
    handleUnbind,
    handleAttachmentConfirmation,
    handleTelegramMessage,
    buildSessionSwitchText,
    setThreadModelPreference,
  }
}
