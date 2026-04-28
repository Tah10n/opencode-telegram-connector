import { normalizeBoundaryError } from "../boundary-errors.js"
import { redactCmdlineSecrets } from "../url-utils.js"

function createLoopState() {
  return {
    retries: 0,
    fallbackHits: 0,
    aborted: 0,
    lastError: "",
    lastErrorAt: 0,
    lastRetryAt: 0,
    lastAbortAt: 0,
    lastAbortReason: "",
    lastSuccessAt: 0,
    lastConnectedAt: 0,
  }
}

function createProjectState() {
  return {
    loops: {
      sse: createLoopState(),
      promptPoll: createLoopState(),
      autoStart: createLoopState(),
      startupSession: createLoopState(),
    },
    promptRecovery: { restored: 0, stale: 0, retryable: 0, fatal: 0 },
    promptCleanup: { stale: 0 },
    callbacks: { stale: 0, retryable: 0, fatal: 0 },
    messages: { assistantMirrored: 0, noisySkipped: 0 },
    prompts: { delivered: 0, answered: 0 },
    telegram: { sendFailures: 0, editFailures: 0 },
    attachments: { fallbacks: 0 },
  }
}

function createGlobalState() {
  return {
    loops: {
      telegramPoll: createLoopState(),
      backlogDrain: createLoopState(),
      promptPoll: createLoopState(),
      shutdown: createLoopState(),
    },
    updates: {
      retryable: 0,
      skipped: 0,
    },
    messages: { assistantMirrored: 0, noisySkipped: 0 },
    prompts: { delivered: 0, answered: 0 },
    telegram: { sendFailures: 0, editFailures: 0 },
    attachments: { fallbacks: 0 },
  }
}

function safeErrorMessage(err) {
  if (!err) return ""
  return redactCmdlineSecrets(normalizeBoundaryError(err, { source: err?.source || "runtime" }).message)
}

function formatTime(value) {
  return value ? new Date(value).toISOString() : "never"
}

function formatLoopLine(label, loop, { includeFallback = false, includeConnected = false } = {}) {
  const parts = [`${label}: retries=${loop.retries}`, `aborted=${loop.aborted}`]
  if (includeFallback) parts.push(`hits=${loop.fallbackHits}`)
  if (includeConnected) parts.push(`connected=${formatTime(loop.lastConnectedAt)}`)
  if (loop.lastSuccessAt) parts.push(`lastOk=${formatTime(loop.lastSuccessAt)}`)
  if (loop.lastRetryAt) parts.push(`lastRetry=${formatTime(loop.lastRetryAt)}`)
  if (loop.lastErrorAt) parts.push(`lastErrorAt=${formatTime(loop.lastErrorAt)}`)
  if (loop.lastAbortAt) parts.push(`lastAbort=${formatTime(loop.lastAbortAt)}`)
  if (loop.lastError) parts.push(`lastError=${loop.lastError}`)
  return parts.join(" ")
}

