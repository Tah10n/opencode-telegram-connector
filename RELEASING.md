# Releasing

Use this checklist before a release.

## Release readiness

- Confirm `README.md` still matches the shipped behavior, commands, and configuration.
- Confirm the quick start still tells users to run `npm run setup:check` before `npm start`.
- Confirm `.env.example` and `connector.config.example.mjs` still match supported setup paths.
- Confirm `README.md`, `.env.example`, `connector.config.example.mjs`, `CHANGELOG.md`, and this checklist stay synchronized for local auto-start, remote server, Basic Auth via env, multi-project, and headless/server-only examples.
- Confirm any documented legacy `PROJECTS_FILE` / `PROJECTS_JSON` fallback is still correct.
- Confirm `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` are present and current.
- Confirm no secrets or private state are tracked or referenced by mistake (`.env`, `projects.json`, `.data/`).
- If behavior changed, update `CHANGELOG.md` and any user-facing docs.
- Confirm package guidance still states that `package.json` remains `"private": true` in this phase and that npm publishing is deferred.

## Verification

From this package directory, run:

```sh
npm run setup:check
npm run check
npm test
npm run test:coverage
```

If the change affects runtime behavior, also run the manual smoke flow from `README.md` / `CONTRIBUTING.md`.

## Package metadata

- Confirm `package.json` description, keywords, version, and bin entry are still correct.
- Confirm `package.json` still keeps `"private": true` for this phase.
- Do not publish to npm in this phase; packaging and publishing are a later release track.
- If that changes in a future release, update `README.md`, `CHANGELOG.md`, and this checklist together before removing `"private": true`.
- Before a future npm publication, also add real `repository`, `homepage`, and `bugs` metadata.
- Before a future npm publication, inspect the package contents with `npm pack --dry-run`.

## Release steps

- Bump `version` in `package.json` when appropriate.
- Move release notes from `[Unreleased]` into a versioned section in `CHANGELOG.md`.
- Tag the release in git and publish release notes.
- If you publish to npm, do that only after the git tag and changelog are finalized.
