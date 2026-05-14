# Design-system contracts

- Atoms may not import from composites.
- Color values must come from `tokens.json`; raw hex is forbidden in design-system files.
- Failures are logged to `failure-log.md` via `scripts/log-failure.sh`.
