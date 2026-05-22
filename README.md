# claude-ds

Shared design-system governance + scaffold CLI.

Install (per-project, no global): `npx github:collod873/claude-ds#v0.1.0 <subcommand>`

Subcommands: `init`, `audit`, `adopt`, `migrate`, `reconform`, `enforce`, `sync`, `version`.

See `.claude/spec.md` for the full surface.

## Upgrade notes

### v0.7.6 — `meta.examples: []` semantic flip

In v0.7.6 the meaning of an empty `examples` array in showcase-companion source files changed:

- **Before (≤ v0.7.5):** empty `examples[]` → generator auto-expanded the CVA variant matrix into a synthesized default entry.
- **After (≥ v0.7.6):** empty `examples[]` → authoritative stub signal. Generator emits a placeholder card and skips CVA expansion entirely.

If you were relying on the old auto-expand behavior, migrate to an explicit default entry:

```ts
// Before
export const meta = { examples: [] };

// After
export const meta = { examples: [{ name: "default", props: {} }] };
```

See CHANGELOG `[0.7.6]` and issues #62, #64 for context.
