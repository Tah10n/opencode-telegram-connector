# Releasing

Use this checklist before a release.

## Release readiness

- Confirm `README.md` still matches the shipped behavior, commands, and configuration.
- Confirm `.env.example` and `connector.config.example.mjs` still match supported setup paths.
- Confirm any documented legacy `PROJECTS_FILE` / `PROJECTS_JSON` fallback is still correct.
- Confirm `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` are present and current.
- Confirm no secrets or private state are tracked or referenced by mistake (`.env`, `projects.json`, `.data/`).
- If behavior changed, update `CHANGELOG.md` and any user-facing docs.

## Verification

Run:

```sh
npm run check
npm test
npm run test:coverage
```

If the change affects runtime behavior, also run the manual smoke flow from `README.md` / `CONTRIBUTING.md`.

## Package metadata

- Confirm `package.json` description, keywords, version, and bin entry are still correct.
- If you plan to publish to npm, decide intentionally whether to remove `"private": true`.
- Before npm publication, also add real `repository`, `homepage`, and `bugs` metadata.
- Before npm publication, inspect the package contents with `npm pack --dry-run`.

## Release steps

- Bump `version` in `package.json` when appropriate.
- Move release notes from `[Unreleased]` into a versioned section in `CHANGELOG.md`.
- Tag the release in git and publish release notes.
- If you publish to npm, do that only after the git tag and changelog are finalized.
