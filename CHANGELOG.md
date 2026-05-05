# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `connector.config.mjs` values for `activeTurnStaleMs` and `opencodeWatchdog` now reach runtime config and invalid values fail fast with clear errors.
- Project `baseUrl` now rejects non-HTTP(S) schemes, and string `autoStart` / `openTuiOnAutoStart` values are no longer silently treated as `false`.
- `/use` share links that resolve to unsafe session IDs now receive a clear refusal instead of implying share links bypass session ID safety rules.
- SSE line-size checks now apply to each individual line, so large chunks made of short lines are accepted while one oversized line still fails.
- Scheduled state saves now log write failures instead of silently swallowing them.
- Repeated embedded `runCli` calls no longer leave duplicate process listeners behind.
- Telegram sends now skip empty message text and empty HTML blocks instead of calling the API with invalid empty content.
- New Telegram prompts now detect stale running assistant turns before sending to opencode and warn the thread instead of silently queueing behind a hung agent.
- Assistant and tool failures now surface a redacted `Agent stopped due to error` notice in the bound Telegram thread instead of silently disappearing when no streaming preview exists.
- Tool-error stop notices are delayed and verified against the assistant message so recovered tool failures do not create false stop alerts.
- Child-session permission and question prompts now route through parent session bindings.
- Mirrored opencode TUI user messages are combined consistently instead of arriving as fragmented updates.
- Handled opencode permission and question prompt messages are now removed after the user presses a final inline button, while multi-select prompts stay visible until **Done**.
- Windows auto-start now closes stale matching `opencode attach` UI windows before reopening them when a TUI fails to recover the server or the watchdog restarts a hung project.
- `/new` with `openAttachOnNewMode: "same-window"` now binds Telegram to the created session immediately while best-effort switching the attached TUI.
- Auto-start projects now have a watchdog that restarts a hung opencode server after repeated retryable SSE/prompt-poll/user-prompt failures.
- Initial SSE connections now time out instead of hanging forever when the opencode server accepts the connection but never returns headers.
- Telegram bindings can now follow TUI-reported active-session changes when the opencode server supports `/tui/active-session`.
- Retryable user `prompt_async` failures no longer mark Telegram updates handled before delivery succeeds.
- Group commands addressed to another bot, such as `/start@OtherBot`, are ignored.
- Telegram HTML output splitting now preserves tags and entities across chunks.
- Fatal SSE protocol or size errors stop reconnect loops instead of retrying forever.
- State load and critical state flush/write failures now fail closed instead of silently losing runtime state.
- State schema validation now rejects malformed current-schema sections and unknown schema versions with actionable section paths.

### Security
- Logs now redact bot tokens, Basic Auth credentials, URL userinfo/query/hash values, auth-like command-line flags, and sensitive state/config paths before writing text or JSON output.
- High-entropy token strings of 32 or more characters are automatically redacted even when the token type is not pre-listed in the known-secrets configuration.
- Logged `Error` objects include a `stack_redacted: true` field instead of the raw stack trace so sensitive paths in stacks are not leaked while the omission remains visible.
- Dynamic opencode path segments are URL-encoded, and user-entered binding/session IDs are validated before persistence or routing.
- Parent-session route caching is bounded for long-running processes.
- Atomic state write behavior is covered for replacement failures so existing state is preserved where possible.
- State migrations and invalid parsed state files are preserved in bounded `state.json.backup.*` files before recovery attempts.

### Added
- Update-scoped correlation IDs now flow through Telegram update handling, connector handlers, OpenCode HTTP/SSE requests, mirroring, Telegram delivery logs, and `logger.child()` scoped fields. OpenCode requests include `X-Connector-Correlation` when a context is active.
- Optional no-dependency HTTP health endpoints (`/livez`, `/readyz`, `/healthz`) are available via `CONNECTOR_HEALTH_ENABLED` / `healthServer`, disabled by default and loopback-bound by default.
- `/status` now reports an explicit agent state (`running`, `not running`, or `unknown`) for the bound session.
- Verbose feed mode now mirrors concise agent action/tool-use updates from opencode tool parts.
- Optional JSON log mode for supervisors and hosted runtimes via `CONNECTOR_LOG_FORMAT=json` or `logFormat: "json"`.
- Runtime counters for mirrored assistant messages, skipped noisy events, prompt delivery/answers, Telegram send/edit failures, and attachment fallbacks in `/status` and `/runtime`.
- Connector project packaging groundwork and release guardrails.
- Manual preflight and smoke-test guidance.
- Open-source release basics such as a license, contributing guide, and CI.
- Cross-platform desktop launcher support for Windows, Linux, and macOS `tui` / attach flows.
- Added a unified `connector.config.mjs` configuration path with legacy `.env` / `projects.json` fallback.
- Telegram document prompts for UTF-8 text/code/log files, including size limits and confirmation before large files are sent to opencode.
- Changed-file cards can export summaries as `.txt`, full diffs as `.patch`, and selected file diffs when available.
- Telegram attachment, changed-file, streaming preview, and long-output fallback limits are configurable via `connector.config.mjs` `limits`.

### Changed
- Node.js support baseline is now 20+.
- Added `.gitattributes` for predictable line endings across platforms.
- Start-button auto-start flows and attach-window launch behavior now share one cross-platform launcher path.
- Added explicit project config knobs for background vs visible server launch and whether auto-start should open a TUI window.
- Added `openAttachOnNewMode` so `/new` can either open a fresh attach window or stay in manual same-window mode.

### Documentation
- Quick start now guides users through `npm run setup:check` before `npm start`.
- README, `.env.example`, `connector.config.example.mjs`, and release docs now show synchronized examples for local auto-start, remote Basic Auth via env, multi-project configs, and headless/server-only operation.
- Package guidance now explicitly keeps `package.json` private for this phase; npm packaging and publishing remain a later release track.
