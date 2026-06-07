/**
 * PRD #340 sub-issue #344 — summary-default rendering for mutating commands.
 *
 * The friction this rendering kills: a one-token import swap across 34 files
 * dumped 30k+ lines of full file diff and buried the one substantive change
 * (a config-flag flip). The summary surfaces flag flips first and collapses
 * each file rewrite to a single line. `--diff` opts back into the verbose
 * Runner output; `--json` is the machine surface.
 */
import { describe, it, expect } from "vitest";
import {
  renderChangeSummary,
  renderChangesJson,
  type SummaryEntry,
} from "../../../src/lib/render/index.js";
import type { Change } from "../../../src/lib/operation.js";

function write(path: string, before: string | null, after: string): Change {
  return {
    kind: "write",
    path,
    before: before === null ? null : Buffer.from(before, "utf8"),
    after: Buffer.from(after, "utf8"),
  };
}

function del(path: string, before: string): Change {
  return { kind: "delete", path, before: Buffer.from(before, "utf8") };
}

function abort(path: string, reason: string): Change {
  return { kind: "abort", path, reason };
}

function rename(path: string, after: string): Change {
  return { kind: "rename", path, after };
}

describe("renderChangeSummary", () => {
  it("returns 'No changes.' on empty input", () => {
    expect(renderChangeSummary([])).toEqual(["No changes."]);
  });

  it("renders one line per regular file change", () => {
    const entries: SummaryEntry[] = [
      { opName: "syncPackFiles", change: write("design-system/atoms/button.tsx", "old\n", "new\n") },
      { opName: "syncPackFiles", change: write("design-system/atoms/card.tsx", null, "fresh\n") },
      { opName: "reconcile", change: del("design-system/atoms/orphan.tsx", "old\n") },
      { opName: "migrate-layout", change: rename("foo.tsx", "bar.tsx") },
    ];
    expect(renderChangeSummary(entries)).toMatchInlineSnapshot(`
      [
        "M design-system/atoms/button.tsx",
        "A design-system/atoms/card.tsx",
        "D design-system/atoms/orphan.tsx",
        "R foo.tsx -> bar.tsx",
      ]
    `);
  });

  it("surfaces config-flag flips first with key callouts", () => {
    const before = JSON.stringify(
      { pack: "next-react", packVersion: "v1.0.0", meta_kind_strict: false },
      null,
      2,
    );
    const after = JSON.stringify(
      { pack: "next-react", packVersion: "v1.1.0", meta_kind_strict: true },
      null,
      2,
    );
    const entries: SummaryEntry[] = [
      { opName: "rewriteDsImports", change: write("design-system/atoms/button.tsx", "import x from '@/design-system/foo';\n", "import x from '@ds/foo';\n") },
      { opName: "meta-kind-hard", change: write(".claude-ds.json", before, after) },
    ];
    const lines = renderChangeSummary(entries);
    expect(lines[0]).toBe("Substantive changes:");
    expect(lines).toContain("! .claude-ds.json  (config flags flipped)");
    expect(lines.some(l => l.includes('packVersion: "v1.0.0" -> "v1.1.0"'))).toBe(true);
    expect(lines.some(l => l.includes("meta_kind_strict: false -> true"))).toBe(true);
    expect(lines).toContain("Other changes:");
    // The import-only file is condensed:
    expect(lines).toContain("M design-system/atoms/button.tsx  (1 import rewritten)");
  });

  it("calls out import-only rewrites with rewrite count", () => {
    const before = [
      "import { Foo } from '@/design-system/foo';",
      "import { Bar } from '@/design-system/bar';",
      "",
      "export const Thing = () => <Foo />;",
      "",
    ].join("\n");
    const after = [
      "import { Foo } from '@ds/foo';",
      "import { Bar } from '@ds/bar';",
      "",
      "export const Thing = () => <Foo />;",
      "",
    ].join("\n");
    const entries: SummaryEntry[] = [
      { opName: "rewriteDsImports", change: write("thing.tsx", before, after) },
    ];
    expect(renderChangeSummary(entries)).toEqual([
      "M thing.tsx  (2 imports rewritten)",
    ]);
  });

  it("collapses aborts to a count, multi-reason → breakdown", () => {
    const entries: SummaryEntry[] = [
      { opName: "syncPackFiles", change: write("a.tsx", "old\n", "new\n") },
      { opName: "syncPackFiles", change: abort("b.tsx", "hand-edited managed file") },
      { opName: "syncPackFiles", change: abort("c.tsx", "hand-edited managed file") },
      { opName: "syncPackFiles", change: abort("d.tsx", "conflict with consumer fragment") },
    ];
    const lines = renderChangeSummary(entries);
    expect(lines).toContain("M a.tsx");
    expect(lines).toContain("Skipped: 3 files (hand-edited or unsafe to overwrite)");
    expect(lines).toContain("  2x hand-edited managed file");
    expect(lines).toContain("  1x conflict with consumer fragment");
  });

  it("collapses single-reason aborts to a count without the breakdown", () => {
    const entries: SummaryEntry[] = [
      { opName: "syncPackFiles", change: abort("a.tsx", "hand-edited managed file") },
    ];
    const lines = renderChangeSummary(entries);
    expect(lines).toContain("Skipped: 1 file (hand-edited or unsafe to overwrite)");
    // No per-reason breakdown when one reason
    expect(lines.some(l => l.includes("1x"))).toBe(false);
  });

  it("is pure — calling twice returns equal arrays", () => {
    const entries: SummaryEntry[] = [
      { opName: "op", change: write("a.tsx", "x\n", "y\n") },
    ];
    expect(renderChangeSummary(entries)).toEqual(renderChangeSummary(entries));
  });
});

describe("renderChangesJson", () => {
  it("emits a stable shape, byte buffers stripped", () => {
    const entries: SummaryEntry[] = [
      { opName: "syncPackFiles", change: write("a.tsx", null, "fresh\n") },
      { opName: "syncPackFiles", change: write("b.tsx", "old\n", "new\n") },
      { opName: "reconcile", change: del("c.tsx", "old\n") },
      { opName: "migrate-layout", change: rename("d.tsx", "e.tsx") },
      { opName: "syncPackFiles", change: abort("f.tsx", "hand-edited") },
    ];
    const parsed = JSON.parse(renderChangesJson(entries)) as { changes: unknown[] };
    expect(parsed).toEqual({
      changes: [
        { op: "syncPackFiles", kind: "write", path: "a.tsx", created: true },
        { op: "syncPackFiles", kind: "write", path: "b.tsx", created: false },
        { op: "reconcile", kind: "delete", path: "c.tsx" },
        { op: "migrate-layout", kind: "rename", path: "d.tsx", after: "e.tsx" },
        { op: "syncPackFiles", kind: "abort", path: "f.tsx", reason: "hand-edited" },
      ],
    });
  });

  it("emits valid JSON on empty input", () => {
    expect(JSON.parse(renderChangesJson([]))).toEqual({ changes: [] });
  });
});
