import { describe, expect, it } from "vitest";
import { cliVersion } from "../../src/lib/version-vocab.js";
import { goldenTranscript, normalizeTranscript } from "../helpers/golden-transcript.js";

/**
 * Unit coverage for the golden-transcript normalization rules (#539). The
 * journey snapshots exercise these indirectly; this pins the subtle cases —
 * realpath variants, version prefix-shadowing, duration matching — so a
 * regression in the scrubber surfaces as a focused failure, not a snapshot diff.
 */
describe("normalizeTranscript", () => {
	const dir = "/tmp/e2e-crewops-shaped-Ab12Cd";
	const prevVersion = "v0.9.0";

	it("scrubs the literal fixture dir, its /private realpath variant, and stray mkdtemp paths", () => {
		const text = [
			`adopted (${dir})`,
			`A /private${dir}/design-system/utils/force-state.css`,
			"create: /var/folders/x/e2e-crewops-shaped-Zz99Yy/scripts/build-manifest.ts",
		].join("\n");
		const out = normalizeTranscript(text, { dir, prevVersion });
		expect(out).not.toMatch(/\/tmp\/e2e-/);
		expect(out).not.toMatch(/\/private/);
		expect(out).not.toMatch(/\/var\/folders/);
		expect(out).toBe(
			[
				"adopted (<fixture>)",
				"A <fixture>/design-system/utils/force-state.css",
				"create: <fixture>/scripts/build-manifest.ts",
			].join("\n"),
		);
	});

	it("maps the installed CLI version and the prior pin to distinct stable tokens", () => {
		const cli = cliVersion();
		const out = normalizeTranscript(`pin advanced ${prevVersion} → ${cli}`, { dir, prevVersion });
		expect(out).toBe("pin advanced <prev-version> → <cli-version>");
	});

	it("replaces the longer version first so a prefix pin can't shadow the CLI version", () => {
		// A prev pin that is a string prefix of the CLI version (e.g. v1.8 vs
		// v1.8.1). Naive left-to-right replacement would rewrite the prefix inside
		// the CLI token; sort-longest-first prevents that.
		const cli = cliVersion();
		const prefixPrev = cli.slice(0, cli.lastIndexOf("."));
		expect(cli.startsWith(prefixPrev)).toBe(true);
		expect(prefixPrev).not.toBe(cli);
		const out = normalizeTranscript(`from ${prefixPrev} to ${cli}`, {
			dir,
			prevVersion: prefixPrev,
		});
		expect(out).toBe("from <prev-version> to <cli-version>");
	});

	it("scrubs integer and fractional millisecond timings, leaving non-duration numbers alone", () => {
		const out = normalizeTranscript("took 1234ms (1.5ms p50) across 42 files", {
			dir,
			prevVersion,
		});
		expect(out).toBe("took <dur>ms (<dur>ms p50) across 42 files");
	});
});

describe("goldenTranscript", () => {
	const dir = "/tmp/e2e-crewops-shaped-Ab12Cd";
	const prevVersion = "v0.9.0";

	it("frames the normalized body under a provenance header carrying command and exit code", () => {
		const out = goldenTranscript("heal", 1, `ran in ${dir}\n`, { dir, prevVersion });
		expect(out).toBe(
			[
				"# command: claude-ds heal",
				"# exit: 1",
				"# --- transcript below; bytes are verbatim from the built CLI, normalized for paths/versions/durations ---",
				"ran in <fixture>\n",
			].join("\n"),
		);
	});
});
