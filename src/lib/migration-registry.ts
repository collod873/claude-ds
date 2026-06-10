import type { MigrationVersion } from "./migration-framework.js";
import { manageForceState } from "./ops/migrations/v0.8.0/manage-force-state.js";
import { retireStates } from "./ops/migrations/v0.8.0/retire-states.js";
import { dsFolderAlias } from "./ops/migrations/v0.9.0/ds-folder-alias.js";
import { manageManifestMigration } from "./ops/migrations/v0.9.0/manage-manifest.js";
import { managePortalScope } from "./ops/migrations/v0.9.0/manage-portal-scope.js";
import { metaKindHardMigration } from "./ops/migrations/v0.9.0/meta-kind-hard.js";
import { rewritePortalStyles } from "./ops/migrations/v0.9.0/rewrite-portal-styles.js";
import { widenTokensMigration } from "./ops/migrations/v0.9.0/widen-tokens.js";
import { liftTrackingManifest } from "./ops/migrations/v1.0.0/lift-tracking-manifest.js";
import { migrateExceptions } from "./ops/migrations/v1.0.0/migrate-exceptions.js";
import { backfillChartTokens } from "./ops/migrations/v1.7.0/backfill-chart-tokens.js";

/**
 * All known pack migration sets, keyed by release version.
 * The upgrade command chains these in version order between the consumer's
 * pinned packVersion and the target version.
 */
export const MIGRATION_REGISTRY: MigrationVersion[] = [
	{ version: "v0.8.0", ops: [manageForceState, retireStates] },
	// `rewriteDsImports` was removed from this set as part of the ADR-0009
	// addendum (alias-agnostic enforcement, PRD #340 / #346). It rewrote every
	// `@/design-system/*` import to `@ds/*` for zero runtime change — tsconfig
	// maps both to the same files — while silently blinding the alias-keyed
	// CLASS-001 hook that only watched the `@/design-system/*` form. With both
	// spellings now accepted there is no canonical form to normalize toward.
	{
		version: "v0.9.0",
		ops: [
			metaKindHardMigration,
			dsFolderAlias,
			manageManifestMigration,
			widenTokensMigration,
			managePortalScope,
			rewritePortalStyles,
		],
	},
	{ version: "v1.0.0", ops: [migrateExceptions, liftTrackingManifest] },
	{ version: "v1.7.0", ops: [backfillChartTokens] },
];
