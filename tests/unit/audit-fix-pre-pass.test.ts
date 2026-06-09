/**
 * PRD #325 / ADR-0023 — command-level Decision pre-pass + determinism of
 * `fixerAsOperation(f).plan(ctx)`.
 *
 * What the pre-pass guarantees:
 *   - Non-TTY `audit --fix` never invokes a prompt. Every interactive finding's
 *     decision points enumerate to Ambiguity Decisions; the resolver throws
 *     `UnresolvedAmbiguityError` for any unanswered one, audit catches and
 *     exits non-zero. ADR-0014's "every ambiguity gets a safe default in
 *     non-TTY" path (auto-deferral to `exceptions.json`) is retired — the
 *     agent no longer silently picks a project judgment that was the owner's
 *     to make.
 *   - Pre-supplied `--answers` (carried on `ctx.decisions.answers`) resolve
 *     Ambiguities in non-TTY without a prompt and without throwing — the test
 *     seam for the spine.
 *   - `--except` overrides the pre-pass: remaining findings land in
 *     `exceptions.json` via the explicit reason/issue flow, an explicit opt-in
 *     for sanctioned drift.
 *   - Per-finding answers live on `ctx.decisions.fixerChoices`, so the fixer
 *     is a pure function of `(finding, ctx)`. Running the same Op twice over
 *     the same ctx returns equal `Change[]`.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DriftFinding, findingKey } from "../../src/lib/drift/index.js";
import { fixerAsOperation } from "../../src/lib/fix-pass";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

vi.mock("../../src/lib/log.js", () => ({
	info: vi.fn(),
	err: vi.fn(),
	printNextStep: vi.fn(),
	detectBuildCommand: vi.fn().mockResolvedValue("npm run build"),
}));

import { auditCmd } from "../../src/commands/audit";
import { makeTtyPrompt } from "../../src/lib/drift/prompt.js";
import { err as errLog } from "../../src/lib/log.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

describe("audit-fix command-level pre-pass (PRD #266 Phase C step 2)", () => {
	let dir: string;
	let originalStdoutIsTTY: boolean | undefined;
	let originalStdinIsTTY: boolean | undefined;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await freshTmpDir();
		originalStdoutIsTTY = process.stdout.isTTY;
		originalStdinIsTTY = process.stdin.isTTY;
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		// The log mocks are module-level singletons — clear per-test so a prior
		// run's err() / info() / exit() calls don't leak into this test's
		// assertions (e.g. matching a previous test's named-decision message).
		vi.mocked(errLog).mockClear();
		exitSpy.mockClear();
	});

	afterEach(async () => {
		Object.defineProperty(process.stdout, "isTTY", {
			value: originalStdoutIsTTY,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(process.stdin, "isTTY", {
			value: originalStdinIsTTY,
			writable: true,
			configurable: true,
		});
		exitSpy.mockRestore();
		await cleanup(dir);
	});

	function setNonTTY() {
		Object.defineProperty(process.stdout, "isTTY", {
			value: false,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			writable: true,
			configurable: true,
		});
	}

	describe("non-TTY pre-pass fails loud on unresolved Ambiguities (ADR-0023)", () => {
		/**
		 * Composite imports a symbol from `lib/api/` whose source file has its own
		 * `features/auth/` domain dep. `canExtract` is false, `canConvertToProp`
		 * is true → describeDecisions emits a `convert:...` decision point. In
		 * non-TTY with no supplied answer the resolver throws — audit exits
		 * non-zero, no fix runs, no `auto-deferred` exception is written.
		 */
		async function scaffoldInteractiveDsImports() {
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
			);
			await mkdir(join(dir, "design-system/composites"), { recursive: true });
			await mkdir(join(dir, "lib/api"), { recursive: true });
			await mkdir(join(dir, "features/auth"), { recursive: true });

			await writeFile(
				join(dir, "features/auth/session.ts"),
				`export function getSession() { return { user: "x" }; }\n`,
			);
			await writeFile(
				join(dir, "lib/api/client.ts"),
				[
					`import { getSession } from "../../features/auth/session";`,
					`export function apiClient() { return getSession(); }`,
					``,
				].join("\n"),
			);
			await writeFile(
				join(dir, "design-system/composites/user-badge.tsx"),
				[
					`import { apiClient } from "../../lib/api/client";`,
					`export function UserBadge() { return <div>{apiClient()}</div>; }`,
					`export const meta = { kind: "composite" as const, examples: [] };`,
					``,
				].join("\n"),
			);
		}

		it("DRIFT-DS-IMPORTS-FEATURE: fails loud (named exit) in non-TTY with no --answers", async () => {
			await scaffoldInteractiveDsImports();
			setNonTTY();

			const result = await auditCmd({ fix: true, cwd: dir });

			// Named exit, not a silent default — error message carries the Decision id
			// and question so the operator can supply --answers and re-run.
			const errCalls = vi.mocked(errLog).mock.calls.map((c) => String(c[0]));
			const named = errCalls.find((c) => c.includes("audit needs you"));
			expect(named).toBeDefined();
			expect(named).toMatch(/DRIFT-DS-IMPORTS-FEATURE.*user-badge\.tsx/);
			expect(result.exitCode).toBe(2);
			expect(result.outcome).toBe("error");

			// No exceptions.json is written — auto-deferral retired (ADR-0023).
			expect(await exists(join(dir, "design-system/exceptions.json"))).toBe(false);

			// The fix never ran — the original import is still there.
			const composite = await readFile(
				join(dir, "design-system/composites/user-badge.tsx"),
				"utf8",
			);
			expect(composite).toContain("lib/api/client");
		});

		it("DRIFT-INLINE-STATIC-STYLE: equidistant-token finding fails loud in non-TTY", async () => {
			// Two tokens equidistant from `padding: 12` → the only decision point
			// for this finding is `token-tie:padding:12`. Non-TTY + no answer:
			// resolver throws, audit exits non-zero, inline style stays.
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
			);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(
				join(dir, "design-system/tokens.json"),
				JSON.stringify({
					spacing: { 2: "8", 4: "16" },
				}),
			);
			await writeFile(
				join(dir, "design-system/atoms/card.tsx"),
				[
					`export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
					`export const meta = { kind: "atom" as const, examples: [] };`,
					``,
				].join("\n"),
			);

			setNonTTY();
			const result = await auditCmd({ fix: true, cwd: dir });

			const errCalls = vi.mocked(errLog).mock.calls.map((c) => String(c[0]));
			const named = errCalls.find((c) => c.includes("audit needs you"));
			expect(named).toBeDefined();
			expect(named).toMatch(/token-tie:padding:12/);
			expect(result.exitCode).toBe(2);

			// No auto-deferred exceptions.json is written.
			expect(await exists(join(dir, "design-system/exceptions.json"))).toBe(false);

			// Style was not rewritten — the deferred finding was never planned.
			const card = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
			expect(card).toContain("padding: 12");
			expect(card).not.toContain("spacing-");
		});

		it("pre-supplied --answers resolves the Ambiguity without prompting or throwing", async () => {
			// The DRIFT-INLINE-STATIC-STYLE token-tie scenario, but with the answer
			// pre-supplied via the spine's flat `--answers` bag. Resolver picks
			// option 0 ("spacing-2") without prompting; fixer applies the rewrite.
			await writeFile(
				join(dir, ".claude-ds.json"),
				JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
			);
			await mkdir(join(dir, "design-system/atoms"), { recursive: true });
			await writeFile(
				join(dir, "design-system/tokens.json"),
				JSON.stringify({
					spacing: { 2: "8", 4: "16" },
				}),
			);
			await writeFile(
				join(dir, "design-system/atoms/card.tsx"),
				[
					`export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
					`export const meta = { kind: "atom" as const, examples: [] };`,
					``,
				].join("\n"),
			);

			// Spine id: `${ruleId}:${file}::${decisionKey}` (see fixer-adapter).
			const answersPath = join(dir, ".answers.json");
			const decisionId =
				"DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12";
			await writeFile(answersPath, JSON.stringify({ [decisionId]: 0 }));

			setNonTTY();
			await auditCmd({ fix: true, cwd: dir, answers: answersPath });

			// Resolver did not throw — no fail-loud exit.
			const errCalls = vi.mocked(errLog).mock.calls.map((c) => String(c[0]));
			expect(errCalls.find((c) => c.includes("audit needs you"))).toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalledWith(2);
		});

		it("--except still routes remaining findings to exceptions.json (sanctioned drift)", async () => {
			// The explicit reason/issue path stays — the agent must opt in to write
			// exceptions, instead of getting auto-deferral as a non-TTY side effect.
			await scaffoldInteractiveDsImports();
			setNonTTY();

			await auditCmd({ fix: true, except: true, reason: "skip per agent", cwd: dir });

			const ex = JSON.parse(await readFile(join(dir, "design-system/exceptions.json"), "utf8"));
			const flagged = ex.exceptions.filter(
				(e: { rule: string; reason?: string }) => e.rule === "DRIFT-DS-IMPORTS-FEATURE",
			);
			expect(flagged).toHaveLength(1);
			// The reason is the user-supplied one, not the retired "auto-deferred" tag.
			expect(flagged[0].reason).toBe("skip per agent");
		});

		it("never constructs the TTY prompt module's readline interface in non-TTY mode", async () => {
			// makeTtyPrompt() returns a function that opens a readline interface
			// when invoked. The pre-pass only constructs that function path when
			// `isTTY`. We verify by spying on the export — non-TTY should not call
			// it.
			const promptModule = await import("../../src/lib/drift/prompt.js");
			const spy = vi.spyOn(promptModule, "makeTtyPrompt");
			try {
				await scaffoldInteractiveDsImports();
				setNonTTY();
				await auditCmd({ fix: true, cwd: dir });
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		});
	});

	// Smoke test that the prompt module hasn't lost the TTY path — used by the
	// pre-pass when isTTY is true. (Functional TTY coverage is in the audit*
	// integration tests, which run the real auditCmd.)
	describe("TTY prompt construction still works", () => {
		it("makeTtyPrompt returns a callable", () => {
			expect(typeof makeTtyPrompt()).toBe("function");
		});
	});

	describe("plan(ctx) determinism", () => {
		/**
		 * The promise this PRD exists to enforce: `fixerAsOperation(f).plan(ctx)`
		 * returns equal `Change[]` on two consecutive invocations with the same
		 * ctx (including `ctx.decisions.fixerChoices`). With the prompt-in-plan
		 * seam gone, the only inputs to fix() are `finding` and `ctx` — same
		 * inputs ⇒ same outputs.
		 */
		it("DRIFT-META-KIND-MISSING plan is deterministic over the same ctx", async () => {
			const cwd = await freshTmpDir();
			try {
				await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
				await writeFile(
					join(cwd, "design-system/atoms/chip.tsx"),
					`export function Chip() { return <span />; }\n`,
				);
				const finding: DriftFinding = {
					ruleId: "DRIFT-META-KIND-MISSING",
					file: "design-system/atoms/chip.tsx",
					message: "missing meta.kind",
				};
				const ctx = makeFakeCtx(cwd);
				const a = (await fixerAsOperation(finding).plan(ctx)).changes;
				const b = (await fixerAsOperation(finding).plan(ctx)).changes;
				expect(a.map((c) => ({ ...c, before: undefined, after: undefined }))).toEqual(
					b.map((c) => ({ ...c, before: undefined, after: undefined })),
				);
				// Bytes equal too — `plan` only reads, so the writes are identical.
				const aWrite = a.find((c) => c.kind === "write");
				const bWrite = b.find((c) => c.kind === "write");
				expect(aWrite && bWrite && aWrite.kind === "write" && bWrite.kind === "write").toBeTruthy();
				if (aWrite?.kind === "write" && bWrite?.kind === "write") {
					expect(aWrite.after.equals(bWrite.after)).toBe(true);
				}
			} finally {
				await cleanup(cwd);
			}
		});

		it("DRIFT-INLINE-STATIC-STYLE plan is deterministic over the same ctx.decisions.fixerChoices", async () => {
			const cwd = await freshTmpDir();
			try {
				await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
				await writeFile(
					join(cwd, "design-system/tokens.json"),
					JSON.stringify({
						spacing: { 2: "8", 4: "16" },
					}),
				);
				await writeFile(
					join(cwd, "design-system/atoms/card.tsx"),
					[
						`export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
						`export const meta = { kind: "atom" as const, examples: [] };`,
					].join("\n") + "\n",
				);

				const finding: DriftFinding = {
					ruleId: "DRIFT-INLINE-STATIC-STYLE",
					file: "design-system/atoms/card.tsx",
					message: "inline style",
				};
				// Equidistant-token answer: 0 = first nearest token (spacing-2).
				const ctx = makeFakeCtx(cwd, {
					decisions: {
						fixerChoices: {
							[findingKey(finding)]: { "token-tie:padding:12": 0 },
						},
					},
				});

				const a = (await fixerAsOperation(finding).plan(ctx)).changes;
				const b = (await fixerAsOperation(finding).plan(ctx)).changes;

				const aWrite = a.find((c) => c.kind === "write");
				const bWrite = b.find((c) => c.kind === "write");
				expect(aWrite?.kind).toBe("write");
				expect(bWrite?.kind).toBe("write");
				if (aWrite?.kind === "write" && bWrite?.kind === "write") {
					expect(aWrite.after.equals(bWrite.after)).toBe(true);
				}
			} finally {
				await cleanup(cwd);
			}
		});
	});
});
