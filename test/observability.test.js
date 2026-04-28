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

test("createRuntimeObservability records compact privacy-safe counters", () => {
  const observability = createRuntimeObservability({ projectAliases: ["demo"] })

  observability.recordAssistantMirrored("demo")
  observability.recordNoisyEventSkipped("demo", "compaction")
  observability.recordPromptDelivered("demo", "permission")
  observability.recordPromptAnswered("demo", "permission", "ok")
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "sendMessage" })
  observability.recordTelegramFailure({ projectAlias: "demo", operation: "editMessageText" })
  observability.recordAttachmentFallback("demo", "assistant-long-output")

  const projectText = observability.buildStatusLines("demo").join("\n")
  const runtimeText = observability.buildRuntimeStatusLines().join("\n")

  for (const text of [projectText, runtimeText]) {
    assert.match(text, /Messages: assistant=1 skipped=1 attachmentFallbacks=1/)
    assert.match(text, /Prompts: delivered=1 answered=1/)
    assert.match(text, /Telegram delivery: sendFailures=1 editFailures=1/)
    assert.doesNotMatch(text, /chat|session|state\.json|token/i)
  }
})
