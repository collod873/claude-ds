# v0.9.0 Migration Ops

## `widen-tokens`

**Source:** `src/lib/ops/migrations/v0.9.0/widen-tokens.ts`

Additive merge of `motion`, `mask`, `shadow`, and `z` default values into the consumer's `design-system/tokens.json`. Groups already present in the consumer's file are left untouched. Only groups absent from the consumer's tokens receive defaults.

Returns a single `write` Change if any groups were added, or an empty array if the consumer already has all four groups. Returns `abort` if `tokens.json` does not exist (consumer must run `adopt` first).

## `verification.md`

Not yet filled — awaiting Crewops upgrade gate before v0.9.0 is tagged final.
