import crypto from "node:crypto"
import { makeInlineKeyboard } from "../telegram/client.js"
import { formatUnifiedDiffHtml } from "../telegram/diff-formatter.js"
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
import { NOISY_SKIP_REASONS } from "./noisy-skip-reasons.js"
import { redactSensitiveText } from "../url-utils.js"
import { classifyBoundaryError, isRetryableBoundaryError } from "../boundary-errors.js"
import { callbackPacker } from "./callback-data.js"

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
  const packCallback = callbackPacker(cb)

  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const isStopping = () => abortSignal?.aborted === true
  const changedFilesExportInFlight = new Set()
  const agentActivityBySession = new Map()
  const agentActivityTombstonesBySession = new Map()
  const assistantDeliveryStateByKey = new Map()
  const agentStopErrorDeliveryClaims = new Set()
  const AGENT_ACTIVITY_TOMBSTONE_MS = 30 * 60 * 1000
  const AGENT_ACTIVITY_TOMBSTONE_SWEEP_MS = 60 * 1000
  const ROUTE_LOOKUP_MAX_ATTEMPTS = 3
  const ROUTE_LOOKUP_INITIAL_DELAY_MS = 150
  const ASSISTANT_FINAL_DELIVERY_MAX_ATTEMPTS = 4
  const ASSISTANT_FINAL_DELIVERY_RETRY_DELAYS_MS = [500, 1500, 5000]
  const AGENT_STOP_ERROR_FALLBACK_GRACE_MS = 5000
  let nextAgentActivityTombstoneSweepAt = 0

  function ensureForwardedSets(sk) {
    let s = forwardedBySession.get(sk)
    if (!s) {
      const agentStopErrors = new LruSet(8000)
      s = { user: new LruSet(8000), assistant: new LruSet(8000), assistantErrors: agentStopErrors, agentStopErrors, changes: new LruSet(8000), actions: new LruSet(8000) }
      forwardedBySession.set(sk, s)
    }
    if (!s.actions) s.actions = new LruSet(8000)
    if (!s.agentStopErrors) s.agentStopErrors = s.assistantErrors || new LruSet(8000)
    s.assistantErrors = s.agentStopErrors
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

  function activeAgentEntry(sk) {
    let entry = agentActivityBySession.get(sk)
    if (!entry) {
      entry = { messages: new Set(), tools: new Map(), updatedAt: 0 }
      agentActivityBySession.set(sk, entry)
    }
    return entry
  }

  function pruneAgentActivity(sk) {
    const entry = agentActivityBySession.get(sk)
    if (entry && entry.messages.size === 0 && entry.tools.size === 0) agentActivityBySession.delete(sk)
  }

  function activeAgentTombstoneEntry(sk) {
    maybePruneAgentActivityTombstones()
    let entry = agentActivityTombstonesBySession.get(sk)
    if (!entry) {
      entry = { messages: new Map(), tools: new Map(), clearedAt: 0 }
      agentActivityTombstonesBySession.set(sk, entry)
    }
    return entry
  }

  function maybePruneAgentActivityTombstones(now = Date.now()) {
    if (now < nextAgentActivityTombstoneSweepAt) return
    nextAgentActivityTombstoneSweepAt = now + AGENT_ACTIVITY_TOMBSTONE_SWEEP_MS
    for (const key of [...agentActivityTombstonesBySession.keys()]) pruneAgentActivityTombstones(key, now)
  }

  function pruneAgentActivityTombstones(sk, now = Date.now()) {
    const entry = agentActivityTombstonesBySession.get(sk)
    if (!entry) return null
    for (const [messageId, timestamp] of entry.messages.entries()) {
      if (now - timestamp > AGENT_ACTIVITY_TOMBSTONE_MS) entry.messages.delete(messageId)
    }
    for (const [toolKey, timestamp] of entry.tools.entries()) {
      if (now - timestamp > AGENT_ACTIVITY_TOMBSTONE_MS) entry.tools.delete(toolKey)
    }
    if (entry.clearedAt && now - entry.clearedAt > AGENT_ACTIVITY_TOMBSTONE_MS) entry.clearedAt = 0
    if (entry.messages.size === 0 && entry.tools.size === 0 && !entry.clearedAt) {
      agentActivityTombstonesBySession.delete(sk)
      return null
    }
    return entry
  }

  function normalizedActivityTime(value) {
    const normalized = runtime.normalizeEpochMs?.(value)
    return typeof normalized === "number" && Number.isFinite(normalized) ? normalized : null
  }

  function newestActivityEventTime(info) {
    const time = info?.time || {}
    const candidates = [time.completed, time.updated, time.created, time.started, info?.completed, info?.updated, info?.created, info?.started, info?.time]
      .map(normalizedActivityTime)
      .filter((value) => value != null)
    return candidates.length ? Math.max(...candidates) : null
  }

  function tombstoneAgentMessage(sk, messageId, now = Date.now()) {
    if (!messageId) return
    activeAgentTombstoneEntry(sk).messages.set(String(messageId), now)
    pruneAgentActivityTombstones(sk, now)
  }

  function tombstoneAgentTool(sk, toolKey, now = Date.now()) {
    if (!toolKey) return
    activeAgentTombstoneEntry(sk).tools.set(String(toolKey), now)
    pruneAgentActivityTombstones(sk, now)
  }

  function agentToolMessageId(toolKey) {
    return String(toolKey || "").split(":", 1)[0].trim()
  }

  function shouldSuppressRunningAgentActivity(projectAlias, sessionId, { messageId = "", toolKey = "", eventInfo = null } = {}) {
    if (!projectAlias || !sessionId) return true
    const sk = sessionKey(projectAlias, sessionId)
    maybePruneAgentActivityTombstones()
    const tombstones = pruneAgentActivityTombstones(sk)
    if (!tombstones) return false
    if (messageId && tombstones.messages.has(String(messageId))) return true
    if (toolKey && tombstones.tools.has(String(toolKey))) return true
    if (!tombstones.clearedAt) return false

    const eventTime = newestActivityEventTime(eventInfo)
    if (eventTime != null && eventTime > tombstones.clearedAt) {
      tombstones.clearedAt = 0
      pruneAgentActivityTombstones(sk)
      return false
    }
    return true
  }

  function markAgentMessageActive(projectAlias, sessionId, messageId, active, eventInfo = null) {
    if (!projectAlias || !sessionId || !messageId) return
    const sk = sessionKey(projectAlias, sessionId)
    if (active && shouldSuppressRunningAgentActivity(projectAlias, sessionId, { messageId, eventInfo })) return
    const entry = active ? activeAgentEntry(sk) : agentActivityBySession.get(sk)
    if (!entry) {
      if (!active) tombstoneAgentMessage(sk, messageId)
      return
    }
    if (active) entry.messages.add(String(messageId))
    else {
      entry.messages.delete(String(messageId))
      tombstoneAgentMessage(sk, messageId)
    }
    entry.updatedAt = Date.now()
    pruneAgentActivity(sk)
  }

  function markAgentToolStatus(projectAlias, sessionId, toolKey, status, text = "", { messageId = "", eventInfo = null } = {}) {
    if (!projectAlias || !sessionId || !toolKey) return
    const sk = sessionKey(projectAlias, sessionId)
    if (status === "running" && shouldSuppressRunningAgentActivity(projectAlias, sessionId, { messageId, toolKey, eventInfo })) return
    const entry = status === "running" ? activeAgentEntry(sk) : agentActivityBySession.get(sk)
    if (status === "running") entry.tools.set(String(toolKey), { text: String(text || ""), updatedAt: Date.now() })
    else {
      if (entry) entry.tools.delete(String(toolKey))
      tombstoneAgentTool(sk, toolKey)
    }
    if (!entry) return
    entry.updatedAt = Date.now()
    pruneAgentActivity(sk)
  }

  function clearAgentActivity(projectAlias, sessionId) {
    if (!projectAlias || !sessionId) return
    const sk = sessionKey(projectAlias, sessionId)
    const now = Date.now()
    const entry = agentActivityBySession.get(sk)
    agentActivityBySession.delete(sk)
    if (!entry) {
      maybePruneAgentActivityTombstones(now)
      return
    }
    const tombstones = activeAgentTombstoneEntry(sk)
    if (entry) {
      for (const messageId of entry.messages) tombstones.messages.set(String(messageId), now)
      for (const toolKey of entry.tools.keys()) {
        tombstones.tools.set(String(toolKey), now)
        const toolMessageId = agentToolMessageId(toolKey)
        if (toolMessageId) tombstones.messages.set(toolMessageId, now)
      }
    }
    pruneAgentActivityTombstones(sk, now)
  }

  function clearAgentMessageActivity(projectAlias, sessionId, messageId) {
    if (!projectAlias || !sessionId || !messageId) return
    const sk = sessionKey(projectAlias, sessionId)
    const now = Date.now()
    tombstoneAgentMessage(sk, messageId, now)
    const entry = agentActivityBySession.get(sk)
    if (!entry) return
    const messageKey = String(messageId)
    entry.messages.delete(messageKey)
    for (const toolKey of entry.tools.keys()) {
      if (String(toolKey).startsWith(`${messageKey}:`)) {
        entry.tools.delete(toolKey)
        tombstoneAgentTool(sk, toolKey, now)
      }
    }
    entry.updatedAt = Date.now()
    pruneAgentActivity(sk)
  }

  function getAgentActivityStatus(projectAlias, sessionId) {
    const sk = sessionKey(projectAlias, sessionId)
    maybePruneAgentActivityTombstones()
    const tombstones = pruneAgentActivityTombstones(sk)
    const tombstoneStatus = tombstones
      ? {
        endedMessageIds: [...tombstones.messages.keys()],
        endedToolMessageIds: [...tombstones.tools.keys()].map(agentToolMessageId).filter(Boolean),
        ...(tombstones.clearedAt ? { clearedAt: tombstones.clearedAt } : {}),
      }
      : {}
    const entry = agentActivityBySession.get(sk)
    if (!entry || (entry.messages.size === 0 && entry.tools.size === 0)) return { state: "not-running", ...tombstoneStatus }
    return {
      state: "running",
      activeMessages: entry.messages.size,
      activeTools: entry.tools.size,
      activeMessageIds: [...entry.messages],
      activeToolMessageIds: [...entry.tools.keys()].map(agentToolMessageId).filter(Boolean),
      updatedAt: entry.updatedAt,
      ...tombstoneStatus,
    }
  }

  function hashTextForEcho(text) {
    const t = String(text ?? "")
    return crypto.createHash("sha1").update(t, "utf8").digest("hex") + ":" + String(t.length)
  }

  function agentStopErrorDedupeKey({ messageId = "", partId = "", details = "" } = {}) {
    const msg = String(messageId || "").trim()
    if (msg) return msg
    const part = String(partId || "").trim()
    if (part) return `part:${part}:${hashTextForEcho(details || "agent-stop-error")}`
    return `error:${hashTextForEcho(details || "agent-stop-error")}`
  }

  function agentStopErrorDebounceKey(projectAlias, sessionId, dedupeKey) {
    return `agent-stop-error:${sessionKey(projectAlias, sessionId)}:${dedupeKey}`
  }

  function isAgentStopErrorDebounce(entry) {
    return String(entry?.kind || "").startsWith("agent-stop-error")
  }

  function redactAgentStopErrorText(value) {
    return redactSensitiveText(String(value || ""))
      .replace(/(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|authorization)[A-Za-z0-9_-]*)\s*[:=]\s*[^,;\n\r]+/gi, "$1$2=***")
      .trim()
  }

  function formatAgentStopErrorNotice({ reason = "Agent stopped due to error.", details = "" } = {}) {
    const lines = ["⚠️ Agent stopped due to error."]
    const reasonText = redactAgentStopErrorText(reason)
    if (reasonText) lines.push("", reasonText)
    let detailsText = redactAgentStopErrorText(details)
    if (detailsText.length > 2000) detailsText = `${detailsText.slice(0, 1999)}…`
    if (detailsText) lines.push("", detailsText)
    return lines.join("\n")
  }

  function cancelPendingAgentStopError(projectAlias, sessionId, messageId) {
    const msg = String(messageId || "").trim()
    if (!projectAlias || !sessionId || !msg) return false
    const key = agentStopErrorDebounceKey(projectAlias, sessionId, agentStopErrorDedupeKey({ messageId: msg }))
    const entry = assistantDebounce.get(key)
    if (!isAgentStopErrorDebounce(entry)) return false
    clearTimeout(entry?.timer || entry)
    assistantDebounce.delete(key)
    return true
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
    return kind === "assistant-final" || kind === "assistant-stream" || kind === "changed-files" || kind === "agent-action"
  }

  function renderFeedSettingsText(ctxKey) {
    const mode = getFeedMode(ctxKey)
    return [
      `Feed for this thread: ${feedModeLabel(mode)}`,
      "",
      "Main — final assistant replies only.",
      "Main + changes — final assistant replies and changed files.",
      "Verbose — final replies, streaming previews, agent actions, and changed files.",
      "TUI user-message mirroring is controlled by the runtime mirrorTuiUserMessages setting.",
      "",
      "Internal compaction output stays hidden in all modes.",
    ].join("\n")
  }

  function feedKeyboard(ctxKey) {
    const current = getFeedMode(ctxKey)
    const button = (mode, label) => ({ text: `${current === mode ? "✓ " : ""}${label}`, callback_data: packCallback("feed", mode) })
    return makeInlineKeyboard([
      [button("main", "Main")],
      [button("main+changes", "Main + changes")],
      [button("verbose", "Verbose")],
      [{ text: "Close", callback_data: packCallback("feed", "close") }],
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
    const rows = entries.slice(0, CHANGED_FILES_LIMIT).map((entry, index) => [{
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

  function normalizeAgentActionStatus(status) {
    const normalized = String(status || "").trim().toLowerCase()
    if (normalized === "running" || normalized === "completed" || normalized === "error") return normalized
    return ""
  }

  function compactAgentActionText(value, { fallback = "", max = 180 } = {}) {
    let text = redactSensitiveText(String(value ?? ""))
      .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=***")
      .replace(/\s+/g, " ")
      .trim()
    if (!text) text = fallback
    if (!text) return ""
    if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`
    return text
  }

  function formatToolName(tool) {
    const raw = String(tool || "").trim()
    if (!raw) return "tool"
    return raw.replace(/[_-]+/g, " ")
  }

  function agentActionStatusLabel(status) {
    if (status === "running") return "Running"
    if (status === "completed") return "Done"
    return "Failed"
  }

  function agentActionIcon(status) {
    if (status === "running") return "🛠"
    if (status === "completed") return "✅"
    return "⚠️"
  }

  function formatAgentActionText(part) {
    if (part?.type !== "tool") return ""
    const status = normalizeAgentActionStatus(part?.state?.status)
    if (!status) return ""

    const toolName = compactAgentActionText(part.tool, { fallback: "tool", max: 80 })
    const title = compactAgentActionText(part?.state?.title || part?.metadata?.title || part?.state?.metadata?.title, {
      fallback: formatToolName(toolName),
      max: 180,
    })
    const lines = [`${agentActionIcon(status)} Agent action`, `${agentActionStatusLabel(status)}: ${title}`]
    if (toolName && toolName.toLowerCase() !== title.toLowerCase()) lines.push(`Tool: ${toolName}`)
    if (status === "error") {
      const errorText = compactAgentActionText(part?.state?.error, { max: 240 })
      if (errorText) lines.push(`Error: ${errorText}`)
    }
    return lines.join("\n")
  }

  function stableHash(value) {
    let text = ""
    try {
      text = JSON.stringify(value ?? null)
    } catch {
      text = String(value ?? "")
    }
    return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12)
  }

  function fallbackAgentActionPartId(part, props) {
    const state = part?.state || {}
    const stateTime = state.time || {}
    const identity = [part?.tool || "tool", stateTime.start ?? "", state.raw ?? "", state.input ?? null]
    if (!stateTime.start && !state.raw && state.input == null) identity.push(state.title ?? part?.metadata?.title ?? state.metadata?.title ?? part?.time ?? "")
    return `tool:${stableHash(identity)}`
  }

  function agentActionForwardKey(messageId, partId, status) {
    return `${messageId}:${partId}:${status}`
  }

  function partEventTimeInfo(part, props) {
    const stateTime = part?.state?.time || {}
    const created = stateTime.start ?? props?.time ?? part?.time
    const completed = stateTime.end ?? (part?.state?.status === "completed" || part?.state?.status === "error" ? props?.time : undefined)
    return { time: { created, updated: props?.time, completed } }
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
    return formatUnifiedDiffHtml(diffText, { title: "Changed files diff" })
  }

  function renderSelectedFileDiffHtml(entry) {
    return formatUnifiedDiffHtml(entry?.diff || "", { title: `Changed file diff: ${entry?.file || "file"}` })
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

  async function pauseWithSignal(ms, signal) {
    if (signal?.aborted) return
    if (!signal) {
      await pause(ms)
      return
    }
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      signal.addEventListener?.("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([pause(ms), abortPromise])
    } finally {
      if (onAbort) signal.removeEventListener?.("abort", onAbort)
    }
  }

  async function resolveBoundRouteWithRetry(projectAlias, sessionId, { attempts = ROUTE_LOOKUP_MAX_ATTEMPTS, initialDelayMs = ROUTE_LOOKUP_INITIAL_DELAY_MS, signal, ignoreStopping = false } = {}) {
    let waitMs = initialDelayMs
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted || (isStopping() && ignoreStopping !== true)) return null
      try {
        return await resolveBoundRoute(projectAlias, sessionId)
      } catch (err) {
        if (!isRetryableBoundaryError(err) || attempt + 1 >= attempts) throw err
        logSseDebug(projectAlias, sessionId, `retry=route_lookup attempt=${attempt + 2} error=${err?.message || String(err)}`)
        await pauseWithSignal(waitMs, signal)
        waitMs = Math.min(1000, waitMs * 2)
      }
    }
    return null
  }

  function assistantRetryDelayMs(attempt) {
    return ASSISTANT_FINAL_DELIVERY_RETRY_DELAYS_MS[Math.max(0, Math.min(ASSISTANT_FINAL_DELIVERY_RETRY_DELAYS_MS.length - 1, attempt - 1))]
  }

  function routeCtxFromRoute(route) {
    return { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
  }

  function sameRouteCtx(a, b) {
    return String(a?.chatId ?? "") === String(b?.chatId ?? "") && String(a?.threadIdOr0 || 0) === String(b?.threadIdOr0 || 0)
  }

  function previewMatchesRoute(previewState, routeCtx) {
    const previewRoute = previewState?.routeCtx || previewState?.route
    if (!previewRoute) return true
    return sameRouteCtx(previewRoute, routeCtx)
  }

  function routeProgressKey(routeCtx) {
    return routeCtx?.ctxKey || `${routeCtx?.chatId ?? ""}:${routeCtx?.threadIdOr0 || 0}`
  }

  function resetAssistantDeliveryProgressForRoute(deliveryOptions, routeCtx) {
    const nextRouteKey = routeProgressKey(routeCtx)
    if (!nextRouteKey) return
    if (deliveryOptions.assistantDeliveryRouteKey && deliveryOptions.assistantDeliveryRouteKey !== nextRouteKey) {
      delete deliveryOptions.assistantTextDelivered
      delete deliveryOptions.assistantTextBlockIndex
      delete deliveryOptions.assistantLongNoticeDelivered
    }
    deliveryOptions.assistantDeliveryRouteKey = nextRouteKey
  }

  async function resolveFreshAssistantDeliveryRoute(projectAlias, sessionId, messageId, deliveryOptions = {}) {
    const signal = deliveryOptions.signal || abortSignal
    const allowParentRoute = deliveryOptions.allowParentRoute === true
    const resolved = await resolveBoundRouteWithRetry(projectAlias, sessionId, { signal, ignoreStopping: deliveryOptions.ignoreStopping === true })
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, `drop=assistant_no_route msg=${messageId}`)
      return null
    }
    if (resolved.boundSessionId !== sessionId && !allowParentRoute) {
      logSseDebug(projectAlias, sessionId, `drop=assistant_child_message msg=${messageId} bound=${resolved.boundSessionId}`)
      return null
    }
    const route = resolved.route
    const routeCtx = routeCtxFromRoute(route)
    return { route, routeCtx, boundKey: sessionKey(projectAlias, resolved.boundSessionId) }
  }

  async function deliverAgentStopErrorNotice({
    projectAlias,
    sessionId,
    messageId = "",
    dedupeKey,
    text,
    route,
    routeCtx,
    boundKey,
    previewState,
    allowParentRoute = false,
    verifyMessageError = false,
    deliveryOptions = {},
  } = {}) {
    if (!projectAlias || !sessionId || !dedupeKey || !text) return false
    const sk = sessionKey(projectAlias, sessionId)
    const sets = ensureForwardedSets(sk)
    if (sets.agentStopErrors.has(dedupeKey)) {
      logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_already_forwarded key=${dedupeKey}`)
      return true
    }

    const deliveryKey = agentStopErrorDebounceKey(projectAlias, sessionId, dedupeKey)
    assistantDebounce.delete(deliveryKey)
    if ((isStopping() && deliveryOptions.ignoreStopping !== true) || deliveryOptions.signal?.aborted === true) return false
    let deliveryClaimed = false

    const claimDelivery = () => {
      if (sets.agentStopErrors.has(dedupeKey)) {
        logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_already_forwarded key=${dedupeKey}`)
        return false
      }
      if (deliveryClaimed) return true
      if (agentStopErrorDeliveryClaims.has(deliveryKey)) {
        logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_in_flight key=${dedupeKey}`)
        return false
      }
      agentStopErrorDeliveryClaims.add(deliveryKey)
      deliveryClaimed = true
      return true
    }
    const releaseDeliveryClaim = () => {
      if (!deliveryClaimed) return
      agentStopErrorDeliveryClaims.delete(deliveryKey)
      deliveryClaimed = false
    }

    let noticeText = text
    if (verifyMessageError) {
      if (!messageId) return false
      let msg = null
      try {
        msg = await ocByAlias[projectAlias]?.getMessage?.(sessionId, messageId, { signal: deliveryOptions.signal || abortSignal, timeoutMs: deliveryOptions.timeoutMs })
      } catch (err) {
        const attempt = Number.isInteger(deliveryOptions.agentStopErrorVerifyAttempt) && deliveryOptions.agentStopErrorVerifyAttempt > 0 ? deliveryOptions.agentStopErrorVerifyAttempt : 1
        const classification = classifyBoundaryError(err)
        const canRetry = deliveryOptions.ignoreStopping !== true && deliveryOptions.signal?.aborted !== true && !isStopping() && attempt < ASSISTANT_FINAL_DELIVERY_MAX_ATTEMPTS && classification.retryable
        if (canRetry) {
          const nextAttempt = attempt + 1
          const delayMs = classification.retryAfterMs || assistantRetryDelayMs(attempt)
          logSseDebug(projectAlias, sessionId, `retry=agent_stop_error_verify key=${dedupeKey} attempt=${nextAttempt} delay=${delayMs} ${err?.message || String(err)}`)
          const retryOptions = { ...deliveryOptions, agentStopErrorVerifyAttempt: nextAttempt }
          const retryTimer = setTimeout(() => {
            void deliverAgentStopErrorNotice({ projectAlias, sessionId, messageId, dedupeKey, text, allowParentRoute, verifyMessageError, deliveryOptions: retryOptions })
          }, delayMs)
          retryTimer.unref?.()
          assistantDebounce.set(deliveryKey, {
            timer: retryTimer,
            run: (overrideOptions = {}) => deliverAgentStopErrorNotice({ projectAlias, sessionId, messageId, dedupeKey, text, allowParentRoute, verifyMessageError, deliveryOptions: { ...retryOptions, ...overrideOptions } }),
            deliveryOptions: retryOptions,
            kind: "agent-stop-error-verify",
          })
        } else {
          logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_verify_failed key=${dedupeKey} ${err?.message || String(err)}`)
        }
        return false
      }
      const confirmedError = msg?.info?.error
      if (!confirmedError) {
        if (runtime.normalizeEpochMs(msg?.info?.time?.completed) != null) logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_completed key=${dedupeKey}`)
        else logSseDebug(projectAlias, sessionId, `drop=agent_stop_error_unconfirmed key=${dedupeKey}`)
        return false
      }
      noticeText = formatAgentStopErrorNotice({ reason: "Assistant reply failed.", details: confirmedError })
    }

    const clearPreviewForMessage = (targetBoundKey = boundKey) => {
      if (!targetBoundKey || !messageId) return
      const currentPreview = assistantPreviewBySession.get(targetBoundKey)
      if (currentPreview?.messageId === messageId) assistantPreviewBySession.delete(targetBoundKey)
    }
    const markDelivered = (deliveredRouteCtx = routeCtx, deliveredBoundKey = boundKey) => {
      clearPreviewForMessage(deliveredBoundKey)
      sets.agentStopErrors.add(dedupeKey)
      releaseDeliveryClaim()
      logSseDebug(projectAlias, sessionId, `send=agent_stop_error key=${dedupeKey} thread=${deliveredRouteCtx?.threadIdOr0 || 0}`)
    }

    const previewForMessage = previewState?.messageId === messageId ? previewState : null
    let previewEditFailed = false
    if (previewForMessage?.telegramMessageId && route && routeCtx && previewMatchesRoute(previewForMessage, routeCtx)) {
      if (!claimDelivery()) return false
      const edited = await tg.editMessageText(route.chatId, previewForMessage.telegramMessageId, noticeText, null).then(() => true, () => false)
      if (edited) {
        markDelivered(routeCtx, boundKey)
        return true
      }
      previewEditFailed = true
    }

    try {
      const routeDeliveryOptions = allowParentRoute ? { ...deliveryOptions, allowParentRoute: true } : deliveryOptions
      const freshTarget = await resolveFreshAssistantDeliveryRoute(projectAlias, sessionId, messageId || dedupeKey, routeDeliveryOptions)
      if (!freshTarget) return false
      const freshPreviewState = messageId ? assistantPreviewBySession.get(freshTarget.boundKey) : null
      if (!previewEditFailed && freshPreviewState?.messageId === messageId && freshPreviewState.telegramMessageId && previewMatchesRoute(freshPreviewState, freshTarget.routeCtx)) {
        if (!claimDelivery()) return false
        const edited = await tg.editMessageText(freshTarget.route.chatId, freshPreviewState.telegramMessageId, noticeText, null).then(() => true, () => false)
        if (edited) {
          markDelivered(freshTarget.routeCtx, freshTarget.boundKey)
          return true
        }
      }
      if (!claimDelivery()) return false
      await sendToThread(freshTarget.routeCtx, noticeText)
      markDelivered(freshTarget.routeCtx, freshTarget.boundKey)
      return true
    } catch (err) {
      releaseDeliveryClaim()
      const attempt = Number.isInteger(deliveryOptions.agentStopErrorDeliveryAttempt) && deliveryOptions.agentStopErrorDeliveryAttempt > 0 ? deliveryOptions.agentStopErrorDeliveryAttempt : 1
      const message = err?.message || String(err)
      const classification = classifyBoundaryError(err)
      const canRetry =
        deliveryOptions.ignoreStopping !== true &&
        deliveryOptions.signal?.aborted !== true &&
        !isStopping() &&
        attempt < ASSISTANT_FINAL_DELIVERY_MAX_ATTEMPTS &&
        classification.retryable
      if (canRetry) {
        const nextAttempt = attempt + 1
        const delayMs = classification.retryAfterMs || assistantRetryDelayMs(attempt)
        logSseDebug(projectAlias, sessionId, `retry=agent_stop_error_delivery key=${dedupeKey} attempt=${nextAttempt} delay=${delayMs} ${message}`)
        const retryOptions = { ...deliveryOptions, agentStopErrorDeliveryAttempt: nextAttempt }
        const retryTimer = setTimeout(() => {
          void deliverAgentStopErrorNotice({
            projectAlias,
            sessionId,
            messageId,
            dedupeKey,
            text: noticeText,
            boundKey,
            previewState,
            allowParentRoute,
            deliveryOptions: retryOptions,
          })
        }, delayMs)
        retryTimer.unref?.()
        assistantDebounce.set(deliveryKey, {
          timer: retryTimer,
          run: (overrideOptions = {}) =>
            deliverAgentStopErrorNotice({
              projectAlias,
              sessionId,
              messageId,
              dedupeKey,
              text: noticeText,
              boundKey,
              previewState,
              allowParentRoute,
              deliveryOptions: { ...retryOptions, ...overrideOptions },
            }),
          deliveryOptions: retryOptions,
          kind: "agent-stop-error-retry",
        })
        return false
      }
      runtime.logger?.error?.("Agent stop error notification failed:", projectAlias, sessionId, dedupeKey, message)
      logSseDebug(projectAlias, sessionId, `error=agent_stop_error_delivery key=${dedupeKey} ${message}`)
      return false
    } finally {
      releaseDeliveryClaim()
    }
  }

  function scheduleAgentStopErrorFallback({ projectAlias, sessionId, messageId = "", partId = "", text, dedupeKey, allowParentRoute = false, verifyMessageError = false } = {}) {
    if (!projectAlias || !sessionId || !text) return false
    if (verifyMessageError && !messageId) return false
    const key = dedupeKey || agentStopErrorDedupeKey({ messageId, partId, details: text })
    const sk = sessionKey(projectAlias, sessionId)
    const sets = ensureForwardedSets(sk)
    if (sets.agentStopErrors.has(key)) return false
    const deliveryKey = agentStopErrorDebounceKey(projectAlias, sessionId, key)
    if (isAgentStopErrorDebounce(assistantDebounce.get(deliveryKey))) return false
    const run = (deliveryOptions = {}) =>
      deliverAgentStopErrorNotice({
        projectAlias,
        sessionId,
        messageId,
        dedupeKey: key,
        text,
        allowParentRoute,
        verifyMessageError,
        deliveryOptions,
      })
    const timer = setTimeout(() => {
      void run()
    }, AGENT_STOP_ERROR_FALLBACK_GRACE_MS)
    timer.unref?.()
    assistantDebounce.set(deliveryKey, {
      timer,
      run: (overrideOptions = {}) => run(overrideOptions),
      deliveryOptions: {},
      kind: "agent-stop-error-fallback",
    })
    logSseDebug(projectAlias, sessionId, `schedule=agent_stop_error key=${key} delay=${AGENT_STOP_ERROR_FALLBACK_GRACE_MS}`)
    return true
  }

  async function getAssistantMessageWithRetry(oc, sessionId, messageId, { attempts = 3, initialDelayMs = 150, signal, timeoutMs } = {}) {
    let waitMs = initialDelayMs
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) return null
      const msg = await oc.getMessage(sessionId, messageId, { signal, timeoutMs }).catch(() => null)
      if (msg) return msg
      if (attempt + 1 < attempts) await pauseWithSignal(waitMs, signal)
      waitMs = Math.min(1000, waitMs * 2)
    }
    return null
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

  async function handleMessagePartUpdated({ projectAlias, props }) {
    if (isStopping()) return
    const part = props?.part
    if (part?.type !== "tool") return

    const sessionId = props?.sessionID || part.sessionID || part.sessionId
    const messageId = String(part.messageID || part.messageId || props?.messageID || props?.messageId || "")
    const partId = String(part.id || part.callID || part.callId || fallbackAgentActionPartId(part, props))
    const status = normalizeAgentActionStatus(part?.state?.status)
    if (!sessionId || !partId || !status) return

    logSseDebug(projectAlias, sessionId, `event type=message.part.updated part=tool status=${status} msg=${messageId || "unknown"} part=${partId}`)

    const text = formatAgentActionText(part)
    if (!text) return

    const sk = sessionKey(projectAlias, sessionId)
    const resolved = await resolveBoundRouteWithRetry(projectAlias, sessionId, { signal: abortSignal })
    if (!resolved?.route) {
      logSseDebug(projectAlias, sessionId, "drop=agent_action_no_route")
      return
    }
    if (!eventStartedAfterLaunch(partEventTimeInfo(part, props), { allowCompletedAfterStart: true })) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_before_start part=${partId}`)
      return
    }
    const isChildAction = resolved.boundSessionId !== sessionId
    const route = resolved.route
    const routeCtx = { chatId: route.chatId, threadIdOr0: route.threadIdOr0, ctxKey: ctxKeyFrom(route.chatId, route.threadIdOr0) }
    const sets = ensureForwardedSets(sk)
    const forwardKey = agentActionForwardKey(messageId, partId, status)
    const eventInfo = partEventTimeInfo(part, props)
    markAgentToolStatus(projectAlias, sessionId, `${messageId}:${partId}`, status, text, { messageId, eventInfo })
    if (status === "error") {
      scheduleAgentStopErrorFallback({
        projectAlias,
        sessionId,
        messageId,
        partId,
        text: formatAgentStopErrorNotice({ reason: "Agent action failed; no successful completion was seen yet.", details: text }),
        allowParentRoute: isChildAction,
        verifyMessageError: true,
      })
    }
    if (isChildAction) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_child bound=${resolved.boundSessionId}`)
      return
    }
    if (sets.actions.has(forwardKey)) {
      logSseDebug(projectAlias, sessionId, `drop=agent_action_already_forwarded part=${partId} status=${status}`)
      return
    }

    if (!shouldMirrorToFeed(routeCtx.ctxKey, "agent-action")) {
      sets.actions.add(forwardKey)
      logSseDebug(projectAlias, sessionId, `drop=agent_action_feed part=${partId} mode=${getFeedMode(routeCtx.ctxKey)}`)
      recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.AGENT_ACTION_FEED_FILTERED)
      return
    }

    await sendToThread(routeCtx, text, null, { disable_web_page_preview: true })
    sets.actions.add(forwardKey)
    logSseDebug(projectAlias, sessionId, `send=agent_action part=${partId} status=${status} thread=${route.threadIdOr0 || 0}`)
  }

  async function handleMessageUpdated({ projectAlias, props }) {
    if (isStopping()) return
    const sessionId = props.sessionID
    const info = props.info
    if (!sessionId || !info?.id || !info?.role) return
    logSseDebug(projectAlias, sessionId, `event type=message.updated role=${info.role} msg=${info.id}`)
    const sk = sessionKey(projectAlias, sessionId)
    const resolved = await resolveBoundRouteWithRetry(projectAlias, sessionId, { signal: abortSignal })
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
    const isChildMessage = resolved.boundSessionId !== sessionId
    if (isChildMessage && !(info.role === "assistant" && info.error)) {
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
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.USER_EMPTY)
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
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.USER_ECHO)
        return
      }
      if (config.mirrorTuiUserMessages !== true) {
        sets.user.add(info.id)
        logSseDebug(projectAlias, sessionId, `drop=user_mirror_disabled msg=${info.id}`)
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.USER_MIRROR_DISABLED)
        return
      }
      const blocks = formatMarkdownToTelegramHtmlBlocks(text)
      if (blocks.length > 0) {
        blocks[0] = { ...blocks[0], html: `<i>User:</i>\n${blocks[0].html}` }
      }
      await tg.sendHtmlBlocks(route.chatId, blocks, null, { message_thread_id: route.threadIdOr0 || undefined })
      sets.user.add(info.id)
      logSseDebug(projectAlias, sessionId, `send=user msg=${info.id} thread=${route.threadIdOr0 || 0}`)
    }

    if (info.role !== "assistant") return
    if (!runtime.mirrorCompaction && (info.mode === "compaction" || info.agent === "compaction")) {
      logSseDebug(projectAlias, sessionId, `drop=compaction msg=${info.id}`)
      recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.COMPACTION)
      return
    }

    const completed = runtime.normalizeEpochMs(info.time?.completed) != null
    const hasError = !!info.error
    lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: null })

    if (hasError || completed) clearAgentMessageActivity(projectAlias, sessionId, info.id)
    else markAgentMessageActive(projectAlias, sessionId, info.id, true, info)

    if (hasError) {
      cancelPendingAgentStopError(projectAlias, sessionId, info.id)
      const previewState = assistantPreviewBySession.get(boundKey)
      await deliverAgentStopErrorNotice({
        projectAlias,
        sessionId,
        messageId: info.id,
        dedupeKey: agentStopErrorDedupeKey({ messageId: info.id }),
        text: formatAgentStopErrorNotice({ reason: "Assistant reply failed.", details: info.error }),
        route,
        routeCtx,
        boundKey,
        previewState,
        allowParentRoute: isChildMessage,
      })
      return
    }

    if (completed) cancelPendingAgentStopError(projectAlias, sessionId, info.id)

    if (!completed) {
      if (!shouldMirrorToFeed(routeCtx.ctxKey, "assistant-stream")) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_PREVIEW_FEED_FILTERED)
        return
      }
      const previewState = assistantPreviewBySession.get(boundKey)
      const lastPreviewAt = previewState?.messageId === info.id ? previewState.lastPreviewAt || 0 : 0
      if (Date.now() - lastPreviewAt < 200) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_throttled msg=${info.id}`)
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_PREVIEW_THROTTLED)
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
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_PREVIEW_COMPACTION)
        return
      }
      const text = extractTextParts(msg)
      if (!text || !text.trim()) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_empty msg=${info.id}`)
        recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_PREVIEW_EMPTY)
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
      state.routeCtx = routeCtx
      assistantPreviewBySession.set(boundKey, state)
      logSseDebug(projectAlias, sessionId, `stream=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
      return
    }

    const debounceKey = `${sk}:${info.id}`
    let deliveryState = assistantDeliveryStateByKey.get(debounceKey)
    if (!deliveryState) {
      deliveryState = { deliveryOptions: {}, inFlight: false }
      assistantDeliveryStateByKey.set(debounceKey, deliveryState)
    }
    const existing = assistantDebounce.get(debounceKey)
    if (existing?.kind === "retry") {
      logSseDebug(projectAlias, sessionId, `drop=assistant_retry_pending msg=${info.id}`)
      return
    }
    if (deliveryState.inFlight) {
      logSseDebug(projectAlias, sessionId, `drop=assistant_delivery_in_flight msg=${info.id}`)
      return
    }
    if (existing) clearTimeout(existing?.timer || existing)
    const initialDeliveryOptions = existing?.deliveryOptions && typeof existing.deliveryOptions === "object" ? existing.deliveryOptions : deliveryState.deliveryOptions
    const runDelivery = async (deliveryOptions = {}) => {
      deliveryState.inFlight = true
      const shouldStopDelivery = () => (isStopping() && deliveryOptions.ignoreStopping !== true) || deliveryOptions.signal?.aborted === true
      try {
        assistantDebounce.delete(debounceKey)
        if (shouldStopDelivery()) return
        if (sets.assistant.has(info.id)) {
          logSseDebug(projectAlias, sessionId, `drop=assistant_already_forwarded msg=${info.id}`)
          return
        }
        await (async () => {
          if (shouldStopDelivery()) return
          const msg = await getAssistantMessageWithRetry(oc, sessionId, info.id, deliveryOptions)
          if (shouldStopDelivery()) return

          let currentRoute = null
          let currentRouteCtx = null
          let currentBoundKey = null
          let replaceMessageId = undefined
          const refreshDeliveryTarget = async () => {
            const freshRoute = await resolveFreshAssistantDeliveryRoute(projectAlias, sessionId, info.id, deliveryOptions)
            if (shouldStopDelivery() || !freshRoute) return false
            currentRoute = freshRoute.route
            currentRouteCtx = freshRoute.routeCtx
            currentBoundKey = freshRoute.boundKey
            resetAssistantDeliveryProgressForRoute(deliveryOptions, currentRouteCtx)
            const previewState = assistantPreviewBySession.get(currentBoundKey)
            replaceMessageId = previewState?.messageId === info.id && previewMatchesRoute(previewState, currentRouteCtx) ? previewState.telegramMessageId : undefined
            return true
          }

          if (!msg) {
            if (!(await refreshDeliveryTarget())) return
            if (replaceMessageId) {
              await tg
                .editMessageText(
                  currentRoute.chatId,
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
            recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_COMPACTION)
            return
          }

          const displayText = extractAssistantDisplayText(projectAlias, msg)
          const text = extractTextParts(msg)
          const changedFilesSummary = extractChangedFilesSummary(projectAlias, msg)
          const hasAssistantText = !!text?.trim()
          const hasChangedFiles = !!changedFilesSummary

          if (!(await refreshDeliveryTarget())) return

          if (!displayText || !displayText.trim()) {
            if (replaceMessageId) {
              await tg.editMessageText(currentRoute.chatId, replaceMessageId, "Assistant reply finished with no Telegram-visible content.", null).catch(() => {})
              assistantPreviewBySession.delete(currentBoundKey)
            }
            sets.assistant.add(info.id)
            logSseDebug(projectAlias, sessionId, `drop=assistant_empty msg=${info.id}`)
            recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.ASSISTANT_EMPTY)
            return
          }

          const current = lastAssistantBySession.get(currentBoundKey)
          if (current?.messageId === info.id) lastAssistantBySession.set(currentBoundKey, { messageId: info.id, sessionId, text: displayText })
          const allowChangedFiles = hasChangedFiles && shouldMirrorToFeed(currentRouteCtx.ctxKey, "changed-files")
          let visibleOutputSent = false

          if (hasAssistantText) {
            if (deliveryOptions.assistantTextDelivered === true) {
              visibleOutputSent = true
            } else {
              if (shouldStopDelivery()) return
              const delivered = await deliverAssistantText(currentRouteCtx, projectAlias, sessionId, info.id, text, { replaceMessageId, deliveryOptions })
              if (delivered) deliveryOptions.assistantTextDelivered = true
              visibleOutputSent = visibleOutputSent || !!delivered
            }
          }

          if (allowChangedFiles) {
            if (shouldStopDelivery()) return
            const deliveredChanges = await deliverChangedFilesSummary(currentRouteCtx, projectAlias, sessionId, info.id, msg, {
              replaceMessageId: !hasAssistantText ? replaceMessageId : undefined,
            })
            visibleOutputSent = visibleOutputSent || !!deliveredChanges
            sets.changes.add(info.id)
            logSseDebug(projectAlias, sessionId, `send=changed_files msg=${info.id} thread=${currentRoute.threadIdOr0 || 0}`)
          } else if (hasChangedFiles) {
            sets.changes.add(info.id)
            logSseDebug(projectAlias, sessionId, `drop=changed_files_feed msg=${info.id} mode=${getFeedMode(currentRouteCtx.ctxKey)}`)
            recordNoisySkip(projectAlias, NOISY_SKIP_REASONS.CHANGED_FILES_FEED_FILTERED)
          }

          if (replaceMessageId && !visibleOutputSent) {
            await tg
              .editMessageText(currentRoute.chatId, replaceMessageId, "Assistant reply finished, but no updates matched the current feed mode.", null)
              .catch(() => {})
          }

          if (replaceMessageId) assistantPreviewBySession.delete(currentBoundKey)
          sets.assistant.add(info.id)
          if (visibleOutputSent) recordAssistantMirrored?.(projectAlias)
          logSseDebug(projectAlias, sessionId, `send=assistant msg=${info.id} thread=${currentRoute.threadIdOr0 || 0}`)
        })()
      } finally {
        deliveryState.inFlight = false
      }
    }
    const run = async (deliveryOptions = {}) => {
      try {
        deliveryState.deliveryOptions = deliveryOptions
        await runDelivery(deliveryOptions)
        assistantDeliveryStateByKey.delete(debounceKey)
      } catch (err) {
        const attempt = Number.isInteger(deliveryOptions.finalDeliveryAttempt) && deliveryOptions.finalDeliveryAttempt > 0 ? deliveryOptions.finalDeliveryAttempt : 1
        const message = err?.message || String(err)
        const classification = classifyBoundaryError(err)
        const canRetry =
          deliveryOptions.ignoreStopping !== true &&
          deliveryOptions.signal?.aborted !== true &&
          !isStopping() &&
          attempt < ASSISTANT_FINAL_DELIVERY_MAX_ATTEMPTS &&
          classification.retryable
        if (canRetry) {
          const nextAttempt = attempt + 1
          const delayMs = classification.retryAfterMs || assistantRetryDelayMs(attempt)
          logSseDebug(projectAlias, sessionId, `retry=assistant_final_delivery msg=${info.id} attempt=${nextAttempt} delay=${delayMs} ${message}`)
          deliveryOptions.finalDeliveryAttempt = nextAttempt
          const retryOptions = deliveryOptions
          deliveryState.deliveryOptions = retryOptions
          const retryTimer = setTimeout(() => {
            void run(retryOptions)
          }, delayMs)
          retryTimer.unref?.()
          assistantDebounce.set(debounceKey, {
            timer: retryTimer,
            run: (overrideOptions = {}) => run({ ...retryOptions, ...overrideOptions }),
            deliveryOptions: retryOptions,
            kind: "retry",
          })
          return
        }
        assistantDeliveryStateByKey.delete(debounceKey)
        runtime.logger?.error?.("Assistant final delivery failed:", projectAlias, sessionId, info.id, message)
        logSseDebug(projectAlias, sessionId, `error=assistant_final_delivery msg=${info.id} ${message}`)
      }
    }
    const t = setTimeout(() => {
      void run(initialDeliveryOptions)
    }, 250)
    assistantDebounce.set(debounceKey, {
      timer: t,
      run: (overrideOptions = {}) => run({ ...initialDeliveryOptions, ...overrideOptions }),
      deliveryOptions: initialDeliveryOptions,
      kind: "debounce",
    })
  }

  async function flushPendingAssistantDeliveries({ timeoutMs = 5000 } = {}) {
    const pending = [...assistantDebounce.values()]
    assistantDebounce.clear()
    const ctrl = new AbortController()
    const deadlineMs = Math.max(1, timeoutMs)
    const startedAt = Date.now()
    const timeout = setTimeout(() => ctrl.abort(), deadlineMs)
    for (const entry of pending) {
      if (ctrl.signal.aborted) break
      clearTimeout(entry?.timer || entry)
      if (typeof entry?.run === "function") {
        const remainingMs = Math.max(1, deadlineMs - (Date.now() - startedAt))
        let entryTimeout = null
        try {
          await Promise.race([
            entry.run({ attempts: 1, initialDelayMs: 0, signal: ctrl.signal, timeoutMs: Math.max(1, Math.min(1000, remainingMs)), ignoreStopping: true }),
            new Promise((resolve) => {
              entryTimeout = setTimeout(() => {
                ctrl.abort()
                resolve()
              }, remainingMs)
            }),
          ])
        } finally {
          if (entryTimeout) clearTimeout(entryTimeout)
        }
      }
    }
    clearTimeout(timeout)
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
    formatAgentActionText,
    handleMessagePartUpdated,
    handleMessageUpdated,
    clearAgentActivity,
    getAgentActivityStatus,
    flushPendingAssistantDeliveries,
  }
}
