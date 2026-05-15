import { extractPatchFileEntries } from "../../message-display.js"
import { makeInlineKeyboard } from "../../telegram/client.js"
import { ATTACHMENT_NOTICES, attachmentCaption, sanitizeFilenamePart } from "../attachment-utils.js"
import {
  changedFilesAttachmentName as formatChangedFilesAttachmentName,
  extractChangedFilesSummary as formatChangedFilesSummary,
  formatChangedFileDiffList,
  loadChangedFilesDiffData,
  renderChangedFilesDiffHtml,
  renderSelectedFileDiffHtml,
} from "./changed-files-format.js"

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

  function changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg) {
    const fileEntries = extractPatchFileEntries(msg).filter((entry) => entry.diff)
    const canLoadFileDiffs = fileEntries.length > 0 || !!msg?.info?.parentID
    const rows = [
      [{ text: "Show diff", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "show") }],
      [
        { text: "Send summary", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "summary") },
        { text: "Full .patch", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "patch") },
      ],
    ]
    if (canLoadFileDiffs) rows.push([{ text: "File diffs", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "files") }])
    rows.push([{ text: "Close", callback_data: packCallback("cf", "close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesDiffKeyboard(projectAlias, sessionId, messageId, { fileIndex = null } = {}) {
    const rows = [[{ text: "Back", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "back") }]]
    if (Number.isInteger(fileIndex)) {
      rows.push([{ text: "Send file .patch", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "filepatch", fileIndex) }])
    }
    rows.push([{ text: "Full .patch", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "patch") }])
    rows.push([{ text: "Close", callback_data: packCallback("cf", "close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesListKeyboard(projectAlias, sessionId, messageId, entries) {
    const rows = entries.slice(0, changedFilesLimit).map((entry, index) => [{
      text: `${index + 1}. ${sanitizeFilenamePart(entry.file, "file")}`.slice(0, 64),
      callback_data: packCallback("cf", projectAlias, sessionId, messageId, "file", index),
    }])
    rows.push([
      { text: "Back", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "back") },
      { text: "Full .patch", callback_data: packCallback("cf", projectAlias, sessionId, messageId, "patch") },
    ])
    rows.push([{ text: "Close", callback_data: packCallback("cf", "close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesCloseKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: packCallback("cf", "close") }]])
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
      const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, action)
      if (!claim.claimed) return
      try {
        await tg.sendDocument(
          ctxMeta.chatId,
          summary,
          changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files-summary", extension: ".txt" }),
          attachmentCaption("changed-files-summary", { projectAlias, sessionId }),
          { message_thread_id: ctxMeta.threadIdOr0 || undefined },
        )
        await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action })
      } finally {
        releaseChangedFilesExport(claim.key)
      }
      return
    }

    const { diffText, fileEntries } = await loadChangedFilesDiffData(oc, sessionId, msg)

    if (action === "patch") {
      if (!diffText) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Diff unavailable for this update.", changedFilesDiffKeyboard(projectAlias, sessionId, messageId)).catch(() => {})
        return
      }
      const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, action)
      if (!claim.claimed) return
      try {
        await tg.sendDocument(
          ctxMeta.chatId,
          diffText,
          changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files", extension: ".patch" }),
          attachmentCaption("changed-files-patch", { projectAlias, sessionId }),
          { message_thread_id: ctxMeta.threadIdOr0 || undefined },
        )
        await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action })
      } finally {
        releaseChangedFilesExport(claim.key)
      }
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
        const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, action, String(fileIndex))
        if (!claim.claimed) return
        try {
          await tg.sendDocument(
            ctxMeta.chatId,
            entry.diff,
            changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "file-diff", extension: ".patch", fileName: entry.file }),
            attachmentCaption("changed-files-patch", { projectAlias, sessionId, fileName: entry.file }),
            { message_thread_id: ctxMeta.threadIdOr0 || undefined },
          )
          await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action })
        } finally {
          releaseChangedFilesExport(claim.key)
        }
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
        const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, "file-large", String(fileIndex))
        if (!claim.claimed) return
        try {
          await tg.sendDocument(
            ctxMeta.chatId,
            entry.diff,
            changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "file-diff", extension: ".patch", fileName: entry.file }),
            attachmentCaption("changed-files-patch", { projectAlias, sessionId, fileName: entry.file }),
            { message_thread_id: ctxMeta.threadIdOr0 || undefined },
          )
          recordAttachmentFallback?.(projectAlias, "changed-file-diff-too-long")
          await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action: "file-large" })
        } finally {
          releaseChangedFilesExport(claim.key)
        }
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
      const claim = await claimChangedFilesExport(projectAlias, sessionId, messageId, "show-large")
      if (!claim.claimed) return
      try {
        await tg.sendDocument(
          ctxMeta.chatId,
          diffText,
          changedFilesAttachmentName(projectAlias, sessionId, messageId, { label: "changed-files", extension: ".patch" }),
          attachmentCaption("changed-files-patch", { projectAlias, sessionId }),
          { message_thread_id: ctxMeta.threadIdOr0 || undefined },
        )
        recordAttachmentFallback?.(projectAlias, "changed-files-diff-too-long")
        await markChangedFilesExportSent(claim.key, { projectAlias, sessionId, action: "show-large" })
      } finally {
        releaseChangedFilesExport(claim.key)
      }
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
