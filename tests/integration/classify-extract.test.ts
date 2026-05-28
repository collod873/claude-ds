import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// A tsconfig + ambient JSX shim that lets the produced files compile with the
// project's own tsc — no react/@types needed. `@/*` maps to the fixture root so
// the atom import classify writes (`@/design-system/atoms/...`) resolves.
const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      jsx: "preserve",
      baseUrl: ".",
      paths: { "@/*": ["*"] },
    },
    include: ["design-system", "utils", "jsx.d.ts"],
  },
  null,
  2,
);

const JSX_SHIM = `declare namespace JSX {
  interface IntrinsicElements { [elem: string]: any; }
  interface Element {}
}
`;

/** Inline component (>=20 lines) referencing one import + three local decls. */
const CALENDAR_TSX = `import { Button } from "@/design-system/atoms/button";
import { formatDay } from "@/utils/format";

type DayProps = { label: string };

const WEEK_LENGTH = 7;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function DayList(props: { days: DayProps[] }) {
  // Render each provided day, formatted for display.
  // Pad out to a full week so the layout never collapses.
  const labels = props.days.map((d) => formatDay(d.label));
  const count = pad(labels.length);
  const filled: string[] = [];
  for (let i = 0; i < WEEK_LENGTH; i++) {
    filled.push(labels[i] ?? "-");
  }
  return (
    <div className="day-list">
      <span className="count">{count}</span>
      <ul>
        {filled.map((label, i) => (
          <li key={i}>{label}</li>
        ))}
      </ul>
    </div>
  );
}

export function Calendar() {
  const weeks = WEEK_LENGTH;
  return (
    <div>
      <Button />
      <DayList days={[{ label: "Mon" }]} />
      <small>{weeks}</small>
    </div>
  );
}
`;

const BUTTON_STUB = `export function Button() {
  return <button type="button" />;
}

export const meta = { kind: "atom" as const, examples: [] };
`;

const FORMAT_STUB = `export function formatDay(label: string): string {
  return label.trim();
}
`;

async function readDsAtom(dir: string, kebab: string): Promise<string> {
  return readFile(join(dir, "design-system", "atoms", `${kebab}.tsx`), "utf8");
}

