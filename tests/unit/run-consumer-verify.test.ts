/**
 * Unit table for `runConsumerVerify` — the A2 deep module (PRD #407 /
 * issue #410). Stubs the subprocess executor so the tests assert on
 * detection, parsing, and the scaffold-vs-consumer partition without
 * spawning any real `tsc`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectVerifyCommand,
	type ExecFn,
	parseVerifyErrors,
	runConsumerVerify,
} from "../../src/lib/run-consumer-verify.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

/** Build a deterministic exec stub that returns the supplied output. */
function stubExec(returned: {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	timedOut?: boolean;
}): ExecFn {
	return async () => ({
		exitCode: returned.exitCode,
		stdout: returned.stdout ?? "",
		stderr: returned.stderr ?? "",
		timedOut: returned.timedOut ?? false,
	});
}

/** Exec stub that records the resolved `timeoutMs` the runner passed it. */
function capturingExec(seen: { timeoutMs: number }): ExecFn {
	return async (_cmd, _args, { timeoutMs }) => {
		seen.timeoutMs = timeoutMs;
		return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
	};
}

describe("parseVerifyErrors", () => {
	it("parses a tsc-style diagnostic line", () => {
		const raw = `design-system/atoms/button.tsx(12,7): error TS2304: Cannot find name 'Foo'.`;
		const out = parseVerifyErrors(raw);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			file: "design-system/atoms/button.tsx",
			line: 12,
			col: 7,
			code: "TS2304",
			message: "Cannot find name 'Foo'.",
		});
	});

	it("parses multiple diagnostics across newlines", () => {
		const raw = [
			`design-system/atoms/a.tsx(1,1): error TS2300: Duplicate identifier 'meta'.`,
			`src/page.tsx(99,2): error TS2304: Cannot find name 'Bar'.`,
		].join("\n");
		const out = parseVerifyErrors(raw);
		expect(out.map((e) => e.file)).toEqual(["design-system/atoms/a.tsx", "src/page.tsx"]);
	});

	it("returns no errors for green output", () => {
		expect(parseVerifyErrors("")).toEqual([]);
		expect(parseVerifyErrors("Found 0 errors. Watching for file changes.\n")).toEqual([]);
	});
});

describe("detectVerifyCommand", () => {
	it("prefers an explicit `verify` script", async () => {
		const cwd = await freshTmpDir("rcv-detect-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					scripts: { verify: "tsc --noEmit", typecheck: "tsc --noEmit", build: "next build" },
					devDependencies: { typescript: "^5.0.0" },
				}),
			);
			await writeFile(join(cwd, "tsconfig.json"), "{}");
			const cmd = await detectVerifyCommand(cwd);
			expect(cmd?.label).toBe("npm run verify");
		} finally {
			await cleanup(cwd);
		}
	});

	it("falls back to `typecheck` when no `verify` script", async () => {
		const cwd = await freshTmpDir("rcv-detect-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					scripts: { typecheck: "tsc --noEmit", build: "next build" },
					devDependencies: { typescript: "^5.0.0" },
				}),
			);
			const cmd = await detectVerifyCommand(cwd);
			expect(cmd?.label).toBe("npm run typecheck");
		} finally {
			await cleanup(cwd);
		}
	});

	it("falls back to `tsc --noEmit` when no verify/typecheck script but typescript is a dep", async () => {
		const cwd = await freshTmpDir("rcv-detect-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					scripts: { build: "next build" },
					devDependencies: { typescript: "^5.0.0" },
				}),
			);
			await writeFile(join(cwd, "tsconfig.json"), "{}");
			const cmd = await detectVerifyCommand(cwd);
			expect(cmd?.label).toBe("npx tsc --noEmit");
		} finally {
			await cleanup(cwd);
		}
	});

	it("falls back to `build` script when no typecheck/typescript path exists", async () => {
		const cwd = await freshTmpDir("rcv-detect-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					scripts: { build: "next build" },
				}),
			);
			const cmd = await detectVerifyCommand(cwd);
			expect(cmd?.label).toBe("npm run build");
		} finally {
			await cleanup(cwd);
		}
	});

	it("returns null when no detectable verify command", async () => {
		const cwd = await freshTmpDir("rcv-detect-");
		try {
			await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
			const cmd = await detectVerifyCommand(cwd);
			expect(cmd).toBeNull();
		} finally {
			await cleanup(cwd);
		}
	});
});

