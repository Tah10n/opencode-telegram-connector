import { directoriesMatch } from "./directory-paths.js"

function configuredDirectory(value) {
  const directory = String(value ?? "").trim()
  return directory || ""
}

function sessionDirectory(session) {
  return configuredDirectory(session?.directory)
}

export function sessionProjectScopeDecision(session, project) {
  const projectDirectory = configuredDirectory(project?.directory)
  if (!projectDirectory) return { ok: true, reason: "project-directory-not-configured" }

  const directory = sessionDirectory(session)
  if (directory && directoriesMatch(directory, projectDirectory)) return { ok: true, reason: "directory-match" }
  if (!directory && project?.allowUnscopedSessionListFallback === true) return { ok: true, reason: "unscoped-fallback" }

  return { ok: false, reason: directory ? "directory-mismatch" : "missing-directory" }
}

export function sessionProjectScopeDecisionWithFallback(session, project, fallbackEvidence = null) {
  const decision = sessionProjectScopeDecision(session, project)
  if (decision.ok || sessionDirectory(session) || !fallbackEvidence) return decision
  return sessionProjectScopeDecision(fallbackEvidence, project)
}

export function sessionProjectScopeErrorText(projectAlias, sessionId, decision = {}) {
  const project = String(projectAlias || "").trim() || "(unknown)"
  const session = String(sessionId || "").trim() || "(unknown)"
  if (decision.reason === "missing-directory") {
    return `Session ${session} cannot be used for project '${project}' because OpenCode did not return project directory evidence.`
  }
  return `Session ${session} cannot be used for project '${project}' because OpenCode reported a different project directory.`
}
