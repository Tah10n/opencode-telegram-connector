# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
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
- Dynamic opencode path segments are URL-encoded, and user-entered binding/session IDs are validated before persistence or routing.
- Parent-session route caching is bounded for long-running processes.
- Atomic state write behavior is covered for replacement failures so existing state is preserved where possible.
- State migrations and invalid parsed state files are preserved in bounded `state.json.backup.*` files before recovery attempts.

### Added
- Public-project split with subtree workflow helpers and boundary checks.
- Manual preflight and smoke-test helper scripts.
- Public OSS basics such as license, contributing guide, and CI.
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