function summarizeTasks(tasks) {
  const counts = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const kind = task?.kind || "unknown"
    counts.set(kind, (counts.get(kind) || 0) + 1)
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}=${count}`).join(" ") || "none"
}

export function createRuntimeObservability({ projectAliases = [] } = {}) {
  const projectState = new Map(projectAliases.map((alias) => [alias, createProjectState()]))
  const globalState = createGlobalState()

  function getProjectState(projectAlias) {
    if (!projectAlias) return null
    if (!projectState.has(projectAlias)) projectState.set(projectAlias, createProjectState())
    return projectState.get(projectAlias)
  }

  function getLoop(loopName, { projectAlias } = {}) {
    if (projectAlias) return getProjectState(projectAlias)?.loops?.[loopName] || null
    return globalState.loops?.[loopName] || null
  }

  function increment(bucketName, counterName, { projectAlias, by = 1 } = {}) {
    const amount = Number.isFinite(Number(by)) ? Number(by) : 1
    if (globalState[bucketName] && Object.hasOwn(globalState[bucketName], counterName)) {
      globalState[bucketName][counterName] += amount
    }
    const project = getProjectState(projectAlias)
    if (project?.[bucketName] && Object.hasOwn(project[bucketName], counterName)) {
      project[bucketName][counterName] += amount
    }
  }

  function recordLoopRetry(loopName, { projectAlias, err } = {}) {
    const loop = getLoop(loopName, { projectAlias })
    if (!loop) return
    loop.retries += 1
    loop.lastRetryAt = Date.now()
    loop.lastError = safeErrorMessage(err)
    loop.lastErrorAt = loop.lastError ? Date.now() : loop.lastErrorAt
  }

  function recordLoopError(loopName, { projectAlias, err } = {}) {
    const loop = getLoop(loopName, { projectAlias })
    if (!loop) return
    loop.lastError = safeErrorMessage(err)
    loop.lastErrorAt = loop.lastError ? Date.now() : loop.lastErrorAt
  }

  function recordLoopSuccess(loopName, { projectAlias, connected = false } = {}) {
    const loop = getLoop(loopName, { projectAlias })
    if (!loop) return
    loop.lastSuccessAt = Date.now()
    loop.lastError = ""
    if (connected) loop.lastConnectedAt = loop.lastSuccessAt
  }

  function recordLoopAbort(loopName, { projectAlias, reason } = {}) {
    const loop = getLoop(loopName, { projectAlias })
    if (!loop) return
    loop.aborted += 1
    loop.lastAbortAt = Date.now()
    loop.lastAbortReason = String(reason || "")
  }

  function recordLoopFallbackHit(loopName, { projectAlias } = {}) {
    const loop = getLoop(loopName, { projectAlias })
    if (!loop) return
    loop.fallbackHits += 1
    loop.lastSuccessAt = Date.now()
  }

  function recordPromptRecovery(projectAlias, outcome) {
    const bucket = getProjectState(projectAlias)?.promptRecovery
    if (!bucket || !Object.hasOwn(bucket, outcome)) return
    bucket[outcome] += 1
  }

  function recordPromptCleanup(projectAlias, outcome = "stale") {
    const bucket = getProjectState(projectAlias)?.promptCleanup
    if (!bucket || !Object.hasOwn(bucket, outcome)) return
    bucket[outcome] += 1
  }

  function recordCallbackOutcome(projectAlias, outcome) {
    const bucket = getProjectState(projectAlias)?.callbacks
    if (!bucket || !Object.hasOwn(bucket, outcome)) return
    bucket[outcome] += 1
  }

  function recordUpdateRetry() {
    globalState.updates.retryable += 1
  }

  function recordUpdateSkip() {
    globalState.updates.skipped += 1
  }

  function recordAssistantMirrored(projectAlias) {
    increment("messages", "assistantMirrored", { projectAlias })
  }

  function recordNoisyEventSkipped(projectAlias, _reason) {
    increment("messages", "noisySkipped", { projectAlias })
  }

  function recordPromptDelivered(projectAlias, _type) {
    increment("prompts", "delivered", { projectAlias })
  }

  function recordPromptAnswered(projectAlias, _type, _outcome = "ok") {
    increment("prompts", "answered", { projectAlias })
  }

  function recordTelegramFailure({ projectAlias, operation } = {}) {
    const op = String(operation || "").toLowerCase()
    const counter = op.includes("edit") ? "editFailures" : "sendFailures"
    increment("telegram", counter, { projectAlias })
  }

  function recordAttachmentFallback(projectAlias, _kind) {
    increment("attachments", "fallbacks", { projectAlias })
  }

  function formatCounterLines(state) {
    return [
      `Messages: assistant=${state.messages.assistantMirrored} skipped=${state.messages.noisySkipped} attachmentFallbacks=${state.attachments.fallbacks}`,
      `Prompts: delivered=${state.prompts.delivered} answered=${state.prompts.answered}`,
      `Telegram delivery: sendFailures=${state.telegram.sendFailures} editFailures=${state.telegram.editFailures}`,
    ]
  }

  function buildStatusLines(projectAlias) {
    const project = getProjectState(projectAlias)
    if (!project) {
      return [
        `Runtime: update retries=${globalState.updates.retryable} skipped=${globalState.updates.skipped} telegram retries=${globalState.loops.telegramPoll.retries} backlog retries=${globalState.loops.backlogDrain.retries}`,
      ]
    }

    const lines = [
      `Prompt recovery: restored=${project.promptRecovery.restored} stale=${project.promptRecovery.stale} retryable=${project.promptRecovery.retryable} fatal=${project.promptRecovery.fatal}`,
      `Callback outcomes: stale=${project.callbacks.stale} retryable=${project.callbacks.retryable} fatal=${project.callbacks.fatal}`,
      ...formatCounterLines(project),
    ]

    if (project.promptCleanup.stale > 0) {
      lines.push(`Prompt cleanup: stale=${project.promptCleanup.stale}`)
    }

    lines.push(formatLoopLine("SSE observed", project.loops.sse, { includeConnected: true }))

    if (
      project.loops.promptPoll.retries > 0 ||
      project.loops.promptPoll.fallbackHits > 0 ||
      project.loops.promptPoll.aborted > 0 ||
      project.loops.promptPoll.lastError
    ) {
      lines.push(formatLoopLine("Prompt poll observed", project.loops.promptPoll, { includeFallback: true }))
    }

    if (project.loops.autoStart.retries > 0 || project.loops.autoStart.lastError) {
      lines.push(formatLoopLine("Auto-start observed", project.loops.autoStart))
    }

    if (project.loops.startupSession.retries > 0 || project.loops.startupSession.lastError) {
      lines.push(formatLoopLine("Startup session observed", project.loops.startupSession))
    }

    lines.push(
      `Runtime: update retries=${globalState.updates.retryable} skipped=${globalState.updates.skipped} telegram retries=${globalState.loops.telegramPoll.retries} backlog retries=${globalState.loops.backlogDrain.retries}`,
    )

    return lines
  }

  function buildRuntimeStatusLines({ managedTasks = [], shutdownState = "running" } = {}) {
    return [
      `Runtime: managedTasks=${Array.isArray(managedTasks) ? managedTasks.length : 0} taskKinds=${summarizeTasks(managedTasks)} shutdown=${shutdownState}`,
      formatLoopLine("Telegram poll", globalState.loops.telegramPoll),
      formatLoopLine("Backlog drain", globalState.loops.backlogDrain),
      formatLoopLine("Prompt poll", globalState.loops.promptPoll, { includeFallback: true }),
      formatLoopLine("Shutdown", globalState.loops.shutdown),
      `Updates: retryable=${globalState.updates.retryable} skipped=${globalState.updates.skipped}`,
      ...formatCounterLines(globalState),
    ]
  }

  return {
    recordLoopRetry,
    recordLoopError,
    recordLoopSuccess,
    recordLoopAbort,
    recordLoopFallbackHit,
    recordPromptRecovery,
    recordPromptCleanup,
    recordCallbackOutcome,
    recordUpdateRetry,
    recordUpdateSkip,
    recordAssistantMirrored,
    recordNoisyEventSkipped,
    recordPromptDelivered,
    recordPromptAnswered,
    recordTelegramFailure,
    recordAttachmentFallback,
    buildStatusLines,
    buildRuntimeStatusLines,
  }
}
