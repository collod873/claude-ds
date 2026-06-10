import type { Config } from "../../src/lib/config.js";
import type { Manifest } from "../../src/lib/manifest.js";

/**
 * Fully-populated fixture builders for the two parsed-file types ops tests
 * need. Before these existed, each test hand-rolled a partial literal typed
 * `: Config` / `: Manifest` and silently drifted as the interfaces grew —
 * invisible until tests started being typechecked (issue #482).
 */
export function makeCfg(overrides: Partial<Config> = {}): Config {
	return {
		packVersion: "v0.0.0",
		pack: "next-react",
		mode: "warn",
		enforce_threshold: 10,
		removed: [],
		lookalike_ignore: [],
		app_dir: "app",
		claude_md_target: ".claude/CLAUDE.md",
		domain_roots: ["features", "lib"],
		meta_kind_strict: false,
		role_contracts_strict: false,
		srcRoot: "src",
		allowed_imports: [],
		ds_aliases: [],
		...overrides,
	};
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		files: [],
		canonical_paths: [],
		lookalike_ignore: [],
		deprecated_paths: [],
		managed_roots: [],
		generated_patterns: [],
		...overrides,
	};
}
