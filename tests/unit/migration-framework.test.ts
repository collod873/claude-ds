import { describe, it, expect } from "vitest";
import { computeMigrationChain } from "../../src/lib/migration-framework.js";
import type { MigrationVersion } from "../../src/lib/migration-framework.js";
import type { Operation, Change } from "../../src/lib/operation.js";
import type { ProjectContext } from "../../src/lib/project.js";

function mockOp(name: string): Operation {
  return {
    name,
    async plan(_ctx: ProjectContext): Promise<Change[]> { return []; },
  };
}

const registry: MigrationVersion[] = [
  { version: "v0.7.0", ops: [mockOp("op-v0.7.0")] },
  { version: "v0.8.0", ops: [mockOp("op-v0.8.0-a"), mockOp("op-v0.8.0-b")] },
  { version: "v0.9.0", ops: [mockOp("op-v0.9.0")] },
  { version: "v1.0.0", ops: [mockOp("op-v1.0.0")] },
];

describe("computeMigrationChain", () => {
  it("returns versions strictly after from up to and including to", () => {
    const chain = computeMigrationChain("v0.7.5", "v0.9.0", registry);
    expect(chain.map((mv) => mv.version)).toEqual(["v0.8.0", "v0.9.0"]);
  });

  it("chains all versions when from is behind all registered versions", () => {
    const chain = computeMigrationChain("v0.6.0", "v1.0.0", registry);
    expect(chain.map((mv) => mv.version)).toEqual(["v0.7.0", "v0.8.0", "v0.9.0", "v1.0.0"]);
  });

  it("returns empty when already at target", () => {
    const chain = computeMigrationChain("v0.9.0", "v0.9.0", registry);
    expect(chain).toHaveLength(0);
  });

  it("excludes from version itself (strict greater-than)", () => {
    const chain = computeMigrationChain("v0.8.0", "v1.0.0", registry);
    expect(chain.map((mv) => mv.version)).toEqual(["v0.9.0", "v1.0.0"]);
  });

  it("returns empty when to is before all registered migrations", () => {
    const chain = computeMigrationChain("v0.5.0", "v0.6.0", registry);
    expect(chain).toHaveLength(0);
  });

  it("returns a single version when from and to are adjacent", () => {
    const chain = computeMigrationChain("v0.8.0", "v0.9.0", registry);
    expect(chain.map((mv) => mv.version)).toEqual(["v0.9.0"]);
    expect(chain[0].ops).toHaveLength(1);
  });

  it("preserves multiple ops registered for the same version", () => {
    const chain = computeMigrationChain("v0.7.0", "v0.8.0", registry);
    expect(chain).toHaveLength(1);
    expect(chain[0].version).toBe("v0.8.0");
    expect(chain[0].ops).toHaveLength(2);
  });

  it("sorts registry versions ascending even if provided out of order", () => {
    const unordered: MigrationVersion[] = [
      { version: "v0.9.0", ops: [mockOp("op-0.9")] },
      { version: "v0.8.0", ops: [mockOp("op-0.8")] },
    ];
    const chain = computeMigrationChain("v0.7.0", "v0.9.0", unordered);
    expect(chain.map((mv) => mv.version)).toEqual(["v0.8.0", "v0.9.0"]);
  });

  it("handles pre-release versions in from (treats them as the base version for math)", () => {
    const chain = computeMigrationChain("v0.8.0-rc.1", "v0.9.0", registry);
    // v0.8.0-rc.1 < v0.8.0 in strict semver, but parseSemver strips pre-release
    // so v0.8.0-rc.1 compares equal to v0.8.0 in our math → v0.8.0 is NOT included
    expect(chain.map((mv) => mv.version)).toEqual(["v0.9.0"]);
  });
});
