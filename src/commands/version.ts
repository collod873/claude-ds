import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../lib/config.js";
import { colors, printNextStep } from "../lib/log.js";
import { semverLt } from "../lib/version-currency.js";
import { cliVersion, LABEL_CLI, LABEL_PIN } from "../lib/version-vocab.js";

// Distribution moved from git installs to the npm registry (ADR-0027), so
// `latest` is the registry dist-tag — public, no git auth needed.
const REGISTRY_LATEST_URL = "https://registry.npmjs.org/claude-ds/latest";

async function readIfExistsLocal(p: string): Promise<string | null> {
	try {
		return await readFile(p, "utf8");
	} catch (e) {
		if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export type LatestTagResult = { ok: true; tag: string | null } | { ok: false; reason: string };

export type RegistryFetcher = (url: string) => Promise<{ status: number; body: string }>;

const defaultFetcher: RegistryFetcher = async (url) => {
	const r = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	return { status: r.status, body: await r.text() };
};

/** Resolve the latest published version from the npm registry, as `vX.Y.Z`.
 *  Caller distinguishes network/registry failure (ok:false) from "package not
 *  published yet" (ok:true, tag:null — the registry 404s on unknown names). */
export async function fetchLatestVersion(
	fetcher: RegistryFetcher = defaultFetcher,
): Promise<LatestTagResult> {
	let res: { status: number; body: string };
	try {
		res = await fetcher(REGISTRY_LATEST_URL);
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	if (res.status === 404) return { ok: true, tag: null };
	if (res.status !== 200) return { ok: false, reason: `registry returned HTTP ${res.status}` };
	try {
		const version = (JSON.parse(res.body) as { version?: unknown }).version;
		if (typeof version !== "string")
			return { ok: false, reason: "registry response has no version field" };
		return { ok: true, tag: `v${version}` };
	} catch {
		return { ok: false, reason: "registry returned unparseable JSON" };
	}
}

export async function versionCmd(opts: { offline?: boolean; check?: boolean; cwd?: string }) {
	const cwd = opts.cwd ?? process.cwd();
	const raw = await readIfExistsLocal(join(cwd, ".claude-ds.json"));
	const pinned = raw ? parseConfig(raw).packVersion : null;
	const installedVer = cliVersion();

	const c = colors();
	if (opts.check) {
		if (!pinned) {
			console.log(c.red("no .claude-ds.json found — cannot check version"));
			printNextStep("version", { versionState: "no-config" });
			process.exit(1);
		}

		if (pinned === installedVer) {
			console.log(c.green(`up to date (${installedVer})`));
			printNextStep("version", { versionState: "up-to-date" });
			process.exit(0);
		}

		console.log(`${LABEL_PIN}: ${c.bold(pinned)}  ${LABEL_CLI}: ${c.bold(installedVer)}`);
		console.log("");

		// #363: replace the free-form "Run `claude-ds upgrade`..." line with the
		// canonical `→ Next:` breadcrumb. Route based on direction: pinned <
		// installed → upgrade; pinned > installed → update the CLI binary.
		const state: "behind" | "ahead" = semverLt(pinned, installedVer) ? "behind" : "ahead";
		printNextStep("version", { versionState: state });
		process.exit(1);
	}

	// Default mode. `installed` is the CLI binary version (consistent with
	// --check — issue #367). `pinned` is .claude-ds.json#packVersion, or
	// `(none)` when no config is present. `latest` is the registry dist-tag;
	// failures print a hint on stderr instead of silently rendering
	// `latest: unknown` (issue #368).
	console.log(`${LABEL_CLI}: ${c.bold(installedVer)}`);
	console.log(`${LABEL_PIN}: ${c.bold(pinned ?? "(none)")}`);

	if (opts.offline) {
		console.log(`latest: ${c.dim("unknown")}`);
		printNextStep("version", { versionState: defaultVersionState(pinned, installedVer) });
		return;
	}

	const result = await fetchLatestVersion();
	if (result.ok) {
		console.log(`latest: ${c.bold(result.tag ?? "unknown")}`);
	} else {
		console.log(`latest: ${c.dim("unknown")}`);
		console.error(c.red(`(latest version check failed: ${result.reason}; pass --offline to skip)`));
	}
	printNextStep("version", { versionState: defaultVersionState(pinned, installedVer) });
}

/**
 * #363: pick the breadcrumb routing for the default `version` mode. Mirrors
 * the `--check` branch — no pin → adopt, pin behind → upgrade, pin ahead →
 * update the CLI, equal → audit — so both surfaces land on the same next step
 * for the same project state.
 */
function defaultVersionState(
	pinned: string | null,
	installedVer: string,
): "no-config" | "up-to-date" | "behind" | "ahead" {
	if (!pinned) return "no-config";
	if (pinned === installedVer) return "up-to-date";
	return semverLt(pinned, installedVer) ? "behind" : "ahead";
}
