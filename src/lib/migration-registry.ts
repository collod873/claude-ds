import type { MigrationVersion } from "./migration-framework.js";
import { noopMigration } from "./ops/migrations/v0.8.0/noop.js";
import { widenTokensMigration } from "./ops/migrations/v0.9.0/widen-tokens.js";

/**
 * All known pack migration sets, keyed by release version.
 * The upgrade command chains these in version order between the consumer's
 * pinned packVersion and the target version.
 */
export const MIGRATION_REGISTRY: MigrationVersion[] = [
  { version: "v0.8.0", ops: [noopMigration] },
  { version: "v0.9.0", ops: [widenTokensMigration] },
];
