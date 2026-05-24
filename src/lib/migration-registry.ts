import type { MigrationVersion } from "./migration-framework.js";
import { noopMigration } from "./ops/migrations/v0.8.0/noop.js";
import { dsFolderAlias } from "./ops/migrations/v0.9.0/ds-folder-alias.js";
import { rewriteDsImports } from "./ops/migrations/v0.9.0/rewrite-ds-imports.js";

/**
 * All known pack migration sets, keyed by release version.
 * The upgrade command chains these in version order between the consumer's
 * pinned packVersion and the target version.
 */
export const MIGRATION_REGISTRY: MigrationVersion[] = [
  { version: "v0.8.0", ops: [noopMigration] },
  { version: "v0.9.0", ops: [dsFolderAlias, rewriteDsImports] },
];
