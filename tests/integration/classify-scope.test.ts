import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join, relative } from "node:path";

// PRD #241 / sub-issue #246 — settle #209 with evidence. Two flavors of guard:
//
// 1. The HITL check: bare `claude-ds classify` against a Crewops-like brownfield
//    tree must leave src/ entirely untouched. The HITL acceptance literally
//    inspects `git status` after `claude-ds classify` — any non-design-system
//    path in the diff is a fail.
//
// 2. Scope narrowing under explicit --src: even when the user opts into a
//    brownfield walk, classify must refuse zero-signal non-React modules,
//    lookalike_ignore paths, app dir, domain roots, and the source root
//    itself. These are the corner cases that turned 191 files into atoms
//    on the original Crewops run.

const BASE_CFG = {
  packVersion: "v0.8.0",
  pack: "next-react",
  mode: "warn",
  enforce_threshold: 10,
  removed: [],
  lookalike_ignore: [],
  app_dir: "app",
  claude_md_target: ".claude/CLAUDE.md",
  domain_roots: ["features", "lib"],
};

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs);
        result.set(rel, await readFile(abs, "utf8"));
      }
    }
  }
  await walk(root);
  return result;
}

function assertSameTree(before: Map<string, string>, after: Map<string, string>): void {
  // Same set of paths
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  // Same content for every path
  for (const [path, content] of before) {
    expect(after.get(path), `content of ${path}`).toBe(content);
  }
}

