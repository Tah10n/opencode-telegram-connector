import test from "node:test"
import assert from "node:assert/strict"
import { formatModelUiChoices, resolveModelProviderCatalog } from "../src/connector/model-ui.js"

function pack(value) {
  return `packed:${value}`
}

test("formatModelUiChoices renders text and root model controls", () => {
  const result = formatModelUiChoices({
    cbPack: pack,
    noticeText: "Changed.",
    binding: { projectAlias: "demo", sessionId: "ses_1" },
    preference: { mode: "inherit" },
    effectiveState: { label: "openai/gpt-5", source: "project-default" },
    configuredInfo: { label: "openai/gpt-5" },
    sessionModelInfo: { label: "openai/gpt-4" },
    providerCatalog: [{ id: "openai", name: "OpenAI", models: [{ key: "openai/gpt-5", model: { providerID: "openai", modelID: "gpt-5" }, name: "GPT-5" }] }],
    selectedProviderId: "",
    selectedModelKey: "",
  })

  assert.match(result.text, /^Changed\.\n\nModel for this thread:/)
  assert.match(result.text, /Project default: openai\/gpt-5/)
  assert.deepEqual(result.replyMarkup.inline_keyboard[0], [
    { text: "✓ Inherit", callback_data: "packed:m|set|inherit" },
    { text: "Project default", callback_data: "packed:m|set|project-default" },
  ])
  assert.deepEqual(result.replyMarkup.inline_keyboard[1], [{ text: "openai", callback_data: "packed:m|provider|openai" }])
})

test("formatModelUiChoices renders variant choices without changing callback payloads", () => {
  const result = formatModelUiChoices({
    cbPack: pack,
    binding: { projectAlias: "demo", sessionId: "ses_1" },
    preference: { mode: "custom", model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
    effectiveState: { label: "openai/gpt-5 high", source: "thread-custom" },
    configuredInfo: null,
    sessionModelInfo: null,
    providerCatalog: [{ id: "openai", name: "openai", models: [{ key: "openai/gpt-5", model: { providerID: "openai", modelID: "gpt-5" }, name: "gpt-5" }] }],
    selectedProviderId: "openai",
    selectedModelKey: "openai/gpt-5",
  })

  assert.match(result.text, /Pick a variant for: openai\/gpt-5/)
  assert.deepEqual(result.replyMarkup.inline_keyboard[0], [{ text: "No variant", callback_data: "packed:m|apply|openai/gpt-5|~" }])
  assert.ok(result.replyMarkup.inline_keyboard.some((row) => row.some((button) => button.callback_data === "packed:m|apply|openai/gpt-5|high")))
})

test("resolveModelProviderCatalog merges provider config with fallback models", async () => {
  const catalog = await resolveModelProviderCatalog(
    {
      getConfigProviders: async () => ({
        providers: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-5", providerID: "openai", modelID: "gpt-5", name: "GPT-5" }] }],
      }),
    },
    { providerID: "anthropic", modelID: "claude" },
    { providerID: "openai", modelID: "gpt-5" },
  )

  assert.deepEqual(catalog.map((provider) => provider.id), ["anthropic", "openai"])
  assert.deepEqual(catalog.find((provider) => provider.id === "openai")?.models.map((model) => model.key), ["openai/gpt-5"])
})
