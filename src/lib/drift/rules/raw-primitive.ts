import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import { attributedEnumVariants } from "../cva.js";
import type { DriftFinding, DriftRule, DriftRuleInput, FixResult } from "../rule.js";

/**
 * Stable marker embedded in a DRIFT-RAW-PRIMITIVE remediation message when the
 * fixer hit an inline component it can't replace and is deferring the structural
 * decision to `classify` (ADR-0015). Both the fixer that emits the finding and
 * the breadcrumb logic that routes on it reference this single constant so the
 * two never drift apart.
 */
export const EXTRACTION_NEEDED_MARKER = "needs extraction";

/** True when a finding is a DRIFT-RAW-PRIMITIVE that `audit` deferred to `classify`. */
export function isExtractionNeededFinding(f: { ruleId: string; message: string }): boolean {
	return f.ruleId === "DRIFT-RAW-PRIMITIVE" && f.message.includes(EXTRACTION_NEEDED_MARKER);
}

/**
 * Match raw HTML primitives (<button, <input) in JSX.
 * Case-sensitive — PascalCase variants (<Button, <Input) are component refs, not raw HTML.
 * Captures the element name for counting.
 */
const RAW_PRIMITIVE_RE = /<(button|input)[\s>/]/g;

const NAMED_COMPONENT_START_RE = /^function\s+([A-Z][A-Za-z0-9]+)\s*\(/gm;

export interface InternalComponent {
	name: string;
	startIndex: number;
	endIndex: number;
	body: string;
}

function extractFullFunction(source: string, start: number): string {
	let parenDepth = 0;
	let braceDepth = 0;
	let foundOpenParen = false;
	let pastParams = false;
	let foundBodyOpen = false;
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (!pastParams) {
			if (c === "(") {
				parenDepth++;
				foundOpenParen = true;
			}
			if (c === ")" && foundOpenParen) {
				parenDepth--;
				if (parenDepth === 0) pastParams = true;
			}
			continue;
		}
		if (c === "{") {
			braceDepth++;
			foundBodyOpen = true;
		}
		if (c === "}") {
			braceDepth--;
			if (foundBodyOpen && braceDepth === 0) return source.slice(start, i + 1);
		}
	}
	return source.slice(start);
}

/**
 * Find non-exported, ≥20-line `function PascalCase(...)` declarations — the
 * inline components that `audit` can't replace in place and must defer to
 * `classify` for extraction (ADR-0015). Lives on the rule layer so both the
 * DRIFT-RAW-PRIMITIVE detector and the fixer route on one definition.
 */
export function findInternalComponents(source: string): InternalComponent[] {
	const components: InternalComponent[] = [];
	NAMED_COMPONENT_START_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = NAMED_COMPONENT_START_RE.exec(source)) !== null) {
		const lineStart = source.lastIndexOf("\n", m.index) + 1;
		const beforeOnLine = source.slice(lineStart, m.index);
		if (/export\s+/.test(beforeOnLine)) continue;

		const funcBody = extractFullFunction(source, m.index);
		const lineCount = funcBody.split("\n").length;
		if (lineCount < 20) continue;

		components.push({
			name: m[1],
			startIndex: m.index,
			endIndex: m.index + funcBody.length,
			body: funcBody,
		});
	}
	return components;
}

/** DRIFT-RAW-PRIMITIVE: composite/pattern using raw HTML primitive instead of atom. */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, source } = input;
	if (locationTier === null) return null;
	if (locationTier === "atom") return null;
	if (source === undefined) return null;

	const counts = new Map<string, number>();
	let m: RegExpExecArray | null;
	RAW_PRIMITIVE_RE.lastIndex = 0;
	while ((m = RAW_PRIMITIVE_RE.exec(source)) !== null) {
		const el = m[1];
		counts.set(el, (counts.get(el) ?? 0) + 1);
	}
	if (counts.size === 0) return null;

	const parts = [...counts.entries()].map(([el, n]) => `${n} <${el}>`);
	const plural = counts.size > 1 || [...counts.values()][0] > 1;

	// If the file defines an inline component, audit can't replace the primitive
	// in place — extraction is a structural decision owned by `classify` (ADR-0015).
	// Stamp the marker at detection time so it survives post-fix re-validation and
	// the breadcrumb routes to `classify`, not `audit --fix` (issue #207). The fixer
	// defers on the same `findInternalComponents` condition, keeping the two in sync.
	if (findInternalComponents(source).length > 0) {
		return {
			ruleId: "DRIFT-RAW-PRIMITIVE",
			file,
			message: `raw HTML primitive${plural ? "s" : ""}: ${parts.join(", ")} — ${EXTRACTION_NEEDED_MARKER}, run \`claude-ds classify\` to extract the inline component into design-system/atoms/`,
		};
	}

	return {
		ruleId: "DRIFT-RAW-PRIMITIVE",
		file,
		message: `raw HTML primitive${plural ? "s" : ""}: ${parts.join(", ")} — use design-system atoms instead`,
	};
}