describe("classify scope confinement (#209, PRD #241)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir();
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  describe("bare classify (no --src) — the HITL acceptance shape", () => {
    it("leaves every path under src/ untouched on a Crewops-like brownfield tree", async () => {
      // Closely mirrors the Crewops baseline shape: routed pages, server
      // modules, db schema, emails, a shadcn-style components/ui dir, and
      // colocated feature components under app/_components.
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));

      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "design-system/composites"), { recursive: true });

      // Existing DS atom so classify has *something* to consider in-DS.
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        `export function Button() { return <button/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      // App router pages & API routes — server side, never DS parts.
      await mkdir(join(dir, "src/app/api/dev"), { recursive: true });
      await mkdir(join(dir, "src/app/dashboard"), { recursive: true });
      await mkdir(join(dir, "src/app/_components"), { recursive: true });

      await writeFile(
        join(dir, "src/app/api/dev/route.ts"),
        `export async function GET() { return new Response("ok"); }\n`,
      );
      await writeFile(
        join(dir, "src/app/dashboard/page.tsx"),
        `export default function Page() { return <main>dashboard</main>; }\n`,
      );
      // Feature component colocated under app/_components, imports DS via @/ alias.
      await writeFile(
        join(dir, "src/app/_components/invoice-list.tsx"),
        `import { Button } from "@/design-system/atoms/button";\nexport function InvoiceList() { return <Button/>; }\n`,
      );

      // Server utility / DB / emails — pre-#209 fix, classify dragged these into atoms/.
      await mkdir(join(dir, "src/lib"), { recursive: true });
      await mkdir(join(dir, "src/db/schema"), { recursive: true });
      await mkdir(join(dir, "src/emails"), { recursive: true });
      await writeFile(
        join(dir, "src/lib/stripe.ts"),
        `export function makeCharge() { return null; }\n`,
      );
      await writeFile(
        join(dir, "src/lib/utils.ts"),
        `export function cn(...c: string[]) { return c.join(" "); }\n`,
      );
      await writeFile(
        join(dir, "src/db/schema/auth.ts"),
        `export const usersTable = { name: "users" };\n`,
      );
      await writeFile(
        join(dir, "src/emails/welcome.tsx"),
        `export function Welcome() { return <div>hi</div>; }\n`,
      );

      // Shadcn-style components/ui dir — DS source, but bare classify must not walk it.
      await mkdir(join(dir, "src/components/ui"), { recursive: true });
      await writeFile(
        join(dir, "src/components/ui/badge.tsx"),
        `export function Badge() { return <span>b</span>; }\n`,
      );

      const before = await snapshotTree(join(dir, "src"));
      expect(before.size).toBeGreaterThan(0);

      const r = await runCli(["classify"], { cwd: dir });
      expect(r.code).toBe(0);

      const after = await snapshotTree(join(dir, "src"));
      assertSameTree(before, after);
    });
  });

  describe("--src brownfield pull-in — scope narrowing", () => {
    it("excludes lookalike_ignore paths from the walk", async () => {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({
          ...BASE_CFG,
          lookalike_ignore: ["src/components/ui/internal/**"],
        }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "src/components/ui/internal"), { recursive: true });

      // File matched by lookalike_ignore — must stay put.
      await writeFile(
        join(dir, "src/components/ui/internal/private.tsx"),
        `export function Private() { return <span/>; }\n`,
      );

      const r = await runCli(["classify", "--src", "src/components/ui", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);

      // Did NOT get moved into design-system/atoms/.
      await expect(
        access(join(dir, "design-system/atoms/private.tsx")),
      ).rejects.toThrow();
      // Stayed where it was.
      await expect(
        access(join(dir, "src/components/ui/internal/private.tsx")),
      ).resolves.toBeUndefined();
    });

    it("excludes the configured app dir from the walk", async () => {
      // app_dir="src/app" — anything under src/app must be excluded even when
      // the user points --src at src/app itself.
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ ...BASE_CFG, app_dir: "src/app" }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "src/app/_components"), { recursive: true });
      await writeFile(
        join(dir, "src/app/_components/sidebar.tsx"),
        `export function Sidebar() { return <aside/>; }\n`,
      );

      const r = await runCli(["classify", "--src", "src/app", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);

      // Sidebar stayed put.
      await expect(
        access(join(dir, "src/app/_components/sidebar.tsx")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, "design-system/atoms/sidebar.tsx")),
      ).rejects.toThrow();
    });

    it("refuses a --src that targets the source root itself", async () => {
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
      await mkdir(join(dir, "src/components"), { recursive: true });

      const r = await runCli(["classify", "--src", "src"], { cwd: dir });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/refusing to walk the entire source root/);
    });

    it("does NOT pull non-React .ts modules into design-system/atoms/", async () => {
      // The smoking gun from the #209 reproduction: lib/stripe.ts,
      // db/schema/auth.ts, app/api/route.ts all classified as "atom" and got
      // moved into design-system/atoms/. Even when the user explicitly points
      // --src at a dir that happens to contain server-side .ts modules
      // (e.g. test files alongside components), zero-signal .ts files must
      // not default to atom and silently relocate.
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "src/components"), { recursive: true });

      // A real .tsx atom — should move.
      await writeFile(
        join(dir, "src/components/badge.tsx"),
        `export function Badge() { return <span/>; }\n`,
      );
      // A server-side .ts utility — must NOT move.
      await writeFile(
        join(dir, "src/components/format.ts"),
        `export function formatCurrency(n: number) { return "$" + n.toFixed(2); }\n`,
      );
      // A server-side .ts test file (companion suffix only covers .test.tsx).
      await writeFile(
        join(dir, "src/components/util.test.ts"),
        `import { test } from "vitest"; test("noop", () => {});\n`,
      );

      const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
      expect(r.code).toBe(0);

      // .tsx atom did move.
      await expect(
        access(join(dir, "design-system/atoms/badge.tsx")),
      ).resolves.toBeUndefined();

      // .ts files did NOT move into atoms/.
      await expect(
        access(join(dir, "design-system/atoms/format.ts")),
      ).rejects.toThrow();
      await expect(
        access(join(dir, "design-system/atoms/util.test.ts")),
      ).rejects.toThrow();

      // They stayed in src/components/.
      await expect(
        access(join(dir, "src/components/format.ts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, "src/components/util.test.ts")),
      ).resolves.toBeUndefined();
    });
  });
});
