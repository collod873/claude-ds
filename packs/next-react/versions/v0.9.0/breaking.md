# v0.9.0 Breaking Changes

## Token surface widened: motion, mask, shadow, z

`design-system/tokens.json` gains four optional groups. Existing consumers are unaffected on upgrade because the `widen-tokens` migration Op performs an **additive merge only** — it adds default values for any missing group and leaves existing groups untouched.

### New token groups

| Group | Tailwind utilities | Description |
|---|---|---|
| `motion.duration` | `duration-fast`, `duration-base`, `duration-slow` | Transition durations |
| `motion.ease` | `ease-in`, `ease-out`, `ease-in-out` | Transition timing functions |
| `shadow` | `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-popover` | Box shadows |
| `z` | `z-base`, `z-dropdown`, `z-sticky`, `z-modal`, `z-popover`, `z-toast` | Z-index scale |
| `mask` | `.mask-fade-to-bottom`, `.mask-fade-to-top`, `.mask-fade-edges` | CSS mask-image utilities |

## Tailwind plugin

`tailwind.config.cjs` is now a managed hybrid file. On `adopt`/`sync`, claude-ds seeds this file with a marker block that reads `design-system/tokens.json` at build time and injects the token groups into the Tailwind theme. Consumer customisations (content globs, additional plugins, extra theme extensions) live outside the marker block.

If a consumer already has a `tailwind.config.cjs`, the marker block is inserted into it; content outside the markers is preserved.

## Migration

Run `claude-ds upgrade --to v0.9.0` to apply the `widen-tokens` Op (additive token merge) and advance `packVersion` to `v0.9.0`.
