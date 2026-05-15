import { normalizeBoundaryError } from "../boundary-errors.js"

export function createConnectorLifecycleTools({
  lifecycle,
  abortController,
  logger,
  onFatalError,
  runtimeObservability,
  sleep,
} = {}) {
  let fatalRuntimeErrorReported = false

  function trackManagedPromise(name, promise, { kind = "task", metadata, stop } = {}) {
    lifecycle.registerPromise(name, promise, { kind, metadata, stop })
    return promise
  }

  function trackManagedHandle(name, handle, { kind = "task", metadata } = {}) {
    return lifecycle.registerHandle(name, handle, { kind, metadata })
  }

  function recordLoopError(loopName, err, { projectAlias, source = projectAlias ? "opencode" : "runtime", operation, method, pathname } = {}) {
    const normalized = normalizeBoundaryError(err, {
      source,
      operation,
      method,
      pathname,
    })
    runtimeObservability.recordLoopError(loopName, { projectAlias, err: normalized })
    return normalized
  }

  function logLoopIssue(loopName, err, { projectAlias, retryable = false, source = projectAlias ? "opencode" : "runtime", operation, method, pathname } = {}) {
    const normalized = normalizeBoundaryError(err, {
      source,
      operation,
      method,
      pathname,
    })
    if (retryable) {
      runtimeObservability.recordLoopRetry(loopName, { projectAlias, err: normalized })
      logger.warn("Loop retryable error", {
        loop: loopName,
        projectAlias,
        source: normalized.source,
        operation: normalized.operation,
        method: normalized.method,
        pathname: normalized.pathname,
        outcome: normalized.outcome,
        kind: normalized.kind,
        status: normalized.status,
        code: normalized.code,
        retryable: true,
        error: normalized.message,
      })
    } else {
      runtimeObservability.recordLoopError(loopName, { projectAlias, err: normalized })
      logger.error("Loop error", {
        loop: loopName,
        projectAlias,
        source: normalized.source,
        operation: normalized.operation,
        method: normalized.method,
        pathname: normalized.pathname,
        outcome: normalized.outcome,
        kind: normalized.kind,
        status: normalized.status,
        code: normalized.code,
        retryable: false,
        error: normalized.message,
      })
    }
    return normalized
  }

  function recordLoopAbort(loopName, { projectAlias, reason } = {}) {
    runtimeObservability.recordLoopAbort(loopName, { projectAlias, reason })
    logger.info("Loop aborted", { loop: loopName, projectAlias, operation: "abort loop", reason: reason || "stopped" })
  }

  function reportFatalRuntimeError(err, { name, projectAlias } = {}) {
    if (fatalRuntimeErrorReported || abortController.signal.aborted) return
    fatalRuntimeErrorReported = true
    abortController.abort()
    logger.error("Fatal runtime error", { name, projectAlias, source: err?.source || "runtime", operation: err?.operation, kind: err?.kind, outcome: err?.outcome, error: err?.message || String(err) })
    onFatalError(err)
  }

  function startManagedTask(name, run, { kind = "task", metadata, fatalOnError = false } = {}) {
    const promise = (async () => {
      try {
        return await run()
      } catch (err) {
        if (abortController.signal.aborted) return null
        const normalized = logLoopIssue(name, err, {
          projectAlias: metadata?.projectAlias,
          source: metadata?.source || (metadata?.projectAlias ? "opencode" : "runtime"),
          operation: metadata?.operation,
          method: metadata?.method,
          pathname: metadata?.pathname,
        })
        if (fatalOnError) {
          reportFatalRuntimeError(normalized, {
            name,
            projectAlias: metadata?.projectAlias,
          })
          throw normalized
        }
        return null
      }
    })()
    trackManagedPromise(name, promise, { kind, metadata })
    return promise
  }

  async function sleepWithAbort(ms) {
    if (abortController.signal.aborted) return
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      abortController.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([sleep(ms), abortPromise])
    } finally {
      if (onAbort) abortController.signal.removeEventListener("abort", onAbort)
    }
  }

  async function waitForPromiseOrAbort(promise) {
    if (!promise || abortController.signal.aborted) return
    let onAbort = null
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve()
      abortController.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([Promise.resolve(promise).catch(() => {}), abortPromise])
    } finally {
      if (onAbort) abortController.signal.removeEventListener("abort", onAbort)
    }
  }

  return {
    trackManagedPromise,
    trackManagedHandle,
    recordLoopError,
    logLoopIssue,
    recordLoopAbort,
    reportFatalRuntimeError,
    startManagedTask,
    sleepWithAbort,
    waitForPromiseOrAbort,
  }
}
