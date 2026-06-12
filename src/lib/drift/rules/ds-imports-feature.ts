import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import { type FixerDecisionPoint, findingKey } from "../decisions.js";
import { extractUntilStatement } from "../extract.js";
import type { DriftFinding, DriftRule, DriftRuleInput, FixResult } from "../rule.js";

/** DRIFT-DS-IMPORTS-FEATURE: DS file whose classifier verdict is feature. */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, classifierVerdict } = input;
	if (locationTier === null) return null;
	if (classifierVerdict.tier !== "feature") return null;
	return {
		ruleId: "DRIFT-DS-IMPORTS-FEATURE",
		file,
		message: `design-system file imports from domain root (${classifierVerdict.signals.join("; ")})`,
	};
}

interface DomainImport {
	symbols: string[];
	importPath: string;
	fullLine: string;
}

const IMPORT_STMT_RE = /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?\s*$/gm;

function parseDomainImports(source: string, domainRoots: string[]): DomainImport[] {
	const results: DomainImport[] = [];
	for (const m of source.matchAll(IMPORT_STMT_RE)) {
		const importPath = m[2];
		const isDomain = domainRoots.some((root) => {
			const re = new RegExp(`(?:^|/)${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
			return re.test(importPath);
		});
		if (!isDomain) continue;
		const symbols = m[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		results.push({ symbols, importPath, fullLine: m[0] });
	}
	return results;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx"];

async function resolveImportFile(
	importPath: string,
	fromFileRel: string,
	cwd: string,
): Promise<string | null> {
	let candidate: string;
	if (importPath.startsWith("@/")) {
		candidate = join(cwd, importPath.slice(2));
	} else {
		const fromDir = dirname(join(cwd, fromFileRel));
		candidate = resolve(fromDir, importPath);
	}

	for (const ext of RESOLVE_EXTS) {
		try {
			const s = await stat(candidate + ext);
			if (s.isFile()) return candidate + ext;
		} catch {
			/* not found */
		}
	}
	try {
		const s = await stat(candidate);
		if (s.isFile()) return candidate;
	} catch {
		/* not found */
	}
	for (const ext of RESOLVE_EXTS) {
		try {
			const s = await stat(join(candidate, `index${ext}`));
			if (s.isFile()) return join(candidate, `index${ext}`);
		} catch {
			/* not found */
		}
	}
	return null;
}

function sourceHasDomainDeps(source: string, domainRoots: string[]): boolean {
	for (const root of domainRoots) {
		const re = new RegExp(`from\\s+["'][^"']*/${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
		if (re.test(source)) return true;
	}
	return false;
}

interface SymbolInfo {
	definition: string;
	isFunction: boolean;
	paramCount: number;
	isConstant: boolean;
}

function buildExportFuncRe(name: string): RegExp {
	return new RegExp(
		`export\\s+function\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::\\s*[^{]+)?\\s*\\{`,
		"s",
	);
}

function buildExportArrowRe(name: string): RegExp {
	return new RegExp(
		`export\\s+const\\s+${name}\\s*(?::\\s*[^=]+)?\\s*=\\s*\\(([^)]*)\\)\\s*(?::\\s*[^=]+)?\\s*=>`,
		"s",
	);
}

function buildExportConstRe(name: string): RegExp {
	return new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*[^=]+)?\\s*=\\s*`);
}

function extractFunctionBody(source: string, start: number): string {
	let depth = 0;
	let inBody = false;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "{") {
			depth++;
			inBody = true;
		}
		if (source[i] === "}") {
			depth--;
			if (inBody && depth === 0) return source.slice(start, i + 1);
		}
	}
	return source.slice(start);
}

function extractSymbolInfo(source: string, symbolName: string): SymbolInfo | null {
	const funcMatch = buildExportFuncRe(symbolName).exec(source);
	if (funcMatch) {
		const params = funcMatch[1].trim();
		const paramCount = params === "" ? 0 : params.split(",").length;
		const defStart = funcMatch.index;
		const definition = extractFunctionBody(source, defStart);
		return { definition, isFunction: true, paramCount, isConstant: false };
	}

	const arrowMatch = buildExportArrowRe(symbolName).exec(source);
	if (arrowMatch) {
		const params = arrowMatch[1].trim();
		const paramCount = params === "" ? 0 : params.split(",").length;
		const defStart = arrowMatch.index;
		const definition = extractUntilStatement(source, defStart);
		return { definition, isFunction: true, paramCount, isConstant: false };
	}

	const constMatch = buildExportConstRe(symbolName).exec(source);
	if (constMatch) {
		const defStart = constMatch.index;
		const definition = extractUntilStatement(source, defStart);
		const isFunc = /=>\s*/.test(definition) || /function\s*\(/.test(definition);
		return { definition, isFunction: isFunc, paramCount: 0, isConstant: !isFunc };
	}

	return null;
}

function resolveToCanonical(importPath: string, fromFileRel: string): string {
	if (importPath.startsWith("@/")) return importPath.slice(2);
	const parts = dirname(fromFileRel).replace(/\\/g, "/").split("/");
	for (const seg of importPath.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

async function collectProjectImportRewriteChanges(
	cwd: string,
	oldImportPath: string,
	newImportPath: string,
): Promise<Change[]> {
	const changes: Change[] = [];
	// Resolve the target file so we can skip it (prevents circular self-imports)
	const targetRelPath = newImportPath.replace(/^@\//, "");

	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = join(dir, entry);
			let s: Stats;
			try {
				s = await stat(full);
			} catch {
				continue;
			}
			if (s.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!s.isFile()) continue;
			if (
				!(
					entry.endsWith(".ts") ||
					entry.endsWith(".tsx") ||
					entry.endsWith(".js") ||
					entry.endsWith(".jsx")
				)
			)
				continue;
			const relPath = full.slice(cwd.length + 1);
			const relPathNoExt = relPath.replace(/\.\w+$/, "");
			if (relPathNoExt === targetRelPath) continue;
			let content: string;
			try {
				content = await readFile(full, "utf8");
			} catch {
				continue;
			}
			if (content.includes(oldImportPath)) {
				const updated = content.split(oldImportPath).join(newImportPath);
				changes.push({
					kind: "write",
					path: relPath,
					before: Buffer.from(content),
					after: Buffer.from(updated),
				});
			}
		}
	}
	await walk(cwd);
	return changes;
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
	const absPath = join(ctx.cwd, finding.file);
	let source: string;
	try {
		source = await readFile(absPath, "utf8");
	} catch {
		return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
	}

	const { domainRoots } = ctx.auditConfig;
	const domainImports = parseDomainImports(source, domainRoots);
	if (domainImports.length === 0) {
		return {
			finding,
			fixed: false,
			message: `no domain imports found in ${finding.file}`,
			changes: [],
		};
	}

	// Per-finding decisions answered by the command-level pre-pass (PRD #266
	// Phase C step 2). Missing entry → "defer".
	const choices = ctx.decisions.fixerChoices?.[findingKey(finding)] ?? {};

	let anyFixed = false;
	let currentSource = source;
	const changes: Change[] = [];

	for (const imp of domainImports) {
		const resolvedFile = await resolveImportFile(imp.importPath, finding.file, ctx.cwd);
		let sourceFileContent: string | null = null;
		if (resolvedFile) {
			try {
				sourceFileContent = await readFile(resolvedFile, "utf8");
			} catch {
				/* */
			}
		}

		const hasDomainDeps = sourceFileContent
			? sourceHasDomainDeps(sourceFileContent, domainRoots)
			: false;

		for (const symbolName of imp.symbols) {
			const symbolInfo = sourceFileContent
				? extractSymbolInfo(sourceFileContent, symbolName)
				: null;

			const canExtract = !hasDomainDeps;
			const canConvertToProp =
				symbolInfo !== null &&
				(symbolInfo.isConstant || (symbolInfo.isFunction && symbolInfo.paramCount <= 2));

			let selectedOption: string;
			if (canExtract) {
				selectedOption = `Extract "${symbolName}" to design-system/utils/`;
			} else if (canConvertToProp) {
				const answer = choices[`convert:${imp.importPath}:${symbolName}`] ?? "defer";
				if (answer === "defer") continue;
				selectedOption = `Convert "${symbolName}" to prop injection`;
			} else {
				continue;
			}

			if (selectedOption.startsWith("Extract")) {
				const canonical = resolveToCanonical(imp.importPath, finding.file);
				const utilsFileName = basename(canonical);
				const utilsRelPath = `design-system/utils/${utilsFileName}.ts`;

				const definition =
					symbolInfo?.definition ?? `export { ${symbolName} } from "${imp.importPath}";\n`;
				changes.push({
					kind: "write",
					path: utilsRelPath,
					before: null,
					after: Buffer.from(`${definition.trimEnd()}\n`),
				});

				const newPath = `@/design-system/utils/${utilsFileName}`;

				const importLineRe = new RegExp(
					`import\\s+\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s+from\\s+["']` +
						imp.importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
						`["']\\s*;?`,
				);
				currentSource = currentSource.replace(
					importLineRe,
					`import { ${symbolName} } from "${newPath}";`,
				);

				const aliasOldPath = `@/${canonical}`;
				const importChanges = await collectProjectImportRewriteChanges(
					ctx.cwd,
					imp.importPath,
					newPath,
				);
				changes.push(...importChanges);
				if (aliasOldPath !== imp.importPath) {
					const aliasChanges = await collectProjectImportRewriteChanges(
						ctx.cwd,
						aliasOldPath,
						newPath,
					);
					changes.push(...aliasChanges);
				}
				anyFixed = true;
			} else if (selectedOption.startsWith("Convert")) {
				const importLineRe = new RegExp(
					`import\\s+\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s+from\\s+["']` +
						imp.importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
						`["']\\s*;?\\s*\\n?`,
				);
				currentSource = currentSource.replace(importLineRe, "");

				const funcRe =
					/export\s+(?:default\s+)?function\s+\w+\s*\(\s*\{([^}]*)\}\s*(?::\s*\{([^}]*)\})?\s*\)/;
				const funcMatch = funcRe.exec(currentSource);
				if (funcMatch) {
					const existingProps = funcMatch[1].trim();
					const existingTypes = funcMatch[2]?.trim();
					const newProps = existingProps ? `${existingProps}, ${symbolName}` : symbolName;
					let replacement: string;
					if (existingTypes !== undefined) {
						const typeSuffix = symbolInfo?.isFunction
							? `${symbolName}: (...args: unknown[]) => unknown`
							: `${symbolName}: unknown`;
						const newTypes = existingTypes ? `${existingTypes}; ${typeSuffix}` : typeSuffix;
						replacement = funcMatch[0]
							.replace(`{${funcMatch[1]}}`, `{${newProps}}`)
							.replace(`{${funcMatch[2]}}`, `{${newTypes}}`);
					} else {
						replacement = funcMatch[0].replace(`{${funcMatch[1]}}`, `{${newProps}}`);
					}
					currentSource = currentSource.replace(funcMatch[0], replacement);
				} else {
					const simpleFuncRe = /export\s+(?:default\s+)?function\s+\w+\s*\(\s*\)/;
					const simpleMatch = simpleFuncRe.exec(currentSource);
					if (simpleMatch) {
						currentSource = currentSource.replace(
							simpleMatch[0],
							simpleMatch[0].replace("()", `({ ${symbolName} })`),
						);
					}
				}

				anyFixed = true;
			}
		}
	}

	if (!anyFixed) {
		return {
			finding,
			fixed: false,
			message: `deferred domain import fixes for ${finding.file}`,
			changes: [],
		};
	}

	changes.push({
		kind: "write",
		path: finding.file,
		before: Buffer.from(source),
		after: Buffer.from(currentSource),
	});

	return { finding, fixed: true, message: `resolved domain imports in ${finding.file}`, changes };
}