// --- DRIFT-RAW-PRIMITIVE fixer ---

const RAW_PRIMITIVE_RE_FIXER = /<(button|input)([\s>])/g;

const ELEMENT_TO_ATOM: Record<string, string> = {
	button: "button",
	input: "input",
};

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

interface RawElementMatch {
	element: string;
	fullMatch: string;
	index: number;
}

function findRawElements(source: string): RawElementMatch[] {
	const matches: RawElementMatch[] = [];
	RAW_PRIMITIVE_RE_FIXER.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = RAW_PRIMITIVE_RE_FIXER.exec(source)) !== null) {
		matches.push({ element: m[1], fullMatch: m[0], index: m.index });
	}
	return matches;
}

async function atomFileExists(cwd: string, atomName: string): Promise<string | null> {
	const candidates = [`design-system/atoms/${atomName}.tsx`, `design-system/atoms/${atomName}.ts`];
	for (const c of candidates) {
		try {
			const s = await stat(join(cwd, c));
			if (s.isFile()) return c;
		} catch {
			/* not found */
		}
	}
	return null;
}

export function buildVariantOptions(cvaVariants: Record<string, string[]>): string[] {
	const axes = Object.entries(cvaVariants);
	if (axes.length === 0) return ["Use default"];

	const options: string[] = [];
	for (const [axis, values] of axes) {
		for (const v of values) {
			options.push(`${axis}="${v}"`);
		}
	}
	return options;
}

interface InstanceRewrite {
	element: string;
	atomComponent: string;
	variantProp: string | null;
	index: number;
}

function rewriteRawElement(
	source: string,
	element: string,
	atomComponent: string,
	variantProp: string | null,
): string {
	const openTagRe = new RegExp(`<${element}(\\s[^>]*)?>`, "g");
	const closeTagRe = new RegExp(`</${element}>`, "g");

	let result = source;

	result = result.replace(openTagRe, (_match, attrs: string | undefined) => {
		let cleanAttrs = (attrs ?? "").trim();
		cleanAttrs = cleanAttrs
			.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "")
			.trim();

		const parts = [`<${atomComponent}`];
		if (variantProp) parts.push(` ${variantProp}`);
		if (cleanAttrs) parts.push(` ${cleanAttrs}`);
		return `${parts.join("")}>`;
	});

	result = result.replace(closeTagRe, `</${atomComponent}>`);

	const selfCloseRe = new RegExp(`<${element}(\\s[^>]*)\\s*/>`, "g");
	result = result.replace(selfCloseRe, (_match, attrs: string) => {
		let cleanAttrs = attrs.trim();
		cleanAttrs = cleanAttrs
			.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "")
			.trim();

		const parts = [`<${atomComponent}`];
		if (variantProp) parts.push(` ${variantProp}`);
		if (cleanAttrs) parts.push(` ${cleanAttrs}`);
		return `${parts.join("")} />`;
	});

	return result;
}

