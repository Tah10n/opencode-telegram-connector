import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildProjectsOverviewKeyboard, buildProjectsOverviewText, createOverviewHelpers } from "../src/connector/overview.js"
import { encodeCallback } from "../src/connector/callback-data.js"

function packedCallback(...parts) {
  return `packed:${encodeCallback(parts)}`
}

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function makeFakeLauncherDir(t, ...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-connector-overview-"))
  for (const name of names) fs.writeFileSync(path.join(dir, name), "")
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

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
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, packedCallback("srv", "veryLongAliasNameForProject1234567890", "start"))
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, packedCallback("srv", "close"))
})

test("buildProjectsOverviewText renders empty and populated project summaries", () => {
  assert.equal(buildProjectsOverviewText({ projects: {} }), "No projects")

  const text = buildProjectsOverviewText({
    projects: {
      demo: { baseUrl: "http://127.0.0.1:4312/path" },
      other: { baseUrl: "http://127.0.0.1:4313" },
    },
    bindings: {
      "100:7": { projectAlias: "demo" },
      "100:0": { projectAlias: "demo" },
      "100:9": { projectAlias: "demo" },
      "200:0": { projectAlias: "other" },
    },
    startupSessionByProject: {
      demo: "demo-session",
      other: "other-session",
    },
    getProjectSseStatus: (alias) => (alias === "demo" ? "connected" : "down"),
    parseCtxKey: (ctxKey) => {
      const [chatId, threadIdOr0] = String(ctxKey).split(":")
      return { chatId: Number(chatId), threadIdOr0: Number(threadIdOr0) }
    },
    formatThreadLabel: (threadIdOr0) => (threadIdOr0 === 0 ? "main" : `topic-${threadIdOr0}`),
    previewLimit: 2,
  })

  assert.match(text, /Projects:/)
  assert.match(text, /- demo/)
  assert.match(text, /URL: http:\/\/127\.0\.0\.1:4312\/path/)
  assert.match(text, /Startup session: demo-session/)
  assert.match(text, /SSE: connected/)
  assert.match(text, /Bindings: 3 \(chat 100\/topic-7, chat 100\/main, \+1 more\)/)
  assert.match(text, /- other/)
  assert.match(text, /Bindings: 1 \(chat 200\/main\)/)
})

test("buildProjectsOverviewText hides binding scopes when requested", () => {
  const text = buildProjectsOverviewText({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    bindings: {
      "100:7": { projectAlias: "demo" },
    },
    startupSessionByProject: {
      demo: "demo-session",
    },
    getProjectSseStatus: () => "connected",
    parseCtxKey: () => null,
    formatThreadLabel: () => "main",
    showBindingScopes: false,
    hiddenBindingsLabel: "hidden outside private chat",
  })

  assert.match(text, /Bindings: hidden outside private chat/)
})

test("buildProjectsOverviewText hides project details when requested", () => {
  const text = buildProjectsOverviewText({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    bindings: {
      "100:7": { projectAlias: "demo" },
    },
    startupSessionByProject: {
      demo: "demo-session",
    },
    getProjectSseStatus: () => "connected",
    parseCtxKey: () => null,
    formatThreadLabel: () => "main",
    showBindingScopes: false,
    showProjectDetails: false,
  })

  assert.match(text, /^Projects:/)
  assert.match(text, /- demo/)
  assert.match(text, /SSE: connected/)
  assert.doesNotMatch(text, /URL:/)
  assert.doesNotMatch(text, /Startup session:/)
  assert.doesNotMatch(text, /demo-session/)
})

test("buildProjectsOverviewKeyboard includes safe project actions", () => {
  const keyboard = buildProjectsOverviewKeyboard({
    projects: { demo: {}, remote: {} },
    cb: { pack: (value) => `packed:${value}` },
    canAutoStartProject: (alias) => alias === "demo",
    platform: "win32",
    showSessions: true,
  })

  assert.deepEqual(keyboard.inline_keyboard, [
    [
      { text: "Start demo", callback_data: packedCallback("srv", "demo", "start") },
      { text: "Status demo", callback_data: packedCallback("srv", "demo", "health") },
      { text: "Sessions demo", callback_data: packedCallback("srv", "demo", "sessions") },
    ],
    [
      { text: "Status remote", callback_data: packedCallback("srv", "remote", "health") },
      { text: "Sessions remote", callback_data: packedCallback("srv", "remote", "sessions") },
    ],
    [{ text: "Close", callback_data: packedCallback("srv", "close") }],
  ])
})

