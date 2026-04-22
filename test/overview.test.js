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