function rewriteInstances(source: string, rewrites: InstanceRewrite[]): string {
	const sorted = [...rewrites].sort((a, b) => b.index - a.index);
	let result = source;

	for (const { element, atomComponent, variantProp, index } of sorted) {
		const selfCloseRe = new RegExp(`<${element}(\\s[^>]*)\\s*/>`);
		const openTagRe = new RegExp(`<${element}(\\s[^>]*)?>`);

		const after = result.slice(index);

		const selfMatch = after.match(selfCloseRe);
		if (selfMatch && selfMatch.index === 0) {
			let cleanAttrs = (selfMatch[1] ?? "").trim();
			cleanAttrs = cleanAttrs
				.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "")
				.trim();
			const parts = [`<${atomComponent}`];
			if (variantProp) parts.push(` ${variantProp}`);
			if (cleanAttrs) parts.push(` ${cleanAttrs}`);
			result = `${result.slice(0, index) + parts.join("")} />${result.slice(index + selfMatch[0].length)}`;
			continue;
		}

		const openMatch = after.match(openTagRe);
		if (openMatch && openMatch.index === 0) {
			let cleanAttrs = (openMatch[1] ?? "").trim();
			cleanAttrs = cleanAttrs
				.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "")
				.trim();
			const parts = [`<${atomComponent}`];
			if (variantProp) parts.push(` ${variantProp}`);
			if (cleanAttrs) parts.push(` ${cleanAttrs}`);
			let replaced = `${result.slice(0, index) + parts.join("")}>${result.slice(index + openMatch[0].length)}`;

			const closeRe = new RegExp(`</${element}>`);
			const closeMatch = replaced.slice(index).match(closeRe);
			if (closeMatch && closeMatch.index != null) {
				const closeStart = index + closeMatch.index;
				replaced =
					replaced.slice(0, closeStart) +
					`</${atomComponent}>` +
					replaced.slice(closeStart + closeMatch[0].length);
			}
			result = replaced;
		}
	}

	return result;
}

function addImportIfMissing(source: string, componentName: string, importPath: string): string {
	// Check if already imported from ANY path (prevents duplicates across alias variants)
	const anyImportRe = new RegExp(
		`import\\s+\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s+from\\s+["']`,
	);
	if (anyImportRe.test(source)) return source;

	const importLine = `import { ${componentName} } from "${importPath}";\n`;
	const firstImportMatch = source.match(/^import\s/m);
	if (firstImportMatch && firstImportMatch.index !== undefined) {
		return (
			source.slice(0, firstImportMatch.index) + importLine + source.slice(firstImportMatch.index)
		);
	}
	return importLine + source;
}

