/**
 * compile-what-you-emit harness (PRD #546, issue #551).
 *
 * String assertions on generated `.tsx` only encode the generator's own beliefs
 * back at itself — they were green throughout the Crewops breakage. The only
 * ground truth is: does the consumer's compiler accept this output against the
 * real component? This helper supplies that oracle to the suite.
 *
 * `compileEmitted(files, fixtureRoot)` overlays the emitted file(s) onto the
 * fixture project in memory and returns the TypeScript diagnostics the
 * fixture's *own* tsconfig semantics (jsx mode, `paths`) would produce — no
 * `tsc` spawn, no temp dir. A single `LanguageService` is built per fixture
 * root and reused across calls (cached module-side), so the lib + fixture
 * source files parse once and every later compile is a cheap incremental
 * update — the budget is "one program per test file, not per assertion"
 * (PRD #546: the whole layer stays within ~+10s on `npm test`).
 *
 * Risk it guards (PRD #546): in-memory semantics drifting from the consumer's
 * real `tsc`. Mitigated by reading the fixture's actual `tsconfig.json` rather
 * than hand-rolling compiler options.
 */

import { isAbsolute, join, resolve } from "node:path";
import ts from "typescript";

/** An emitted file to typecheck, addressed relative to the fixture root. */
export interface EmittedFile {
	/** Path relative to `fixtureRoot` (e.g. `design-system/atoms/x.showcase.tsx`). */
	path: string;
	content: string;
}

/** What the fixture's compiler said about the emitted file(s). */
export interface CompileResult {
	/** Raw diagnostics, for callers that need codes/spans. */
	diagnostics: ts.Diagnostic[];
	/** Flattened, human-readable messages — what tripwires match against. */
	messages: string[];
	/** True when any diagnostic was produced. */
	hasErrors: boolean;
}

interface FixtureService {
	service: ts.LanguageService;
	options: ts.CompilerOptions;
	baseFileNames: string[];
	/** Virtual emitted files overlaid on the fixture, keyed by absolute path. */
	overlay: Map<string, { content: string; version: number }>;
	/** Monotonic version stamp — never resets, so the service never serves a stale snapshot for a reused path. */
	nextVersion: number;
	root: string;
}

/** One LanguageService per fixture root, reused for the whole test file. */
const fixtureServices = new Map<string, FixtureService>();

function loadFixtureService(root: string): FixtureService {
	const cached = fixtureServices.get(root);
	if (cached) return cached;

	const configPath = join(root, "tsconfig.json");
	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error) {
		throw new Error(
			`compileEmitted: could not read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
		);
	}
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
	// Diagnostics only — never write, even if the fixture's tsconfig omits noEmit.
	const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
	const overlay = new Map<string, { content: string; version: number }>();

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => [...parsed.fileNames, ...overlay.keys()],
		getScriptVersion: (fileName) => {
			const o = overlay.get(fileName);
			return o ? String(o.version) : "0";
		},
		getScriptSnapshot: (fileName) => {
			const o = overlay.get(fileName);
			if (o) return ts.ScriptSnapshot.fromString(o.content);
			const text = ts.sys.readFile(fileName);
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => root,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
		fileExists: (f) => overlay.has(f) || ts.sys.fileExists(f),
		readFile: (f) => {
			const o = overlay.get(f);
			return o ? o.content : ts.sys.readFile(f);
		},
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};

	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	const fs: FixtureService = {
		service,
		options,
		baseFileNames: parsed.fileNames,
		overlay,
		nextVersion: 1,
		root,
	};
	fixtureServices.set(root, fs);
	return fs;
}

/**
 * Typecheck `files` (the emitted bytes) against the fixture project at
 * `fixtureRoot`. Each call replaces the overlay wholesale, so compiles are
 * isolated from one another while the underlying service — and its parsed lib
 * + fixture source files — stays warm.
 */
export function compileEmitted(files: EmittedFile[], fixtureRoot: string): CompileResult {
	const fs = loadFixtureService(resolve(fixtureRoot));

	// Fresh overlay per call: a previous test's emitted file must not leak in as
	// a resolvable module for this one. The version stamp is monotonic across
	// calls so the service re-typechecks a reused path instead of serving the
	// prior call's cached diagnostics.
	fs.overlay.clear();
	const version = fs.nextVersion++;
	const targets: string[] = [];
	for (const f of files) {
		const abs = isAbsolute(f.path) ? f.path : resolve(fs.root, f.path);
		fs.overlay.set(abs, { content: f.content, version });
		targets.push(abs);
	}

	const diagnostics: ts.Diagnostic[] = [];
	for (const abs of targets) {
		diagnostics.push(...fs.service.getSyntacticDiagnostics(abs));
		diagnostics.push(...fs.service.getSemanticDiagnostics(abs));
	}

	return {
		diagnostics,
		messages: diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
		hasErrors: diagnostics.length > 0,
	};
}
