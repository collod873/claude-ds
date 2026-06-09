import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

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

	it("carries a parent-exported type referenced by the extracted component (and keeps the parent's export)", async () => {
		await scaffold();
		// Mirrors the crewops baseline regression: the composite EXPORTS a type
		// (PageHeaderAction) that an inline component references in its props, plus a
		// transitive type (Tone) reached only through the first. Before the fix the
		// closure short-circuited on `exported`, so neither type made it into the
		// atom → 26 TS2304 "Cannot find name" errors. The parent's export must also
		// survive (external files import it), so the type is copied, never moved.
		await writeFile(
			join(dir, "src/components/page-header.tsx"),
			`import { Button } from "@/design-system/atoms/button";

export type Tone = "primary" | "ghost";

export type PageHeaderAction = {
  label: string;
  tone: Tone;
};

function ActionButton(props: { action: PageHeaderAction }) {
  // Inline component referencing a parent-EXPORTED type in its props.
  // Padded out to clear the >=20 line extraction threshold so it is picked
  // up as an extractable inline component rather than skipped as a helper.
  // grow line one to clear the threshold
  // grow line two to clear the threshold
  // grow line three to clear the threshold
  // grow line four to clear the threshold
  const { action } = props;
  const label = action.label;
  const cls = action.tone === "primary" ? "btn-primary" : "btn-ghost";
  const parts = [cls, label];
  return (
    <button className={cls}>
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </button>
  );
}

export function PageHeader(props: { actions: PageHeaderAction[] }) {
  return (
    <div>
      <Button />
      <ActionButton action={props.actions[0]} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// The atom carries both the directly-referenced type and its transitive dep.
		const atom = await readDsAtom(dir, "action-button");
		expect(atom).toMatch(/export function ActionButton\b/);
		expect(atom).toMatch(/type PageHeaderAction =/);
		expect(atom).toMatch(/type Tone =/);

		// The parent keeps its exports intact — copied, not moved.
		const parent = await readFile(join(dir, "design-system/composites/page-header.tsx"), "utf8");
		expect(parent).toMatch(/export type PageHeaderAction =/);
		expect(parent).toMatch(/export type Tone =/);
		expect(parent).not.toMatch(/function ActionButton\b/);

		// And it all compiles — no TS2304.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("leaves inline a component that references an exported runtime decl (no dangling TS2304)", async () => {
		// Regression for issue #250: classify produced atoms that referenced e.g.
		// `comboboxTriggerVariants` — an `export const … = cva(…)` in the parent —
		// without declaring or importing it, causing TS2304 on every consumer.
		// The fix: if the transitive closure of a to-be-extracted component touches
		// an exported runtime local, skip extraction entirely (option 1).
		await scaffold();
		await writeFile(
			join(dir, "src/components/combobox.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Exported runtime value — must stay in the parent; cannot be carried or
// imported without a tier-layering violation.
export const comboboxTriggerVariants = { default: "btn", open: "btn-open" };

function ComboboxTrigger(props: { open: boolean }) {
  // Inline component referencing the exported runtime const above.
  // Padded out to clear the >=20 line extraction threshold so classify
  // sees it as an extractable inline component and tries to extract it.
  const cls = props.open
    ? comboboxTriggerVariants.open
    : comboboxTriggerVariants.default;
  const label = props.open ? "close" : "open";
  const rows = [cls, label];
  const extra = "extra";
  return (
    <button className={cls}>
      {rows.map((r, i) => (
        <span key={i}>{r}</span>
      ))}
      <span>{extra}</span>
    </button>
  );
}

export function Combobox() {
  return (
    <div>
      <Button />
      <ComboboxTrigger open={false} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// Option 1 fix: the component stays inline — no atom is written.
		// Access should reject (file does not exist).
		await expect(access(join(dir, "design-system/atoms/combobox-trigger.tsx"))).rejects.toThrow();

		// Whether extracted or not, tsc must be clean — no TS2304 dangling refs.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("keeps a shared type alias in the parent when a guard-skipped sibling still references it (no TS2304)", async () => {
		// Regression for issue #250 (second facet): a non-exported type alias used by
		// BOTH the inline component being extracted AND a sibling component that is
		// ultimately skipped by the exported-runtime guard must not be removed from the
		// parent. Before the fix, `protectedRanges` included the (unconfirmed) sibling's
		// body, so `referencedOutside` wrongly returned false → the type was moved out,
		// leaving the parent with a dangling TS2304 on the type name.
		await scaffold();
		await writeFile(
			join(dir, "src/components/form-field.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Exported runtime value — causes the sibling FormFieldPanel to be skipped.
export const formFieldVariants = { base: "field", error: "field-error" };

// Non-exported type used by BOTH FormFieldRoot (inline, to be extracted) AND
// FormFieldPanel (skipped because it references the exported runtime above).
// After extraction, FormFieldPanel stays inline and still needs this type.
type Requirement = { label: string; required: boolean };

function FormFieldRoot(props: { req: Requirement }) {
  // Inline component referencing Requirement in its props.
  // Padded out to clear the >=20 line extraction threshold so classify
  // recognises it as an extractable inline component.
  const { req } = props;
  const label = req.label;
  const cls = req.required ? "required" : "optional";
  const parts = [label, cls];
  const extra1 = "pad1";
  const extra2 = "pad2";
  const extra3 = "pad3";
  return (
    <div className={cls}>
      <label>{label}</label>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

function FormFieldPanel(props: { req: Requirement }) {
  // Sibling inline component that also uses Requirement AND the exported
  // runtime above — so the guard fires and it is left inline.
  // Padded out to clear the >=20 line extraction threshold.
  const variant = formFieldVariants.base;
  const { req } = props;
  const label = req.label;
  const cls = req.required ? variant : formFieldVariants.error;
  const parts = [label, cls];
  const extra1 = "pad1";
  const extra2 = "pad2";
  const extra3 = "pad3";
  return (
    <fieldset className={cls}>
      <legend>{label}</legend>
      <ul>
        {parts.map((p, i) => (
          <span key={i}>{p}</span>
        ))}
      </ul>
    </fieldset>
  );
}

export function FormField() {
  const req: Requirement = { label: "email", required: true };
  return (
    <div>
      <Button />
      <FormFieldRoot req={req} />
      <FormFieldPanel req={req} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// FormFieldRoot is extracted; FormFieldPanel is not (guard fires on exportedRuntime).
		const atomPath = join(dir, "design-system/atoms/form-field-root.tsx");
		await expect(access(atomPath)).resolves.toBeUndefined();
		await expect(access(join(dir, "design-system/atoms/form-field-panel.tsx"))).rejects.toThrow();

		// The parent must still declare `Requirement` — FormFieldPanel still uses it.
		const parent = await readFile(join(dir, "design-system/composites/form-field.tsx"), "utf8");
		expect(parent).toMatch(/type Requirement =/);

		// And the whole project must typecheck — no TS2304 from either file.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("keeps a shared runtime decl in the parent when a guard-skipped sibling still references it (no TS2552)", async () => {
		// Regression for issue #250 (second facet): a non-exported runtime decl (here
		// a hook function `useComboboxCtx`) used by BOTH the inline component being
		// extracted AND a guard-skipped sibling must not be removed from the parent.
		// Before the fix, `protectedRanges` included the unconfirmed sibling's range,
		// so `referencedOutside` wrongly returned false → the function was moved out,
		// leaving the parent with a dangling TS2552 for `useComboboxCtx`.
		await scaffold();
		await writeFile(
			join(dir, "src/components/combobox.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Exported runtime const — causes Combobox (the sibling) to be skipped.
export const comboboxVariants = { default: "btn", open: "btn-open" };

// Non-exported runtime function used by BOTH ComboboxItem (extracted) AND
// Combobox (skipped). After extraction Combobox still calls it in the parent.
function useComboboxCtx() {
  return { open: false };
}

function ComboboxItem(props: { label: string }) {
  // Inline component that uses useComboboxCtx.
  // Padded out to clear the >=20 line extraction threshold.
  const ctx = useComboboxCtx();
  const label = props.label;
  const open = ctx.open;
  const parts = [label];
  const a = "a";
  const b = "b";
  const c = "c";
  const d = "d";
  return (
    <div>
      <span>{label}</span>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
      <em>{open ? "open" : "closed"}</em>
    </div>
  );
}

function Combobox() {
  // Sibling that uses BOTH useComboboxCtx AND comboboxVariants (exported).
  // The exported-runtime guard fires, leaving Combobox inline.
  // Padded out to clear the >=20 line extraction threshold.
  const v = comboboxVariants.default;
  const ctx = useComboboxCtx();
  const open = ctx.open;
  const cls = open ? v : comboboxVariants.open;
  const parts = [cls];
  const a = "a";
  const b = "b";
  const c = "c";
  return (
    <div>
      <Button />
      <ComboboxItem label="test" />
      <span className={cls}>
        {parts.map((p, i) => (
          <em key={i}>{p}</em>
        ))}
      </span>
    </div>
  );
}

export { Combobox };
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// ComboboxItem is extracted; Combobox is not (guard fires on exportedRuntime).
		await expect(
			access(join(dir, "design-system/atoms/combobox-item.tsx")),
		).resolves.toBeUndefined();
		await expect(access(join(dir, "design-system/atoms/combobox.tsx"))).rejects.toThrow();

		// The parent must still declare `useComboboxCtx` — Combobox still calls it.
		const parent = await readFile(join(dir, "design-system/composites/combobox.tsx"), "utf8");
		expect(parent).toMatch(/function useComboboxCtx\b/);

		// And the whole project must typecheck — no TS2552 / TS2304 from either file.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("keeps a non-exported type alias in the parent when it is used ONLY in type position inside an exported type (no TS2304)", async () => {
		// Regression for issue #250 (type-position facet): the extracted component
		// references an exported type alias (FormFieldProps) that in turn references a
		// non-exported type (Requirement). Requirement appears ONLY in type position —
		// inside the body of FormFieldProps, nowhere at runtime. Before the fix,
		// protectedRanges included FormFieldProps's range (even though it is exported and
		// stays in the parent), so Requirement's occurrence inside FormFieldProps was
		// treated as "inside a protected range" → referencedOutside returned false →
		// Requirement was MOVED into the atom and removed from the parent → parent
		// TS2304: "Cannot find name 'Requirement'".
		// Fix: exported decls are excluded from protectedRanges so their body's
		// references remain visible as live parent references.
		await scaffold();
		await writeFile(
			join(dir, "src/components/form-field.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Non-exported type used ONLY in type position inside an exported type.
// The extracted component references FormFieldProps which transitively refs Requirement.
type Requirement = "required" | "optional";

export type FormFieldProps = {
  requirement?: Requirement;
  label: string;
};

function FormFieldRoot(props: FormFieldProps) {
  // Inline component to be extracted. It references FormFieldProps (exported)
  // which transitively pulls Requirement into the closure. Padded to clear
  // the >=20 line extraction threshold.
  const { requirement, label } = props;
  const cls = requirement === "required" ? "req" : "opt";
  const parts = [label, cls];
  const a = "a";
  const b = "b";
  const c = "c";
  const d = "d";
  return (
    <div className={cls}>
      <label>{label}</label>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function FormField(props: FormFieldProps) {
  return (
    <div>
      <Button />
      <FormFieldRoot {...props} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// FormFieldRoot is extracted into its own atom.
		const atomPath = join(dir, "design-system/atoms/form-field-root.tsx");
		await expect(access(atomPath)).resolves.toBeUndefined();

		// The atom carries both the exported type and the non-exported dep.
		const atom = await readDsAtom(dir, "form-field-root");
		expect(atom).toMatch(/export function FormFieldRoot\b/);
		expect(atom).toMatch(/type FormFieldProps =/);
		expect(atom).toMatch(/type Requirement =/);

		// The parent keeps Requirement: FormFieldProps is exported (stays) and still
		// references Requirement, so Requirement must NOT be moved out.
		const parent = await readFile(join(dir, "design-system/composites/form-field.tsx"), "utf8");
		expect(parent).toMatch(/type Requirement =/);
		expect(parent).toMatch(/export type FormFieldProps =/);
		expect(parent).not.toMatch(/function FormFieldRoot\b/);

		// No TS2304 in either file — the critical assertion.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("keeps a non-exported type in the parent when it is exported via a separate export statement (Failure A — no TS2304)", async () => {
		// Regression for issue #250 (Failure A): `FormFieldProps` is declared WITHOUT
		// an inline `export` keyword — so `isExported` returns false and prior code
		// added its range to `protectedRanges`. Its body references a non-exported
		// `type Requirement`. Because the occurrence of `Requirement` was inside
		// `FormFieldProps`'s (wrongly) protected range, `referencedOutside` returned
		// false → `Requirement` was MOVED out and removed from the parent → parent
		// TS2304: "Cannot find name 'Requirement'".
		//
		// Shape: non-exported `type FormFieldProps = { req?: Requirement }` declared
		// on its own line, then exported via a separate `export type { FormFieldProps }`
		// statement later in the file. The inline-export test above uses
		// `export type FormFieldProps = ...` which has a different `isExported` result
		// and does NOT reproduce this bug.
		await scaffold();
		await writeFile(
			join(dir, "src/components/form-field.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Non-exported type — no inline \`export\` keyword here.
type Requirement = "required" | "optional";

// Also non-exported inline, but exported via the separate statement below.
type FormFieldProps = {
  requirement?: Requirement;
  label: string;
};

// Separate re-export: FormFieldProps gets exported here, NOT at the declaration.
export type { FormFieldProps };

function FormFieldRoot(props: FormFieldProps) {
  // Inline component to be extracted. References FormFieldProps (re-exported
  // separately) which transitively refs Requirement. Padded to clear the
  // >=20 line extraction threshold.
  const { requirement, label } = props;
  const cls = requirement === "required" ? "req" : "opt";
  const parts = [label, cls];
  const a = "a";
  const b = "b";
  const c = "c";
  const d = "d";
  return (
    <div className={cls}>
      <label>{label}</label>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function FormField(props: FormFieldProps) {
  return (
    <div>
      <Button />
      <FormFieldRoot {...props} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// FormFieldRoot is extracted into its own atom.
		const atomPath = join(dir, "design-system/atoms/form-field-root.tsx");
		await expect(access(atomPath)).resolves.toBeUndefined();

		// The atom carries both types.
		const atom = await readDsAtom(dir, "form-field-root");
		expect(atom).toMatch(/export function FormFieldRoot\b/);
		expect(atom).toMatch(/type FormFieldProps =/);
		expect(atom).toMatch(/type Requirement =/);

		// The parent must keep Requirement: FormFieldProps stays (re-exported) and
		// still references Requirement, so Requirement must NOT be moved out.
		const parent = await readFile(join(dir, "design-system/composites/form-field.tsx"), "utf8");
		expect(parent).toMatch(/type Requirement =/);
		expect(parent).toMatch(/type FormFieldProps =/);
		expect(parent).not.toMatch(/function FormFieldRoot\b/);

		// No TS2304 in either file — the critical assertion.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("transitively keeps a type dep when the type that references it is retained in the parent (Failure B — no TS2304)", async () => {
		// Regression for issue #250 (Failure B): `SortState` is kept in the parent
		// because it is referenced by exported code outside `confirmedRanges`, but its
		// body references `SortDirection`. In prior code `SortState`'s range was in
		// `protectedRanges`, hiding the `SortDirection` reference → `referencedOutside`
		// returned false → `SortDirection` was MOVED out → parent TS2304:
		// "Cannot find name 'SortDirection'".
		//
		// Fix: the move-vs-copy decision now uses a transitive-closure computation:
		// keeping `SortState` in the parent automatically keeps everything `SortState`
		// references, including `SortDirection`.
		await scaffold();
		await writeFile(
			join(dir, "src/components/data-table.tsx"),
			`import { Button } from "@/design-system/atoms/button";

// Two non-exported types: SortDirection is only referenced inside SortState.
// SortState is referenced by the exported DataTableProps → it must stay in the
// parent → SortDirection must also stay (transitive closure).
type SortDirection = "asc" | "desc";
type SortState = { key: string; direction: SortDirection };

export type DataTableProps = {
  sort?: SortState | null;
  label: string;
};

function SortIndicator(props: { state: SortState }) {
  // Inline component to be extracted. References SortState which transitively
  // refs SortDirection. Padded to clear the >=20 line extraction threshold.
  const { state } = props;
  const dir = state.direction;
  const key = state.key;
  const parts = [dir, key];
  const a = "a";
  const b = "b";
  const c = "c";
  const d = "d";
  return (
    <span className={dir}>
      <strong>{key}</strong>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </span>
  );
}

export function DataTable(props: DataTableProps) {
  return (
    <div>
      <Button />
      <SortIndicator state={props.sort ?? { key: "id", direction: "asc" }} />
    </div>
  );
}
`,
		);

		const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// SortIndicator is extracted into its own atom.
		const atomPath = join(dir, "design-system/atoms/sort-indicator.tsx");
		await expect(access(atomPath)).resolves.toBeUndefined();

		// The atom carries both SortState and SortDirection.
		const atom = await readDsAtom(dir, "sort-indicator");
		expect(atom).toMatch(/export function SortIndicator\b/);
		expect(atom).toMatch(/type SortState =/);
		expect(atom).toMatch(/type SortDirection =/);

		// The parent must keep BOTH SortDirection and SortState: DataTableProps
		// (exported) references SortState, and SortState references SortDirection.
		const parent = await readFile(join(dir, "design-system/composites/data-table.tsx"), "utf8");
		expect(parent).toMatch(/type SortDirection =/);
		expect(parent).toMatch(/type SortState =/);
		expect(parent).not.toMatch(/function SortIndicator\b/);

		// No TS2304 in either file — the critical assertion.
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

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

// ── Backfill-helper-closure tests (issue #261) ────────────────────────────────
//
// These tests cover the NEW `backfillAtomHelpers` pass that runs as part of
// `classify`. It repairs pre-existing atoms that were extracted without their
// parent-local helper closure, leaving TS2304-dangling references that
// `audit --fix` correctly refuses to heal (code-motion is classify's job,
// per ADR-0015).
//
// Setup shared across all cases in this suite:
//   - A composite that declares a private helper used by an already-extracted atom.
//   - The atom exists in design-system/atoms/ but its source does NOT declare
//     or import the helper → analyzeResolution reports it as unresolved.
//
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — backfill helper closure into pre-existing atoms (issue #261)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function scaffoldBase(): Promise<void> {
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await writeFile(join(dir, "tsconfig.json"), TSCONFIG);
		await writeFile(join(dir, "jsx.d.ts"), JSX_SHIM);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
	}

	it("backfills a parent-local non-exported helper into a dangling atom", async () => {
		// Mirrors the Crewops month-grid / calendar-view case:
		//   - atom `month-grid.tsx` references `startOfMonthGrid` which is not declared/imported
		//   - composite `calendar-view.tsx` declares private `startOfMonthGrid`
		// After classify, the atom must contain `startOfMonthGrid` and tsc must pass.
		await scaffoldBase();

		await writeFile(
			join(dir, "design-system/atoms/month-grid.tsx"),
			`export function MonthGrid({ anchor }: { anchor: Date }) {
  const start = startOfMonthGrid(anchor);
  return <div>{start.toISOString()}</div>;
}
export const meta = { kind: "atom" as const, examples: [] };
`,
		);

		await writeFile(
			join(dir, "design-system/composites/calendar-view.tsx"),
			`import { MonthGrid } from "@/design-system/atoms/month-grid";

function startOfMonthGrid(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  return x;
}

export function CalendarView({ anchor }: { anchor: Date }) {
  return <MonthGrid anchor={anchor} />;
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// The atom now contains the carried helper
		const atom = await readFile(join(dir, "design-system/atoms/month-grid.tsx"), "utf8");
		expect(atom).toMatch(/function startOfMonthGrid/);
		expect(atom).toMatch(/export function MonthGrid/);
		// No dangling marker
		expect(atom).not.toMatch(/EXTRACTION_NEEDED/);

		// tsc must be clean
		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("backfills a transitive helper chain (helper depends on another helper)", async () => {
		// atom references `buildMonthGrid`, which itself calls `addDays` and `startOfMonthGrid`.
		// All three are private in the composite. All three must be carried.
		await scaffoldBase();

		await writeFile(
			join(dir, "design-system/atoms/month-grid.tsx"),
			`export function MonthGrid({ anchor }: { anchor: Date }) {
  const days = buildMonthGrid(anchor);
  return <div>{days.length}</div>;
}
export const meta = { kind: "atom" as const, examples: [] };
`,
		);

		await writeFile(
			join(dir, "design-system/composites/calendar-view.tsx"),
			`import { MonthGrid } from "@/design-system/atoms/month-grid";

function startOfMonthGrid(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function buildMonthGrid(anchor: Date): Date[] {
  const start = startOfMonthGrid(anchor);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(start, i));
  return days;
}

export function CalendarView({ anchor }: { anchor: Date }) {
  return <MonthGrid anchor={anchor} />;
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const atom = await readFile(join(dir, "design-system/atoms/month-grid.tsx"), "utf8");
		// All three helpers must be in the atom
		expect(atom).toMatch(/function buildMonthGrid/);
		expect(atom).toMatch(/function startOfMonthGrid/);
		expect(atom).toMatch(/function addDays/);
		expect(atom).not.toMatch(/EXTRACTION_NEEDED/);

		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);

	it("EXTRACTION_NEEDED fallback: leaves a marker when a helper is exported (cannot be safely carried)", async () => {
		// The atom references `clampValue` which IS in the composite, but it is
		// exported there (exported runtime value — duplicating it would give it two
		// runtime identities; importing from the composite would be atom→composite
		// layering violation). classify must NOT carry it. It must add the marker.
		await scaffoldBase();

		await writeFile(
			join(dir, "design-system/atoms/clamp-box.tsx"),
			`export function ClampBox({ value }: { value: number }) {
  const clamped = clampValue(value);
  return <div>{clamped}</div>;
}
export const meta = { kind: "atom" as const, examples: [] };
`,
		);

		await writeFile(
			join(dir, "design-system/composites/clamp-view.tsx"),
			`import { ClampBox } from "@/design-system/atoms/clamp-box";

// Exported runtime value — cannot be safely carried into atom.
export function clampValue(v: number): number {
  return Math.max(0, Math.min(100, v));
}

export function ClampView({ value }: { value: number }) {
  return <ClampBox value={value} />;
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const atom = await readFile(join(dir, "design-system/atoms/clamp-box.tsx"), "utf8");
		// Marker must be present — closure hit an exported decl
		expect(atom).toMatch(/EXTRACTION_NEEDED/);
		// clampValue must NOT have been invented or carried into the atom
		expect(atom).not.toMatch(/function clampValue/);
	});

	it("no EXTRACTION_NEEDED marker when helper simply is not in any composite (left for audit --fix)", async () => {
		// The atom references `mysteryHelper` which exists in no composite.
		// That means it's a missing IMPORT (not a parent-local symbol), which
		// audit --fix handles. backfillAtomHelpers must leave the atom unchanged.
		await scaffoldBase();

		const originalAtom = `export function MysteryGrid({ anchor }: { anchor: Date }) {
  const result = mysteryHelper(anchor);
  return <div>{result}</div>;
}
export const meta = { kind: "atom" as const, examples: [] };
`;
		await writeFile(join(dir, "design-system/atoms/mystery-grid.tsx"), originalAtom);

		await writeFile(
			join(dir, "design-system/composites/some-view.tsx"),
			`import { MysteryGrid } from "@/design-system/atoms/mystery-grid";

export function SomeView({ anchor }: { anchor: Date }) {
  return <MysteryGrid anchor={anchor} />;
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const atom = await readFile(join(dir, "design-system/atoms/mystery-grid.tsx"), "utf8");
		// No EXTRACTION_NEEDED marker — this is a missing import, not a parent-local symbol
		expect(atom).not.toMatch(/EXTRACTION_NEEDED/);
		// Atom content unchanged (backfill didn't touch it)
		expect(atom).toBe(originalAtom);
	});

	it("control: an atom with no unresolved symbols is left unchanged", async () => {
		// The atom is already self-contained. classify must not modify it.
		await scaffoldBase();

		const originalAtom = `export function CleanAtom({ label }: { label: string }) {
  return <span>{label}</span>;
}
export const meta = { kind: "atom" as const, examples: [] };
`;
		await writeFile(join(dir, "design-system/atoms/clean-atom.tsx"), originalAtom);

		await writeFile(
			join(dir, "design-system/composites/clean-view.tsx"),
			`import { CleanAtom } from "@/design-system/atoms/clean-atom";

export function CleanView() {
  return <CleanAtom label="hello" />;
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		// Atom content must be unchanged (no spurious helper motion)
		const atom = await readFile(join(dir, "design-system/atoms/clean-atom.tsx"), "utf8");
		expect(atom).toBe(originalAtom);
	});

	it("helper is COPIED (not moved) when the composite also uses it in its own code", async () => {
		// The composite defines `formatDate` (private), used by BOTH the atom AND the composite.
		// After classify: atom gets `formatDate`, composite KEEPS `formatDate`.
		await scaffoldBase();

		await writeFile(
			join(dir, "design-system/atoms/event-chip.tsx"),
			`export function EventChip({ date }: { date: Date }) {
  const label = formatDate(date);
  return <span>{label}</span>;
}
export const meta = { kind: "atom" as const, examples: [] };
`,
		);

		await writeFile(
			join(dir, "design-system/composites/calendar-view.tsx"),
			`import { EventChip } from "@/design-system/atoms/event-chip";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function CalendarView({ date }: { date: Date }) {
  const label = formatDate(date);
  return (
    <div>
      <span>{label}</span>
      <EventChip date={date} />
    </div>
  );
}
export const meta = { kind: "composite" as const, examples: [] };
`,
		);

		const r = await runCli(["classify", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);

		const atom = await readFile(join(dir, "design-system/atoms/event-chip.tsx"), "utf8");
		expect(atom).toMatch(/function formatDate/);

		// Composite must still declare `formatDate` (its own code uses it)
		const composite = await readFile(
			join(dir, "design-system/composites/calendar-view.tsx"),
			"utf8",
		);
		expect(composite).toMatch(/function formatDate/);

		const tsc = runTsc(dir);
		if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.out}`);
		expect(tsc.status).toBe(0);
	}, 90_000);
});
