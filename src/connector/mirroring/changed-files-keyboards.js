import { extractPatchFileEntries } from "../../message-display.js"
import { makeInlineKeyboard } from "../../telegram/client.js"
import { sanitizeFilenamePart } from "../attachment-utils.js"

export function createChangedFilesKeyboards({ packCallback, changedFilesLimit } = {}) {
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

  return {
    changedFilesSummaryKeyboard,
    changedFilesDiffKeyboard,
    changedFilesListKeyboard,
    changedFilesCloseKeyboard,
  }
}
