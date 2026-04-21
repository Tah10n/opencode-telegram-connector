# Contributing

Thanks for contributing.

## Development

- Node.js 20+
- ESM modules only
- Prefer small, local changes
- Do not commit secrets such as `.env`, `projects.json`, or runtime state

Run before opening a PR:

```powershell
npm run check
npm test
```

## Project expectations

- The connector is designed to run as a single instance per Telegram bot token.
- Keep dependencies light unless they provide clear value.
- Preserve safe handling around auth, local state, and insecure HTTP restrictions.

## Pull requests

- Keep commit history and PR scope focused.
- Update docs when behavior or configuration changes.
- Include tests when changing non-trivial logic.
