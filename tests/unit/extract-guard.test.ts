import { describe, expect, it } from "vitest";
import { __test } from "../../src/lib/ops/extract-inline-components";

const { planFile } = __test;

// Regression guard for #259, fix-direction 3: classify must not extract a child
// component out of a parent that does not resolve its own symbols — doing so
// mints a fresh broken atom (Crewops `file-uploader-row.tsx` from a corrupt
// `row.tsx`). A healthy parent still extracts normally.
//
// `findInternalComponents` only flags inline components of >=20 lines, so the
// shared `FileUploaderRow` body below is deliberately long enough to be a real
// extraction candidate. That makes the A/B meaningful: the ONLY difference
// between the healthy and broken variants is whether the parent resolves.

const INLINE_BODY = `function FileUploaderRow(props: { label: string; progress: number }) {
  const pct = Math.round(props.progress * 100);
  const status = pct >= 100 ? "done" : "uploading";
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push(i);
  }
  return (
    <div className={cn("file-uploader-row", status)}>
      <Paperclip />
      <span className="label">{props.label}</span>
      <span className="status">{status}</span>
      <span className="pct">{pct}%</span>
      <Button variant="ghost">
        <X />
      </Button>
      <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}

export function Row() {
  return (
    <div>
      <FileUploaderRow label="upload" progress={0.5} />
    </div>
  );
}
`;

const HEALTHY_IMPORTS = `import { Button } from "@/design-system/atoms/button";
import { Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";

`;

describe("extract guard — non-resolving parent (#259)", () => {
	it("still extracts from a healthy parent (positive control)", () => {
		const source = HEALTHY_IMPORTS + INLINE_BODY;
		const plan = planFile(source, "design-system/atoms/row.tsx", "@/design-system", new Set());
		expect(plan.extractions.map((e) => e.componentName)).toEqual(["FileUploaderRow"]);
		expect(plan.extractions[0].atomRel).toBe("design-system/atoms/file-uploader-row.tsx");
	});

	it("refuses extraction when the same parent's imports are stripped (unbound symbols)", () => {
		// Identical body, import block gone — references unbound Button/cn/Paperclip/X.
		const source = INLINE_BODY;
		const plan = planFile(source, "design-system/atoms/row.tsx", "@/design-system", new Set());
		expect(plan.extractions).toEqual([]);
		expect(plan.changes).toEqual([]);
	});

	it("refuses extraction when the parent duplicates a top-level function", () => {
		const source =
			HEALTHY_IMPORTS + INLINE_BODY + "\n" + INLINE_BODY.split("\nexport function Row")[0];
		const plan = planFile(source, "design-system/atoms/row.tsx", "@/design-system", new Set());
		expect(plan.extractions).toEqual([]);
		expect(plan.changes).toEqual([]);
	});
});
