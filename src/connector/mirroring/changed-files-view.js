import { ATTACHMENT_NOTICES, attachmentCaption } from "../attachment-utils.js"
import { sendChangedFilesExport } from "./changed-files-export.js"
import {
  changedFilesAttachmentName as formatChangedFilesAttachmentName,
  extractChangedFilesSummary as formatChangedFilesSummary,
  formatChangedFileDiffList,
  loadChangedFilesDiffData,
  renderChangedFilesDiffHtml,
  renderSelectedFileDiffHtml,
} from "./changed-files-format.js"
import { createChangedFilesKeyboards } from "./changed-files-keyboards.js"

export function createChangedFilesView({
  store,
  tg,
  projects,
  ocByAlias,
  sendToThread,
  packCallback,
  changedFilesLimit,
  inlineDiffTextMaxChars,
  claimChangedFilesExport,
  markChangedFilesExportSent,
  releaseChangedFilesExport,
  recordAttachmentFallback,
} = {}) {
  function changedFilesAttachmentName(projectAlias, sessionId, messageId, { label = "changed-files", extension = ".patch", fileName = "" } = {}) {
    return formatChangedFilesAttachmentName(projectAlias, sessionId, messageId, { label, fileName, extension })
  }

  const {
    changedFilesSummaryKeyboard,
    changedFilesDiffKeyboard,
    changedFilesListKeyboard,
    changedFilesCloseKeyboard,
  } = createChangedFilesKeyboards({ packCallback, changedFilesLimit })

  function sendExport(options) {
    return sendChangedFilesExport({
      claimChangedFilesExport,
      markChangedFilesExportSent,
      releaseChangedFilesExport,
      tg,
      ...options,
    })
  }

  function extractChangedFilesSummary(projectAlias, msg) {
    return formatChangedFilesSummary(projectAlias, msg, { projects, limit: changedFilesLimit })
  }

  async function deliverChangedFilesSummary(ctxMeta, projectAlias, sessionId, messageId, msg, { replaceMessageId } = {}) {
    const text = extractChangedFilesSummary(projectAlias, msg)
    if (!text) return null
    const replyMarkup = changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg)
    if (replaceMessageId) {
      const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, text, replyMarkup).catch(() => null)
      if (edited) return { mode: "edited" }
    }
    await sendToThread(ctxMeta, text, replyMarkup)
    return { mode: "sent" }
  }

  async function renderChangedFilesView(ctxMeta, projectAlias, sessionId, messageId, action, { editMessageId, actionArg } = {}) {
    if (!editMessageId) return
    if (typeof store.getBinding === "function") {
      const currentBinding = store.getBinding(ctxMeta.ctxKey)
      if (!currentBinding || currentBinding.projectAlias !== projectAlias || currentBinding.sessionId !== sessionId) {
        await tg.editMessageText(
          ctxMeta.chatId,
          editMessageId,
          "Changed files action is no longer valid because this thread is no longer bound to that project/session.",
          changedFilesCloseKeyboard(),
        ).catch(() => {})
        return
      }
    }
    const oc = ocByAlias[projectAlias]
    if (!oc) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, `Unknown project: ${projectAlias}`).catch(() => {})
      return
    }
    const msg = await oc.getMessage(sessionId, messageId).catch(() => null)
    if (!msg) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, "Changed files update is no longer available.").catch(() => {})
      return
    }

    if (action === "back") {
      const summary = extractChangedFilesSummary(projectAlias, msg) || "Changed files are unavailable for this update."
      await tg.editMessageText(ctxMeta.chatId, editMessageId, summary, changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg))
      return
    }

    const summary = extractChangedFilesSummary(projectAlias, msg)

    if (action === "summary") {
      if (!summary) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Changed files summary is unavailable.", changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg)).catch(() => {})
        return
      }
      await sendExport({
        ctxMeta,
        projectAlias,
        sessionId,
        messageId,
        action,
        content: summary,
        filename: changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files-summary", extension: ".txt" }),
        caption: attachmentCaption("changed-files-summary", { projectAlias, sessionId }),
      })
      return
    }

    const { diffText, fileEntries } = await loadChangedFilesDiffData(oc, sessionId, msg)

    if (action === "patch") {
      if (!diffText) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Diff unavailable for this update.", changedFilesDiffKeyboard(projectAlias, sessionId, messageId)).catch(() => {})
        return
      }
      await sendExport({
        ctxMeta,
        projectAlias,
        sessionId,
        messageId,
        action,
        content: diffText,
        filename: changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files", extension: ".patch" }),
        caption: attachmentCaption("changed-files-patch", { projectAlias, sessionId }),
      })
      return
    }

    if (action === "files") {
      if (!fileEntries.length) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Selected file diffs are unavailable for this update.", changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg))
        return
      }
      await tg.editMessageText(ctxMeta.chatId, editMessageId, formatChangedFileDiffList(fileEntries, { limit: changedFilesLimit }), changedFilesListKeyboard(projectAlias, sessionId, messageId, fileEntries))
      return
    }

    if (action === "file" || action === "filepatch") {
      const fileIndex = Number(actionArg)
      const entry = Number.isInteger(fileIndex) ? fileEntries[fileIndex] : null
      if (!entry) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Selected file diff is unavailable.", changedFilesListKeyboard(projectAlias, sessionId, messageId, fileEntries)).catch(() => {})
        return
      }
      if (action === "filepatch") {
        await sendExport({
          ctxMeta,
          projectAlias,
          sessionId,
          messageId,
          action,
          actionArg: String(fileIndex),
          content: entry.diff,
          filename: changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "file-diff", extension: ".patch", fileName: entry.file }),
          caption: attachmentCaption("changed-files-patch", { projectAlias, sessionId, fileName: entry.file }),
        })
        return
      }

      const fileDiffHtml = renderSelectedFileDiffHtml(entry)
      if (entry.diff.length > inlineDiffTextMaxChars || fileDiffHtml.length > 3900) {
        await tg.editMessageText(
          ctxMeta.chatId,
          editMessageId,
          ATTACHMENT_NOTICES.diffTooLong,
          changedFilesDiffKeyboard(projectAlias, sessionId, messageId, { fileIndex }),
        )
        await sendExport({
          ctxMeta,
          projectAlias,
          sessionId,
          messageId,
          action: "file-large",
          actionArg: String(fileIndex),
          content: entry.diff,
          filename: changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "file-diff", extension: ".patch", fileName: entry.file }),
          caption: attachmentCaption("changed-files-patch", { projectAlias, sessionId, fileName: entry.file }),
          onSent: () => recordAttachmentFallback?.(projectAlias, "changed-file-diff-too-long"),
        })
        return
      }

      await tg.editMessageText(ctxMeta.chatId, editMessageId, fileDiffHtml, changedFilesDiffKeyboard(projectAlias, sessionId, messageId, { fileIndex }), {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
      return
    }

    if (!diffText) {
      await tg.editMessageText(
        ctxMeta.chatId,
        editMessageId,
        "Diff unavailable for this update.",
        changedFilesDiffKeyboard(projectAlias, sessionId, messageId),
      )
      return
    }

    const diffHtml = renderChangedFilesDiffHtml(diffText)
    if (diffText.length > inlineDiffTextMaxChars || diffHtml.length > 3900) {
      await tg.editMessageText(
        ctxMeta.chatId,
        editMessageId,
        ATTACHMENT_NOTICES.diffTooLong,
        changedFilesDiffKeyboard(projectAlias, sessionId, messageId),
      )
      await sendExport({
        ctxMeta,
        projectAlias,
        sessionId,
        messageId,
        action: "show-large",
        content: diffText,
        filename: changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files", extension: ".patch" }),
        caption: attachmentCaption("changed-files-patch", { projectAlias, sessionId }),
        onSent: () => recordAttachmentFallback?.(projectAlias, "changed-files-diff-too-long"),
      })
      return
    }

    await tg.editMessageText(ctxMeta.chatId, editMessageId, diffHtml, changedFilesDiffKeyboard(projectAlias, sessionId, messageId), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
  }

  return {
    extractChangedFilesSummary,
    renderChangedFilesDiffHtml,
    deliverChangedFilesSummary,
    renderChangedFilesView,
  }
}
