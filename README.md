# Telegram connector for opencode

[![Node.js >=20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![Module: ESM](https://img.shields.io/badge/module-ESM-f7df1e?logo=javascript&logoColor=111111)](#telegram-connector-for-opencode)
[![License: MIT](https://img.shields.io/badge/license-MIT-1677ff.svg)](./LICENSE)
[![Telegram Bot](https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram&logoColor=white)](#telegram-commands)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6f42c1)](#platform-notes)
[![CI](https://img.shields.io/badge/CI-check%20%2B%20test-2ea44f)](./.github/workflows/ci.yml)

Run your opencode sessions from Telegram.

This Node.js connector binds each Telegram chat or forum topic to a specific `{ projectAlias, sessionId }`, so you can keep multiple projects active in parallel without manually switching context.

## Highlights

- **Per-thread bindings** — each chat/topic keeps its own project and session.
- **Telegram-first workflow** — send prompts from Telegram and get assistant replies back in the same thread.
- **Prompt handling in chat** — approve or deny permission requests and answer questions with inline buttons.
- **Multi-project friendly** — different chats/topics can stay bound to different projects at the same time.
- **Optional local auto-start** — start local opencode servers and optionally open attach/TUI windows.
- **Restart-safe state** — bindings, feed mode, model preference, and pending prompt state survive restarts.

## How it works

1. Configure one or more opencode-backed projects.
2. In Telegram, bind a chat/topic with `/bind`, `/new`, or `/use`.
3. Send messages from Telegram to the bound opencode session.
4. Receive assistant replies, changed-file cards, and prompt requests back in the same thread.

## Requirements

- Node.js **20+**
- A Telegram bot token
- Reachable opencode endpoints for your configured projects
- If you use `autoStart`, the `opencode` CLI must be installed and available on `PATH`

## Quick start

1. Install dependencies:

```sh
npm install
```

2. Copy `connector.config.example.mjs` to `connector.config.mjs`.
3. Create `.env` from `.env.example`.
4. Put your secrets in `.env`:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_USER_ID`
5. Define your projects in `connector.config.mjs`.
   Legacy `PROJECTS_FILE` / `PROJECTS_JSON` is still supported if you need the older JSON-based setup.
6. Start the connector:

```sh
npm start
```

7. In Telegram, send `/start`, then `/bind <projectAlias>`.

Sanity check:

```sh
npm run check
```

## Minimal config example

`connector.config.mjs` is the preferred configuration entrypoint.
Legacy `PROJECTS_FILE` / `PROJECTS_JSON` setup is still supported if you need it.

```js
export default {
  cwd: ".",

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUserId: Number(process.env.TELEGRAM_ALLOWED_USER_ID),
  },

  defaultProject: "pocket",

  projects: {
    pocket: {
      directory: "./project-a",
      port: 4100,
      autoStart: true,
      serverLaunchMode: "background",
      openTuiOnAutoStart: true,
      openAttachOnNewMode: "same-window",
    },

    remote: {
      baseUrl: "http://127.0.0.1:4200",
    },
  },
}
```

## Telegram commands

### Binding and sessions

- `/start`, `/help` — show help.
- `/bind [projectAlias]` — bind the current chat/topic to a project's startup session. Without an argument, the bot asks for the alias interactively.
- `/new [title]` — create a new session. With `openAttachOnNewMode: "new-window"` it binds immediately; with `same-window` Telegram stays on the current session until the attached TUI reports the switch, or you switch manually with `/use`.
- `/use <sessionId|shareLink>` — bind an existing session. Supports `https://opncd.ai/share/<id>` and `https://opncd.ai/s/<id>`.
- `/sessions` — list recent sessions and switch with buttons.
- `/unbind` — remove the current binding.

### Thread settings and control

- `/model`, `/model default`, `/model reset`, `/model <provider/model> [variant]` — show or change the model for the current thread.
- `/feed` — choose mirrored updates for the current thread.
- `/status` — show the current binding, model, feed mode, SSE status, and base URL.
- `/abort` — abort the active run in the current thread.
- `/sendlast` — resend the latest assistant reply for the bound session.
- `/cancel` — cancel the current Telegram-side flow.

### Overview

- `/projects` — show projects, startup sessions, SSE status, and active-binding summary. Binding scopes are hidden outside private chats.
- `/bindings` — list all active bindings (**private chat only**).

## Feed modes

- `Main` — final assistant replies only.
- `Main + changes` — final assistant replies and changed-file cards.
- `Verbose` — final replies, streaming previews, user mirror, and changed-file cards.

## Configuration overview

### Global settings (`connector.config.mjs` or env)

- `TELEGRAM_BOT_TOKEN` / `telegram.botToken`
- `TELEGRAM_ALLOWED_USER_ID` / `telegram.allowedUserId`
- `DEFAULT_PROJECT` / `defaultProject`
- `STATE_FILE` / `stateFile` (default: `./.data/state.json`)
- `TG_PREFIX` / `tgPrefix`
- `ECHO_FILTER_MODE` / `echoFilterMode` (`recent` or `prefix`)
- `OPENCODE_ALLOW_INSECURE_HTTP=1` / `allowInsecureHttp`
- `OPENCODE_TERMINAL` (Linux terminal launcher override)
- `cwd` (`connector.config.mjs` only; base directory for relative paths)

### Per-project fields

- `baseUrl` or `port`
- `directory` (required for `autoStart`)
- `autoStart`
- `serverLaunchMode`: `background` or `window`
- `openTuiOnAutoStart`
- `openAttachOnNewMode`: `same-window` or `new-window`
  - `same-window` does not open a new window; it requests a switch for the existing attached TUI and keeps Telegram on the current session until the TUI reports the new active session.
    When the opencode server exposes the TUI active-session API, Telegram can follow both Telegram-driven and TUI-driven session switches in the same thread.
  - `new-window` opens a fresh `opencode attach --session ...` window for the new session.
- `username` / `password` or `usernameEnv` / `passwordEnv`
- `displayName`

### CLI flags

- `--env-file <path>`
- `--config-file <path>`
- `--projects-file <path>`
- `--projects-json <json>`
- `--state-file <path>`

### Advanced debug env

- `DEBUG_SSE_ROUTING=<projectAlias>[:sessionId]` — enable verbose SSE routing logs.
- `MIRROR_COMPACTION=1` — also mirror compaction messages.
- `OPENCODE_SERVER_DEBUG=1` — start local `opencode serve` processes with debug logging.

## Platform notes

- **Windows**, **macOS**, and **Linux desktop** environments support local auto-start and optional attach/TUI windows.
- On Linux, the connector tries `OPENCODE_TERMINAL` first and then common terminal emulators from `PATH`.
- In headless Linux/macOS environments, connecting to an already running opencode server still works, but opening a new terminal window requires an available GUI/terminal launcher.

## Running under a supervisor

The connector now logs last-resort `unhandledRejection` / `uncaughtException` failures and exits so an external supervisor can restart it cleanly.

Recommended options:

- **systemd** with `Restart=on-failure`
- **Docker** with `--restart unless-stopped` or `restart: unless-stopped`
- **pm2** / **launchd** / another process manager for your platform

Treat the process as a single long-running worker: if a truly fatal runtime error occurs, inspect the logs and let the supervisor restart it instead of trying to keep the broken process alive.

## Important behavior and limits

- The bot accepts messages from a single Telegram user ID only.
- The connector is designed to run as a **single instance** per bot token.
- On first start, it drains old Telegram updates to avoid replaying history.
- Feed mode is stored per Telegram thread/topic; the default is `Main + changes`.
- Large replies or diffs may be delivered as `.txt` attachments instead of many chat messages.
- Basic Auth over non-loopback `http://` is blocked unless `OPENCODE_ALLOW_INSECURE_HTTP=1` is set.

## Useful local commands

```sh
npm run check
npm test
npm run test:coverage
```

## Viewing the same session in opencode

Use `/status` to see the current binding, then attach from a terminal:

```sh
opencode attach <baseUrl> --session <sessionId>
```

## More docs

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CHANGELOG.md](./CHANGELOG.md)
