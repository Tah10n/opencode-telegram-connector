import crypto from "node:crypto"
import { makeInlineKeyboard } from "../telegram/client.js"
import { escapeHtml, formatMarkdownToTelegramHtmlBlocks } from "../telegram/formatter.js"
import { ctxKeyFrom } from "../telegram/routing.js"
import {
  extractPatchDiffText,
  extractPatchFileEntries,
  extractPatchFiles,
  extractSummaryFileDiffEntries,
  formatChangedFilesText,
  formatFileDiffEntriesPatch,
} from "../message-display.js"
import { DEFAULT_FEED_MODE, normalizeFeedMode, sessionKey } from "../state/store.js"
import { ATTACHMENT_NOTICES, attachmentCaption, sanitizeFilenamePart, scopedAttachmentFilename } from "./attachment-utils.js"

export function createMirroringHandlers(runtime) {
  const {
    tg,
    store,
    config,
    projects,
    ocByAlias,
    cb,
    LruSet,
    CHANGED_FILES_LIMIT,
    INLINE_DIFF_TEXT_MAX_CHARS,
    STREAM_PREVIEW_MAX_CHARS,
    TEXT_ATTACHMENT_THRESHOLD,
    forwardedBySession,
    assistantDebounce,
    assistantPreviewBySession,
    recentTgPromptsBySession,
    lastAssistantBySession,
    sendToThread,
    sendBlocksToThread,
    resolveBoundRoute,
    logSseDebug,
    eventStartedAfterLaunch,
    sleep,
    abortSignal,
    recordAssistantMirrored,
    recordNoisyEventSkipped,
    recordAttachmentFallback,
  } = runtime

  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const isStopping = () => abortSignal?.aborted === true
  const changedFilesExportInFlight = new Set()

  function ensureForwardedSets(sk) {
    let s = forwardedBySession.get(sk)
    if (!s) {
      s = { user: new LruSet(8000), assistant: new LruSet(8000), changes: new LruSet(8000) }
      forwardedBySession.set(sk, s)
    }
    return s
  }

  function ensureRecentPromptSet(sk) {
    let s = recentTgPromptsBySession.get(sk)
    if (!s) {
      s = new LruSet(2000)
      recentTgPromptsBySession.set(sk, s)
    }
    return s
  }

  function hashTextForEcho(text) {
    const t = String(text ?? "")
    return crypto.createHash("sha1").update(t, "utf8").digest("hex") + ":" + String(t.length)
  }

  function changedFilesExportIdempotencyKey(projectAlias, sessionId, messageId, action, actionArg = "") {
    const hash = crypto
      .createHash("sha1")
      .update(JSON.stringify([projectAlias, sessionId, messageId, action, actionArg]), "utf8")
      .digest("hex")
      .slice(0, 24)
    return `changed-files-export:${hash}`
  }

  async function claimChangedFilesExport(projectAlias, sessionId, messageId, action, actionArg = "") {
    const key = changedFilesExportIdempotencyKey(projectAlias, sessionId, messageId, action, actionArg)
    if (store?.hasIdempotencyKey?.(key) || changedFilesExportInFlight.has(key)) return { claimed: false, key }
    changedFilesExportInFlight.add(key)
    return { claimed: true, key }
  }

  async function markChangedFilesExportSent(key, { projectAlias, sessionId, action } = {}) {
    if (!key) return
    if (typeof store?.markIdempotencyKey === "function") {
      const marked = store.markIdempotencyKey(key, {
        kind: "changed-files-export",
        projectAlias,
        sessionId,
        operation: "sendDocument",
        action,
      })
      if (marked && typeof store?.flush === "function") await store.flush()
      return
    }
    if (typeof store?.markIdempotencyKeyAndFlush === "function") {
      await store.markIdempotencyKeyAndFlush(key, {
        kind: "changed-files-export",
        projectAlias,
        sessionId,
        operation: "sendDocument",
        action,
      })
    }
  }

  function getFeedMode(ctxKey) {
    return store.getFeedMode?.(ctxKey) || DEFAULT_FEED_MODE
  }

  function feedModeLabel(mode) {
    const normalized = normalizeFeedMode(mode)
    if (normalized === "main") return "Main"
    if (normalized === "verbose") return "Verbose"
    return "Main + changes"
  }

  function shouldMirrorToFeed(ctxKey, kind) {
    const mode = getFeedMode(ctxKey)
    if (kind === "internal") return false
    if (mode === "main") return kind === "assistant-final"
    if (mode === "main+changes") return kind === "assistant-final" || kind === "changed-files"
    return kind === "assistant-final" || kind === "assistant-stream" || kind === "user-mirror" || kind === "changed-files"
  }

  function renderFeedSettingsText(ctxKey) {
    const mode = getFeedMode(ctxKey)
    return [
      `Feed for this thread: ${feedModeLabel(mode)}`,
      "",
      "Main — final assistant replies only.",
      "Main + changes — final assistant replies and changed files.",
      "Verbose — final replies, streaming previews, user mirror, and changed files.",
      "",
      "Internal compaction output stays hidden in all modes.",
    ].join("\n")
  }

  function feedKeyboard(ctxKey) {
    const current = getFeedMode(ctxKey)
    const button = (mode, label) => ({ text: `${current === mode ? "✓ " : ""}${label}`, callback_data: cb.pack(`feed|${mode}`) })
    return makeInlineKeyboard([
      [button("main", "Main")],
      [button("main+changes", "Main + changes")],
      [button("verbose", "Verbose")],
      [{ text: "Close", callback_data: cb.pack("feed|close") }],
    ])
  }

  async function renderFeedSettings(ctxMeta, { editMessageId, noticeText = "" } = {}) {
    const settingsText = renderFeedSettingsText(ctxMeta.ctxKey)
    const text = noticeText ? `${noticeText}\n\n${settingsText}` : settingsText
    const replyMarkup = feedKeyboard(ctxMeta.ctxKey)
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  function changedFilesAttachmentName(projectAlias, sessionId, messageId, { label = "changed-files", extension = ".patch", fileName = "" } = {}) {
    return scopedAttachmentFilename({ projectAlias, sessionId, messageId, label, fileName, extension })
  }

  function changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg) {
    const fileEntries = extractPatchFileEntries(msg).filter((entry) => entry.diff)
    const canLoadFileDiffs = fileEntries.length > 0 || !!msg?.info?.parentID
    const rows = [
      [{ text: "Show diff", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|show`) }],
      [
        { text: "Send summary", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|summary`) },
        { text: "Full .patch", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|patch`) },
      ],
    ]
    if (canLoadFileDiffs) rows.push([{ text: "File diffs", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|files`) }])
    rows.push([{ text: "Close", callback_data: cb.pack("cf|close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesDiffKeyboard(projectAlias, sessionId, messageId, { fileIndex = null } = {}) {
    const rows = [[{ text: "Back", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|back`) }]]
    if (Number.isInteger(fileIndex)) {
      rows.push([{ text: "Send file .patch", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|filepatch|${fileIndex}`) }])
    }
    rows.push([{ text: "Full .patch", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|patch`) }])
    rows.push([{ text: "Close", callback_data: cb.pack("cf|close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesListKeyboard(projectAlias, sessionId, messageId, entries) {
    const rows = entries.slice(0, CHANGED_FILES_LIMIT).map((entry, index) => [{
      text: `${index + 1}. ${sanitizeFilenamePart(entry.file, "file")}`.slice(0, 64),
      callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|file|${index}`),
    }])
    rows.push([
      { text: "Back", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|back`) },
      { text: "Full .patch", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|patch`) },
    ])
    rows.push([{ text: "Close", callback_data: cb.pack("cf|close") }])
    return makeInlineKeyboard(rows)
  }

  function changedFilesCloseKeyboard() {
    return makeInlineKeyboard([[{ text: "Close", callback_data: cb.pack("cf|close") }]])
  }

  function extractTextParts(message) {
    if (!message || !Array.isArray(message.parts)) return ""
    const parts = message.parts.filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.ignored)
    return parts.map((p) => p.text).join("")
  }

  function extractChangedFilesSummary(projectAlias, msg) {
    const files = extractPatchFiles(msg)
    if (!files.length) return ""
    return formatChangedFilesText(files, { baseDir: projects?.[projectAlias]?.directory, limit: CHANGED_FILES_LIMIT })
  }

  async function loadChangedFilesDiffData(oc, sessionId, msg) {
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

  function renderChangedFilesDiffHtml(diffText) {
    return `<b>Changed files diff</b>\n<pre><code>${escapeHtml(diffText)}</code></pre>`
  }

  function renderSelectedFileDiffHtml(entry) {
    return `<b>Changed file diff: ${escapeHtml(entry?.file || "file")}</b>\n<pre><code>${escapeHtml(entry?.diff || "")}</code></pre>`
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
        changedFilesExportInFlight.delete(claim.key)
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
        changedFilesExportInFlight.delete(claim.key)
      }
      return
    }

    if (action === "files") {
      if (!fileEntries.length) {
        await tg.editMessageText(ctxMeta.chatId, editMessageId, "Selected file diffs are unavailable for this update.", changedFilesSummaryKeyboard(projectAlias, sessionId, messageId, msg))
        return
      }
      const shown = fileEntries.slice(0, CHANGED_FILES_LIMIT)
      const lines = ["Changed file diffs:", ...shown.map((entry, index) => `${index + 1}. ${entry.file}`)]
      if (fileEntries.length > shown.length) lines.push(`…and ${fileEntries.length - shown.length} more.`)
      await tg.editMessageText(ctxMeta.chatId, editMessageId, lines.join("\n"), changedFilesListKeyboard(projectAlias, sessionId, messageId, fileEntries))
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
          changedFilesExportInFlight.delete(claim.key)
        }
        return
      }

      const fileDiffHtml = renderSelectedFileDiffHtml(entry)
      if (entry.diff.length > INLINE_DIFF_TEXT_MAX_CHARS || fileDiffHtml.length > 3900) {
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
          changedFilesExportInFlight.delete(claim.key)
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
    if (diffText.length > INLINE_DIFF_TEXT_MAX_CHARS || diffHtml.length > 3900) {
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
        changedFilesExportInFlight.delete(claim.key)
      }
      return
    }

    await tg.editMessageText(ctxMeta.chatId, editMessageId, diffHtml, changedFilesDiffKeyboard(projectAlias, sessionId, messageId), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
  }

  function extractAssistantDisplayText(projectAlias, msg) {
    let text = extractTextParts(msg)
    if (!text || !text.trim()) text = extractChangedFilesSummary(projectAlias, msg)
    return text
  }

  function shouldSendAssistantAsAttachment(text) {
    return typeof text === "string" && text.length >= TEXT_ATTACHMENT_THRESHOLD
  }

  function recordNoisySkip(projectAlias, reason) {
    recordNoisyEventSkipped?.(projectAlias, reason)
  }

  function assistantAttachmentName(projectAlias, sessionId, messageId) {
    return scopedAttachmentFilename({ projectAlias, sessionId, messageId, label: "assistant", extension: ".txt" })
  }

  function buildAssistantStreamPreviewHtml(text) {
    const body = String(text || "").trim()
    if (!body) return ""
    const maxLen = Math.min(STREAM_PREVIEW_MAX_CHARS, 3900)
    let escaped = ""
    for (const ch of body) {
      const next = escapeHtml(ch)
      if (escaped.length + next.length > maxLen) {
        escaped = `${escaped.slice(0, Math.max(0, maxLen - 1))}…`
        break
      }
      escaped += next
    }
    return escaped
  }

  async function getAssistantMessageWithRetry(oc, sessionId, messageId, { attempts = 3, initialDelayMs = 150 } = {}) {
    let waitMs = initialDelayMs
    for (let attempt = 0; attempt < attempts; attempt++) {
      const msg = await oc.getMessage(sessionId, messageId).catch(() => null)
      if (msg) return msg
      if (attempt + 1 < attempts) await pause(waitMs)
      waitMs = Math.min(1000, waitMs * 2)
    }
    return null
  }

  async function deliverAssistantText(ctxMeta, projectAlias, sessionId, messageId, text, { replaceMessageId } = {}) {
    if (!text || !text.trim()) return null
    if (shouldSendAssistantAsAttachment(text)) {
      const notice = ATTACHMENT_NOTICES.assistantTooLong
      if (replaceMessageId) {
        const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, notice, null).catch(() => null)
        if (!edited) await sendToThread(ctxMeta, notice)
      } else {
        await sendToThread(ctxMeta, notice)
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

  async function handleMessageUpdated({ projectAlias, props }) {
    if (isStopping()) return
    const sessionId = props.sessionID
    const info = props.info
    if (!sessionId || !info?.id || !info?.role) return
    logSseDebug(projectAlias, sessionId, `event type=message.updated role=${info.role} msg=${info.id}`)
    const sk = sessionKey(projectAlias, sessionId)
    const resolved = await resolveBoundRoute(projectAlias, sessionId)
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=no_route")
      return
    }
    const route = resolved.route
    const routeCtx = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
    const boundKey = sessionKey(projectAlias, resolved.boundSessionId)

    // Avoid side effects (like auto-rebinding) for historical/backlog events.
    if (!eventStartedAfterLaunch(info, { allowCompletedAfterStart: info.role === "assistant" })) {
      logSseDebug(projectAlias, sessionId, "drop=before_connector_start")
      return
    }
    if (resolved.boundSessionId !== sessionId) {
      logSseDebug(projectAlias, sessionId, `drop=child_message bound=${resolved.boundSessionId}`)
      return
    }

    const oc = ocByAlias[projectAlias]
    const sets = ensureForwardedSets(sk)

    if (info.role === "user") {
      if (sets.user.has(info.id)) {
        logSseDebug(projectAlias, sessionId, `drop=user_already_forwarded msg=${info.id}`)
        return
      }
      const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
      const text = extractTextParts(msg)
      if (!text || !text.trim()) {
        logSseDebug(projectAlias, sessionId, `drop=user_empty msg=${info.id}`)
        recordNoisySkip(projectAlias, "user-empty")
        return
      }
      const mode = config.echoFilterMode ?? "recent"
      let isEcho = false
      if (mode === "prefix") {
        const prefix = config.tgPrefix ?? ""
        const p = String(prefix).trim()
        isEcho = p ? text.trimStart().startsWith(p) : false
      } else if (mode === "recent") {
        const h = hashTextForEcho(text)
        const recent = ensureRecentPromptSet(sk)
        if (recent.has(h)) isEcho = true
      }
      if (isEcho) {
        logSseDebug(projectAlias, sessionId, `drop=user_echo msg=${info.id}`)
        recordNoisySkip(projectAlias, "user-echo")
        return
      }
      if (!shouldMirrorToFeed(routeCtx.ctxKey, "user-mirror")) {
        sets.user.add(info.id)
        logSseDebug(projectAlias, sessionId, `drop=user_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
        recordNoisySkip(projectAlias, "user-feed-filtered")
        return
      }
      const blocks = [{ type: "text", html: "<b>User</b>" }, ...formatMarkdownToTelegramHtmlBlocks(text)]
      await tg.sendHtmlBlocks(route.chatId, blocks, null, { message_thread_id: route.threadIdOr0 || undefined })
      sets.user.add(info.id)
      logSseDebug(projectAlias, sessionId, `send=user msg=${info.id} thread=${route.threadIdOr0 || 0}`)
    }

    if (info.role !== "assistant") return
    if (!runtime.mirrorCompaction && (info.mode === "compaction" || info.agent === "compaction")) {
      logSseDebug(projectAlias, sessionId, `drop=compaction msg=${info.id}`)
      recordNoisySkip(projectAlias, "compaction")
      return
    }

    const completed = runtime.normalizeEpochMs(info.time?.completed) != null
    const hasError = !!info.error
    lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: null })

    if (hasError) {
      const previewState = assistantPreviewBySession.get(boundKey)
      if (previewState?.messageId === info.id && previewState.telegramMessageId) {
        await tg.editMessageText(route.chatId, previewState.telegramMessageId, `Assistant reply failed.\n\n${String(info.error)}`, null).catch(() => {})
        assistantPreviewBySession.delete(boundKey)
      }
      logSseDebug(projectAlias, sessionId, `drop=assistant_error msg=${info.id}`)
      return
    }

    if (!completed) {
      if (!shouldMirrorToFeed(routeCtx.ctxKey, "assistant-stream")) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
        recordNoisySkip(projectAlias, "assistant-preview-feed-filtered")
        return
      }
      const previewState = assistantPreviewBySession.get(boundKey)
      const lastPreviewAt = previewState?.messageId === info.id ? previewState.lastPreviewAt || 0 : 0
      if (Date.now() - lastPreviewAt < 200) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_throttled msg=${info.id}`)
        recordNoisySkip(projectAlias, "assistant-preview-throttled")
        return
      }
      const msg = await oc.getMessage(sessionId, info.id).catch(() => null)
      if (isStopping()) return
      if (!eventStartedAfterLaunch(msg?.info || info, { allowCompletedAfterStart: true })) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_before_start msg=${info.id}`)
        return
      }
      if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_compaction msg=${info.id}`)
        recordNoisySkip(projectAlias, "assistant-preview-compaction")
        return
      }
      const text = extractTextParts(msg)
      if (!text || !text.trim()) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_empty msg=${info.id}`)
        recordNoisySkip(projectAlias, "assistant-preview-empty")
        return
      }
      const previewHtml = buildAssistantStreamPreviewHtml(text)
      const state = previewState?.messageId === info.id ? previewState : { messageId: info.id, telegramMessageId: null, lastPreviewHtml: "", lastPreviewAt: 0 }
      if (state.lastPreviewHtml === previewHtml) return
      if (!state.telegramMessageId) {
        const sent = await tg
          .sendMessage(route.chatId, previewHtml, null, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            message_thread_id: route.threadIdOr0 || undefined,
          })
          .catch(() => null)
        state.telegramMessageId = sent?.message_id || null
      } else {
        await tg
          .editMessageText(route.chatId, state.telegramMessageId, previewHtml, null, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          })
          .catch(() => {})
      }
      state.lastPreviewHtml = previewHtml
      state.lastPreviewAt = Date.now()
      assistantPreviewBySession.set(boundKey, state)
      logSseDebug(projectAlias, sessionId, `stream=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
      return
    }

    const debounceKey = `${sk}:${info.id}`
    const existing = assistantDebounce.get(debounceKey)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      assistantDebounce.delete(debounceKey)
      if (isStopping()) return
      if (sets.assistant.has(info.id)) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_already_forwarded msg=${info.id}`)
        return
      }
      void (async () => {
        if (isStopping()) return
        const previewState = assistantPreviewBySession.get(boundKey)
        const replaceMessageId = previewState?.messageId === info.id ? previewState.telegramMessageId : undefined
        const msg = await getAssistantMessageWithRetry(oc, sessionId, info.id)
        if (isStopping()) return
        if (!msg) {
          if (replaceMessageId) {
            await tg
              .editMessageText(
                route.chatId,
                replaceMessageId,
                "Assistant reply finished, but the final content could not be fetched yet. Use /sendlast to retry.",
                null,
              )
              .catch(() => {})
          }
          logSseDebug(projectAlias, sessionId, `drop=assistant_fetch_failed msg=${info.id}`)
          return
        }
        if (!eventStartedAfterLaunch(msg?.info, { allowCompletedAfterStart: true })) {
          logSseDebug(projectAlias, sessionId, `drop=assistant_message_before_start msg=${info.id}`)
          return
        }
        if (!runtime.mirrorCompaction && (msg?.info?.mode === "compaction" || msg?.info?.agent === "compaction")) {
          logSseDebug(projectAlias, sessionId, `drop=compaction_message msg=${info.id}`)
          recordNoisySkip(projectAlias, "assistant-compaction")
          return
        }

        const displayText = extractAssistantDisplayText(projectAlias, msg)
        const text = extractTextParts(msg)
        const changedFilesSummary = extractChangedFilesSummary(projectAlias, msg)
        const hasAssistantText = !!text?.trim()
        const hasChangedFiles = !!changedFilesSummary

        if (!displayText || !displayText.trim()) {
          if (replaceMessageId) {
            await tg.editMessageText(route.chatId, replaceMessageId, "Assistant reply finished with no Telegram-visible content.", null).catch(() => {})
            assistantPreviewBySession.delete(boundKey)
          }
          sets.assistant.add(info.id)
          logSseDebug(projectAlias, sessionId, `drop=assistant_empty msg=${info.id}`)
          recordNoisySkip(projectAlias, "assistant-empty")
          return
        }

        const current = lastAssistantBySession.get(boundKey)
        if (current?.messageId === info.id) lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: displayText })
        const allowChangedFiles = hasChangedFiles && shouldMirrorToFeed(routeCtx.ctxKey, "changed-files")
        let visibleOutputSent = false

        if (hasAssistantText) {
          if (isStopping()) return
          const delivered = await deliverAssistantText(routeCtx, projectAlias, sessionId, info.id, text, { replaceMessageId })
          visibleOutputSent = visibleOutputSent || !!delivered
        }

        if (allowChangedFiles) {
          if (isStopping()) return
          const deliveredChanges = await deliverChangedFilesSummary(routeCtx, projectAlias, sessionId, info.id, msg, {
            replaceMessageId: !hasAssistantText ? replaceMessageId : undefined,
          })
          visibleOutputSent = visibleOutputSent || !!deliveredChanges
          sets.changes.add(info.id)
          logSseDebug(projectAlias, sessionId, `send=changed_files msg=${info.id} thread=${route.threadIdOr0 || 0}`)
        } else if (hasChangedFiles) {
          sets.changes.add(info.id)
          logSseDebug(projectAlias, sessionId, `drop=changed_files_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
          recordNoisySkip(projectAlias, "changed-files-feed-filtered")
        }

        if (replaceMessageId && !visibleOutputSent) {
          await tg
            .editMessageText(route.chatId, replaceMessageId, "Assistant reply finished, but no updates matched the current feed mode.", null)
            .catch(() => {})
        }

        if (replaceMessageId) assistantPreviewBySession.delete(boundKey)
        sets.assistant.add(info.id)
        if (visibleOutputSent) recordAssistantMirrored?.(projectAlias)
        logSseDebug(projectAlias, sessionId, `send=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
      })().catch((err) => {
        const message = err?.message || String(err)
        runtime.logger?.error?.("Assistant final delivery failed:", projectAlias, sessionId, info.id, message)
        logSseDebug(projectAlias, sessionId, `error=assistant_final_delivery msg=${info.id} ${message}`)
      })
    }, 250)
    assistantDebounce.set(debounceKey, t)
  }

  return {
    extractTextParts,
    ensureForwardedSets,
    ensureRecentPromptSet,
    hashTextForEcho,
    getFeedMode,
    feedModeLabel,
    shouldMirrorToFeed,
    renderFeedSettingsText,
    feedKeyboard,
    renderFeedSettings,
    extractChangedFilesSummary,
    renderChangedFilesDiffHtml,
    deliverChangedFilesSummary,
    renderChangedFilesView,
    extractAssistantDisplayText,
    shouldSendAssistantAsAttachment,
    assistantAttachmentName,
    buildAssistantStreamPreviewHtml,
    deliverAssistantText,
    handleMessageUpdated,
  }
}
