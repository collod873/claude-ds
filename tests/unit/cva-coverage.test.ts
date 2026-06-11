/**
 * Coverage-loss diagnostics (#570). Makes silent CVA coverage shrink visible
 * without changing detection/fix behavior. These pin the per-file warning
 * function's external behavior — which warnings fire, never internal walk shape.
 */

import { describe, expect, it } from "vitest";
import { cvaCoverageWarnings } from "../../src/lib/reports/cva-coverage.js";

describe("cvaCoverageWarnings — render-target resolution failure", () => {
	it("warns on an acronym export whose name does not match the file basename", () => {
		const source = `
import { cva } from "class-variance-authority";
const qrCode = cva("qr", { variants: { size: { sm: "s", lg: "l" } } });
export function QRCode({ size }: { size?: "sm" | "lg" }) {
  return <svg className={qrCode({ size })} />;
}
`;
		const warnings = cvaCoverageWarnings(source, "design-system/atoms/qr-code.tsx");
		const rt = warnings.find((w) => w.kind === "render-target-unresolved");
		expect(rt).toBeDefined();
		if (rt?.kind === "render-target-unresolved") {
			expect(rt.expected).toEqual(["QrCode", "qr-code"]);
			expect(rt.components).toContain("QRCode");
		}
	});

	it("stays silent when the export matches the file basename", () => {
		const source = `
import { cva } from "class-variance-authority";
const badge = cva("badge", { variants: { size: { sm: "s", lg: "l" } } });
export function Badge({ size }: { size?: "sm" | "lg" }) {
  return <span className={badge({ size })} />;
}
`;
		expect(cvaCoverageWarnings(source, "design-system/atoms/badge.tsx")).toEqual([]);
	});
});

describe("cvaCoverageWarnings — unresolvable props type", () => {
	it("warns when a cva-consuming component's props type is externally typed and an axis is dropped", () => {
		const source = `
import { cva } from "class-variance-authority";
import type { BadgeProps } from "./badge-types";
const badge = cva("badge", { variants: { tone: { neutral: "n", danger: "d" } } });
export function Badge(props: BadgeProps) {
  return <span className={badge({ tone: "neutral" })} {...props} />;
}
`;
		const warnings = cvaCoverageWarnings(source, "design-system/atoms/badge.tsx");
		const up = warnings.find((w) => w.kind === "unresolvable-props");
		expect(up).toBeDefined();
		if (up?.kind === "unresolvable-props") {
			expect(up.component).toBe("Badge");
			expect(up.unresolvedType).toBe("BadgeProps");
			expect(up.axes).toContain("tone");
		}
	});

	it("stays silent when the axis is exposed via a locally-resolvable props type", () => {
		const source = `
import { cva, type VariantProps } from "class-variance-authority";
const badge = cva("badge", { variants: { tone: { neutral: "n", danger: "d" } } });
interface BadgeProps extends VariantProps<typeof badge> {}
export function Badge(props: BadgeProps) {
  return <span className={badge(props)} />;
}
`;
		expect(cvaCoverageWarnings(source, "design-system/atoms/badge.tsx")).toEqual([]);
	});

	it("stays silent when no props type exists (hardcoded axis is provably not a prop)", () => {
		const source = `
import { cva } from "class-variance-authority";
const badge = cva("badge", { variants: { tone: { neutral: "n", danger: "d" } } });
export function Badge() {
  return <span className={badge({ tone: "neutral" })} />;
}
`;
		expect(cvaCoverageWarnings(source, "design-system/atoms/badge.tsx")).toEqual([]);
	});

	it("does not warn on a file with no cva at all", () => {
		const source = `export function Badge() { return <span />; }`;
		expect(cvaCoverageWarnings(source, "design-system/atoms/badge.tsx")).toEqual([]);
	});
});
