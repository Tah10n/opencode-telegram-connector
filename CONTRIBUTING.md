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
- `src/index.js` — top-level composition for Telegram polling, SSE wiring, state, and shutdown; keep detailed runtime assembly in `src/runtime/service-wiring.js`
- `src/runtime/*` — lifecycle tools, Telegram polling loop, request context, observability, health checks, and runtime service wiring
- `src/connector/callbacks.js` and `src/connector/callbacks/*` — callback dispatch, shared callback context, and prompt-specific permission/question flows
- `src/connector/mirroring.js` and `src/connector/mirroring/*` — assistant, TUI user, changed-file, feed, and agent-action mirroring
- `src/opencode/*` — HTTP client, SSE loop, startup-session resolution, and cross-platform auto-start helpers
- `src/opencode/launcher.js` and `src/opencode/launcher/*` — platform launcher facade plus Windows/POSIX launcher internals
- `src/telegram/*` — Telegram API client, formatting, and routing-key helpers
- `src/state/*` — persisted runtime state and file storage

## Project expectations

- The connector is designed to run as a single instance per Telegram bot token.
- Keep dependencies light unless they provide clear value.
- Preserve safe handling around auth, local state, and insecure HTTP restrictions.
- Treat per-thread routing, restart recovery, and feed semantics as core behavior: changes here should come with focused tests.
- Keep Telegram/OpenCode boundary failures normalized through `src/boundary-errors.js`; avoid scattering new string-matching heuristics across handlers.
- Preserve the recovery contract when touching prompt flows: `stale` clears local pending state, `retryable` keeps it for manual retry, and `fatal` must be surfaced explicitly.
- State read/write failures must not silently fall back to empty state or pretend persistence succeeded.
- Retryable user prompt sends must not advance Telegram offset or mark the message handled until OpenCode delivery succeeds.
- Commands addressed to other Telegram bots must remain ignored in groups and topics.
- Telegram HTML output must remain valid when split into multiple messages.
- Keep SSE retryable disconnects and fatal protocol/size failures distinct. The default opencode event source is `/global/event`; preserve payload unwrapping, fail-closed directory metadata checks for global events, and the `OPENCODE_SSE_EVENT_PATH=/event` legacy override.
- Encode dynamic OpenCode URL path segments and validate persisted/user-entered session IDs before routing.
- `npm run check` includes `scripts/verify-architecture.mjs`. If a change intentionally moves a facade boundary or grows an entry file, update that guard in the same change and keep the new boundary explicit.

## Pull requests

- Keep commit history and PR scope focused.
- Update docs when behavior or configuration changes.
- Include tests when changing non-trivial logic.
- When changing a completed roadmap feature, keep the user-facing docs (`README.md`) and the relevant test coverage in sync.
- Use `RELEASING.md` as the release checklist when preparing a release.
