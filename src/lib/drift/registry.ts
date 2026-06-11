import type { DriftRule, DriftRuleId } from "./rule.js";

import { cvaVariantUnrenderedRule } from "./rules/cva-variant-unrendered.js";
import { dsImportsFeatureRule } from "./rules/ds-imports-feature.js";
import { inlineStaticStyleRule } from "./rules/inline-static-style.js";
import { metaExamplesCorruptRule } from "./rules/meta-examples-corrupt.js";
import { metaExamplesDuplicateRule } from "./rules/meta-examples-duplicate.js";
import { metaExamplesInvalidPropRule } from "./rules/meta-examples-invalid-prop.js";
import { metaKindMissingRule } from "./rules/meta-kind-missing.js";
import { misclassifiedAtomRule } from "./rules/misclassified-atom.js";
import { misclassifiedCompositeRule } from "./rules/misclassified-composite.js";
import { misplacedRule } from "./rules/misplaced.js";
import { patternImportsPatternRule } from "./rules/pattern-imports-pattern.js";
import { patternNoSlotsRule } from "./rules/pattern-no-slots.js";
import { rawPrimitiveRule } from "./rules/raw-primitive.js";
import { roleNoContractRule } from "./rules/role-no-contract.js";
import { smartPartNoRoleRule } from "./rules/smart-part-no-role.js";
import { staleMetaStatesRule } from "./rules/stale-meta-states.js";
import { tokenParityRule } from "./rules/token-parity.js";

/**
 * The drift-rule registry indexed by id. Declared as `Record<DriftRuleId, DriftRule>`
 * so the compiler enforces totality — adding a new id to the `DriftRuleId` union
 * without adding the matching rule here fails to build. This is the seam that
 * prevents a silently-unfixable rule from shipping.
 */
export const DRIFT_RULES_BY_ID: Record<DriftRuleId, DriftRule> = {
	"DRIFT-META-KIND-MISSING": metaKindMissingRule,
	"DRIFT-SMART-PART-NO-ROLE": smartPartNoRoleRule,
	"DRIFT-ROLE-NO-CONTRACT": roleNoContractRule,
	"DRIFT-MISPLACED": misplacedRule,
	"DRIFT-MISCLASSIFIED-ATOM": misclassifiedAtomRule,
	"DRIFT-MISCLASSIFIED-COMPOSITE": misclassifiedCompositeRule,
	"DRIFT-DS-IMPORTS-FEATURE": dsImportsFeatureRule,
	"DRIFT-PATTERN-NO-SLOTS": patternNoSlotsRule,
	"DRIFT-PATTERN-IMPORTS-PATTERN": patternImportsPatternRule,
	"DRIFT-INLINE-STATIC-STYLE": inlineStaticStyleRule,
	"DRIFT-RAW-PRIMITIVE": rawPrimitiveRule,
	"DRIFT-CVA-VARIANT-UNRENDERED": cvaVariantUnrenderedRule,
	"DRIFT-META-EXAMPLES-DUPLICATE": metaExamplesDuplicateRule,
	"DRIFT-META-EXAMPLES-CORRUPT": metaExamplesCorruptRule,
	"DRIFT-META-EXAMPLES-INVALID-PROP": metaExamplesInvalidPropRule,
	"DRIFT-STALE-META-STATES": staleMetaStatesRule,
	"DRIFT-TOKEN-PARITY": tokenParityRule,
};

/**
 * The drift-rule registry as an ordered array. Order is the canonical
 * evaluation order — `evaluateDrift` runs each rule's `detect` in this
 * sequence and pushes non-null findings, so `audit`'s grouped display
 * (Map insertion order) is determined here. `allRuleIds()` derives from
 * the same array so the two orderings can't diverge.
 *
 * Derived from `DRIFT_RULES_BY_ID` so the typed record's totality check
 * propagates here — a new id added to the union without an entry in the
 * record fails to build, and the array can't silently miss it.
 *
 * Canonical order (the record's literal order):
 * META-KIND-MISSING, MISPLACED, MISCLASSIFIED-ATOM, MISCLASSIFIED-COMPOSITE,
 * DS-IMPORTS-FEATURE, PATTERN-NO-SLOTS, PATTERN-IMPORTS-PATTERN,
 * INLINE-STATIC-STYLE, RAW-PRIMITIVE, CVA-VARIANT-UNRENDERED,
 * META-EXAMPLES-DUPLICATE, META-EXAMPLES-CORRUPT, STALE-META-STATES.
 */
export const DRIFT_RULES: readonly DriftRule[] = Object.values(DRIFT_RULES_BY_ID);
