export class ConfigError extends Error {}
export interface Config {
	/** Pack version this consumer was last initialized/synced against. Written by `init`; read by `upgrade`. */
	packVersion: string;
	pack: string;
	mode: "warn" | "block";
	enforce_threshold: number;
	removed: string[];
	lookalike_ignore: string[];
	/** Where Next.js app router lives in this project. Manifest stays canonical (`app/...`);
	 *  CLI rewrites the `app/` prefix to this dir at every I/O boundary. */
	app_dir: string;
	/** Where the claude-ds managed pointer block lives. Set at adopt time after detecting
	 *  existing CLAUDE.md files. Never defaults to root unless the user already had one there. */
	claude_md_target: string;
	/** Domain folder names whose imports mark a file as feature-tier (used by classifier + DRIFT-DS-IMPORTS-FEATURE).
	 *  Defaults to ["features", "lib"]. */
	domain_roots: string[];
	/** When true, audit errors (exit 1) on DS files missing a meta.kind declaration.
	 *  Set by the meta-kind-hard migration Op after classify guarantees backfill. */
	meta_kind_strict: boolean;
	/** When true, audit errors (exit 1) on smart DS parts (state/effect/context users)
	 *  that declare no meta.role. Default false for fresh projects — a v-next migration
	 *  Op flips it on after a `classify` pass assigns roles (mirrors meta_kind_strict).
	 *  ADR-0016 / PRD #301. */
	role_contracts_strict: boolean;
	/** Root where TypeScript source files live, relative to cwd. Used to locate tsconfig.json.
	 *  Defaults to "src". Set to "." for projects with source at repo root. */
	srcRoot: string;
	/** Import paths that DS files are allowed to use without triggering DRIFT-DS-IMPORTS-FEATURE.
	 *  Entries are path prefixes matched against import specifiers (e.g. "@/lib/utils").
	 *  Auto-detected during upgrade when a shared utility is imported by many DS files. */
	allowed_imports: string[];
	/** Path alias prefixes that resolve to the design-system/ folder (e.g. "@ds").
	 *  When empty, auto-detected from tsconfig.json paths at classification time. */
	ds_aliases: string[];
}
const ALLOWED = new Set([
	"packVersion",
	"version",
	"pack",
	"mode",
	"enforce_threshold",
	"removed",
	"lookalike_ignore",
	"app_dir",
	"claude_md_target",
	"domain_roots",
	"meta_kind_strict",
	"role_contracts_strict",
	"srcRoot",
	"allowed_imports",
	"ds_aliases",
]);
const VERSION_RE = /^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
export function parseConfig(raw: string): Config {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch (e) {
		throw new ConfigError(`invalid JSON: ${(e as Error).message}`);
	}
	if (typeof obj !== "object" || obj === null) throw new ConfigError("config must be an object");
	const o = obj as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!ALLOWED.has(k)) throw new ConfigError(`unknown field: ${k}`);
	// Accept `packVersion` (new) or `version` (legacy key written by pre-v0.8 init).
	const rawPackVersion = o.packVersion ?? o.version;
	if (typeof rawPackVersion !== "string" || !VERSION_RE.test(rawPackVersion))
		throw new ConfigError(`packVersion must match vX.Y.Z`);
	if (typeof o.pack !== "string" || o.pack.length === 0) throw new ConfigError(`pack required`);
	if (o.mode !== "warn" && o.mode !== "block") throw new ConfigError(`mode must be warn|block`);
	const enforce_threshold = o.enforce_threshold === undefined ? 10 : Number(o.enforce_threshold);
	if (!Number.isInteger(enforce_threshold) || enforce_threshold < 0)
		throw new ConfigError(`enforce_threshold must be ≥ 0 integer`);
	const removed = o.removed === undefined ? [] : o.removed;
	if (!Array.isArray(removed) || removed.some((x) => typeof x !== "string"))
		throw new ConfigError(`removed must be string[]`);
	const lookalike_ignore = o.lookalike_ignore === undefined ? [] : o.lookalike_ignore;
	if (!Array.isArray(lookalike_ignore) || lookalike_ignore.some((x) => typeof x !== "string"))
		throw new ConfigError(`lookalike_ignore must be string[]`);
	// Back-compat: pre-v0.6 configs lack app_dir / claude_md_target. Defaults preserve old behavior:
	//   - app_dir="app"            → original hardcoded prefix
	//   - claude_md_target="CLAUDE.md" → root, where pre-#34 adopt always wrote
	const app_dir = o.app_dir === undefined ? "app" : o.app_dir;
	if (typeof app_dir !== "string" || app_dir.length === 0)
		throw new ConfigError(`app_dir must be non-empty string`);
	const claude_md_target = o.claude_md_target === undefined ? "CLAUDE.md" : o.claude_md_target;
	if (typeof claude_md_target !== "string" || claude_md_target.length === 0)
		throw new ConfigError(`claude_md_target must be non-empty string`);
	const domain_roots = o.domain_roots === undefined ? ["features", "lib"] : o.domain_roots;
	if (!Array.isArray(domain_roots) || domain_roots.some((x) => typeof x !== "string"))
		throw new ConfigError(`domain_roots must be string[]`);
	const meta_kind_strict = o.meta_kind_strict === undefined ? false : Boolean(o.meta_kind_strict);
	const role_contracts_strict =
		o.role_contracts_strict === undefined ? false : Boolean(o.role_contracts_strict);
	const srcRoot = o.srcRoot === undefined ? "src" : o.srcRoot;
	if (typeof srcRoot !== "string" || srcRoot.length === 0)
		throw new ConfigError(`srcRoot must be non-empty string`);
	const allowed_imports = o.allowed_imports === undefined ? [] : o.allowed_imports;
	if (!Array.isArray(allowed_imports) || allowed_imports.some((x) => typeof x !== "string"))
		throw new ConfigError(`allowed_imports must be string[]`);
	const ds_aliases = o.ds_aliases === undefined ? [] : o.ds_aliases;
	if (
		!Array.isArray(ds_aliases) ||
		ds_aliases.some((x) => typeof x !== "string" || (x as string).length === 0)
	)
		throw new ConfigError(`ds_aliases must be non-empty string[]`);
	return {
		packVersion: rawPackVersion,
		pack: o.pack,
		mode: o.mode,
		enforce_threshold,
		removed: removed as string[],
		lookalike_ignore: lookalike_ignore as string[],
		app_dir,
		claude_md_target,
		domain_roots: domain_roots as string[],
		meta_kind_strict,
		role_contracts_strict,
		srcRoot,
		allowed_imports: allowed_imports as string[],
		ds_aliases: ds_aliases as string[],
	};
}
