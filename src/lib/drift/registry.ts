import type { DriftRule, DriftRuleId } from "./rule.js";

import { cvaVariantUnrenderedRule } from "./rules/cva-variant-unrendered.js";
import { dsImportsFeatureRule } from "./rules/ds-imports-feature.js";
import { inlineStaticStyleRule } from "./rules/inline-static-style.js";
import { metaExamplesCorruptRule } from "./rules/meta-examples-corrupt.js";
import { metaExamplesDuplicateRule } from "./rules/meta-examples-duplicate.js";
import { metaKindMissingRule } from "./rules/meta-kind-missing.js";
import { misclassifiedAtomRule } from "./rules/misclassified-atom.js";
import { misclassifiedCompositeRule } from "./rules/misclassified-composite.js";
import { misplacedRule } from "./rules/misplaced.js";
import { patternImportsPatternRule } from "./rules/pattern-imports-pattern.js";
import { patternNoSlotsRule } from "./rules/pattern-no-slots.js";
import { rawPrimitiveRule } from "./rules/raw-primitive.js";
import { staleDsImportRule } from "./rules/stale-ds-import.js";
import { staleMetaStatesRule } from "./rules/stale-meta-states.js";

/**
 * The drift-rule registry indexed by id. Declared as `Record<DriftRuleId, DriftRule>`
 * so the compiler enforces totality — adding a new id to the `DriftRuleId` union
 * without adding the matching rule here fails to build. This is the seam that
 * prevents a silently-unfixable rule from shipping.
 */
export const DRIFT_RULES_BY_ID: Record<DriftRuleId, DriftRule> = {
  "DRIFT-META-KIND-MISSING": metaKindMissingRule,
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
  "DRIFT-STALE-DS-IMPORT": staleDsImportRule,
  "DRIFT-STALE-META-STATES": staleMetaStatesRule,
};

/**
 * The drift-rule registry as an ordered array. Order is the canonical
 * evaluation order — `evaluateDrift` runs each rule's `detect` in this
 * sequence and pushes non-null findings, so `audit`'s grouped display
 * (Map insertion order) is determined here. `allRuleIds()` derives from
 * the same array so the two orderings can't diverge.
 *
 * Canonical order:
 * META-KIND-MISSING, MISPLACED, MISCLASSIFIED-ATOM, MISCLASSIFIED-COMPOSITE,
 * DS-IMPORTS-FEATURE, PATTERN-NO-SLOTS, PATTERN-IMPORTS-PATTERN,
 * INLINE-STATIC-STYLE, RAW-PRIMITIVE, CVA-VARIANT-UNRENDERED,
 * META-EXAMPLES-DUPLICATE, META-EXAMPLES-CORRUPT, STALE-DS-IMPORT,
 * STALE-META-STATES.
 */
export const DRIFT_RULES: readonly DriftRule[] = [
  metaKindMissingRule,
  misplacedRule,
  misclassifiedAtomRule,
  misclassifiedCompositeRule,
  dsImportsFeatureRule,
  patternNoSlotsRule,
  patternImportsPatternRule,
  inlineStaticStyleRule,
  rawPrimitiveRule,
  cvaVariantUnrenderedRule,
  metaExamplesDuplicateRule,
  metaExamplesCorruptRule,
  staleDsImportRule,
  staleMetaStatesRule,
];
