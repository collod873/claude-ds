/**
 * Ambient `ImportMeta.glob` augmentation — shipped pack-managed so the
 * scaffolded `role-contracts.test.tsx` typechecks under the consumer's plain
 * `tsc` with zero Vite dependency (PRD #407 / A3, issue #411).
 *
 * Vite supplies this augmentation via `vite/client`. We deliberately do NOT
 * pull `vite/client` here (ADR-0003: zero local DS infrastructure outside the
 * pack-installed scaffold), nor do we vendor Vite at runtime. Instead we ship
 * the exact slice of the ImportMeta shape the runner uses — `glob(pattern,
 * { eager?: true })` — so `tsc --noEmit` resolves the call without TS2339.
 *
 * At runtime the call is still resolved by Vite/Vitest (the consumer's test
 * runtime, never `tsc` itself). The ambient declaration only buys the
 * scaffolded test file the right to typecheck under the consumer's own gate.
 *
 * Pack-managed: claude-ds owns this file whole. Edits are reverted on the
 * next `sync` so the typecheck contract can't drift on the consumer side.
 *
 * The file is intentionally a script-mode `.d.ts` (no top-level imports or
 * exports) so its `interface ImportMeta` augments the global ImportMeta type
 * across the project — the same merge pattern `vite/client.d.ts` uses.
 */

interface ImportMetaGlobEagerOptions {
  eager: true;
  /** Named export to load instead of the module namespace. Vite-compatible. */
  import?: string;
  /** Optional query string / record passed to Vite's resolver. */
  query?: string | Record<string, string | number | boolean>;
  /** Disable Vite's stripping of import-only modules; ignored at typecheck. */
  exhaustive?: boolean;
}

interface ImportMetaGlobLazyOptions {
  eager?: false;
  import?: string;
  query?: string | Record<string, string | number | boolean>;
  exhaustive?: boolean;
}

interface ImportMeta {
  /**
   * Eager variant: resolves every match at module-load time and returns the
   * module records keyed by relative path. This is the variant the scaffold's
   * `role-contracts.test.tsx` uses.
   */
  glob<T = unknown>(
    pattern: string | readonly string[],
    options: ImportMetaGlobEagerOptions,
  ): Record<string, T>;
  /**
   * Lazy variant: returns dynamic-import thunks keyed by relative path. Kept
   * for parity with Vite so consumer code that mixes lazy/eager glob calls
   * also typechecks — the pack itself only uses the eager variant.
   */
  glob<T = unknown>(
    pattern: string | readonly string[],
    options?: ImportMetaGlobLazyOptions,
  ): Record<string, () => Promise<T>>;
}
