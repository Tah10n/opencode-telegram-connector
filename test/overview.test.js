import test from "node:test"
import assert from "node:assert/strict"
import { createOverviewHelpers } from "../src/connector/overview.js"

test("createOverviewHelpers startServerKeyboard packs callback data", () => {
  const helpers = createOverviewHelpers({
    projects: { veryLongAliasNameForProject1234567890: {} },
    store: { get: () => ({ bindings: {} }) },
    startInProgress: new Map(),
    parseCtxKey: () => null,
    sendToThread: async () => {},
    cb: {
      pack: (value) => `packed:${value}`,
    },
  })

  const keyboard = helpers.startServerKeyboard("veryLongAliasNameForProject1234567890")
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "packed:srv|veryLongAliasNameForProject1234567890|start")
})

test("createOverviewHelpers sends unavailable and recovered notices only to threads bound to that project", async () => {
  const sent = []
  const helpers = createOverviewHelpers({
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312", autoStart: true, directory: "C:/demo", port: 4312 },
      other: { baseUrl: "http://127.0.0.1:4313" },
    },
    store: {
      get: () => ({
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_demo_1" },
          "100:9": { projectAlias: "demo", sessionId: "ses_demo_2" },
          "200:0": { projectAlias: "other", sessionId: "ses_other" },
        },
      }),
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => {
      const [chatId, threadIdOr0] = String(ctxKey).split(":")
      return { chatId: Number(chatId), threadIdOr0: Number(threadIdOr0), ctxKey }
    },
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "win32" })
  helpers.markProjectUp("demo")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(sent.length, 4)
  assert.deepEqual(
    sent.map((entry) => entry.ctx.ctxKey),
    ["100:7", "100:9", "100:7", "100:9"],
  )
  assert.ok(sent[0].replyMarkup)
  assert.ok(sent[1].replyMarkup)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
  assert.match(sent[2].text, /Project 'demo' is back online/)
  assert.ok(!sent.some((entry) => entry.ctx.ctxKey === "200:0"))
})
