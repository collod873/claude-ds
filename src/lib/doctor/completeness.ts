import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../config.js";
import {
	type Exception,
	type ExceptionLint,
	type IssueChecker,
	lintExceptions,
	parseExceptions,
} from "../exceptions.js";
import { detectBuildCommand, printNextStep } from "../log.js";
import { isManifestOrKeepfile, type ManagedRoot, parseManifest } from "../manifest.js";
import {
	allOwnedConcernIds,
	countOwnedConcernFindings,
	type OwnedConcernScannerFinding,
	scanOwnedConcerns,
} from "../owned-concerns/index.js";
import { renderCompleteness } from "../render/completeness.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function walkDir(base: string, rel: string): Promise<string[]> {
	const abs = join(base, rel);
	let entries: Dirent[];
	try {
		entries = await readdir(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const results: string[] = [];
	for (const e of entries) {
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) results.push(...(await walkDir(base, childRel)));
		else results.push(childRel);
	}
	return results;
}

const COMPLETENESS_FALLBACK_ROOTS: ManagedRoot[] = [
	{ root: ".claude/skills/", strict: true },
	{ root: ".claude/hooks/", strict: true },
	{ root: "design-system/", strict: true },
];

const WORKAROUND_RE = /(?:\/\/|\/\*|\*)\s*(?:WORKAROUND|HACK|FIXME)\b/i;
const SHELL_WORKAROUND_RE = /^\s*#\s+(?:WORKAROUND|HACK|FIXME)\b/i;
const ISSUE_REF_RE = /#\d+|https?:\/\/github\.com\/\S+\/issues\/\d+/;
const SCANNABLE_EXTS = new Set([".ts", ".tsx", ".css", ".md", ".sh"]);

interface CompletenessWorkaround {
	file: string;
	line: number;
	text: string;
}

function stripTrailingSlash(p: string): string {
	return p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Returns the configured managed roots, or the fallback list if none are declared. */
function resolveRoots(managedRoots: ManagedRoot[]): ManagedRoot[] {
	return managedRoots.length > 0 ? managedRoots : COMPLETENESS_FALLBACK_ROOTS;
}

async function findOrphanFiles(
	cwd: string,
	manifestPaths: Set<string>,
	roots: ManagedRoot[],
	generatedPatterns: string[],
): Promise<string[]> {
	const openPrefixes = roots.filter((r) => !r.strict).map((r) => `${stripTrailingSlash(r.root)}/`);

	let isGenerated: ((path: string) => boolean) | null = null;
	if (generatedPatterns.length > 0) {
		const { default: picomatch } = await import("picomatch");
		isGenerated = picomatch(generatedPatterns, { dot: true });
	}

	// Derive the set of skill subdirectory names the pack actually ships.
	// A file under .claude/skills/<name>/ is only DS-owned if <name> is one of these.
	const packSkillDirs = new Set(
		[...manifestPaths]
			.filter((p) => p.startsWith(".claude/skills/"))
			.map((p) => p.split("/")[2])
			.filter(Boolean),
	);

	const orphans: string[] = [];
	for (const { root, strict } of roots) {
		if (!strict) continue;
		const files = await walkDir(cwd, stripTrailingSlash(root));
		for (const f of files) {
			if (openPrefixes.some((prefix) => f.startsWith(prefix))) continue;
			if (isManifestOrKeepfile(f, manifestPaths)) continue;
			if (isGenerated?.(f)) continue;
			// .claude/skills/ is a shared namespace: only treat files under pack-shipped
			// skill subdirectories as DS-owned. Consumer skill dirs are not orphans (#257).
			if (f.startsWith(".claude/skills/")) {
				const skillDir = f.split("/")[2];
				if (!packSkillDirs.has(skillDir)) continue;
			}
			orphans.push(f);
		}
	}
	return orphans;
}

async function scanWorkaroundComments(
	cwd: string,
	roots: ManagedRoot[],
): Promise<CompletenessWorkaround[]> {
	const seen = new Set<string>();
	const results: CompletenessWorkaround[] = [];

	for (const { root } of roots) {
		const files = await walkDir(cwd, stripTrailingSlash(root));
		for (const f of files) {
			if (seen.has(f)) continue;
			seen.add(f);
			if (!SCANNABLE_EXTS.has(extname(f))) continue;
			let content: string;
			try {
				content = await readFile(join(cwd, f), "utf8");
			} catch {
				continue;
			}
			const re = f.endsWith(".sh") ? SHELL_WORKAROUND_RE : WORKAROUND_RE;
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (re.test(line) && !ISSUE_REF_RE.test(line)) {
					results.push({ file: f, line: i + 1, text: line.trim() });
				}
			}
		}
	}
	return results;
}

