# Design-system contracts

- Atoms may not import from composites.
- Color values must come from `tokens.json`; raw hex is forbidden in design-system files.
- Failures are logged to `failure-log.md` via `.claude/hooks/lib/log-failure.sh`.

## Per-component bundle

Every component — atom or composite — ships as a four-file bundle (per `design-system-scaffold.md`):

```
<Name>.tsx
<Name>.showcase.tsx
<Name>.states.json
<Name>.test.tsx
```

No component is considered complete until all four files are present. The showcase generator and hook contracts assume this shape.
