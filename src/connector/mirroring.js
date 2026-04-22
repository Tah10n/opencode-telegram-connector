import crypto from "node:crypto"
import { makeInlineKeyboard } from "../telegram/client.js"
import { escapeHtml, formatMarkdownToTelegramHtmlBlocks } from "../telegram/formatter.js"
import { ctxKeyFrom } from "../telegram/routing.js"
import { extractPatchDiffText, extractPatchFiles, formatChangedFilesText } from "../message-display.js"
import { DEFAULT_FEED_MODE, normalizeFeedMode, sessionKey } from "../state/store.js"

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
  } = runtime

  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const isStopping = () => abortSignal?.aborted === true

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
    return makeInlineKeyboard([[button("main", "Main")], [button("main+changes", "Main + changes")], [button("verbose", "Verbose")]])
  }

  async function renderFeedSettings(ctxMeta, { editMessageId } = {}) {
    const text = renderFeedSettingsText(ctxMeta.ctxKey)
    const replyMarkup = feedKeyboard(ctxMeta.ctxKey)
    if (editMessageId) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  function changedFilesAttachmentName(projectAlias, sessionId, messageId) {
    const clean = (value, fallback) => {
      const s = String(value || fallback)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
      return s || fallback
    }
    return `${clean(projectAlias, "project")}-${clean(sessionId, "session")}-${clean(messageId, "reply")}.diff.txt`
  }

  function changedFilesSummaryKeyboard(projectAlias, sessionId, messageId) {
    return makeInlineKeyboard([[{ text: "Show diff", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|show`) }]])
  }

  function changedFilesDiffKeyboard(projectAlias, sessionId, messageId) {
    return makeInlineKeyboard([[{ text: "Back", callback_data: cb.pack(`cf|${projectAlias}|${sessionId}|${messageId}|back`) }]])
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

  function renderChangedFilesDiffHtml(diffText) {
    return `<b>Changed files diff</b>\n<pre><code>${escapeHtml(diffText)}</code></pre>`
  }

  async function deliverChangedFilesSummary(ctxMeta, projectAlias, sessionId, messageId, msg, { replaceMessageId } = {}) {
    const text = extractChangedFilesSummary(projectAlias, msg)
    if (!text) return null
    const replyMarkup = changedFilesSummaryKeyboard(projectAlias, sessionId, messageId)
    if (replaceMessageId) {
      const edited = await tg.editMessageText(ctxMeta.chatId, replaceMessageId, text, replyMarkup).catch(() => null)
      if (edited) return { mode: "edited" }
    }
    await sendToThread(ctxMeta, text, replyMarkup)
    return { mode: "sent" }
  }

  async function renderChangedFilesView(ctxMeta, projectAlias, sessionId, messageId, action, { editMessageId } = {}) {
    if (!editMessageId) return
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
      await tg.editMessageText(ctxMeta.chatId, editMessageId, summary, changedFilesSummaryKeyboard(projectAlias, sessionId, messageId))
      return
    }

    const diffText = extractPatchDiffText(msg)
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
        "Diff is too large for an inline preview. It was attached as a .txt file.",
        changedFilesDiffKeyboard(projectAlias, sessionId, messageId),
      )
      await tg.sendDocument(
        ctxMeta.chatId,
        diffText,
        changedFilesAttachmentName(projectAlias, sessionId, messageId),
        `Changed files diff (${projectAlias}/${sessionId})`,
        { message_thread_id: ctxMeta.threadIdOr0 || undefined },
      )
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

  function assistantAttachmentName(projectAlias, sessionId, messageId) {
    const clean = (value, fallback) => {
      const s = String(value || fallback)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
      return s || fallback
    }
    return `${clean(projectAlias, "project")}-${clean(sessionId, "session")}-${clean(messageId, "reply")}.txt`
  }

  function buildAssistantStreamPreviewHtml(text) {
    const body = String(text || "").trim()
    if (!body) return "<i>Streaming reply…</i>"
    const trimmed = runtime.clampString(body, STREAM_PREVIEW_MAX_CHARS)
    return `<i>Streaming reply…</i>\n${escapeHtml(trimmed)}`
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
      const notice = "Assistant reply was attached as a .txt file because it is too long for Telegram messages."
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
        `Assistant reply (${projectAlias}/${sessionId})`,
        { message_thread_id: ctxMeta.threadIdOr0 || undefined },
      )
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

    if (resolved.boundSessionId !== sessionId) {
      logSseDebug(projectAlias, sessionId, `drop=child_message bound=${resolved.boundSessionId}`)
      return
    }
    if (!eventStartedAfterLaunch(info, { allowCompletedAfterStart: info.role === "assistant" })) {
      logSseDebug(projectAlias, sessionId, "drop=before_connector_start")
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
        return
      }
      if (!shouldMirrorToFeed(routeCtx.ctxKey, "user-mirror")) {
        sets.user.add(info.id)
        logSseDebug(projectAlias, sessionId, `drop=user_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
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
        return
      }
      const previewState = assistantPreviewBySession.get(boundKey)
      const lastPreviewAt = previewState?.messageId === info.id ? previewState.lastPreviewAt || 0 : 0
      if (Date.now() - lastPreviewAt < 200) {
        logSseDebug(projectAlias, sessionId, `drop=assistant_preview_throttled msg=${info.id}`)
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
        return
      }
      const text = extractTextParts(msg)
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
          return
        }

        const current = lastAssistantBySession.get(boundKey)
        if (current?.messageId === info.id) lastAssistantBySession.set(boundKey, { messageId: info.id, sessionId, text: displayText })
        const allowChangedFiles = hasChangedFiles && shouldMirrorToFeed(routeCtx.ctxKey, "changed-files")
        let visibleOutputSent = false

        if (hasAssistantText) {
          if (isStopping()) return
          await deliverAssistantText(routeCtx, projectAlias, sessionId, info.id, text, { replaceMessageId })
          visibleOutputSent = true
        }

        if (allowChangedFiles) {
          if (isStopping()) return
          await deliverChangedFilesSummary(routeCtx, projectAlias, sessionId, info.id, msg, {
            replaceMessageId: !hasAssistantText ? replaceMessageId : undefined,
          })
          visibleOutputSent = true
          sets.changes.add(info.id)
          logSseDebug(projectAlias, sessionId, `send=changed_files msg=${info.id} thread=${route.threadIdOr0 || 0}`)
        } else if (hasChangedFiles) {
          sets.changes.add(info.id)
          logSseDebug(projectAlias, sessionId, `drop=changed_files_feed msg=${info.id} mode=${getFeedMode(routeCtx.ctxKey)}`)
        }

        if (replaceMessageId && !visibleOutputSent) {
          await tg
            .editMessageText(route.chatId, replaceMessageId, "Assistant reply finished, but no updates matched the current feed mode.", null)
            .catch(() => {})
        }

        if (replaceMessageId) assistantPreviewBySession.delete(boundKey)
        sets.assistant.add(info.id)
        logSseDebug(projectAlias, sessionId, `send=assistant msg=${info.id} thread=${route.threadIdOr0 || 0}`)
      })().catch(() => {})
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