function makeGhIssueChecker(): IssueChecker {
	return async (ref: string): Promise<"open" | "closed" | "unknown"> => {
		try {
			const arg = ref.startsWith("#") ? ref.slice(1) : ref;
			const stdout = await new Promise<string>((res, rej) => {
				execFile("gh", ["issue", "view", arg, "--json", "state"], {}, (err, out) => {
					if (err) rej(err);
					else res(out);
				});
			});
			const { state } = JSON.parse(stdout) as { state: string };
			if (state === "OPEN") return "open";
			if (state === "CLOSED") return "closed";
			return "unknown";
		} catch {
			return "unknown";
		}
	};
}

export async function runCompletenessCheck(opts: { pack?: string; cwd?: string }): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	let pack = opts.pack;
	if (!pack) {
		const cfgPath = join(cwd, ".claude-ds.json");
		if (!(await exists(cfgPath))) {
			process.stderr.write("error: --pack required (no .claude-ds.json found)\n");
			process.exit(2);
		}
		const cfg = parseConfig(await readFile(cfgPath, "utf8"));
		pack = cfg.pack;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = resolve(here, "..", "..", "..");
	const packDir = join(repoRoot, "packs", pack);
	const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
	const manifestPaths = new Set(manifest.files.map((f) => f.path));
	const roots = resolveRoots(manifest.managed_roots);

	const orphans = await findOrphanFiles(cwd, manifestPaths, roots, manifest.generated_patterns);

	const exceptionsPath = join(cwd, "design-system/exceptions.json");
	let exceptionWarnings: ExceptionLint[] = [];
	let permanentExceptions: Exception[] = [];
	let exceptions: Exception[] = [];
	if (await exists(exceptionsPath)) {
		try {
			exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
			exceptionWarnings = await lintExceptions(exceptions, makeGhIssueChecker());
			permanentExceptions = exceptions.filter((e) => e.permanent);
		} catch {
			// malformed exceptions.json — audit catches parse errors, not completeness's concern
		}
	}

	const workarounds = await scanWorkaroundComments(cwd, roots);

	// Owned-concern scan (ADR-0017): repo-wide, signature-as-identity. Catches
	// DS infrastructure hand-rolled in unowned dirs (scripts/, src/) that the
	// location-scoped orphan check above is blind to.
	const rawOwnedFindings: OwnedConcernScannerFinding[] = await scanOwnedConcerns({
		cwd,
		manifestPaths,
		generatedPatterns: manifest.generated_patterns,
	});
	// Suppress Owned-concern findings whose (rule, path) matches an exception
	// — same shape audit uses for drift/integrity (#316/#320). `permanent: true`
	// covers detector over-match; an issue-linked entry covers a tracked gap
	// pending upstream removal (ADR-0003).
	const suppressedSet = new Set(exceptions.map((e) => `${e.rule}:${e.path}`));
	const ownedFindings = rawOwnedFindings.filter(
		(f) => !suppressedSet.has(`${f.concernId}:${f.file}`),
	);
	const ownedConcernsChecked = allOwnedConcernIds();
	const ownedCounts = countOwnedConcernFindings(ownedFindings);

	const totalFindings =
		orphans.length + exceptionWarnings.length + workarounds.length + ownedFindings.length;

	// #640 (PRD #635 Module 6): route the output through the shared render layer
	// so doctor speaks the dashboard's plain consumer dialect — no raw markdown
	// headings, the internal taxonomy demoted out of the headlines, concern IDs
	// kept only as parenthetical `exceptions.json` keys, and a findings-pending
	// verdict that says "need your review" rather than "failed".
	const lines = renderCompleteness({
		orphans,
		exceptionWarnings: exceptionWarnings.map((w) => w.warning),
		workarounds,
		ownedFindings,
		permanentExceptions: permanentExceptions.map((e) => ({
			path: e.path,
			rule: e.rule,
			reason: e.reason,
		})),
		ownedConcernsChecked,
		ownedCounts,
	});

	process.stdout.write(`${lines.join("\n")}\n`);

	// #349 F21: every command — including doctor's completeness mode —
	// ends with a → Next breadcrumb. Findings route to the per-finding
	// remediation prose; a clean completeness check routes back to the
	// day-to-day build hint.
	const buildCmd = await detectBuildCommand(cwd);
	printNextStep("doctor", {
		doctorVerdict: totalFindings > 0 ? "completeness-findings" : "clean",
		buildCmd,
	});

	if (totalFindings > 0) process.exit(1);
}
