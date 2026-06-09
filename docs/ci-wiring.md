# CI Wiring

claude-ds ships two CI scripts that gate the governance scaffold in CI:

| npm script | script | what it checks |
|---|---|---|
| `pnpm run ci:hook-contract` | `scripts/check-hook-contract.sh` | Every `exit 2` in `.claude/hooks/` is preceded by a `log-failure.sh` call (HOOK-001) |
| `pnpm run ci:consistency` | `scripts/consistency-probe.sh` | Consistency probe (stub — exits 0 today, real orchestration post-Slice H) |

Run them manually after `adopt`:

```sh
pnpm run ci:hook-contract
pnpm run ci:consistency
```

Exit code 0 = clean. Exit code 2 = violations found (see stderr).

---

## GitHub Actions

`adopt` seeds `.github/workflows/claude-ds-governance.yml` into your repo.
It runs both scripts on every push and pull_request to `main`.
Delete the file if you are not on GitHub Actions — the scripts still work locally.

### Example: default seeded workflow

```yaml
name: claude-ds governance

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  governance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Hook-contract check
        run: pnpm run ci:hook-contract

      - name: Consistency probe
        run: pnpm run ci:consistency
```

### Example: with pnpm setup

```yaml
name: claude-ds governance

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  governance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Hook-contract check
        run: pnpm run ci:hook-contract

      - name: Consistency probe
        run: pnpm run ci:consistency
```
