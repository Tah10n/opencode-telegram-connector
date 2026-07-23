import { classifyBoundaryError, makeBoundaryError } from "../../boundary-errors.js"
import { normalizeOpenCodeOutboxReadTimeoutMs } from "../../config/outbox.js"
import { sessionKey } from "../../state/store.js"
import { normalizeEpochMs } from "../active-turns.js"
import { NOISY_SKIP_REASONS } from "../noisy-skip-reasons.js"
import { agentStopErrorDedupeKey, extractTextParts, formatAgentStopErrorNotice } from "./assistant-format.js"
import { formatUserMirrorBlocks } from "./user-format.js"
import { editPreviewOrNull } from "./preview-edit.js"

function isMissingOpenCodeMessage(err) {
  const classification = classifyBoundaryError(err)
  return classification.stale || classification.status === 404 || classification.status === 410
}

function unconfirmedAgentError(cause) {
  return makeBoundaryError({
    source: "opencode",
    operation: "verify durable agent error",
    kind: "unavailable",
    outcome: "retryable",
    message: "OpenCode agent error is not available for durable Telegram delivery yet",
    ...(cause ? { cause } : {}),
  })
}

export function createOutboxDelivery({
  tg,
  store,
  ocByAlias,
  runtime,
  assistantPreviewBySession,
  lastAssistantBySession,
  ensureForwardedSets,
  extractAssistantDisplayText,
  extractChangedFilesSummary,
  getAssistantMessageWithRetry,
  deliverAssistantText,
  deliverChangedFilesSummary,
  shouldMirrorToFeed,
  previewMatchesRoute,
  sendToThread,
  logSseDebug,
  recordNoisySkip,
  recordAssistantMirrored,
  openCodeReadTimeoutMs,
} = {}) {
  const requestTimeoutMs = normalizeOpenCodeOutboxReadTimeoutMs(openCodeReadTimeoutMs ?? runtime?.config?.opencodeOutboxReadTimeoutMs, {
    fieldName: "openCodeReadTimeoutMs",
  })

  async function finalizePreview(routeCtx, telegramMessageId, text, signal) {
    const edited = await editPreviewOrNull(() => tg.editMessageText(routeCtx.chatId, telegramMessageId, text, null, { signal }))
    if (edited) return
    await sendToThread(routeCtx, text, null, { signal })
  }

  return async function deliverOutboxItem(item, { checkpoint, signal = runtime?.abortSignal } = {}) {
    const routeCtx = { ...item.route }
    const currentBinding = store.getBinding?.(routeCtx.ctxKey)
    if (!currentBinding || currentBinding.projectAlias !== item.projectAlias || currentBinding.sessionId !== item.boundSessionId) {
      logSseDebug(item.projectAlias, item.sessionId, `drop=outbox_stale_route msg=${item.messageId} thread=${routeCtx.threadIdOr0 || 0}`)
      return { delivered: false, reason: "stale-route" }
    }
    const oc = ocByAlias[item.projectAlias]
    if (!oc) {
      logSseDebug(item.projectAlias, item.sessionId, `drop=outbox_project_missing msg=${item.messageId}`)
      return { delivered: false, reason: "project-not-configured" }
    }
    const sk = sessionKey(item.projectAlias, item.sessionId)
    const sets = ensureForwardedSets(sk)
    const progress = { ...(item.progress || {}) }
    const persistProgress = async (patch) => {
      Object.assign(progress, patch)
      await checkpoint?.(patch)
    }

    if (item.type === "user-mirror") {
      const msg = await oc.getMessage(item.sessionId, item.messageId, { signal, timeoutMs: requestTimeoutMs }).catch((err) => {
        if (!isMissingOpenCodeMessage(err)) throw err
        throw makeBoundaryError({
          source: "opencode",
          operation: "recover durable TUI user message",
          kind: "unavailable",
          outcome: "retryable",
          message: "OpenCode user message is not available for durable Telegram delivery",
          cause: err,
        })
      })
      const text = extractTextParts(msg)
      if (!text?.trim()) return
      const blocks = formatUserMirrorBlocks(text)
      for (let index = Number.isInteger(progress.userBlockIndex) ? progress.userBlockIndex : 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block?.type === "text" && block.html) {
          await tg.sendHtmlBlocks(routeCtx.chatId, [block], null, {
            message_thread_id: routeCtx.threadIdOr0 || undefined,
            signal,
          })
        }
        await persistProgress({ userBlockIndex: index + 1 })
      }
      sets.user.add(item.messageId)
      logSseDebug(item.projectAlias, item.sessionId, `send=user_outbox msg=${item.messageId} thread=${routeCtx.threadIdOr0 || 0}`)
      return
    }

    if (item.type === "agent-error") {
      if (progress.noticeDelivered === true) return
      const requireMessageError = item.payload?.requireMessageError === true
      let msg = null
      try {
        msg = await oc.getMessage(item.sessionId, item.messageId, { signal, timeoutMs: requestTimeoutMs })
      } catch (err) {
        if (requireMessageError) {
          if (isMissingOpenCodeMessage(err)) throw unconfirmedAgentError(err)
          throw err
        }
      }
      if (requireMessageError && !msg?.info?.error) {
        if (normalizeEpochMs(msg?.info?.time?.completed) != null) {
          return { delivered: false, completed: false, reason: "message-completed-without-error" }
        }
        throw unconfirmedAgentError()
      }
      const text = msg?.info?.error
        ? formatAgentStopErrorNotice({ reason: "Assistant reply failed.", details: msg.info.error })
        : item.payload?.text || "Assistant reply failed."
      await sendToThread(routeCtx, text, null, { signal })
      await persistProgress({ noticeDelivered: true })
      sets.agentStopErrors.add(agentStopErrorDedupeKey({ messageId: item.messageId }))
      logSseDebug(item.projectAlias, item.sessionId, `send=agent_stop_error_outbox msg=${item.messageId}`)
      return
    }

    if (item.type !== "assistant-final") throw new Error(`Unsupported durable outbox type: ${item.type}`)
    const msg = await getAssistantMessageWithRetry(oc, item.sessionId, item.messageId, { attempts: 1, signal, timeoutMs: requestTimeoutMs })
    if (!msg) {
      throw makeBoundaryError({
        source: "opencode",
        operation: "GET assistant message for durable delivery",
        method: "GET",
        pathname: `/session/${item.sessionId}/message/${item.messageId}`,
        kind: "unavailable",
        outcome: "retryable",
        message: "Assistant message is not available for durable delivery yet",
      })
    }
    if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
      recordNoisySkip(item.projectAlias, NOISY_SKIP_REASONS.ASSISTANT_COMPACTION)
      return
    }

    const displayText = extractAssistantDisplayText(item.projectAlias, msg)
    const text = extractTextParts(msg)
    const changedFilesSummary = extractChangedFilesSummary(item.projectAlias, msg)
    const hasAssistantText = !!text?.trim()
    const hasChangedFiles = !!changedFilesSummary
    const boundKey = sessionKey(item.projectAlias, item.boundSessionId)
    const previewState = assistantPreviewBySession.get(boundKey)
    const replaceMessageId = previewState?.messageId === item.messageId && previewMatchesRoute(previewState, routeCtx)
      ? previewState.telegramMessageId
      : undefined

    if (!displayText?.trim()) {
      if (replaceMessageId && progress.previewFinalized !== true) {
        await finalizePreview(routeCtx, replaceMessageId, "Assistant reply finished with no Telegram-visible content.", signal)
        await persistProgress({ previewFinalized: true })
      }
      sets.assistant.add(item.messageId)
      recordNoisySkip(item.projectAlias, NOISY_SKIP_REASONS.ASSISTANT_EMPTY)
      return
    }

    lastAssistantBySession.set(boundKey, { messageId: item.messageId, sessionId: item.sessionId, text: displayText })
    let visibleOutputSent = progress.assistantTextDelivered === true || progress.changedFilesDelivered === true
    if (hasAssistantText && progress.assistantTextDelivered !== true) {
      const deliveryOptions = { ...progress, onProgress: persistProgress, signal }
      const delivered = await deliverAssistantText(routeCtx, item.projectAlias, item.sessionId, item.messageId, text, {
        replaceMessageId,
        deliveryOptions,
      })
      if (delivered && progress.assistantTextDelivered !== true) await persistProgress({ assistantTextDelivered: true })
      visibleOutputSent = visibleOutputSent || !!delivered
    }

    const allowChangedFiles = hasChangedFiles && shouldMirrorToFeed(routeCtx.ctxKey, "changed-files")
    if (hasChangedFiles && progress.changedFilesDelivered !== true) {
      if (allowChangedFiles) {
        const deliveredChanges = await deliverChangedFilesSummary(routeCtx, item.projectAlias, item.sessionId, item.messageId, msg, {
          replaceMessageId: !hasAssistantText ? replaceMessageId : undefined,
          deliveryOptions: { ...progress, onProgress: persistProgress, signal },
        })
        visibleOutputSent = visibleOutputSent || !!deliveredChanges
      } else {
        recordNoisySkip(item.projectAlias, NOISY_SKIP_REASONS.CHANGED_FILES_FEED_FILTERED)
      }
      await persistProgress({ changedFilesDelivered: true })
      sets.changes.add(item.messageId)
    }

    if (replaceMessageId && !visibleOutputSent && progress.previewFinalized !== true) {
      await finalizePreview(routeCtx, replaceMessageId, "Assistant reply finished, but no updates matched the current feed mode.", signal)
      await persistProgress({ previewFinalized: true })
    }
    if (replaceMessageId) assistantPreviewBySession.delete(boundKey)
    sets.assistant.add(item.messageId)
    if (visibleOutputSent) recordAssistantMirrored?.(item.projectAlias)
    logSseDebug(item.projectAlias, item.sessionId, `send=assistant_outbox msg=${item.messageId} thread=${routeCtx.threadIdOr0 || 0}`)
  }
}
