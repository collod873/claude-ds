/**
 * PRD #325 sub-issue #332 — live progress UI for long-running TTY commands.
 *
 * The progress layer is TTY-only. On non-TTY the controller is a no-op so the
 * command's existing `info()` lines remain the user-facing output (the issue
 * pins "non-TTY runs emit today's plain log output with no progress UI"). On
 * TTY the controller drives `ora`, writes to stderr, and supports per-phase
 * start/succeed/fail with a status `info` line for things like the heal
 * iteration counter.
 *
 * The Ctrl-C smoke test asserts the SIGINT handler is registered and
 * deregistered around the run — the mechanical guarantee `ora` calls out
 * (cursor restore, spinner clear). We never raise SIGINT inside the test
 * runner; we just inspect the listener delta.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgress } from "../../../src/lib/render/tty-layer.js";

describe("createProgress (PRD #325 / sub-issue #332)", () => {
	const origStdoutIsTTY = process.stdout.isTTY;
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	let captured: string[] = [];

	beforeEach(() => {
		captured = [];
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stderr.write = origStderrWrite;
		Object.defineProperty(process.stdout, "isTTY", {
			value: origStdoutIsTTY,
			writable: true,
			configurable: true,
		});
	});

	describe("non-TTY", () => {
		it("returns a no-op controller (enabled === false)", () => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: false,
				writable: true,
				configurable: true,
			});
			const p = createProgress();
			expect(p.enabled).toBe(false);
		});

		it("non-TTY: start/succeed/fail/info/stop produce no stderr bytes", () => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: false,
				writable: true,
				configurable: true,
			});
			const p = createProgress();
			p.start("sync");
			p.succeed("sync");
			p.info("iteration 1/3");
			p.start("audit --fix");
			p.fail("audit --fix");
			p.stop();
			expect(captured.join("")).toBe("");
		});
	});

	describe("TTY", () => {
		beforeEach(() => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});
		});

		it("returns an enabled controller", () => {
			const p = createProgress();
			try {
				expect(p.enabled).toBe(true);
			} finally {
				p.stop();
			}
		});

		it("succeed writes a line containing the phase text to stderr", () => {
			const p = createProgress();
			try {
				p.start("sync");
				p.succeed("sync");
			} finally {
				p.stop();
			}
			const out = captured.join("");
			expect(out).toMatch(/sync/);
		});

		it("fail writes a line containing the phase text", () => {
			const p = createProgress();
			try {
				p.start("audit --fix");
				p.fail("audit --fix — did not converge");
			} finally {
				p.stop();
			}
			const out = captured.join("");
			expect(out).toMatch(/audit --fix/);
			expect(out).toMatch(/did not converge/);
		});

		it("info writes the status line (used for the heal iteration counter)", () => {
			const p = createProgress();
			try {
				p.info("iteration 1/3");
			} finally {
				p.stop();
			}
			expect(captured.join("")).toMatch(/iteration 1\/3/);
		});

		it("registers a SIGINT handler while active and removes it on stop", () => {
			const before = process.listenerCount("SIGINT");
			const p = createProgress();
			const duringCreate = process.listenerCount("SIGINT");
			expect(duringCreate).toBe(before + 1);
			p.start("sync");
			p.stop();
			const after = process.listenerCount("SIGINT");
			expect(after).toBe(before);
		});

		it("stop() is idempotent — multiple calls do not double-remove the SIGINT handler", () => {
			const before = process.listenerCount("SIGINT");
			const p = createProgress();
			p.start("sync");
			p.stop();
			p.stop();
			expect(process.listenerCount("SIGINT")).toBe(before);
		});
	});
});