export function toKebab(pascal: string): string {
	return pascal
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

function inferVariantForInstance(
	openTag: string,
	cvaVariants: Record<string, string[]>,
): string | null {
	const allValues = Object.entries(cvaVariants).flatMap(([axis, values]) =>
		values.map((v) => ({ axis, value: v })),
	);

	const classMatch = openTag.match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/);
	const classText = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").toLowerCase();
	if (!classText) return "default";

	// Match variant values only as standalone classes (word-bounded by whitespace),
	// not as suffixes of Tailwind utilities like "text-sm" or "bg-secondary"
	const classes = classText.split(/\s+/);
	const matchedVariants = allValues.filter(({ value }) => {
		const v = value.toLowerCase();
		return classes.some((cls) => cls === v);
	});

	if (matchedVariants.length === 0) return "default";
	if (matchedVariants.length === 1) {
		const { axis, value } = matchedVariants[0];
		return `${axis}="${value}"`;
	}
	return null;
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
	const absPath = join(ctx.cwd, finding.file);
	let source: string;
	try {
		source = await readFile(absPath, "utf8");
	} catch {
		return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
	}

	let currentSource = source;
	let anyFixed = false;
	const changes: Change[] = [];
	const canonicalAlias =
		ctx.auditConfig.dsAliases.find((a) => a !== "@/design-system") ?? "@/design-system";

	// Extracting an inline component into its own atom is a structural decision
	// (does it deserve to be a reusable atom? what's its prop surface?) owned by
	// `classify`, not `audit` (ADR-0015). audit is surgical: it edits in place and
	// never creates files. So when a tier file defines an inline component, audit
	// can't replace it via Path A and defers — it emits an unfixed finding whose
	// message carries EXTRACTION_NEEDED_MARKER, which audit's breadcrumb routes on
	// to point the consumer at `claude-ds classify`. We check this first so audit
	// never half-fixes a file whose real blocker is an un-extracted component.
	const internalComponents = findInternalComponents(currentSource);
	if (internalComponents.length > 0) {
		const names = internalComponents.map((c) => c.name).join(", ");
		const it = internalComponents.length > 1 ? "them" : "it";
		return {
			finding,
			fixed: false,
			message: `${names} in ${finding.file} ${EXTRACTION_NEEDED_MARKER} — run \`claude-ds classify\` to extract ${it} into design-system/atoms/`,
			changes: [],
		};
	}

	// Path A: replace raw primitives with existing atoms (per-instance inference)
	const rawElements = findRawElements(currentSource);
	const uniqueElements = [...new Set(rawElements.map((m) => m.element))];

	const skippedElements: string[] = [];

	for (const element of uniqueElements) {
		const atomFileName = ELEMENT_TO_ATOM[element];
		if (!atomFileName) {
			skippedElements.push(element);
			continue;
		}

		const atomPath = await atomFileExists(ctx.cwd, atomFileName);
		if (!atomPath) {
			skippedElements.push(element);
			continue;
		}

		const atomComponent = capitalize(element);
		let atomSource: string;
		try {
			atomSource = await readFile(join(ctx.cwd, atomPath), "utf8");
		} catch {
			continue;
		}

		// Enum axes attributed to the atom's exported component (analyzer-backed,
		// #554): a sub-element cva()'s axes never leak in, so the fixer never
		// infers a variant prop the atom doesn't accept.
		const cvaVariants = attributedEnumVariants(atomSource, atomPath);

		if (!cvaVariants) {
			// No variants — auto-replace all instances
			currentSource = rewriteRawElement(currentSource, element, atomComponent, null);
			currentSource = addImportIfMissing(
				currentSource,
				atomComponent,
				`${canonicalAlias}/atoms/${atomFileName}`,
			);
			anyFixed = true;
			continue;
		}

		// Per-instance: infer variant from each element's own className
		const instances = findRawElements(currentSource);
		const elementInstances = instances.filter((m) => m.element === element);

		const autoRewrites: InstanceRewrite[] = [];
		const ambiguousInstances: RawElementMatch[] = [];

		for (const inst of elementInstances) {
			const openTagMatch = currentSource
				.slice(inst.index)
				.match(new RegExp(`<${element}(\\s[^>]*)?\\/?>`));
			const openTag = openTagMatch ? openTagMatch[0] : "";
			const inferred = inferVariantForInstance(openTag, cvaVariants);

			if (inferred === "default") {
				autoRewrites.push({ element, atomComponent, variantProp: null, index: inst.index });
			} else if (inferred) {
				autoRewrites.push({ element, atomComponent, variantProp: inferred, index: inst.index });
			} else {
				ambiguousInstances.push(inst);
			}
		}

		// Auto-apply unambiguous instances
		if (autoRewrites.length > 0) {
			currentSource = rewriteInstances(currentSource, autoRewrites);
			currentSource = addImportIfMissing(
				currentSource,
				atomComponent,
				`${canonicalAlias}/atoms/${atomFileName}`,
			);
			anyFixed = true;
		}

		// Ambiguous instances: safe default is base atom with no variant prop
		if (ambiguousInstances.length > 0) {
			const remaining = findRawElements(currentSource).filter((m) => m.element === element);
			const remainingRewrites: InstanceRewrite[] = remaining.map((inst) => ({
				element,
				atomComponent,
				variantProp: null,
				index: inst.index,
			}));

			if (remainingRewrites.length > 0) {
				currentSource = rewriteInstances(currentSource, remainingRewrites);
				currentSource = addImportIfMissing(
					currentSource,
					atomComponent,
					`${canonicalAlias}/atoms/${atomFileName}`,
				);
				anyFixed = true;
			}
		}
	}

	if (!anyFixed) {
		if (skippedElements.length > 0) {
			const tags = skippedElements.map((e) => `<${e}>`).join(", ");
			return {
				finding,
				fixed: false,
				message: `no base atom mapping for ${tags} — create the atom in design-system/atoms/ first`,
				changes: [],
			};
		}
		return {
			finding,
			fixed: false,
			message: `no fixable raw primitives in ${finding.file}`,
			changes: [],
		};
	}

	changes.push({
		kind: "write",
		path: finding.file,
		before: Buffer.from(source),
		after: Buffer.from(currentSource),
	});
	return { finding, fixed: true, message: `replaced raw primitives in ${finding.file}`, changes };
}

export const rawPrimitiveRule: DriftRule = {
	id: "DRIFT-RAW-PRIMITIVE",
	severity: "error",
	description: "File renders a raw HTML primitive instead of its design-system atom equivalent",
	detect,
	fixable: true,
	fix,
	priority: 0,
	interactive: false,
};
