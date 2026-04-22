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

- Node.js 20+.
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

Availability notifications stay scoped to the affected bound threads: if a project's health/SSE goes down, only threads bound to that project are notified, and they receive a single back-online notice when connectivity recovers.

4) Start the connector:

```powershell
npm start
# or: node src/cli.js
```

5) Open Telegram, message your bot (e.g. `/start`).

## Commands (in Telegram)

- `/help`
- `/bind <projectAlias>` (bind current thread to that project's startup session)
- `/new [title]` (create a new session in this thread's project, bind to it, and show the thread's active model + source when available)
- `/use <sessionId|shareLink>` (bind to an existing session in this thread's project; accepts `https://opncd.ai/share/<id>` and `https://opncd.ai/s/<id>`; cross-project share links are rejected with guidance)
- `/sessions` (list recent sessions for this thread's current project, including the current thread model + source when available, and switch via buttons)
- `/model [provider/model] [variant]` (show or change the current thread's model preference; `/model default` pins the thread to the project's configured default, `/model reset` returns to inherited behavior)
- `/feed` (configure which updates are mirrored into this thread: Main, Main + changes, Verbose)
- `/status` (show current binding, active model + source, feed mode, startup session, SSE status, and base URL)
- `/bindings` (list all active chat/topic bindings; private chat only)
- `/abort` (abort the current thread's running session)
- `/sendlast` (re-send the latest assistant reply from the currently bound session)
- `/projects` (show a higher-level overview of projects, startup sessions, SSE state, and active bindings)
- `/unbind`

## Notes

- The bot only accepts messages from a single Telegram user id (`TELEGRAM_ALLOWED_USER_ID`).
- On first start it **drains** old Telegram updates so it does not replay history.
- State is stored in `./.data/state.json` by default (override with `STATE_FILE`).
- Each bound Telegram thread/topic stays isolated: switching sessions, streaming previews, changed-file cards, and prompt recovery in one thread do not affect other threads.
- Feed mode is stored per Telegram thread/topic and survives rebinds and restarts.
- Model preference is also stored per Telegram thread/topic and survives `/use`, `/new`, and connector restarts.
- `Main` shows only final assistant replies.
- `Main + changes` shows final assistant replies plus first-class `Changed files` cards.
- `Verbose` also includes streaming previews and non-echo user mirroring.
- Internal compaction output and noisy intermediate model messages stay hidden by default in all feed modes.
- Assistant replies stream into the bound Telegram thread while opencode is still generating output.
- Very long assistant code/log output falls back to a `.txt` attachment instead of flooding the chat with many chunks.
- `Changed files` cards support `Show diff` / `Back` and update the same Telegram message in place; if the diff is unavailable or too large, the bot falls back gracefully and may attach a `.txt` file.
- Pending prompt state persists the minimal recovery data needed to continue Telegram flows after restart: pending permissions, in-progress question wizards, typed reject-note waits, and typed custom-answer waits.
- Restart recovery validates permissions and questions independently against the live backend snapshot before replaying anything into Telegram.
- If the backend confirms that a persisted permission/question is gone, the connector treats it as `stale`, drops the local recovery state, and does not replay it again.
- If the backend is temporarily unavailable during recovery or while submitting a permission/question answer, the connector treats that as `retryable`: it keeps the pending state, does not silently auto-replay the action, and lets you retry from Telegram after the backend recovers.
- Fatal boundary failures are surfaced to the user/operator instead of being retried blindly; the connector now normalizes Telegram/OpenCode boundary errors through a shared classification layer.
- `/use <shareLink>` accepts both current OpenCode share links (`https://opncd.ai/share/<id>`) and older short links (`https://opncd.ai/s/<id>`).
- When switching to an existing session, the connector shows the effective model for the current thread; in inherit mode it falls back to the most recent known session model when OpenCode history exposes it.
- `/model` prefers inline buttons for common choices: inherit, project default, and common variants for the current/default model. Use `/model <provider/model> [variant]` as a typed fallback for anything else.
- `Inherit` means the connector sends no explicit model override, so OpenCode keeps using the session's last model when available and otherwise falls back to the project default.
- `Project default` means the connector resolves the project's configured default model/variant and sends that as a per-thread override on each prompt from that Telegram thread.
- `Custom` means the connector sends the selected provider/model/variant on each prompt from that Telegram thread only; other threads and projects keep their own selections.
- `/new` keeps the current thread's model preference when it creates and binds a new session, so the next prompt in that thread continues with the same override behavior.
- `/sendlast` fetches the latest assistant reply for the currently bound session from OpenCode, so it still works after session switches or connector restarts.
- `/new` reports the effective model for the current thread: custom override, project default override, or inherited/default behavior.
- If `/use <shareLink>` points to a session from a different configured project, the bot refuses the bind and tells you to bind the correct project alias first.
- When a project becomes unavailable, bound threads receive an unavailable notice and, for `autoStart:true` projects, a **Start** button; once the project is healthy again they receive a single back-online notice.
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
