import { describe, it, expect } from "vitest";
import { buildProgram } from "../../src/cli.js";

// ADR-0025 overturn guard. The user-facing command surface is drivers
// (bare `claude-ds`, `heal`) + entry points (`init`/`adopt`) + read-only
// inspection (`doctor`/`audit`/`version`). Loop members (`sync`, `upgrade`,
// `classify`) and the reserved-but-unwired planner slots (`migrate-layout`,
// `reconcile`, `reconform`) are demoted out of the help billing — still
// registered and runnable, just no longer advertised. A future re-add of a
// loop member to the menu flips this snapshot, which is the deliberate-change
// signal an ADR-0025 amendment would have to own.

/** Command names commander renders under `Commands:` (hidden ones excluded). */
function visibleCommands(): string[] {
  const help = buildProgram().helpInformation();
  const section = help.split(/^Commands:\s*$/m)[1] ?? "";
  return section
    .split("\n")
    .map((l) => l.match(/^ {2}(\S+)/)?.[1])
    .filter((n): n is string => Boolean(n));
}

/** Every command commander knows about, hidden or not. */
function registeredCommands(): string[] {
  return buildProgram().commands.map((c) => c.name());
}

const LOOP_MEMBERS = ["sync", "upgrade", "classify"];
const RESERVED_SLOTS = ["migrate-layout", "reconcile", "reconform"];

describe("command surface (ADR-0025)", () => {
  it("bills only drivers + entries + inspection in --help", () => {
    expect(visibleCommands().sort()).toMatchInlineSnapshot(`
      [
        "adopt",
        "audit",
        "doctor",
        "enforce",
        "heal",
        "init",
        "migrate",
        "version",
      ]
    `);
  });

  it("demotes loop members from the help billing", () => {
    const visible = visibleCommands();
    for (const m of LOOP_MEMBERS) expect(visible).not.toContain(m);
  });

  it("demotes the reserved planner slots from the help billing", () => {
    const visible = visibleCommands();
    for (const s of RESERVED_SLOTS) expect(visible).not.toContain(s);
  });

  it("keeps demoted commands registered + runnable (no behavior change)", () => {
    const registered = registeredCommands();
    for (const m of [...LOOP_MEMBERS, ...RESERVED_SLOTS]) {
      expect(registered).toContain(m);
    }
  });
});
