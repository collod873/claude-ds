import { cliVersion } from "../../src/lib/version-vocab.js";

/**
 * Golden-transcript normalization + framing (PRD #529 / sub-issue #539).
 *
 * The journey transcripts are snapshotted as plain vitest snapshot files — the
 * lean rebuild of ADR-0020's gate, no bespoke harness or friction baseline. The
 * committed `.snap` file is the artifact: the verbatim bytes the built CLI
 * emitted, captured the same way a TTY-blind agent reads them back, with only
 * the three machine-volatile token classes scrubbed so the snapshot is stable
 * across machines and releases:
 *
 *   - **absolute paths** — the materialized fixture's tmp dir → `<fixture>`.
 *   - **versions** — the installed CLI's version → `<cli-version>`, the prior
 *     pinned pack version → `<prev-version>`. Both move every release; the pin
 *     advance stays legible (`<prev-version> → <cli-version>`).
 *   - **durations** — millisecond timings → `<dur>ms`.
 *
 * A deliberate change to user-facing output surfaces as a snapshot diff and is
 * re-goldened via the standard vitest update flow (`vitest -u` / `npm test --
 * -u`) in the same PR — re-goldening is a reviewed act, never a reflex to make
 * red go green.
 */

export interface NormalizeOptions {
	/** The materialized fixture's tmp dir — scrubbed to `<fixture>`. */
	dir: string;
	/** The consumer's prior pinned pack version — scrubbed to `<prev-version>`. */
	prevVersion: string;
}

/**
 * Scrub the machine-volatile tokens (paths, versions, durations) from a captured
 * transcript so the snapshot is identical on any machine and at any release.
 */
export function normalizeTranscript(text: string, opts: NormalizeOptions): string {
	let out = text;

	// Absolute fixture paths — the `/private` realpath variant FIRST (macOS
	// resolves `/var/folders/…` ⇄ `/private/var/folders/…`), since it contains
	// the literal dir as a substring; scrubbing the bare dir first would leave a
	// dangling `/private<fixture>`. Then the literal tmp dir, then any stray
	// `e2e-…-XXXX` mkdtemp path the literal replace missed.
	out = out.split(`/private${opts.dir}`).join("<fixture>");
	out = out.split(opts.dir).join("<fixture>");
	out = out.replace(/\/[^\s()]*e2e-[a-z0-9-]+-[A-Za-z0-9]{6}/g, "<fixture>");

	// Versions — replace the longer string first so a prefix can't shadow it.
	const cli = cliVersion();
	const versions = [cli, opts.prevVersion].sort((a, b) => b.length - a.length);
	const tokenFor = (v: string) => (v === cli ? "<cli-version>" : "<prev-version>");
	for (const v of versions) {
		out = out.split(v).join(tokenFor(v));
	}

	// Durations — millisecond timings.
	out = out.replace(/\b\d+(?:\.\d+)?ms\b/g, "<dur>ms");

	return out;
}

/**
 * Frame a normalized transcript as a golden snapshot: a small provenance header
 * (the format carried forward from the wiped golden README) followed by the
 * verbatim, normalized bytes. The header records what produced the bytes so the
 * snapshot reads as a self-describing artifact, not an opaque blob.
 */
export function goldenTranscript(
	command: string,
	exitCode: number,
	transcript: string,
	opts: NormalizeOptions,
): string {
	const body = normalizeTranscript(transcript, opts);
	return [
		`# command: claude-ds ${command}`,
		`# exit: ${exitCode}`,
		"# --- transcript below; bytes are verbatim from the built CLI, normalized for paths/versions/durations ---",
		body,
	].join("\n");
}
