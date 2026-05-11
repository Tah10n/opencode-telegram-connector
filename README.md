# Telegram connector for opencode

[![Node.js >=20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![Module: ESM](https://img.shields.io/badge/module-ESM-f7df1e?logo=javascript&logoColor=111111)](#telegram-connector-for-opencode)
[![License: MIT](https://img.shields.io/badge/license-MIT-1677ff.svg)](./LICENSE)
[![Telegram Bot](https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram&logoColor=white)](#telegram-commands)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6f42c1)](#platform-notes)
![CI: check + test](https://img.shields.io/badge/CI-check%20%2B%20test-2ea44f)

Run your opencode sessions from Telegram.

This Node.js connector binds each Telegram chat or forum topic to a specific `{ projectAlias, sessionId }`, so you can keep multiple projects active in parallel without manually switching context.

## Highlights

- **Per-thread bindings** — each chat/topic keeps its own project and session.
- **Telegram-first workflow** — send prompts from Telegram and get assistant replies back in the same thread.
- **Prompt handling in chat** — approve or deny permission requests and answer questions with inline buttons.
- **Multi-project friendly** — different chats/topics can stay bound to different projects at the same time.
- **Localized Telegram UI** — English and Russian bot menus/messages with per-thread `/language` selection.
- **Optional local auto-start** — start local opencode servers and optionally open attach/TUI windows.
- **Restart-safe, fail-closed state** — bindings, feed mode, model preference, pending prompts, offsets, and idempotency survive restarts; corrupt or unwritable state is surfaced instead of silently reset.
- **Operator-safe observability** — compact Telegram runtime counters, redacted text/JSON logs with correlation IDs, and optional loopback health probes for supervisors.

## How it works

1. Configure one or more opencode-backed projects.
2. In Telegram, bind a chat/topic with `/bind`, `/new`, or `/use`.
3. Send messages from Telegram to the bound opencode session.
4. Receive assistant replies, changed-file cards, and prompt requests back in the same thread.

## Requirements

- Node.js **20+**
- A Telegram bot token
- Reachable opencode endpoints for remote/manual projects
- If you use local `autoStart`, the `opencode` CLI must be installed and available on `PATH`

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
5. Define your projects in `connector.config.mjs`, keep only the entries you plan to use, and update their placeholder paths/URLs before you continue.
   The bundled examples cover local auto-start, a remote server with Basic Auth loaded from env, and headless/server-only mode.
   Legacy `PROJECTS_FILE` / `PROJECTS_JSON` is still supported if you need the older JSON-based setup.
6. Run the guided setup check before starting:

```sh
npm run setup:check
```

7. Start the connector:

```sh
npm start
```

8. In Telegram, send `/start`, then `/bind <projectAlias>`.

> Package status: `package.json` remains `"private": true` in this phase. Install and run the connector from a checkout for now; npm packaging and publishing are a later release track.

Optional syntax check:

```sh
npm run check
```

## Runtime file locations

When you follow the quick start from the connector directory, local runtime files live next to this README:

- `.env` — secrets and env-only overrides; create it from `.env.example` and do not commit it.
- `connector.config.mjs` — preferred project configuration; create it from `connector.config.example.mjs` and keep secrets in `.env`.
- `.data/state.json` — default persisted state path; treat it as sensitive because it contains bindings, offsets, pending prompts, and idempotency history.

If you launch the connector from another working directory, pass explicit `--env-file`, `--config-file`, and/or `--state-file` paths, or set `cwd` / `stateFile` in `connector.config.mjs` so relative paths resolve where you expect.

## Starter config example

`connector.config.mjs` is the preferred configuration entrypoint.
Legacy `PROJECTS_FILE` / `PROJECTS_JSON` setup is still supported if you need it.

```js
export default {
  cwd: ".",

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUserId: Number(process.env.TELEGRAM_ALLOWED_USER_ID),
  },

  defaultProject: "localDesktop",
  logFormat: "text",

  i18n: {
    defaultLocale: "en",
    supportedLocales: ["en", "ru"],
    autoDetectTelegramLanguage: true,
    botCommandLocales: ["en", "ru"],
  },

  // Optional local health endpoints for supervisors/probes.
  // Disabled by default and loopback-bound by default; not a Telegram webhook.
  // healthServer: { enabled: true, host: "127.0.0.1", port: 8787 },

  // Uncomment only if you intentionally use Basic Auth over
  // non-loopback http:// for a project below.
  // allowInsecureHttp: process.env.OPENCODE_ALLOW_INSECURE_HTTP === "1",

  projects: {
    localDesktop: {
      displayName: "Local desktop project",
      directory: "./project-a",
      port: 4100,
      autoStart: true,
      serverLaunchMode: "background",
      openTuiOnAutoStart: true,
      openAttachOnNewMode: "new-window",
    },

    remoteTeam: {
      displayName: "Remote shared server",
      baseUrl: "https://opencode.example.com",
      // Match the directory reported by opencode's /global/event stream;
      // omit only when using OPENCODE_SSE_EVENT_PATH=/event for compatibility.
      directory: "/srv/workspaces/team-project",
      usernameEnv: "REMOTE_OPENCODE_USERNAME",
      passwordEnv: "REMOTE_OPENCODE_PASSWORD",
    },

    serverOnly: {
      displayName: "Headless local server",
      directory: "./project-b",
      port: 4101,
      autoStart: true,
      serverLaunchMode: "background",
      openTuiOnAutoStart: false,
      openAttachOnNewMode: "same-window",
    },
  },
}
```

- `localDesktop` shows a local auto-start workflow with a TUI/attach window.
- `remoteTeam` shows an already running remote server with Basic Auth credentials loaded from `.env`.
- `serverOnly` keeps local auto-start but suppresses UI windows for headless or supervisor-managed deployments.
- You can mix local and remote projects in one file; keep aliases stable because Telegram bindings are persisted by alias.

If a Basic Auth project uses a non-loopback `http://` URL, set `OPENCODE_ALLOW_INSECURE_HTTP=1` intentionally before `npm run setup:check`; otherwise the connector refuses to start.

## Telegram commands

### Binding and sessions

- `/start`, `/help` — show help.
- `/bind [projectAlias]` — bind the current chat/topic to a project's startup session. Without an argument, the bot asks for the alias interactively.
- `/new [title]` — create a new session and bind the current Telegram thread to it. With `openAttachOnNewMode: "new-window"` it also opens a fresh attach window; with `same-window` it requests the existing attached TUI to switch to the new session.
- `/use <sessionId|shareLink>` — bind an existing session. Supports `https://opncd.ai/share/<id>` and `https://opncd.ai/s/<id>`. Session IDs must be non-empty and cannot contain whitespace, colons, pipes (`|`), or URL path/query separators; share links are accepted only when they resolve to a session ID that meets the same safety rule.
- `/sessions` — list recent sessions and switch with buttons.
- `/unbind` — remove the current binding.

In groups and forum topics, Telegram commands addressed to another bot are ignored: `/start@OtherBot` is ignored, while `/start@<this bot username>` is handled.

### Thread settings and control

- `/model`, `/model default`, `/model reset`, `/model <provider/model> [variant]` — show or change the model for the current thread.
- `/feed` — choose mirrored updates for the current thread.
- `/language`, `/language <en|ru>`, `/language reset` — show or change the bot UI language for the current thread.
- `/status` — show the current binding, model, feed mode, whether the agent is running, SSE status, and base URL.
- `/runtime` or `/health` — show compact connector runtime counters (**private chat only**): managed tasks, Telegram polling, backlog drain, update retry/skip counts, prompt polling, mirrored/skipped message counts, prompt delivery/answer counts, Telegram send/edit failures, attachment fallbacks, and shutdown state. The message includes **Restart**, **Stop**, and **Close** buttons. Restart and Stop always ask for confirmation first; after a supervised Restart, the bot sends a private-chat notice when the connector is online again.
- Observability note: `Telegram send/edit failures` count only delivery/edit attempts that affect visible messages (`sendMessage`, `sendDocument`, `editMessageText`, `editMessageReplyMarkup`); polling/control methods such as `getUpdates`, `getMe`, `setMyCommands`, `deleteMessage`, and `answerCallbackQuery` are intentionally excluded.
- `/abort` — abort the active run in the current thread.
- `/sendlast` — resend the latest assistant reply for the bound session.
- `/cancel` — cancel the current Telegram-side flow.

### Overview

- `/projects` — show projects, startup sessions, SSE status, active-binding summary, and safe action buttons: Start where auto-start is supported, Retry health check, Show sessions in private chats, and Close. Binding scopes are hidden outside private chats.
- `/bindings` — list all active bindings (**private chat only**).

### Prompt requests

When opencode asks for a permission decision or a question answer, the connector sends Telegram inline buttons in the bound thread. After a final action is accepted, the original prompt message is removed to keep the chat tidy. Multi-select question prompts stay visible while you toggle options and are removed only after you press **Done**.

## Feed modes

- `Main` — final assistant replies only.
- `Main + changes` — final assistant replies and changed-file cards.
- `Verbose` — final replies, streaming previews, agent action/tool-use updates, and changed-file cards.

User messages typed directly in opencode TUI are mirrored separately from `/feed`; enable `mirrorTuiUserMessages: true` or `MIRROR_TUI_USER_MESSAGES=1` to duplicate them into the bound Telegram thread.

Agent-stop error notices are delivered separately from `/feed`: if an assistant reply fails, the bound thread gets a redacted `Agent stopped due to error` warning. If only a tool error arrives first, the connector waits briefly and verifies the assistant message before sending the warning so recovered tool failures do not create false stop notices.

If a session still has a running assistant turn with no recent progress, new Telegram prompts are not sent into that stale queue. The thread receives a warning with `/abort` and `/new` recovery options instead.

## Localization

Supported UI locales are `en` and `ru`. The connector publishes Telegram command menus for both languages, auto-detects `message.from.language_code` per chat/topic, and persists the effective locale for async prompt/SSE messages. Users can override the language for the current chat/topic with `/language` or `/language <en|ru>`; `/language reset` returns to auto-detection/default behavior.

Configuration knobs:

```js
i18n: {
  defaultLocale: "en",
  supportedLocales: ["en", "ru"],
  autoDetectTelegramLanguage: true,
  botCommandLocales: ["en", "ru"],
}
```

Equivalent env overrides are available for simple deployments: `CONNECTOR_DEFAULT_LOCALE`, `CONNECTOR_SUPPORTED_LOCALES`, `CONNECTOR_BOT_COMMAND_LOCALES`, and `CONNECTOR_AUTO_DETECT_LANGUAGE`.

The connector localizes Telegram UI chrome, buttons, command menus, prompts, session/model/feed/status text, and common callback toasts. It does not translate user messages, assistant/opencode output, filenames, diffs, model/provider IDs, or diagnostic logs.

## File, code, and log workflow

### Incoming Telegram files

When a Telegram thread is bound to a project/session, you can send UTF-8 text-like files as Telegram **documents**. The connector includes the file contents in the prompt text for that thread's bound opencode session; it does not create a global current file or switch any other thread.

Supported document types:

- plain text and logs: `.txt`, `.text`, `.log`, Markdown
- code and scripts: JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin, C/C++, C#, PHP, Swift, shell, PowerShell, batch/cmd
- data/config/diffs: JSON/JSONL, YAML, TOML, INI/CFG/CONF, XML/HTML/CSS/SCSS/SASS, SQL, CSV, `.diff`, `.patch`
- any Telegram document reported as `text/*` MIME type

Limits and intentionally unsupported media:

- Maximum file size defaults to **256 KiB** (`limits.userAttachmentMaxBytes`).
- Files from **32 KiB** require an inline confirmation before their contents are sent to opencode (`limits.userAttachmentConfirmBytes`).
- Only UTF-8 text is accepted. Binary or invalid UTF-8 files are rejected.
- Photos, videos, audio/voice, stickers, contacts, locations, polls, and PDFs/images are intentionally out of scope for now.
- Filenames are sanitized before being shown or included in prompts; long token-like filename segments are redacted.

If Telegram file download or opencode `prompt_async` is temporarily unavailable, the connector keeps the action retryable instead of pretending the file was delivered.

### Outgoing long text and changed files

Long assistant replies are still delivered as `.txt` attachments instead of oversized Telegram messages. Changed-file cards include buttons to:

- show an inline diff preview when it fits Telegram limits
- send the changed-file summary as `.txt`
- send the full diff as `.patch`
- open per-file diff choices and send a selected file diff as `.patch` when file-level diffs are available

If the final assistant message cannot be fetched yet and a Telegram preview/placeholder exists, the connector updates it with a retry hint (`/sendlast`). If a completed reply has no output allowed by the current feed mode, the connector updates the existing Telegram placeholder with that explanation.

## Configuration overview

### Global settings (`connector.config.mjs` or env)

- `TELEGRAM_BOT_TOKEN` / `telegram.botToken`
- `TELEGRAM_ALLOWED_USER_ID` / `telegram.allowedUserId`
- `DEFAULT_PROJECT` / `defaultProject`
- `STATE_FILE` / `stateFile` (default: `./.data/state.json`)
- `TG_PREFIX` / `tgPrefix`
- `ECHO_FILTER_MODE` / `echoFilterMode` (`recent` or `prefix`)
- `MIRROR_TUI_USER_MESSAGES=1` / `mirrorTuiUserMessages` (default `false`)
- `CONNECTOR_LOG_FORMAT` / `logFormat` (`text` or `json`, default `text`)
- `CONNECTOR_HEALTH_ENABLED`, `CONNECTOR_HEALTH_HOST`, `CONNECTOR_HEALTH_PORT` / `healthServer` (disabled by default; default host `127.0.0.1`, default port `8787`)
- `OPENCODE_ALLOW_INSECURE_HTTP=1` / `allowInsecureHttp`
- `OPENCODE_TERMINAL` (Linux terminal launcher override)
- `activeTurnStaleMs` (`connector.config.mjs` only; milliseconds before a running assistant turn is treated as stale)
- `cwd` (`connector.config.mjs` only; base directory for relative paths)

### Telegram workflow limits

Prefer the `limits` object in `connector.config.mjs`; env fallbacks are available for legacy deployments.

| `connector.config.mjs` key | Env fallback | Default | Purpose |
| --- | --- | ---: | --- |
| `limits.userAttachmentConfirmBytes` | `TG_ATTACHMENT_CONFIRM_BYTES` | `32768` | Ask before sending larger Telegram documents to opencode. |
| `limits.userAttachmentMaxBytes` | `TG_ATTACHMENT_MAX_BYTES` | `262144` | Reject larger incoming Telegram documents. |
| `limits.changedFilesLimit` | `TG_CHANGED_FILES_LIMIT` | `10` | Number of changed files shown in Telegram lists. |
| `limits.inlineDiffTextMaxChars` | `TG_INLINE_DIFF_TEXT_MAX_CHARS` | `2500` | Inline diff preview size before `.patch` fallback. |
| `limits.streamPreviewMaxChars` | `TG_STREAM_PREVIEW_MAX_CHARS` | `3500` | Streaming assistant preview size. |
| `limits.textAttachmentThreshold` | `TG_TEXT_ATTACHMENT_THRESHOLD` | `12000` | Assistant reply size before `.txt` fallback. |

### Per-project fields

- `baseUrl` or `port` (`baseUrl` must use `http://` or `https://`)
- `directory` (required for `autoStart`; also required for default `/global/event` SSE mirroring so global events can be scoped safely. `setup:check` fails when this is missing under the default SSE path. If an older opencode build cannot provide matching directory metadata, use `OPENCODE_SSE_EVENT_PATH=/event`.)
- `autoStart` (boolean; strings such as `"true"` are rejected)
- `serverLaunchMode`: `background` or `window`
- `openTuiOnAutoStart` (boolean; strings such as `"false"` are rejected)
  - Set this to `false` for headless/server-only deployments where the connector should start or monitor opencode without opening UI windows.
- `openAttachOnNewMode`: `same-window` or `new-window`
  - `same-window` does not open a new window; it binds Telegram to the new session immediately and requests a switch for the existing attached TUI.
    When the opencode server exposes the TUI active-session API, Telegram can also follow later TUI-driven session switches in the same thread.
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
- `OPENCODE_SSE_EVENT_PATH` — override the opencode SSE endpoint. Defaults to `/global/event`, where events must include project directory metadata to be mirrored; set `/event` only for older opencode builds that do not expose the global stream or its directory metadata.
- `OPENCODE_SSE_MAX_LINE_BYTES`, `OPENCODE_SSE_MAX_EVENT_BYTES`, `OPENCODE_SSE_MAX_EVENT_LINES` — tune SSE safety limits for unusually large upstream events.
- `OPENCODE_SSE_CONNECT_TIMEOUT_MS` — timeout for an initial SSE connection that accepts TCP but never returns headers.
- `OPENCODE_SSE_HEALTHCHECK_MIN_INTERVAL_MS` — tune health-check throttling after SSE disconnects.
- `OPENCODE_WATCHDOG_FAILURE_THRESHOLD`, `OPENCODE_WATCHDOG_WINDOW_MS`, `OPENCODE_WATCHDOG_COOLDOWN_MS` / `opencodeWatchdog.{failureThreshold,windowMs,cooldownMs}` — tune the autoStart watchdog that restarts a configured opencode server after repeated retryable health/SSE/prompt-poll failures.
  On Windows, watchdog restarts also close matching stale `opencode attach` UI windows before reopening the TUI for that project.

### Logging and redaction

Logs default to compact text. Set `CONNECTOR_LOG_FORMAT=json` or `logFormat: "json"` to emit one JSON object per line for supervisors and hosted runtimes. Runtime logs include structured fields such as `correlationId`, `projectAlias`, Telegram context, `sessionId`, `operation`, retry outcome, and boundary error classification where available.

Every Telegram update gets an opaque correlation ID that is carried through command/callback handling, opencode requests, mirroring, and Telegram delivery logs. OpenCode HTTP and SSE requests include the same value as `X-Connector-Correlation` when a request context is active. The ID is generated by the connector and does not include prompt text, tokens, full URLs, local paths, or Telegram secrets.

Before writing logs, the connector redacts bot tokens, Basic Auth credentials, URL userinfo/query/hash values, auth-like command-line flags, and sensitive state/config paths. Telegram `/status` and `/runtime` expose only compact counters and sanitized operational summaries.

### Optional HTTP health endpoints

The connector can expose a no-dependency `node:http` health server for local supervisors and hosted runtime probes:

```js
export default {
  // ...
  healthServer: { enabled: true, host: "127.0.0.1", port: 8787 },
}
```

or with env:

```sh
CONNECTOR_HEALTH_ENABLED=1
CONNECTOR_HEALTH_HOST=127.0.0.1
CONNECTOR_HEALTH_PORT=8787
```

- Disabled by default.
- Bound to `127.0.0.1` by default; expose it beyond loopback only behind your own trusted network/proxy controls.
- `GET /livez` returns process liveness.
- `GET /readyz` and `GET /healthz` return readiness based on shutdown state, state load/flush health, Telegram polling/backlog observation, and lifecycle task presence.
- This is **not** Telegram webhook support and does not change the long-polling runtime model.
- It does not make multiple connector instances safe; keep one connector per Telegram bot token.

## Platform notes

- **Windows**, **macOS**, and **Linux desktop** environments support local auto-start and optional attach/TUI windows.
- On Linux, the connector tries `OPENCODE_TERMINAL` first and then common terminal emulators from `PATH`.
- In headless Linux/macOS environments, local background auto-start can still start the opencode server; `openTuiOnAutoStart` is best-effort and only opens a terminal window when a GUI/terminal launcher is available.
- For long-running service examples on each platform, see [Running under a supervisor](#running-under-a-supervisor).

## Running under a supervisor

The connector now logs last-resort `unhandledRejection` / `uncaughtException` failures and exits so an external supervisor can restart it cleanly.

`/runtime` in a private Telegram chat includes runtime control buttons:

- **Restart** asks for confirmation, stores a private-chat online notice, then stops the connector and exits with code `1`. Configure your supervisor to restart non-zero exits. After startup succeeds, the connector sends `Connector is online again after restart.` to the private chat where Restart was confirmed.
- **Stop** asks for confirmation, then stops Telegram polling/OpenCode streams, flushes state, and exits with code `0`. Configure your supervisor to leave clean exit code `0` stopped.
- **Cancel** or **Close** leaves the process running.

Treat the process as a single long-running worker: if a truly fatal runtime error occurs, inspect the logs and let the supervisor restart it instead of trying to keep the broken process alive. Do not run multiple connector instances with the same Telegram bot token.

### PM2 (Windows, macOS, Linux)

PM2 is the most portable option for a Node.js service. Example `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: "telegram-connector",
      script: "src/cli.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      // /runtime Stop exits 0 and should stay stopped; /runtime Restart exits 1 and restarts.
      stop_exit_codes: [0],
    },
  ],
}
```

Start and inspect it:

```sh
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs telegram-connector
```

Autostart after reboot is platform-specific:

- Linux/macOS: run `pm2 startup`, execute the command it prints, then run `pm2 save` again.
- Windows: use Task Scheduler to run `pm2 resurrect` at user login, or use a helper such as `pm2-windows-startup`.

### systemd (Linux)

Example unit at `/etc/systemd/system/telegram-connector.service`:

```ini
[Unit]
Description=Telegram connector for opencode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=connector
WorkingDirectory=/opt/telegram-opencode-connector
ExecStart=/usr/bin/node src/cli.js --env-file /opt/telegram-opencode-connector/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-connector
sudo systemctl status telegram-connector
journalctl -u telegram-connector -f
```

`Restart=on-failure` restarts `/runtime` Restart (`exit 1`) and leaves `/runtime` Stop (`exit 0`) stopped.

### launchd (macOS)

Example user agent at `~/Library/LaunchAgents/dev.opencode.telegram-connector.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.opencode.telegram-connector</string>
  <key>WorkingDirectory</key><string>/Users/YOU/telegram-opencode-connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/cli.js</string>
    <string>--env-file</string>
    <string>/Users/YOU/telegram-opencode-connector/.env</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>/Users/YOU/telegram-opencode-connector/.data/connector.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/telegram-opencode-connector/.data/connector.err.log</string>
</dict>
</plist>
```

Load and inspect it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.opencode.telegram-connector.plist
launchctl print gui/$(id -u)/dev.opencode.telegram-connector
tail -f /Users/YOU/telegram-opencode-connector/.data/connector.err.log
```

`SuccessfulExit=false` restarts non-zero exits and leaves clean exit code `0` stopped.

### NSSM / Windows service

NSSM is useful when you want a Windows Service instead of a user-session PM2 process. It is best for headless mode; Windows services are not ideal for opening interactive attach/TUI windows.

Run these commands from an elevated PowerShell prompt and adjust paths:

```powershell
nssm install telegram-connector
nssm set telegram-connector Application "C:\Program Files\nodejs\node.exe"
nssm set telegram-connector AppDirectory "C:\path\to\telegram-opencode-connector"
nssm set telegram-connector AppParameters "src\cli.js --env-file C:\path\to\telegram-opencode-connector\.env"
nssm set telegram-connector AppStdout "C:\path\to\telegram-opencode-connector\.data\connector.out.log"
nssm set telegram-connector AppStderr "C:\path\to\telegram-opencode-connector\.data\connector.err.log"
nssm set telegram-connector AppExit 0 Exit
nssm set telegram-connector AppExit Default Restart
nssm set telegram-connector AppRestartDelay 5000
nssm start telegram-connector
```

`AppExit 0 Exit` leaves `/runtime` Stop stopped. `AppExit Default Restart` restarts `/runtime` Restart and other non-zero exits.

### Docker

Container use is optional and best treated as a VPS/headless self-hosting example, not a full production platform contract. Host/PM2 installs remain the better fit when you rely on desktop attach/TUI windows. In containers, keep desktop/TUI launch disabled unless you explicitly wire host GUI access.

If you package the connector in a container, use a restart policy that restarts failures but not manual stops, and mount persistent files explicitly:

- `.env` or equivalent secrets injection
- `.data/` for `state.json` and backups
- project workspaces/directories used by local opencode projects

For example:

```sh
docker run -d --name telegram-connector --restart on-failure --env-file .env telegram-connector:latest
```

In Compose:

```yaml
services:
  telegram-connector:
    image: telegram-connector:latest
    env_file: .env
    volumes:
      - ./.data:/app/.data
      - ./workspaces:/app/workspaces
    restart: on-failure
```

Use `on-failure` if you want `/runtime` Restart (`exit 1`) to relaunch and `/runtime` Stop (`exit 0`) to stay stopped. Use `unless-stopped` only if you want the container runtime to bring the connector back after any process exit.

SSE disconnects reconnect with backoff when they are retryable. The connector listens to opencode's `/global/event` stream by default and mirrors only events whose directory metadata matches the configured project directory; unscoped global events are dropped fail-closed to avoid cross-project routing. Fatal SSE protocol or size errors stop that project's SSE loop instead of reconnecting forever; prompt polling remains available as the fallback path for permission and question prompts while SSE is down.

### Runtime smoke checks

After changing runtime/recovery behavior, run the connector under your usual supervisor and check:

1. `/runtime` in a private chat shows managed tasks, Telegram polling, backlog drain, prompt polling, update retry/skip counts, message/prompt/Telegram-delivery/attachment counters, shutdown state, and Restart/Stop/Close buttons.
2. `/projects` offers Retry health check and Close for every project, Start only where auto-start is configured and supported, and Show sessions only in private chats.
3. Tap `/runtime` Restart or Stop, confirm the warning screen appears, then Cancel once to verify confirmation without stopping the process.
4. In a supervised environment, confirm `/runtime` Restart exits, is relaunched by the supervisor, and sends the online-again notice; confirm `/runtime` Stop exits cleanly and remains stopped.
5. Stop and restart the supervisor-managed process; bindings, offset, feed mode, model preference, and pending prompts should recover without duplicate actions.
6. Temporarily stop one opencode server, use `/projects` → Retry health check, then restore the server and retry again to confirm project-scoped recovery works without restarting the connector.
7. If `healthServer.enabled` is on, confirm `/livez` returns `200` and `/readyz` returns `200` only after Telegram polling/state health are ready.
8. In a group, confirm `/start@OtherBot` is ignored and `/start@<this bot username>` is handled.
9. Answer an opencode permission or question prompt and confirm the handled prompt message is removed; for multi-select questions, confirm the message remains while toggling options and is removed after **Done**.
10. If a normal Telegram prompt hits a retryable opencode failure, confirm it is retried and not marked handled until `prompt_async` succeeds.
11. Send long formatted output and confirm Telegram chunks remain parseable HTML.

## Troubleshooting matrix

| Symptom | What to check | Safe recovery action |
| --- | --- | --- |
| Telegram polling appears stuck | Use `/runtime` in a private chat and inspect `Telegram poll` retries, `lastErrorAt`, and update retry/skip counts. Ensure only one connector instance is running for the bot token. | Fix the Telegram/API/network issue; restart the connector only if the supervisor reports the process is unhealthy. |
| OpenCode unavailable | Use `/projects` and the project's Retry health check. `/status` also shows the current project's SSE and sanitized base URL. | Start opencode manually, or press Start if the project exposes a Start button. Retry health after the server is up. |
| Windows TUI/attach window appears hung | Check logs for watchdog restarts or repeated retryable SSE/prompt-poll failures. A stale attach window can remain after a server restart. | Let the auto-start watchdog recover the project; it closes matching stale attach windows and opens a fresh one. If needed, close the old TUI window manually and use `/projects` → Start/Retry health. |
| State file cannot be read, written, or validated | Startup or runtime logs report a state read/write/schema failure. The connector fails closed instead of silently resetting state. Schema errors include the malformed section path, and migration/invalid-state backups are written next to `state.json` when possible. | Fix permissions/path/corruption, repair the reported section, or restore a known-good `state.json.backup.*` file. Treat backups as sensitive; they contain the same bindings, offset, prompts, and idempotency history as `state.json`. |
| Prompt send reports project unavailable | A retryable opencode `prompt_async` failure happened while forwarding a user message. | Restore the project; the Telegram update remains retryable and should be processed again after recovery. |
| OpenCode works but assistant replies do not appear in Telegram | Check logs for `SSE disabled for project`, rapid `SSE connected` / `SSE disconnected` loops, or `drop=global_directory_missing` SSE debug lines. Current opencode builds expose the long-lived stream at `/global/event` with project directory metadata; older connector versions listening to `/event` may only receive `server.connected` before the stream closes. | Add the project `directory` and run `npm run setup:check`. If you run an older opencode build that lacks `/global/event` or does not send directory metadata there, set `OPENCODE_SSE_EVENT_PATH=/event` and restart. Prompt polling remains available while SSE is disabled or down. |
| SSE stopped after protocol/size error | Logs show a fatal SSE protocol or size failure for one project. | Inspect upstream event size/protocol, fix the source, then restart the connector or recover the project; prompt polling still handles prompts while SSE is down. |
| Group command ignored | The command may be addressed to another bot, for example `/start@OtherBot`. | Use `/command@<this bot username>` or an unsuffixed command that Telegram delivers to this bot. |
| Duplicate prompts or callbacks | Check `/status` for prompt cleanup/recovery and callback outcome counters. Duplicates after restart should be skipped as already handled. | If duplicates continue, keep the connector single-instance and inspect logs around prompt polling/SSE reconnects. |
| Stale callbacks | Button presses may answer `No longer active` or `Already handled` after a prompt is completed or rejected. | Prompt messages are removed automatically when possible; otherwise dismiss any remaining old interactive message with Close and wait for the current prompt to be delivered again if it is still live. |
| Wrong thread/session | Use `/status` in the thread and `/bindings` in a private chat to compare bindings. | Use `/use <sessionId>`, `/bind <projectAlias>`, `/new`, or `/unbind` in the affected thread. |
| Failed auto-start | `/projects` shows Start only when local launch is supported. Logs include launcher errors without exposing secrets. | Verify `opencode` is on `PATH`, the project `directory` and `port` are configured, and a GUI terminal is available if you configured window/TUI launch. |

## Important behavior and limits

- The bot accepts messages from a single Telegram user ID only.
- The connector is designed to run as a **single instance** per bot token.
- On first start, it drains old Telegram updates to avoid replaying history.
- State load and critical state flush/write failures fail closed; the connector should not continue as if durability succeeded.
- Current-schema state is validated on load, unsupported schema versions fail closed, and schema migrations create bounded `state.json.backup.*` files before writing the migrated state.
- A confirmed `/runtime` Restart stores a short pending online-notice record in state until the next startup sends and clears it.
- Feed mode is stored per Telegram thread/topic; the default is `Main + changes`.
- Large assistant replies may be delivered as `.txt` attachments, and large changed-file diffs may be delivered as `.patch` attachments instead of many chat messages.
- Telegram HTML messages are split with tag/entity awareness to avoid malformed chunks.
- OpenCode path IDs are URL-encoded at the HTTP boundary; user-entered binding/session IDs are validated before being persisted and cannot contain whitespace, colons, pipes (`|`), or URL path/query separators.
- Parent-session routing uses a bounded cache for long-running processes.
- OpenCode event mirroring uses `/global/event` by default and requires matching directory metadata before mirroring a global event. Use `OPENCODE_SSE_EVENT_PATH=/event` only when running an older opencode build that does not expose `/global/event` or its directory metadata.
- Basic Auth over non-loopback `http://` is blocked unless `OPENCODE_ALLOW_INSECURE_HTTP=1` is set.

## Useful local commands

```sh
npm run setup:check
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
