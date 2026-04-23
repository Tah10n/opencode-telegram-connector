import test from "node:test"
import assert from "node:assert/strict"
import { createRuntimeObservability } from "../src/runtime/observability.js"

test("createRuntimeObservability redacts loop errors in runtime and project status", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })
  const sensitiveError = new Error("GET http://user:secret@example.test:4312/path?token=abc#frag Authorization: Bearer supersecret")

  observability.recordLoopError("telegramPoll", { err: sensitiveError })
  observability.recordLoopError("sse", { projectAlias: "demo", err: sensitiveError })

  const runtimeText = observability.buildRuntimeStatusLines().join("\n")
  const projectText = observability.buildStatusLines("demo").join("\n")

  for (const text of [runtimeText, projectText]) {
    assert.match(text, /token=\*\*\*/)
    assert.doesNotMatch(text, /user|supersecret|token=abc|frag|Bearer supersecret/)
  }
})
