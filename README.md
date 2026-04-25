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
- **Restart-safe, fail-closed state** — bindings, feed mode, model preference, pending prompts, offsets, and idempotency survive restarts; corrupt or unwritable state is surfaced instead of silently reset.

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

  limits: {
    userAttachmentConfirmBytes: 32 * 1024,
    userAttachmentMaxBytes: 256 * 1024,
    changedFilesLimit: 10,
    inlineDiffTextMaxChars: 2500,
    streamPreviewMaxChars: 3500,
    textAttachmentThreshold: 12_000,
  },

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
- `/new [title]` — create a new session and bind the current Telegram thread to it. With `openAttachOnNewMode: "new-window"` it also opens a fresh attach window; with `same-window` it requests the existing attached TUI to switch to the new session.
- `/use <sessionId|shareLink>` — bind an existing session. Supports `https://opncd.ai/share/<id>` and `https://opncd.ai/s/<id>`. Raw session IDs must be non-empty and cannot contain whitespace or URL path/query separators; use share links for unusual IDs.
- `/sessions` — list recent sessions and switch with buttons.
- `/unbind` — remove the current binding.

In groups and forum topics, Telegram commands addressed to another bot are ignored: `/start@OtherBot` is ignored, while `/start@<this bot username>` is handled.

### Thread settings and control

- `/model`, `/model default`, `/model reset`, `/model <provider/model> [variant]` — show or change the model for the current thread.
- `/feed` — choose mirrored updates for the current thread.
- `/status` — show the current binding, model, feed mode, SSE status, and base URL.
- `/runtime` or `/health` — show compact connector runtime counters (**private chat only**): managed tasks, Telegram polling, backlog drain, update retry/skip counts, prompt polling, and shutdown state. The message includes **Restart**, **Stop**, and **Close** buttons. Restart and Stop always ask for confirmation first; after a supervised Restart, the bot sends a private-chat notice when the connector is online again.
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
- `Verbose` — final replies, streaming previews, user mirror, and changed-file cards.

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

- `baseUrl` or `port`
- `directory` (required for `autoStart`)
- `autoStart`
- `serverLaunchMode`: `background` or `window`
- `openTuiOnAutoStart`
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
- `OPENCODE_SSE_MAX_LINE_BYTES`, `OPENCODE_SSE_MAX_EVENT_BYTES`, `OPENCODE_SSE_MAX_EVENT_LINES` — tune SSE safety limits for unusually large upstream events.
- `OPENCODE_SSE_CONNECT_TIMEOUT_MS` — timeout for an initial SSE `/event` connection that accepts TCP but never returns headers.
- `OPENCODE_SSE_HEALTHCHECK_MIN_INTERVAL_MS` — tune health-check throttling after SSE disconnects.
- `OPENCODE_WATCHDOG_FAILURE_THRESHOLD`, `OPENCODE_WATCHDOG_WINDOW_MS`, `OPENCODE_WATCHDOG_COOLDOWN_MS` — tune the autoStart watchdog that restarts a configured opencode server after repeated retryable health/SSE/prompt-poll failures.
  On Windows, watchdog restarts also close matching stale `opencode attach` UI windows before reopening the TUI for that project.

## Platform notes

- **Windows**, **macOS**, and **Linux desktop** environments support local auto-start and optional attach/TUI windows.
- On Linux, the connector tries `OPENCODE_TERMINAL` first and then common terminal emulators from `PATH`.
- In headless Linux/macOS environments, connecting to an already running opencode server still works, but opening a new terminal window requires an available GUI/terminal launcher.
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
WorkingDirectory=/opt/telegram-connector/project
ExecStart=/usr/bin/node src/cli.js --env-file /opt/telegram-connector/project/.env
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
  <key>WorkingDirectory</key><string>/Users/YOU/telegram-connector/project</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/cli.js</string>
    <string>--env-file</string>
    <string>/Users/YOU/telegram-connector/project/.env</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>/Users/YOU/telegram-connector/project/.data/connector.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/telegram-connector/project/.data/connector.err.log</string>
</dict>
</plist>
```

Load and inspect it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.opencode.telegram-connector.plist
launchctl print gui/$(id -u)/dev.opencode.telegram-connector
tail -f .data/connector.err.log
```

`SuccessfulExit=false` restarts non-zero exits and leaves clean exit code `0` stopped.

### NSSM / Windows service

NSSM is useful when you want a Windows Service instead of a user-session PM2 process. It is best for headless mode; Windows services are not ideal for opening interactive attach/TUI windows.

Run these commands from an elevated PowerShell prompt and adjust paths:

```powershell
nssm install telegram-connector
nssm set telegram-connector Application "C:\Program Files\nodejs\node.exe"
nssm set telegram-connector AppDirectory "C:\path\to\telegram-connector\project"
nssm set telegram-connector AppParameters "src\cli.js --env-file C:\path\to\telegram-connector\project\.env"
nssm set telegram-connector AppStdout "C:\path\to\telegram-connector\project\.data\connector.out.log"
nssm set telegram-connector AppStderr "C:\path\to\telegram-connector\project\.data\connector.err.log"
nssm set telegram-connector AppExit 0 Exit
nssm set telegram-connector AppExit Default Restart
nssm set telegram-connector AppRestartDelay 5000
nssm start telegram-connector
```

`AppExit 0 Exit` leaves `/runtime` Stop stopped. `AppExit Default Restart` restarts `/runtime` Restart and other non-zero exits.

### Docker

If you package the connector in a container, use a restart policy that restarts failures but not manual stops. For example:

```sh
docker run -d --name telegram-connector --restart on-failure --env-file .env telegram-connector:latest
```

In Compose:

```yaml
services:
  telegram-connector:
    image: telegram-connector:latest
    env_file: .env
    restart: on-failure
```

Use `on-failure` if you want `/runtime` Restart (`exit 1`) to relaunch and `/runtime` Stop (`exit 0`) to stay stopped. Use `unless-stopped` only if you want the container runtime to bring the connector back after any process exit.

SSE disconnects reconnect with backoff when they are retryable. Fatal SSE protocol or size errors stop that project's SSE loop instead of reconnecting forever; prompt polling remains available as the fallback path for permission and question prompts while SSE is down.

### Runtime smoke checks

After changing runtime/recovery behavior, run the connector under your usual supervisor and check:

1. `/runtime` in a private chat shows managed tasks, Telegram polling, backlog drain, prompt polling, update retry/skip counts, shutdown state, and Restart/Stop/Close buttons.
2. `/projects` offers Retry health check and Close for every project, Start only where auto-start is configured and supported, and Show sessions only in private chats.
3. Tap `/runtime` Restart or Stop, confirm the warning screen appears, then Cancel once to verify confirmation without stopping the process.
4. In a supervised environment, confirm `/runtime` Restart exits, is relaunched by the supervisor, and sends the online-again notice; confirm `/runtime` Stop exits cleanly and remains stopped.
5. Stop and restart the supervisor-managed process; bindings, offset, feed mode, model preference, and pending prompts should recover without duplicate actions.
6. Temporarily stop one opencode server, use `/projects` → Retry health check, then restore the server and retry again to confirm project-scoped recovery works without restarting the connector.
7. In a group, confirm `/start@OtherBot` is ignored and `/start@<this bot username>` is handled.
8. Answer an opencode permission or question prompt and confirm the handled prompt message is removed; for multi-select questions, confirm the message remains while toggling options and is removed after **Done**.
9. If a normal Telegram prompt hits a retryable opencode failure, confirm it is retried and not marked handled until `prompt_async` succeeds.
10. Send long formatted output and confirm Telegram chunks remain parseable HTML.

## Troubleshooting matrix

| Symptom | What to check | Safe recovery action |
| --- | --- | --- |
| Telegram polling appears stuck | Use `/runtime` in a private chat and inspect `Telegram poll` retries, `lastErrorAt`, and update retry/skip counts. Ensure only one connector instance is running for the bot token. | Fix the Telegram/API/network issue; restart the connector only if the supervisor reports the process is unhealthy. |
| OpenCode unavailable | Use `/projects` and the project's Retry health check. `/status` also shows the current project's SSE and sanitized base URL. | Start opencode manually, or press Start if the project exposes a Start button. Retry health after the server is up. |
| Windows TUI/attach window appears hung | Check logs for watchdog restarts or repeated retryable SSE/prompt-poll failures. A stale attach window can remain after a server restart. | Let the auto-start watchdog recover the project; it closes matching stale attach windows and opens a fresh one. If needed, close the old TUI window manually and use `/projects` → Start/Retry health. |
| State file cannot be read, written, or validated | Startup or runtime logs report a state read/write/schema failure. The connector fails closed instead of silently resetting state. Schema errors include the malformed section path, and migration/invalid-state backups are written next to `state.json` when possible. | Fix permissions/path/corruption, repair the reported section, or restore a known-good `state.json.backup.*` file. Treat backups as sensitive; they contain the same bindings, offset, prompts, and idempotency history as `state.json`. |
| Prompt send reports project unavailable | A retryable opencode `prompt_async` failure happened while forwarding a user message. | Restore the project; the Telegram update remains retryable and should be processed again after recovery. |
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
- OpenCode path IDs are URL-encoded at the HTTP boundary; user-entered binding/session IDs are validated before being persisted.
- Parent-session routing uses a bounded cache for long-running processes.
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