function runTsc(dir: string): { status: number | null; out: string } {
  const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
  const tscBin = join(projectRoot, "node_modules", ".bin", "tsc");
  const r = spawnSync(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("classify — inline component extraction", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir();
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  async function scaffold(): Promise<void> {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await writeFile(join(dir, "tsconfig.json"), TSCONFIG);
    await writeFile(join(dir, "jsx.d.ts"), JSX_SHIM);
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "utils"), { recursive: true });
    await writeFile(join(dir, "design-system/atoms/button.tsx"), BUTTON_STUB);
    await writeFile(join(dir, "utils/format.ts"), FORMAT_STUB);
    await writeFile(join(dir, "src/components/calendar.tsx"), CALENDAR_TSX);
  }

  it("extracts an inline component into its own atom and rewires the parent", async () => {
    await scaffold();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    // New atom file exists with the extracted component + meta.kind atom.
    const atom = await readDsAtom(dir, "day-list");
    expect(atom).toMatch(/export function DayList\b/);
    expect(atom).toMatch(/kind:\s*["']atom["']/);

    // Carried dependencies: the import it referenced, the moved helper + type.
    expect(atom).toMatch(/import \{ formatDay \} from "@\/utils\/format"/);
    expect(atom).toMatch(/function pad\(/);
    expect(atom).toMatch(/type DayProps =/);
    // WEEK_LENGTH is used by the parent too, so it is copied (present in both).
    expect(atom).toMatch(/const WEEK_LENGTH = 7/);
    // It must NOT carry the Button import (parent uses it, the atom doesn't).
    expect(atom).not.toMatch(/atoms\/button/);

    // Parent: body removed, atom imported, copied const retained.
    const parent = await readFile(join(dir, "design-system/composites/calendar.tsx"), "utf8");
    expect(parent).not.toMatch(/function DayList\b/);
    expect(parent).not.toMatch(/function pad\(/);
    expect(parent).not.toMatch(/type DayProps =/);
    expect(parent).toMatch(/import \{ DayList \} from "@\/design-system\/atoms\/day-list"/);
    expect(parent).toMatch(/const WEEK_LENGTH = 7/);
  });

  it("produces tsc-clean output (no missing imports, no duplicate decls)", async () => {
    await scaffold();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const tsc = runTsc(dir);
    if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
    expect(tsc.status).toBe(0);
  }, 90_000);

  it("prints an end-of-run summary of extracted components", async () => {
    await scaffold();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/extracted 1 inline component/i);
    expect(r.stdout).toMatch(/DayList/);
    expect(r.stdout).toMatch(/design-system\/atoms\/day-list\.tsx/);
  });

  it("handles a composite with two inline components in one pass", async () => {
    await scaffold();
    // Replace calendar with a two-inline-component composite.
    await writeFile(
      join(dir, "src/components/dashboard.tsx"),
      `import { Button } from "@/design-system/atoms/button";

function StatTile(props: { value: number }) {
  // A standalone stat tile, clearly its own atom.
  // Padded out below to clear the >=20 line extraction
  // threshold that findInternalComponents enforces, so
  // this component is recognised as worth extracting.
  const display = props.value.toFixed(2);
  const tone = props.value > 0 ? "up" : "down";
  const rows = [display, tone];
  const heading = "stat";
  return (
    <div className="stat-tile">
      <strong>{heading}</strong>
      <span className={tone}>{display}</span>
      <ul>
        {rows.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function TrendBadge(props: { delta: number }) {
  // A standalone trend badge, also its own atom.
  // Padded out below to clear the >=20 line extraction
  // threshold that findInternalComponents enforces, so
  // this component is recognised as worth extracting.
  const arrow = props.delta >= 0 ? "^" : "v";
  const label = Math.abs(props.delta).toString();
  const parts = [arrow, label];
  const heading = "trend";
  return (
    <span className="trend-badge">
      <strong>{heading}</strong>
      <ul>
        {parts.map((p, i) => (
          <em key={i}>{p}</em>
        ))}
      </ul>
    </span>
  );
}

export function Dashboard() {
  return (
    <div>
      <Button />
      <StatTile value={1.5} />
      <TrendBadge delta={-2} />
    </div>
  );
}
`,
    );

    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    await expect(access(join(dir, "design-system/atoms/stat-tile.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/atoms/trend-badge.tsx"))).resolves.toBeUndefined();

    const parent = await readFile(join(dir, "design-system/composites/dashboard.tsx"), "utf8");
    expect(parent).toMatch(/import \{ StatTile \} from "@\/design-system\/atoms\/stat-tile"/);
    expect(parent).toMatch(/import \{ TrendBadge \} from "@\/design-system\/atoms\/trend-badge"/);
    expect(parent).not.toMatch(/function StatTile\b/);
    expect(parent).not.toMatch(/function TrendBadge\b/);

    const tsc = runTsc(dir);
    if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
    expect(tsc.status).toBe(0);
  }, 90_000);

  it("self-import guard: a name colliding with the new atom's path is not re-imported into itself", async () => {
    await scaffold();
    // The parent already imports a `DayList` from the very path the extracted
    // atom will occupy. Naively carrying that import would make day-list.tsx
    // import itself. The guard must drop it.
    await writeFile(
      join(dir, "src/components/calendar.tsx"),
      `import { Button } from "@/design-system/atoms/button";
import { DayList } from "@/design-system/atoms/day-list";

function DayList(props: { days: string[] }) {
  // Shadows an imported name on purpose to exercise the self-import guard.
  // Padded out to clear the >=20 line extraction threshold so it is picked up
  // as an extractable inline component rather than skipped as a small helper.
  const labels = props.days.slice();
  const total = labels.length;
  const filled: string[] = [];
  for (let i = 0; i < total; i++) {
    filled.push(labels[i] ?? "-");
  }
  return (
    <div className="day-list">
      <span>{total}</span>
      <ul>
        {filled.map((label, i) => (
          <li key={i}>{label}</li>
        ))}
      </ul>
    </div>
  );
}

export function Calendar() {
  return (
    <div>
      <Button />
      <DayList days={["Mon"]} />
    </div>
  );
}
`,
    );
    // The pre-existing atom the parent imports.
    await writeFile(
      join(dir, "design-system/atoms/day-list.tsx"),
      `export function DayList(props: { days: string[] }) {\n  return <ul>{props.days.length}</ul>;\n}\n\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );

    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const atom = await readDsAtom(dir, "day-list");
    // The atom must not import its own path.
    expect(atom).not.toMatch(/from "@\/design-system\/atoms\/day-list"/);
  });

  it("does not extract from a file with no inline components (relocation only)", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "src/components/badge.tsx"),
      `export function Badge() { return <span />; }\n`,
    );

    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/extracted/i);
    // The atom moved, but nothing new was created beyond the move.
    await expect(access(join(dir, "design-system/atoms/badge.tsx"))).resolves.toBeUndefined();
  });
});
