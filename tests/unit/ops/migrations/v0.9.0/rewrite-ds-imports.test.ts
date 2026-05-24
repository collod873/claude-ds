import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rewriteDsImports } from "../../../../../src/lib/ops/migrations/v0.9.0/rewrite-ds-imports";
import { run } from "../../../../../src/lib/runner";
import type { ProjectContext } from "../../../../../src/lib/project";
import type { Config } from "../../../../../src/lib/config";
import type { Manifest } from "../../../../../src/lib/manifest";
import { cleanup, freshTmpDir } from "../../../../helpers/tmpdir";

const emptyManifest: Manifest = {
  files: [], canonical_paths: [], lookalike_ignore: [], deprecated_paths: [], managed_roots: [],
};

let cwd: string;
beforeEach(async () => { cwd = await freshTmpDir("rewrite-ds-imports-"); });
afterEach(async () => { await cleanup(cwd); });

function fakeCtx(): ProjectContext {
  const cfg: Config = {
    packVersion: "v0.8.0", pack: "next-react", mode: "warn",
    enforce_threshold: 10, removed: [], lookalike_ignore: [],
    app_dir: "app", claude_md_target: ".claude/CLAUDE.md",
    domain_roots: ["features", "lib"], srcRoot: "src",
  };
  return {
    cwd,
    cfg,
    packDir: "/nonexistent",
    manifest: emptyManifest,
    exists: async (p) => { try { await stat(join(cwd, p)); return true; } catch { return false; } },
    decisions: {},
  };
}

describe("rewriteDsImports op", () => {
  it("rewrites @/design-system/atoms/button → @ds/atoms/button", async () => {
    await mkdir(join(cwd, "app"), { recursive: true });
    await writeFile(
      join(cwd, "app", "page.tsx"),
      `import { Button } from "@/design-system/atoms/button";\nexport default function P() { return null; }\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    const after = changes[0].after.toString("utf8");
    expect(after).toContain(`from "@ds/atoms/button"`);
    expect(after).not.toContain(`@/design-system`);
  });

  it("rewrites @/design-system/composites/card → @ds/composites/card", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "component.tsx"),
      `import { Card } from "@/design-system/composites/card";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    expect(changes[0].after.toString("utf8")).toContain(`from "@ds/composites/card"`);
  });

  it("rewrites @/design-system/types/meta structural imports too", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "meta-user.tsx"),
      `import type { Meta } from "@/design-system/types/meta";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    expect(changes[0].after.toString("utf8")).toContain(`from "@ds/types/meta"`);
  });

  it("rewrites relative paths ../../design-system/atoms/button → @ds/atoms/button", async () => {
    await mkdir(join(cwd, "src", "features", "invoicing"), { recursive: true });
    await writeFile(
      join(cwd, "src", "features", "invoicing", "form.tsx"),
      `import { Button } from "../../design-system/atoms/button";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    expect(changes[0].after.toString("utf8")).toContain(`from "@ds/atoms/button"`);
  });

  it("rewrites ../design-system/atoms/button → @ds/atoms/button", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "component.tsx"),
      `import { Button } from "../design-system/atoms/button";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    expect(changes[0].after.toString("utf8")).toContain(`from "@ds/atoms/button"`);
  });

  it("handles mixed @/design-system and relative imports in the same file", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "mixed.tsx"),
      [
        `import { Button } from "@/design-system/atoms/button";`,
        `import { Card } from "../../design-system/composites/card";`,
        `import type { Meta } from "@/design-system/types/meta";`,
        `import { useState } from "react";`,
        ``,
      ].join("\n"),
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toHaveLength(1);
    if (changes[0].kind !== "write") throw new Error("expected write");
    const after = changes[0].after.toString("utf8");
    expect(after).toContain(`from "@ds/atoms/button"`);
    expect(after).toContain(`from "@ds/composites/card"`);
    expect(after).toContain(`from "@ds/types/meta"`);
    expect(after).toContain(`from "react"`);
    expect(after).not.toContain(`@/design-system`);
    expect(after).not.toContain(`design-system/`);
  });

  it("is idempotent: @ds/* imports are not re-rewritten", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "already.tsx"),
      `import { Button } from "@ds/atoms/button";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toEqual([]);
  });

  it("is idempotent: applying then re-planning returns []", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "component.tsx"),
      `import { Button } from "@/design-system/atoms/button";\n`,
    );

    const ctx = fakeCtx();
    const report = await run(ctx, [rewriteDsImports], "apply");
    expect(report.failed).toBeUndefined();
    expect(report.applied).toHaveLength(1);

    const second = await rewriteDsImports.plan(ctx);
    expect(second).toEqual([]);
  });

  it("does not touch node_modules or .git", async () => {
    await mkdir(join(cwd, "node_modules", "junk"), { recursive: true });
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeFile(
      join(cwd, "node_modules", "junk", "f.ts"),
      `import { Button } from "@/design-system/atoms/button";\n`,
    );
    await writeFile(
      join(cwd, ".git", "hook.ts"),
      `import { Button } from "@/design-system/atoms/button";\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toEqual([]);
  });

  it("returns [] for an empty project", async () => {
    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toEqual([]);
  });

  it("returns [] for files without design-system imports", async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "util.ts"),
      `import { useState } from "react";\nexport const noop = () => {};\n`,
    );

    const changes = await rewriteDsImports.plan(fakeCtx());
    expect(changes).toEqual([]);
  });
});
