import { ATTACHMENT_NOTICES, attachmentCaption } from "../attachment-utils.js"
import { formatMarkdownToTelegramHtmlBlocks } from "../../telegram/formatter.js"
import {
  assistantAttachmentName as formatAssistantAttachmentName,
  shouldSendAssistantAsAttachment as isAssistantAttachmentSized,
} from "./assistant-format.js"

export function createAssistantDelivery({
  tg,
  sendToThread,
  sendBlocksToThread,
  recordAttachmentFallback,
  textAttachmentThreshold,
} = {}) {
  function shouldSendAssistantAsAttachment(text) {
    return isAssistantAttachmentSized(text, textAttachmentThreshold)
  }

  function assistantAttachmentName(projectAlias, sessionId, messageId) {
    return formatAssistantAttachmentName(projectAlias, sessionId, messageId)
  }

  async function sendAssistantBlocksWithProgress(ctxMeta, blocks, replyMarkup, deliveryOptions) {
    let nextBlockIndex = Number.isInteger(deliveryOptions.assistantTextBlockIndex) && deliveryOptions.assistantTextBlockIndex > 0
      ? deliveryOptions.assistantTextBlockIndex
      : 0
    let sentAny = nextBlockIndex > 0
    let currentReplyMarkup = nextBlockIndex === 0 ? replyMarkup : null

    for (let index = nextBlockIndex; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!block || block.type !== "text") {
        deliveryOptions.assistantTextBlockIndex = index + 1
        continue
      }
      await tg.sendMessage(ctxMeta.chatId, block.html, currentReplyMarkup, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        message_thread_id: ctxMeta.threadIdOr0 || undefined,
      })
      currentReplyMarkup = null
      deliveryOptions.assistantTextBlockIndex = index + 1
      nextBlockIndex = index + 1
      sentAny = true
    }

    return sentAny ? { mode: nextBlockIndex > 0 ? "sent" : "skipped" } : null
  }

  async function deliverAssistantText(ctxMeta, projectAlias, sessionId, messageId, text, { replaceMessageId, deliveryOptions = {} } = {}) {
    if (!text || !text.trim()) return null
    if (shouldSendAssistantAsAttachment(text)) {
      const notice = ATTACHMENT_NOTICES.assistantTooLong
      if (deliveryOptions.assistantLongNoticeDelivered !== true) {
        if (replaceMessageId) {
          const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, notice, null).catch(() => null)
          if (!edited) await sendToThread(ctxMeta, notice)
        } else {
          await sendToThread(ctxMeta, notice)
        }
        deliveryOptions.assistantLongNoticeDelivered = true
      }
      await tg.sendDocument(
        ctxMeta.chatId,
        text,
        assistantAttachmentName(projectAlias, sessionId, messageId),
        attachmentCaption("assistant", { projectAlias, sessionId }),
        { message_thread_id: ctxMeta.threadIdOr0 || undefined },
      )
      recordAttachmentFallback?.(projectAlias, "assistant-long-output")
      return { mode: "attachment" }
    }

    const blocks = formatMarkdownToTelegramHtmlBlocks(text)
    if (!blocks.length) return null
    if (blocks.length > 1) {
      if (replaceMessageId && blocks[0]?.type === "text" && !deliveryOptions.assistantTextBlockIndex) {
        const edited = await tg
          .editMessageText(ctxMeta.chatId, replaceMessageId, blocks[0].html, null, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          })
          .catch(() => null)
        if (edited) {
          deliveryOptions.assistantTextBlockIndex = 1
          await sendAssistantBlocksWithProgress(ctxMeta, blocks, null, deliveryOptions)
          return { mode: "edited" }
        }
      }
      const delivered = await sendAssistantBlocksWithProgress(ctxMeta, blocks, null, deliveryOptions)
      return delivered ? { mode: replaceMessageId ? "resent" : "sent" } : null
    }
    if (replaceMessageId && blocks[0]?.type === "text") {
      const edited = await tg
        .editMessageText(ctxMeta.chatId, replaceMessageId, blocks[0].html, null, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => null)
      if (!edited) {
        await sendBlocksToThread(ctxMeta, blocks, null)
        return { mode: "resent" }
      }
      if (blocks.length > 1) await sendBlocksToThread(ctxMeta, blocks.slice(1), null)
      return { mode: "edited" }
    }
    await sendBlocksToThread(ctxMeta, blocks, null)
    return { mode: "sent" }
  }

  return {
    shouldSendAssistantAsAttachment,
    assistantAttachmentName,
    sendAssistantBlocksWithProgress,
    deliverAssistantText,
  }
}
