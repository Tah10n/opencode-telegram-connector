# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `/new` with `openAttachOnNewMode: "same-window"` now best-effort switches an attached TUI to the new session via opencode TUI control endpoints (with a manual fallback note on failure).
- Telegram bindings can now follow TUI-reported active-session changes when the opencode server supports `/tui/active-session`.

### Added
- Public-project split with subtree workflow helpers and boundary checks.
- Manual preflight and smoke-test helper scripts.
- Public OSS basics such as license, contributing guide, and CI.
- Cross-platform desktop launcher support for Windows, Linux, and macOS `tui` / attach flows.
- Added a unified `connector.config.mjs` configuration path with legacy `.env` / `projects.json` fallback.

### Changed
- Node.js support baseline is now 20+.
- Added `.gitattributes` for predictable line endings across platforms.
- Start-button auto-start flows and attach-window launch behavior now share one cross-platform launcher path.
- Added explicit project config knobs for background vs visible server launch and whether auto-start should open a TUI window.
- Added `openAttachOnNewMode` so `/new` can either open a fresh attach window or stay in manual same-window mode.
