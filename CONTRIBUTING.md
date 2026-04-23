# Contributing

Thanks for contributing.

Please follow `CODE_OF_CONDUCT.md` in all project spaces.

## Development

- Node.js 20+
- ESM modules only
- Prefer small, local changes
- Do not commit secrets such as `.env`, `projects.json`, or runtime state

Run before opening a PR:

```sh
npm run check
npm test
npm run test:coverage
```

## Architecture map

- `src/cli.js` — CLI entrypoint, env/config loading, and process startup
- `src/config/*` — `.env`, `connector.config.mjs`, and legacy `projects.json` loading/normalization
- `src/index.js` — high-level orchestration for Telegram polling, SSE wiring, state, and shutdown
- `src/connector/*` — command handlers, callback handlers, mirroring, prompt recovery, and overview notifications
- `src/opencode/*` — HTTP client, SSE loop, startup-session resolution, and auto-start helpers
- `src/telegram/*` — Telegram API client, formatting, and routing-key helpers
- `src/state/*` — persisted runtime state and file storage

## Project expectations

- The connector is designed to run as a single instance per Telegram bot token.
- Keep dependencies light unless they provide clear value.
- Preserve safe handling around auth, local state, and insecure HTTP restrictions.
- Treat per-thread routing, restart recovery, and feed semantics as core behavior: changes here should come with focused tests.
- Keep Telegram/OpenCode boundary failures normalized through `src/boundary-errors.js`; avoid scattering new string-matching heuristics across handlers.
- Preserve the recovery contract when touching prompt flows: `stale` clears local pending state, `retryable` keeps it for manual retry, and `fatal` must be surfaced explicitly.

## Pull requests

- Keep commit history and PR scope focused.
- Update docs when behavior or configuration changes.
- Include tests when changing non-trivial logic.
- When changing a completed roadmap feature, keep the user-facing docs (`README.md`) and the relevant test coverage in sync.
- Use `RELEASING.md` as the release checklist when preparing a release.