/**
 * Pure enumerator of per-(import, symbol) convert/defer questions the fixer
 * could ask. Walks `source` for domain imports against `ctx.auditConfig.
 * domainRoots` and emits one decision point per (importPath, symbol) — an
 * over-approximation (the live fixer skips imports whose source-file probe
 * succeeds and shows extract is safe), kept conservative so a future
 * pre-pass can ask everything that might be needed without doing I/O here.
 *
 * Reads no filesystem and no prompt (PRD #266 Phase C step 1).
 */
function describeDecisions(
	_finding: DriftFinding,
	source: string,
	{ ctx }: { ctx: ProjectContext },
): FixerDecisionPoint[] {
	const points: FixerDecisionPoint[] = [];
	const { domainRoots } = ctx.auditConfig;
	const domainImports = parseDomainImports(source, domainRoots);
	for (const imp of domainImports) {
		for (const symbolName of imp.symbols) {
			points.push({
				key: `convert:${imp.importPath}:${symbolName}`,
				question:
					`"${symbolName}" comes from a domain module that can't be moved to design-system` +
					` (it has its own domain dependencies). What should we do?`,
				options: [
					{
						label: `Convert "${symbolName}" to prop injection`,
						description: "Pass this value as a prop instead of importing it",
					},
					{
						label: "Defer (add exception)",
						description: "Skip for now and add an exception entry",
					},
				],
			});
		}
	}
	return points;
}

export const dsImportsFeatureRule: DriftRule = {
	id: "DRIFT-DS-IMPORTS-FEATURE",
	severity: "error",
	description:
		"Design-system file imports from a domain root (features/, lib/, or configured domain root) — domain code must not pollute the DS",
	detect,
	fixable: true,
	fix,
	priority: 2,
	interactive: true,
	describeDecisions,
};