test("buildProjectsOverviewKeyboard can show bind-only actions for unbound threads", () => {
  const keyboard = buildProjectsOverviewKeyboard({
    projects: { demo: {}, remote: {} },
    cb: { pack: (value) => `packed:${value}` },
    showProjectControls: false,
    showBindControls: true,
  })

  assert.deepEqual(keyboard.inline_keyboard, [
    [{ text: "Bind demo", callback_data: packedCallback("srv", "demo", "bind") }],
    [{ text: "Bind remote", callback_data: packedCallback("srv", "remote", "bind") }],
    [{ text: "Close", callback_data: packedCallback("srv", "close") }],
  ])
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

  assert.equal(helpers.isRetryableProjectError(new Error("fetch failed")), true)

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

test("createOverviewHelpers ignores Telegram-detected locale when unavailable notices run with auto-detect disabled", async () => {
  const sent = []
  const helpers = createOverviewHelpers({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    config: { i18n: { defaultLocale: "en", supportedLocales: ["en", "ru"], autoDetectTelegramLanguage: false } },
    store: {
      get: () => ({ bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_demo" } } }),
      getLocaleRecord(ctxKey) {
        assert.equal(ctxKey, "100:7")
        return { locale: "ru", source: "telegram" }
      },
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "win32" })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
  assert.doesNotMatch(sent[0].text, /Проект 'demo' недоступен/)
})

test("createOverviewHelpers falls back when stored notice locale is no longer supported", async () => {
  const sent = []
  const helpers = createOverviewHelpers({
    projects: { demo: { baseUrl: "http://127.0.0.1:4312" } },
    config: { i18n: { defaultLocale: "en", supportedLocales: ["en"], autoDetectTelegramLanguage: true } },
    store: {
      get: () => ({ bindings: { "100:7": { projectAlias: "demo", sessionId: "ses_demo" } } }),
      getLocaleRecord(ctxKey) {
        assert.equal(ctxKey, "100:7")
        return { locale: "ru", source: "manual" }
      },
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "win32" })
  helpers.markProjectUp("demo")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(sent.length, 2)
  assert.match(sent[0].text, /Project 'demo' is unavailable/)
  assert.match(sent[1].text, /Project 'demo' is back online/)
  assert.doesNotMatch(sent.map((entry) => entry.text).join("\n"), /Проект 'demo'/)
})

test("createOverviewHelpers redacts sensitive error details in unavailable notices", async () => {
  const helpers = createOverviewHelpers({
    projects: { demo: { baseUrl: "http://user:secret@example.test:4312/path?token=abc#frag" } },
    store: { get: () => ({ bindings: {} }) },
    startInProgress: new Map(),
    parseCtxKey: () => null,
    sendToThread: async () => {},
    cb: { pack: (value) => value },
  })

  const text = helpers.formatProjectUnavailable("demo", new Error("GET http://user:secret@example.test:4312/path?token=abc#frag Authorization: Bearer supersecret"))

  assert.match(text, /http:\/\/example\.test:4312\/path\?token=\*\*\*/)
  assert.doesNotMatch(text, /user|supersecret|abc|frag|Bearer supersecret/)
})

test("createOverviewHelpers offers a Start button for Linux TUI auto-start projects", async (t) => {
  const fakeBin = makeFakeLauncherDir(t, "x-terminal-emulator")
  swapEnv(t, { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, PATH: fakeBin, OPENCODE_TERMINAL: undefined })

  const sent = []
  const helpers = createOverviewHelpers({
    projects: {
      demo: {
        baseUrl: "http://127.0.0.1:4312",
        autoStart: true,
        directory: "/demo",
        port: 4312,
        openTuiOnAutoStart: true,
      },
    },
    store: {
      get: () => ({
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_demo_1" },
        },
      }),
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "linux" })

  assert.equal(sent.length, 1)
  assert.ok(sent[0].replyMarkup)
  assert.equal(sent[0].replyMarkup.inline_keyboard[0][0].callback_data, encodeCallback(["srv", "demo", "start"]))
})

test("createOverviewHelpers offers the Start button for Linux background auto-start projects without GUI launcher support", async (t) => {
  swapEnv(t, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, PATH: "", OPENCODE_TERMINAL: undefined })

  const sent = []
  const helpers = createOverviewHelpers({
    projects: {
      demo: {
        baseUrl: "http://127.0.0.1:4312",
        autoStart: true,
        directory: "/demo",
        port: 4312,
        openTuiOnAutoStart: true,
      },
    },
    store: {
      get: () => ({
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_demo_1" },
        },
      }),
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "linux" })

  assert.equal(sent.length, 1)
  assert.ok(sent[0].replyMarkup)
  assert.equal(sent[0].replyMarkup.inline_keyboard[0][0].callback_data, encodeCallback(["srv", "demo", "start"]))
})

test("createOverviewHelpers offers the Start button for macOS SSH background auto-start projects", async (t) => {
  const fakeBin = makeFakeLauncherDir(t, "osascript")
  swapEnv(t, { PATH: fakeBin, SSH_CONNECTION: "ci-session", SSH_TTY: "/dev/ttys001" })

  const sent = []
  const helpers = createOverviewHelpers({
    projects: {
      demo: {
        baseUrl: "http://127.0.0.1:4312",
        autoStart: true,
        directory: "/demo",
        port: 4312,
        openTuiOnAutoStart: true,
      },
    },
    store: {
      get: () => ({
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_demo_1" },
        },
      }),
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "darwin" })

  assert.equal(sent.length, 1)
  assert.ok(sent[0].replyMarkup)
  assert.equal(sent[0].replyMarkup.inline_keyboard[0][0].callback_data, encodeCallback(["srv", "demo", "start"]))
})

test("createOverviewHelpers hides the Start button for window-mode projects without GUI launcher support", async (t) => {
  swapEnv(t, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, PATH: "", OPENCODE_TERMINAL: undefined })

  const sent = []
  const helpers = createOverviewHelpers({
    projects: {
      demo: {
        baseUrl: "http://127.0.0.1:4312",
        autoStart: true,
        serverLaunchMode: "window",
        directory: "/demo",
        port: 4312,
        openTuiOnAutoStart: true,
      },
    },
    store: {
      get: () => ({
        bindings: {
          "100:7": { projectAlias: "demo", sessionId: "ses_demo_1" },
        },
      }),
    },
    startInProgress: new Map(),
    parseCtxKey: (ctxKey) => ({ chatId: 100, threadIdOr0: 7, ctxKey }),
    sendToThread: async (ctx, text, replyMarkup) => {
      sent.push({ ctx, text, replyMarkup })
    },
    cb: { pack: (value) => value },
  })

  await helpers.notifyProjectUnavailable("demo", new Error("fetch failed"), { platform: "linux" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].replyMarkup, null)
})
