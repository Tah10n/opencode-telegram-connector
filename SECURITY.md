# Security Policy

## Supported versions

Security fixes are applied to the latest development line only.

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Reporting a vulnerability

Please report suspected vulnerabilities privately.

- Do **not** post secrets, tokens, passwords, or private state files in public issues.
- Prefer GitHub private vulnerability reporting if it is enabled for the repository.
- If GitHub private vulnerability reporting is not available, open a minimal public issue asking for a private security contact path. Do not include vulnerability details, logs, tokens, URLs with credentials, or state/config contents in that issue.
- If you already have a private maintainer contact, you may use that channel instead.

When reporting, include:

- a short description of the issue
- impact and affected configuration
- reproduction steps or a minimal example
- any suggested mitigation or fix, if known

We will try to acknowledge reports promptly and follow up with a fix or mitigation plan.

## Runtime state and local config

- Treat `.env`, local config files with credentials, and `.data/state.json` as sensitive. State contains chat bindings, session IDs, pending attachment-confirmation metadata, prompt reconciliation, Telegram outbox routes/progress, bounded fallback error text, and idempotency history.
- If state is corrupt or unreadable, the connector fails closed instead of silently resetting. Repair permissions/corruption or restore a backup before restarting; deleting state loses bindings, offset, pending prompts/deliveries, and duplicate-action protection.
- Telegram bot authentication failures (`401`/`403`) are fatal and trigger controlled non-zero shutdown. Diagnostics redact the bot token; do not post the token or an unredacted state/log file when reporting the failure.
- Dynamic OpenCode URL path segments are encoded and user-entered session IDs are validated. Reports involving malformed IDs, routing confusion, or unexpected endpoint access are security-relevant.
