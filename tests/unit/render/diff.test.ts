/**
 * PRD #325 sub-issue #330 — commitment-gate diffs reuse the Runner's
 * existing unified-diff output verbatim; color is applied at the render
 * layer, not inside the Runner. This file pins both halves: the pure
 * `renderCommitmentGateDiff(entries)` returns the Runner-shaped lines with
 * no color, and `colorizeDiffLines(lines, color)` paints them via an
 * injected adapter so picocolors stays out of the non-TTY hot path.
 */
import { describe, it, expect } from "vitest";
import {
  renderCommitmentGateDiff,
  colorizeDiffLines,
  identityColor,
  type ColorAdapter,
  type DiffEntry,
} from "../../../src/lib/render/index.js";
import type { Change } from "../../../src/lib/operation.js";

const WRITE_CREATE: Change = {
  kind: "write",
  path: "design-system/atoms/button.tsx",
  before: null,
  after: Buffer.from("export const Button = () => null;\n", "utf8"),
};

const WRITE_MODIFY: Change = {
  kind: "write",
  path: "design-system/atoms/button.tsx",
  before: Buffer.from("export const Button = () => null;\n", "utf8"),
  after: Buffer.from("export const Button = () => <button />;\n", "utf8"),
};

const DELETE: Change = {
  kind: "delete",
  path: "design-system/atoms/old.tsx",
  before: Buffer.from("export const Old = () => null;\n", "utf8"),
};

const RENAME: Change = {
  kind: "rename",
  path: "design-system/atoms/old.tsx",
  after: "design-system/atoms/new.tsx",
};

describe("renderCommitmentGateDiff (pure, reuses Runner output)", () => {
  it("renders a single write create with Runner formatting", () => {
    const entries: DiffEntry[] = [{ opName: "syncPackFiles", change: WRITE_CREATE }];
    expect(renderCommitmentGateDiff(entries)).toMatchInlineSnapshot(`
      [
        "[syncPackFiles] design-system/atoms/button.tsx (create)",
        "+export const Button = () => null;",
        "+",
      ]
    `);
  });

  it("renders write modify, delete, rename in one batch", () => {
    const entries: DiffEntry[] = [
      { opName: "fix", change: WRITE_MODIFY },
      { opName: "fix", change: DELETE },
      { opName: "rename", change: RENAME },
    ];
    expect(renderCommitmentGateDiff(entries)).toMatchInlineSnapshot(`
      [
        "[fix] design-system/atoms/button.tsx (modify)",
        "-export const Button = () => null;",
        "-",
        "+export const Button = () => <button />;",
        "+",
        "[fix] design-system/atoms/old.tsx (delete)",
        "-export const Old = () => null;",
        "-",
        "[rename] design-system/atoms/old.tsx -> design-system/atoms/new.tsx (rename)",
      ]
    `);
  });

  it("is pure — calling twice returns equal arrays", () => {
    const entries: DiffEntry[] = [{ opName: "syncPackFiles", change: WRITE_CREATE }];
    expect(renderCommitmentGateDiff(entries)).toEqual(renderCommitmentGateDiff(entries));
  });
});

describe("colorizeDiffLines (color adapter at the render layer)", () => {
  const recorder: ColorAdapter = {
    green: l => `G(${l})`,
    red: l => `R(${l})`,
    dim: l => `D(${l})`,
    bold: l => `B(${l})`,
    cyan: l => `C(${l})`,
  };

  it("colors +/- lines and dims op-header lines via the adapter", () => {
    const lines = [
      "[syncPackFiles] design-system/atoms/button.tsx (create)",
      "+export const Button = () => null;",
      "-export const Old = () => null;",
      " context line",
    ];
    expect(colorizeDiffLines(lines, recorder)).toEqual([
      "D([syncPackFiles] design-system/atoms/button.tsx (create))",
      "G(+export const Button = () => null;)",
      "R(-export const Old = () => null;)",
      " context line",
    ]);
  });

  it("identityColor leaves strings unchanged — used on the non-TTY path", () => {
    const lines = [
      "[op] path (create)",
      "+added",
      "-removed",
    ];
    expect(colorizeDiffLines(lines, identityColor)).toEqual(lines);
  });
});
