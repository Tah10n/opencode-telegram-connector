# Telegram connector for opencode

Small Node.js bridge that:

- Reads Telegram updates in a single process/offset.
- Routes each Telegram context `(chat_id, message_thread_id|null)` to `{ projectAlias, sessionId }`.
- Mirrors **user + assistant text** from opencode sessions into the bound Telegram thread, with Telegram HTML formatting.
- Lets you send messages from Telegram into the bound opencode session (optional prefix `TG_PREFIX`, default empty).
- Lets you approve/deny opencode **permission** and answer **question** prompts via Telegram **buttons**.

Unlike bots that keep a single "current project" and force you to switch back and forth, this connector binds each Telegram chat/topic to its own `{ projectAlias, sessionId }`. That means you can keep **multiple projects active at the same time** in different chats or forum topics and continue each session independently.

## Key advantage

This connector is optimized for **parallel multi-project work**:

- one Telegram topic can stay bound to project A
- another topic can stay bound to project B
- each topic keeps its own opencode session binding
- no manual global project switching is required between conversations

## Prereqs

- Node.js 18+ (this repo has Node 24).
- A Telegram bot token (via @BotFather).
- opencode installed and available on PATH.

## Setup

1) Create `.env` (see `.env.example`).

2) Create `projects.json` (see `projects.example.json`).

3) (Optional) Let the connector auto-start opencode.

Add `directory` + `port` + `autoStart:true` in `projects.json` (see `projects.example.json`).

On Windows, `startMode: "tui"` will open a new window per project (`opencode . --port <port> --continue`) so the UI continues the last session. Startup health wait timeout is ~3 minutes.

If you set `openAttachOnNew: true` for a project, then each `/new` in Telegram will also open a new `opencode attach <baseUrl> --session <newSessionId>` window for that project (old windows are kept).

If you send a Telegram message while the project's server is down and the project has `autoStart:true`, the bot will offer a **Start** button that launches opencode for that project.

4) Start the connector:

```powershell
npm start
# or: node src/cli.js
```

5) Open Telegram, message your bot (e.g. `/start`).

## Commands (in Telegram)

- `/help`
- `/bind <projectAlias>` (bind current thread to that project's startup session)
- `/new [title]` (create a new session in this thread's project and bind)
- `/use <sessionId>` (bind to an existing session in this thread's project)
- `/sessions` (list recent sessions for this thread's current project and switch via buttons)
- `/status` (show current binding)
- `/projects` (list project aliases)
- `/unbind`

## Notes

- The bot only accepts messages from a single Telegram user id (`TELEGRAM_ALLOWED_USER_ID`).
- On first start it **drains** old Telegram updates so it does not replay history.
- State is stored in `./.data/state.json` by default (override with `STATE_FILE`).
- Mirrored messages are sent with `parse_mode=HTML`. Triple-backtick fences (```code```) are rendered as Telegram `<pre><code>` blocks.
- Common markdown like `**bold**`, `*italic*`, `` `inline code` ``, `# headings`, `- bullets`, and `[links](https://example.com)` is converted (clickable links are http/https only).

## Config

- `PROJECTS_FILE=./projects.json` (or `PROJECTS_JSON=...`)
- `DEFAULT_PROJECT=...` (optional hint)
- `STATE_FILE=...` (optional)
- `TG_PREFIX=[TG] ` (optional)
- `ECHO_FILTER_MODE=recent` (optional; default)
- `OPENCODE_ALLOW_INSECURE_HTTP=1` (optional; allows Basic Auth over non-loopback http://)

### projects.json fields

Each project entry supports:

- `baseUrl` (required unless `port` is set)
- `directory` (required if `autoStart:true`)
- `port` (required if `autoStart:true`; also enables implicit baseUrl `http://127.0.0.1:<port>`)
- `autoStart` (optional; default false)
- `startMode`: `"tui"` or `"serve"` (optional; default `"tui"`)
- `openAttachOnNew` (optional; Windows-only helper)
- `username` / `password` or `usernameEnv` / `passwordEnv` (optional basic auth)

## Viewing the same session in opencode

Each Telegram thread is bound to a `{ projectAlias, sessionId }`.

- See current binding: `/status`
- See each project's startup session: `/projects`

To view the same session in a terminal UI, attach:

```powershell
opencode attach <baseUrl> --session <sessionId>
```
