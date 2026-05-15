# Design-system contracts

- Atoms may not import from composites.
- Color values must come from `tokens.json`; raw hex is forbidden in design-system files.
- Failures are logged to `failure-log.md` via `scripts/log-failure.sh`.

## Per-component bundle

Every component — atom or composite — ships as a five-file bundle (per `design-system-scaffold.md`):

```
<Name>.tsx
<Name>.showcase.tsx
<Name>.states.json
<Name>.snapshot.png
<Name>.test.tsx
```

No component is considered complete until all five files are present. The showcase generator (Slice H) and hook contracts (Slice D) assume this shape.
