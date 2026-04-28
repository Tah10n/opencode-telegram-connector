import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeModelReference,
  normalizeVariant,
  modelKeyOf,
  formatModelLabel,
  normalizeModelPreference,
  storedModelPreference,
  sessionModelInfoFromMessage,
  pickMostRecentSessionModelInfo,
  configuredModelInfo,
  modelSourceLabel,
  commonVariantsForModel,
  collectModelCandidates,
} from "../src/model-selection.js"

test("normalizeModelReference parses provider/model strings", () => {
  assert.deepEqual(normalizeModelReference("anthropic/claude-3-5-sonnet"), { providerID: "anthropic", modelID: "claude-3-5-sonnet" })
  assert.deepEqual(normalizeModelReference("openai/gpt-4o"), { providerID: "openai", modelID: "gpt-4o" })
  assert.equal(normalizeModelReference(""), null)
  assert.equal(normalizeModelReference("noslash"), null)
  assert.equal(normalizeModelReference("/noProvider"), null)
  assert.equal(normalizeModelReference("noModel/"), null)
  assert.equal(normalizeModelReference(null), null)
})

test("normalizeModelReference parses object form", () => {
  assert.deepEqual(normalizeModelReference({ providerID: "anthropic", modelID: "claude-3" }), { providerID: "anthropic", modelID: "claude-3" })
  assert.deepEqual(normalizeModelReference({ providerId: "openai", modelId: "gpt-4" }), { providerID: "openai", modelID: "gpt-4" })
  assert.deepEqual(normalizeModelReference({ provider: "google", model: "gemini" }), { providerID: "google", modelID: "gemini" })
  assert.equal(normalizeModelReference({ providerID: "", modelID: "x" }), null)
})

test("modelKeyOf returns provider/model string", () => {
  assert.equal(modelKeyOf("anthropic/claude-3"), "anthropic/claude-3")
  assert.equal(modelKeyOf({ providerID: "openai", modelID: "gpt-4" }), "openai/gpt-4")
  assert.equal(modelKeyOf(null), "")
  assert.equal(modelKeyOf("invalid"), "")
})

test("formatModelLabel includes variant when present", () => {
  assert.equal(formatModelLabel("anthropic/claude-3", "high"), "anthropic/claude-3 high")
  assert.equal(formatModelLabel("anthropic/claude-3", ""), "anthropic/claude-3")
  assert.equal(formatModelLabel("anthropic/claude-3"), "anthropic/claude-3")
  assert.equal(formatModelLabel(null), "")
})

test("normalizeModelPreference returns inherit for invalid input", () => {
  assert.deepEqual(normalizeModelPreference(null), { mode: "inherit" })
  assert.deepEqual(normalizeModelPreference({}), { mode: "inherit" })
  assert.deepEqual(normalizeModelPreference({ mode: "custom" }), { mode: "inherit" })
})

test("normalizeModelPreference handles project-default mode", () => {
  assert.deepEqual(normalizeModelPreference({ mode: "project-default" }), { mode: "project-default" })
})

test("normalizeModelPreference handles custom mode with model", () => {
  const result = normalizeModelPreference({ mode: "custom", model: "anthropic/claude-3", variant: "high" })
  assert.equal(result.mode, "custom")
  assert.deepEqual(result.model, { providerID: "anthropic", modelID: "claude-3" })
  assert.equal(result.variant, "high")
})

test("storedModelPreference returns null for inherit mode", () => {
  assert.equal(storedModelPreference(null), null)
  assert.equal(storedModelPreference({}), null)
  assert.deepEqual(storedModelPreference({ mode: "project-default" }), { mode: "project-default" })
})

test("sessionModelInfoFromMessage extracts model info", () => {
  const msg = { info: { providerID: "anthropic", modelID: "claude-3", variant: "high" } }
  const result = sessionModelInfoFromMessage(msg)
  assert.equal(result?.model?.providerID, "anthropic")
  assert.equal(result?.model?.modelID, "claude-3")
  assert.equal(result?.variant, "high")
  assert.equal(result?.label, "anthropic/claude-3 high")
})

test("sessionModelInfoFromMessage supports model payload objects", () => {
  const result = sessionModelInfoFromMessage({
    model: {
      provider: "google",
      model: "gemini-2.0-flash",
      variant: "low",
    },
  })

  assert.equal(result?.model?.providerID, "google")
  assert.equal(result?.model?.modelID, "gemini-2.0-flash")
  assert.equal(result?.variant, "low")
  assert.equal(result?.label, "google/gemini-2.0-flash low")
})

