# Design system

- `atoms/` — primitive UI elements. Must not import from `composites/`.
- `composites/` — compositions of atoms. May import from `atoms/`.
- Tokens live in `tokens.json` at the project root.
