import { makeBoundaryError } from "../boundary-errors.js"
import { directoriesMatch } from "../directory-paths.js"
import { effectiveOpenCodeSseEventPath, getOpenCodeSseEventMeta } from "../opencode/sse.js"
import { createCorrelationId, getRequestContext } from "./request-context.js"

export function sseRequestContextFields(projectAlias, evt) {
  const props = evt?.properties || {}
  const part = props?.part || {}
  const info = props?.info || {}
  const sessionId = props.sessionID || props.sessionId || part.sessionID || part.sessionId || ""
  const messageId = info.id || props.messageID || props.messageId || part.messageID || part.messageId || ""
  return {
    source: "opencode",
    operation: "handle SSE event",
    projectAlias,
    eventType: evt?.type || "unknown",
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(getRequestContext().correlationId ? {} : { correlationId: createCorrelationId("sse", [projectAlias, evt?.type || "event"]) }),
  }
}

export function sseEventDirectoryRoutingDecision(projects, projectAlias, evt) {
  const meta = getOpenCodeSseEventMeta(evt)
  const eventDirectory = meta?.directory
  const projectDirectory = projects?.[projectAlias]?.directory
  if (meta?.requiresDirectoryRouting) {
    if (!eventDirectory) return { matches: false, reason: "global_directory_missing" }
    if (!projectDirectory) return { matches: false, reason: "project_directory_missing" }
  }
  if (eventDirectory && projectDirectory && !directoriesMatch(eventDirectory, projectDirectory)) {
    return { matches: false, reason: "directory_mismatch" }
  }
  return { matches: true, reason: "matched" }
}

function sseEventPathFallback() {
  return effectiveOpenCodeSseEventPath()
}

export function sseErrorContext(err) {
  const method = err?.method || "GET"
  const pathname = err?.pathname || sseEventPathFallback()
  return {
    source: "opencode",
    operation: err?.operation || `${method} ${pathname}`,
    method,
    pathname,
  }
}

export function makeSseProjectRoutingError(projectAlias, issue) {
  const pathname = issue?.eventPath || sseEventPathFallback()
  return makeBoundaryError({
    source: "opencode",
    operation: `GET ${pathname}`,
    method: "GET",
    pathname,
    kind: "configuration",
    outcome: "fatal",
    message: `SSE disabled for project '${projectAlias}': ${pathname} requires project 'directory' for safe routing. Add 'directory' to connector.config.mjs or set OPENCODE_SSE_EVENT_PATH=/event for legacy opencode builds.`,
  })
}
