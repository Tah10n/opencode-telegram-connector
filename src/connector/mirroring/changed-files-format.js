import { formatUnifiedDiffHtml } from "../../telegram/diff-formatter.js"
import {
  extractPatchDiffText,
  extractPatchFileEntries,
  extractPatchFiles,
  extractSummaryFileDiffEntries,
  formatChangedFilesText,
  formatFileDiffEntriesPatch,
} from "../../message-display.js"
import { scopedAttachmentFilename } from "../attachment-utils.js"

export function changedFilesAttachmentName(projectAlias, sessionId, messageId, { label = "changed-files", extension = ".patch", fileName = "" } = {}) {
  return scopedAttachmentFilename({ projectAlias, sessionId, messageId, label, fileName, extension })
}

export function extractChangedFilesSummary(projectAlias, msg, { projects, limit } = {}) {
  const files = extractPatchFiles(msg)
  if (!files.length) return ""
  return formatChangedFilesText(files, { baseDir: projects?.[projectAlias]?.directory, limit })
}

export async function loadChangedFilesDiffData(oc, sessionId, msg) {
  const inlineDiffText = extractPatchDiffText(msg)
  const inlineFileEntries = extractPatchFileEntries(msg).filter((entry) => entry.diff)
  if (inlineDiffText || inlineFileEntries.length) return { diffText: inlineDiffText, fileEntries: inlineFileEntries }

  const parentId = typeof msg?.info?.parentID === "string" ? msg.info.parentID.trim() : ""
  if (!parentId || typeof oc?.getMessage !== "function") return { diffText: "", fileEntries: [] }

  const parentMsg = await oc.getMessage(sessionId, parentId).catch(() => null)
  const fileEntries = extractSummaryFileDiffEntries(parentMsg).filter((entry) => entry.diff)
  return {
    diffText: formatFileDiffEntriesPatch(fileEntries),
    fileEntries,
  }
}

export function renderChangedFilesDiffHtml(diffText) {
  return formatUnifiedDiffHtml(diffText, { title: "Changed files diff" })
}

export function renderSelectedFileDiffHtml(entry) {
  return formatUnifiedDiffHtml(entry?.diff || "", { title: `Changed file diff: ${entry?.file || "file"}` })
}

export function formatChangedFileDiffList(entries, { limit } = {}) {
  const shown = entries.slice(0, limit)
  const lines = ["Changed file diffs:", ...shown.map((entry, index) => `${index + 1}. ${entry.file}`)]
  if (entries.length > shown.length) lines.push(`…and ${entries.length - shown.length} more.`)
  return lines.join("\n")
}