test("sessionModelInfoFromMessage returns null for missing model", () => {
  assert.equal(sessionModelInfoFromMessage(null), null)
  assert.equal(sessionModelInfoFromMessage({}), null)
})

test("pickMostRecentSessionModelInfo returns entry with latest timestamp", () => {
  const messages = [
    { info: { providerID: "anthropic", modelID: "claude-2", time: { created: 1000 } } },
    { info: { providerID: "anthropic", modelID: "claude-3", time: { created: 2000 } } },
  ]
  const result = pickMostRecentSessionModelInfo(messages)
  assert.equal(result?.model?.modelID, "claude-3")
})

test("pickMostRecentSessionModelInfo returns null for empty input", () => {
  assert.equal(pickMostRecentSessionModelInfo([]), null)
  assert.equal(pickMostRecentSessionModelInfo(null), null)
})

test("configuredModelInfo reads from agent config when default_agent set", () => {
  const info = {
    default_agent: "myAgent",
    agent: { myAgent: { model: "anthropic/claude-3", variant: "high" } },
  }
  const result = configuredModelInfo(info)
  assert.equal(result?.model?.providerID, "anthropic")
  assert.equal(result?.variant, "high")
})

test("configuredModelInfo reads from legacy agents map", () => {
  const result = configuredModelInfo({
    default_agent: "primary",
    agents: { primary: { model: { providerID: "openai", modelID: "gpt-4o-mini" }, variant: "minimal" } },
  })

  assert.equal(result?.model?.providerID, "openai")
  assert.equal(result?.model?.modelID, "gpt-4o-mini")
  assert.equal(result?.variant, "minimal")
})

test("configuredModelInfo falls back to top-level model", () => {
  const result = configuredModelInfo({ model: "openai/gpt-4" })
  assert.equal(result?.model?.providerID, "openai")
  assert.equal(result?.model?.modelID, "gpt-4")
})

test("configuredModelInfo returns null for missing model", () => {
  assert.equal(configuredModelInfo(null), null)
  assert.equal(configuredModelInfo({}), null)
})

test("modelSourceLabel returns readable strings", () => {
  assert.equal(modelSourceLabel("thread-custom"), "Thread custom override")
  assert.equal(modelSourceLabel("thread-project-default"), "Thread project default override")
  assert.equal(modelSourceLabel("project-default"), "Inherited from project default")
  assert.equal(modelSourceLabel("unknown-source"), "Unknown")
})

test("commonVariantsForModel returns provider-specific lists", () => {
  assert.deepEqual(commonVariantsForModel("anthropic/claude-3"), ["high", "max"])
  assert.deepEqual(commonVariantsForModel("openai/gpt-4"), ["none", "minimal", "low", "medium", "high", "xhigh"])
  assert.deepEqual(commonVariantsForModel("google/gemini"), ["low", "high"])
  assert.deepEqual(commonVariantsForModel("unknown/model"), ["low", "medium", "high"])
  assert.deepEqual(commonVariantsForModel(null), ["low", "medium", "high"])
})

test("collectModelCandidates deduplicates by model key", () => {
  const entries = [
    { model: "anthropic/claude-3" },
    { model: "openai/gpt-4" },
    { model: "anthropic/claude-3" },
  ]
  const result = collectModelCandidates(entries)
  assert.equal(result.length, 2)
  assert.equal(result[0].model.modelID, "claude-3")
  assert.equal(result[1].model.modelID, "gpt-4")
})

test("collectModelCandidates accepts flat string entries", () => {
  const result = collectModelCandidates(["anthropic/claude-3", "openai/gpt-4"])
  assert.equal(result.length, 2)
})

test("collectModelCandidates skips invalid entries", () => {
  const result = collectModelCandidates([null, undefined, "invalid", { model: "openai/gpt-4" }])
  assert.equal(result.length, 1)
  assert.equal(result[0].model.providerID, "openai")
})

test("normalizeVariant trims whitespace", () => {
  assert.equal(normalizeVariant("  high  "), "high")
  assert.equal(normalizeVariant(""), "")
  assert.equal(normalizeVariant(null), "")
})