describe("runConsumerVerify", () => {
	it("returns ok=true with no errors on a green run", async () => {
		const cwd = await freshTmpDir("rcv-green-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const result = await runConsumerVerify(cwd, { exec: stubExec({ exitCode: 0, stdout: "" }) });
			expect(result.ok).toBe(true);
			expect(result.errors).toEqual([]);
			expect(result.scaffoldErrors).toEqual([]);
			expect(result.consumerErrors).toEqual([]);
			expect(result.command).toBe("npm run verify");
			expect(result.exitCode).toBe(0);
		} finally {
			await cleanup(cwd);
		}
	});

	it("flags errors in scaffold files (default `design-system/` root) as scaffold errors", async () => {
		const cwd = await freshTmpDir("rcv-scaffold-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `design-system/atoms/button.tsx(1,1): error TS2300: Duplicate identifier 'meta'.`;
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.scaffoldErrors).toHaveLength(1);
			expect(result.scaffoldErrors[0].file).toBe("design-system/atoms/button.tsx");
			expect(result.consumerErrors).toEqual([]);
		} finally {
			await cleanup(cwd);
		}
	});

	it("treats errors outside scaffold roots/touched files as consumer errors (ok stays true)", async () => {
		const cwd = await freshTmpDir("rcv-consumer-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `src/legacy/page.tsx(99,2): error TS2304: Cannot find name 'Bar'.`;
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			// Pre-existing consumer errors warn but do not block claude-ds's verdict.
			expect(result.ok).toBe(true);
			expect(result.scaffoldErrors).toEqual([]);
			expect(result.consumerErrors).toHaveLength(1);
			expect(result.consumerErrors[0].file).toBe("src/legacy/page.tsx");
		} finally {
			await cleanup(cwd);
		}
	});

	it("counts errors in claude-ds-touched files as scaffold errors even outside `design-system/`", async () => {
		const cwd = await freshTmpDir("rcv-touched-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `src/special.tsx(3,4): error TS2304: Cannot find name 'X'.`;
			const result = await runConsumerVerify(cwd, {
				touchedFiles: new Set(["src/special.tsx"]),
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.scaffoldErrors).toHaveLength(1);
			expect(result.consumerErrors).toEqual([]);
		} finally {
			await cleanup(cwd);
		}
	});

	it("counts errors in pack-managed files as scaffold errors", async () => {
		const cwd = await freshTmpDir("rcv-managed-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `.claude/hooks/atom-imports.sh(1,1): error TS9999: bogus`;
			const result = await runConsumerVerify(cwd, {
				managedFiles: new Set([".claude/hooks/atom-imports.sh"]),
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.scaffoldErrors).toHaveLength(1);
		} finally {
			await cleanup(cwd);
		}
	});

	it("partitions a mixed scaffold + consumer error list correctly", async () => {
		const cwd = await freshTmpDir("rcv-mixed-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = [
				`design-system/atoms/a.tsx(1,1): error TS2300: Duplicate identifier 'meta'.`,
				`src/legacy/page.tsx(99,2): error TS2304: Cannot find name 'Bar'.`,
				`design-system/composites/b.tsx(5,6): error TS2552: Cannot find name 'Foo'.`,
			].join("\n");
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.scaffoldErrors).toHaveLength(2);
			expect(result.consumerErrors).toHaveLength(1);
			expect(result.consumerErrors[0].file).toBe("src/legacy/page.tsx");
		} finally {
			await cleanup(cwd);
		}
	});

	it("treats a non-zero exit with no parseable errors as an env failure (ok=false)", async () => {
		const cwd = await freshTmpDir("rcv-env-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 2, stderr: "tsc: command not found" }),
			});
			expect(result.ok).toBe(false);
			expect(result.errors).toEqual([]);
			expect(result.reason).toMatch(/exited 2/);
		} finally {
			await cleanup(cwd);
		}
	});

	it("labels a timeout as a timeout (not a parse failure) and shows the limit", async () => {
		const cwd = await freshTmpDir("rcv-timeout-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const result = await runConsumerVerify(cwd, {
				timeoutMs: 1234,
				exec: stubExec({ exitCode: 124, stdout: "Linting…\n", timedOut: true }),
			});
			expect(result.ok).toBe(false);
			expect(result.timedOut).toBe(true);
			// Labeled as a timeout, distinct from the generic "no parseable errors".
			expect(result.reason).toMatch(/timed out/i);
			// The configured limit is shown so a cold-run overrun is diagnosable.
			expect(result.reason).toMatch(/1234/);
			expect(result.reason).not.toMatch(/no parseable errors/);
		} finally {
			await cleanup(cwd);
		}
	});

	it("carries the truncated raw output when a verify fails with zero parseable TS errors", async () => {
		const cwd = await freshTmpDir("rcv-rawtail-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			// A Biome lint failure: real errors, but not in tsc's diagnostic shape.
			const stdout = [
				"design-system/atoms/button.tsx:3:1 lint/style/useConst  ━━━",
				"  × This let declares a variable that is never reassigned.",
				"Checked 42 files. Found 11 errors.",
			].join("\n");
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.errors).toEqual([]);
			// The raw failing output survives in the contract for diagnosis.
			expect(result.outputTail).toBeDefined();
			expect(result.outputTail).toMatch(/Found 11 errors/);
			expect(result.outputTail).toMatch(/lint\/style\/useConst/);
		} finally {
			await cleanup(cwd);
		}
	});

	it("truncates the raw output tail to a bounded size", async () => {
		const cwd = await freshTmpDir("rcv-rawtail-trunc-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `${"x".repeat(10_000)}\nFINAL LINE: build failed`;
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.outputTail).toBeDefined();
			// Bounded — keeps the tail (where the failure summary lives), not the head.
			expect(result.outputTail?.length).toBeLessThan(10_000);
			expect(result.outputTail).toMatch(/FINAL LINE: build failed/);
		} finally {
			await cleanup(cwd);
		}
	});

	it("leaves outputTail undefined on a green run", async () => {
		const cwd = await freshTmpDir("rcv-green-tail-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 0, stdout: "Found 0 errors.\n" }),
			});
			expect(result.ok).toBe(true);
			expect(result.outputTail).toBeUndefined();
		} finally {
			await cleanup(cwd);
		}
	});

	it("returns ok=true with a `no verify command` reason when nothing is detectable", async () => {
		const cwd = await freshTmpDir("rcv-none-");
		try {
			await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
			const result = await runConsumerVerify(cwd);
			expect(result.ok).toBe(true);
			expect(result.command).toBe("(none)");
			expect(result.reason).toMatch(/no verify command/);
		} finally {
			await cleanup(cwd);
		}
	});

	it("defaults the verify timeout to 300_000 ms (suite-scaled — issue #497)", async () => {
		const cwd = await freshTmpDir("rcv-timeout-default-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const seen = { timeoutMs: -1 };
			await runConsumerVerify(cwd, { exec: capturingExec(seen) });
			expect(seen.timeoutMs).toBe(300_000);
		} finally {
			await cleanup(cwd);
		}
	});

	it("honors CLAUDE_DS_VERIFY_TIMEOUT (seconds) as a timeout override", async () => {
		const cwd = await freshTmpDir("rcv-timeout-env-");
		const prev = process.env.CLAUDE_DS_VERIFY_TIMEOUT;
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			process.env.CLAUDE_DS_VERIFY_TIMEOUT = "45";
			const seen = { timeoutMs: -1 };
			await runConsumerVerify(cwd, { exec: capturingExec(seen) });
			expect(seen.timeoutMs).toBe(45_000);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_DS_VERIFY_TIMEOUT;
			else process.env.CLAUDE_DS_VERIFY_TIMEOUT = prev;
			await cleanup(cwd);
		}
	});

	it("lets opts.timeoutMs win over the env var", async () => {
		const cwd = await freshTmpDir("rcv-timeout-precedence-");
		const prev = process.env.CLAUDE_DS_VERIFY_TIMEOUT;
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			process.env.CLAUDE_DS_VERIFY_TIMEOUT = "45";
			const seen = { timeoutMs: -1 };
			await runConsumerVerify(cwd, { timeoutMs: 9_999, exec: capturingExec(seen) });
			expect(seen.timeoutMs).toBe(9_999);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_DS_VERIFY_TIMEOUT;
			else process.env.CLAUDE_DS_VERIFY_TIMEOUT = prev;
			await cleanup(cwd);
		}
	});

	it("ignores a non-numeric CLAUDE_DS_VERIFY_TIMEOUT and falls back to the default", async () => {
		const cwd = await freshTmpDir("rcv-timeout-bad-env-");
		const prev = process.env.CLAUDE_DS_VERIFY_TIMEOUT;
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			process.env.CLAUDE_DS_VERIFY_TIMEOUT = "not-a-number";
			const seen = { timeoutMs: -1 };
			await runConsumerVerify(cwd, { exec: capturingExec(seen) });
			expect(seen.timeoutMs).toBe(300_000);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_DS_VERIFY_TIMEOUT;
			else process.env.CLAUDE_DS_VERIFY_TIMEOUT = prev;
			await cleanup(cwd);
		}
	});

	it("falls back to env/default when opts.timeoutMs is NaN or non-positive (issue #497)", async () => {
		// `heal --verify-timeout abc` → parseInt → NaN → `NaN * 1000` → NaN reaches
		// here; `0`/`-5` reach here directly. A naive `?? default` keeps these and
		// `setTimeout(NaN|0)` fires immediately, SIGKILLing a green suite. Each must
		// fall back to the 300s default instead.
		for (const bad of [Number.NaN, 0, -5]) {
			const cwd = await freshTmpDir("rcv-timeout-bad-opt-");
			try {
				await writeFile(
					join(cwd, "package.json"),
					JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
				);
				const seen = { timeoutMs: -1 };
				await runConsumerVerify(cwd, { timeoutMs: bad, exec: capturingExec(seen) });
				expect(seen.timeoutMs).toBe(300_000);
			} finally {
				await cleanup(cwd);
			}
		}
	});

	it("honors a custom managedRoots prefix", async () => {
		const cwd = await freshTmpDir("rcv-roots-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = `app/ui/widget.tsx(1,1): error TS2300: dup`;
			const result = await runConsumerVerify(cwd, {
				managedRoots: ["app/ui/"],
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.ok).toBe(false);
			expect(result.scaffoldErrors).toHaveLength(1);
		} finally {
			await cleanup(cwd);
		}
	});

	// ── Ownership partition: hand-verify vs claude-ds defect (ADR-0030, #537) ──
	//
	// A scaffold-territory error in a showcase/example companion is partitioned by
	// who authored the file. The discriminator is the `@generated by claude-ds`
	// header: claude-ds wrote it ⇒ a claude-ds defect (blocks); the consumer wrote
	// it ⇒ ADR-0026 hand-verify (warn-only, surfaced as its own bucket).

	it("routes a consumer-authored JSX showcase (no @generated header) to handVerifyErrors, not scaffold", async () => {
		const cwd = await freshTmpDir("rcv-handverify-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
			// Consumer-authored — no `@generated` header.
			await writeFile(
				join(cwd, "design-system/atoms/card.stories.tsx"),
				`export const Demo = () => <Card>hi</Card>;\n`,
			);
			const stdout = `design-system/atoms/card.stories.tsx(1,1): error TS2322: Type error in JSX.`;
			const result = await runConsumerVerify(cwd, { exec: stubExec({ exitCode: 1, stdout }) });
			expect(result.handVerifyErrors).toHaveLength(1);
			expect(result.handVerifyErrors[0].file).toBe("design-system/atoms/card.stories.tsx");
			expect(result.scaffoldErrors).toEqual([]);
			// Hand-verify is the consumer's to fix — it does not flip claude-ds's gate.
			expect(result.ok).toBe(true);
		} finally {
			await cleanup(cwd);
		}
	});

	it("routes an error in a @generated showcase to scaffoldErrors (claude-ds defect), never hand-verify (defect 7)", async () => {
		const cwd = await freshTmpDir("rcv-generated-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
			// claude-ds wrote this — the header forbids editing. ADR-0030: an error
			// here is a claude-ds defect, not something the operator hand-verifies.
			await writeFile(
				join(cwd, "design-system/atoms/combobox.showcase.tsx"),
				`// @generated by claude-ds — do not edit. Source: combobox meta block.\nexport const Demo = () => <Combobox size="sm" />;\n`,
			);
			const stdout = `design-system/atoms/combobox.showcase.tsx(2,30): error TS2322: Property 'size' does not exist.`;
			const result = await runConsumerVerify(cwd, { exec: stubExec({ exitCode: 1, stdout }) });
			expect(result.scaffoldErrors).toHaveLength(1);
			expect(result.handVerifyErrors).toEqual([]);
			// A claude-ds defect blocks the gate — re-running can't converge.
			expect(result.ok).toBe(false);
		} finally {
			await cleanup(cwd);
		}
	});

	it("keeps a non-showcase scaffold file in scaffoldErrors (no hand-verify carve-out)", async () => {
		const cwd = await freshTmpDir("rcv-nonshowcase-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
			await writeFile(join(cwd, "design-system/atoms/button.tsx"), `export const x = 1;\n`);
			const stdout = `design-system/atoms/button.tsx(1,1): error TS2300: Duplicate identifier.`;
			const result = await runConsumerVerify(cwd, { exec: stubExec({ exitCode: 1, stdout }) });
			expect(result.scaffoldErrors).toHaveLength(1);
			expect(result.handVerifyErrors).toEqual([]);
			expect(result.ok).toBe(false);
		} finally {
			await cleanup(cwd);
		}
	});

	it("partitions a mixed generated-defect + hand-verify + consumer error list into three buckets", async () => {
		const cwd = await freshTmpDir("rcv-three-");
		try {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
			await writeFile(
				join(cwd, "design-system/atoms/dialog.showcase.tsx"),
				`// @generated by claude-ds — do not edit.\nexport const D = () => <DialogContent weight="10" />;\n`,
			);
			await writeFile(
				join(cwd, "design-system/atoms/card.stories.tsx"),
				`export const Demo = () => <Card>hi</Card>;\n`,
			);
			const stdout = [
				`design-system/atoms/dialog.showcase.tsx(2,1): error TS2322: bad prop.`,
				`design-system/atoms/card.stories.tsx(1,1): error TS2322: bad jsx.`,
				`src/legacy/page.tsx(99,2): error TS2304: Cannot find name 'Bar'.`,
			].join("\n");
			const result = await runConsumerVerify(cwd, { exec: stubExec({ exitCode: 1, stdout }) });
			expect(result.scaffoldErrors.map((e) => e.file)).toEqual([
				"design-system/atoms/dialog.showcase.tsx",
			]);
			expect(result.handVerifyErrors.map((e) => e.file)).toEqual([
				"design-system/atoms/card.stories.tsx",
			]);
			expect(result.consumerErrors.map((e) => e.file)).toEqual(["src/legacy/page.tsx"]);
			// The generated defect blocks; hand-verify and consumer do not.
			expect(result.ok).toBe(false);
		} finally {
			await cleanup(cwd);
		}
	});

	it("normalizes a leading `./` and backslashes when matching scaffold paths", async () => {
		const cwd = await freshTmpDir("rcv-norm-");
		try {
			await mkdir(join(cwd, "design-system", "atoms"), { recursive: true });
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({ scripts: { verify: "tsc --noEmit" } }),
			);
			const stdout = [
				`./design-system/atoms/a.tsx(1,1): error TS2300: dup`,
				`design-system\\atoms\\b.tsx(1,1): error TS2300: dup`,
			].join("\n");
			const result = await runConsumerVerify(cwd, {
				exec: stubExec({ exitCode: 1, stdout }),
			});
			expect(result.scaffoldErrors).toHaveLength(2);
			expect(result.consumerErrors).toHaveLength(0);
		} finally {
			await cleanup(cwd);
		}
	});
});
