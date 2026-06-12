/**
 * Formatter detection and invocation for post-sync file formatting.
 * Detects biome (biome.json / biome.jsonc) or prettier (.prettierrc*) in cwd,
 * then invokes the consumer's local formatter binary on rewritten files.
 * If the formatter exits non-zero, warns but does not fail sync.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { info } from "./log.js";

export type DetectedFormatter = "biome" | "prettier" | null;

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	".prettierrc.ts",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
	"prettier.config.ts",
];

async function fileExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect a biome / prettier dependency declared in the consumer's `package.json`
 * (issue #493). A consumer can run biome via `extends`-only config, a non-standard
 * config path, or a `lint`/`format` script without a config file detectFormatter
 * recognises — but the dependency is always declared. Biome wins over prettier
 * when both are present (it is the formatter that owns the showcase territory in
 * the failing Crewops shape). Returns null when package.json is absent/unparseable
 * so a consumer with no formatter still behaves exactly as before.
 */
async function detectFormatterFromPackageJson(cwd: string): Promise<DetectedFormatter> {
	let raw: string;
	try {
		raw = await readFile(join(cwd, "package.json"), "utf8");
	} catch {
		return null;
	}
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(raw);
	} catch {
		return null;
	}
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	if ("@biomejs/biome" in deps) return "biome";
	if ("prettier" in deps) return "prettier";
	return null;
}

export async function detectFormatter(cwd: string): Promise<DetectedFormatter> {
	for (const name of BIOME_CONFIGS) {
		if (await fileExists(join(cwd, name))) return "biome";
	}
	for (const name of PRETTIER_CONFIGS) {
		if (await fileExists(join(cwd, name))) return "prettier";
	}
	// #493: config-file detection misses extends-only / non-standard-path setups.
	// Fall back to the declared dependency so the showcase files claude-ds writes
	// still get run through the consumer's formatter.
	return detectFormatterFromPackageJson(cwd);
}

/**
 * Resolve the formatter binary path.
 * Checks consumer's node_modules/.bin first, then falls back to PATH.
 * Returns null if not found anywhere.
 */
async function resolveFormatterBin(name: string, cwd: string): Promise<string | null> {
	const localBin = join(cwd, "node_modules", ".bin", name);
	if (await fileExists(localBin)) return localBin;
	// Fall back to PATH — useful when formatter is globally installed or in tests
	const which = spawnSync("which", [name], { encoding: "utf8" });
	if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
	return null;
}

/** A detected formatter together with its resolved binary path. */
export interface ResolvedFormatter {
	kind: "biome" | "prettier";
	bin: string;
}

/**
 * Detect the consumer's formatter AND resolve its binary in one shot, so a caller
 * formatting many files (issue #493) pays the detect + `which` cost once. Returns
 * null when no formatter is configured or its binary can't be found — callers then
 * skip formatting silently (the "no formatter → behaves as today" contract).
 */
export async function resolveConsumerFormatter(cwd: string): Promise<ResolvedFormatter | null> {
	const kind = await detectFormatter(cwd);
	if (!kind) return null;
	const bin = await resolveFormatterBin(kind, cwd);
	if (!bin) return null;
	return { kind, bin };
}

/**
 * Per-run memo for `formatContent`. The front door re-derives full project state
 * ~6-7× per invocation (#624) and each sweep's generated-integrity scan formats
 * every showcase companion — so the *same* (formatter, content, filePath, cwd)
 * tuple spawns biome/prettier synchronously over and over (~800 spawns on a
 * Crewops-sized tree). `formatContent` is a pure function of that tuple, so the
 * cache only suppresses redundant respawns — same input always yields the same
 * canonical bytes. Process-lifetime scope: a CLI run exits, and every key is
 * fully qualified (formatter identity + cwd + path + content hash) so distinct
 * inputs — and distinct test cases — never collide.
 */
const formatCache = new Map<string, string>();

/**
 * Format a single file's content **in memory** via the consumer's formatter,
 * using its stdin filter (`biome check --write --stdin-file-path=…` /
 * `prettier --stdin-filepath …`). No file on disk is read or written — the bytes
 * round-trip through stdin/stdout — so this is safe to call from an Operation's
 * `plan()` (issue #493: "format before hashing"). `filePath` only tells the
 * formatter which syntax/overrides to apply.
 *
 * Best-effort: returns the original `content` unchanged on any failure (non-zero
 * exit, empty output, a formatter that doesn't support stdin), so a hostile or
 * unexpected formatter can never blank out a file claude-ds is about to write.
 *
 * Memoized per run (#624): a repeated (formatter, content, filePath, cwd) tuple
 * returns the cached bytes without respawning. Failures fall through to the
 * `content` return below and are NOT cached, so a transient spawn failure can't
 * pin a stale fallback for the rest of the run.
 */
export function formatContent(
	rf: ResolvedFormatter,
	content: string,
	filePath: string,
	cwd: string,
): string {
	const key = `${rf.kind}\0${rf.bin}\0${cwd}\0${filePath}\0${createHash("sha256")
		.update(content)
		.digest("hex")}`;
	const cached = formatCache.get(key);
	if (cached !== undefined) return cached;

	const args =
		rf.kind === "biome"
			? ["check", "--write", `--stdin-file-path=${filePath}`]
			: ["--stdin-filepath", filePath];
	let r: ReturnType<typeof spawnSync>;
	try {
		r = spawnSync(rf.bin, args, { cwd, encoding: "utf8", input: content });
	} catch {
		return content;
	}
	if (r.status !== 0) return content;
	const out = typeof r.stdout === "string" ? r.stdout : "";
	const formatted = out.length > 0 ? out : content;
	formatCache.set(key, formatted);
	return formatted;
}

/**
 * Run the detected formatter against the provided file paths.
 * biome: `<formatter> check --write <files...>`
 * prettier: `<formatter> --write <files...>`
 * Warns (does not throw) on non-zero exit or when binary is not found.
 */
export async function runFormatter(
	formatter: DetectedFormatter,
	files: string[],
	cwd: string,
): Promise<void> {
	if (!formatter || files.length === 0) return;

	const bin = await resolveFormatterBin(formatter, cwd);
	if (!bin) {
		info(`warn: ${formatter} config detected but binary not found — skipping auto-format`);
		return;
	}

	// #501: synced paths (.claude/, design-system/, scripts/) often sit outside a
	// consumer's biome `includes`, so `check --write` errors with a ~20-line "no
	// files processed" dump and exits non-zero on every sync. --no-errors-on-unmatched
	// tolerates the mismatch (the pack ships pre-formatted) so the warn doesn't recur.
	const args =
		formatter === "biome"
			? ["check", "--write", "--no-errors-on-unmatched", ...files]
			: ["--write", ...files];

	info(`running formatter: ${bin} ${args.slice(0, 2).join(" ")} <${files.length} file(s)>`);

	const r = spawnSync(bin, args, { cwd, encoding: "utf8" });

	if (r.status !== 0) {
		const detail = (r.stderr ?? r.stdout ?? "").trim();
		info(`warn: formatter exited ${r.status}${detail ? ` — ${detail}` : ""} (sync still applied)`);
	}
}
