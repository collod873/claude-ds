import { describe, it, expect } from "vitest";
import { mergeJsonKeys, pruneHooksJson } from "../../src/lib/json-merge";

// Helper to build a pack hook entry (uses .claude/hooks/ namespace)
function packHook(event: string, matcher: string, commands: string[]) {
  return {
    [event]: [
      {
        matcher,
        hooks: commands.map((cmd) => ({ type: "command", command: cmd })),
      },
    ],
  };
}

describe("mergeJsonKeys — non-hooks owned keys (wholesale replace)", () => {
  it("owned non-hooks key from upstream replaces nothing when not in current", () => {
    const upstream = JSON.stringify({ customSection: { val: "x" } });
    const current = JSON.stringify({ permissions: ["read"] });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    const parsed = JSON.parse(result);
    expect(parsed.customSection).toEqual({ val: "x" });
    expect(parsed.permissions).toEqual(["read"]);
  });

  it("user-only non-owned key preserved when absent in upstream", () => {
    const upstream = JSON.stringify({ customSection: { val: "x" } });
    const current = JSON.stringify({ permissions: ["write"], customSection: { val: "old" } });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    const parsed = JSON.parse(result);
    expect(parsed.permissions).toEqual(["write"]);
  });

  it("conflicting non-hooks owned key — upstream wins wholesale", () => {
    const upstream = JSON.stringify({ customSection: { val: "new" } });
    const current = JSON.stringify({ customSection: { val: "old" } });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    const parsed = JSON.parse(result);
    expect(parsed.customSection).toEqual({ val: "new" });
  });

  it("conflicting non-owned key — current wins", () => {
    const upstream = JSON.stringify({ customSection: { val: "x" }, permissions: ["upstream-perm"] });
    const current = JSON.stringify({ permissions: ["current-perm"] });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    const parsed = JSON.parse(result);
    expect(parsed.permissions).toEqual(["current-perm"]);
  });

  it("nested objects under non-hooks owned key replaced wholesale, not deep-merged", () => {
    const upstream = JSON.stringify({ customSection: { a: 1, b: 2 } });
    const current = JSON.stringify({ customSection: { a: 99, c: 3 } });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    const parsed = JSON.parse(result);
    expect(parsed.customSection).toEqual({ a: 1, b: 2 });
    expect(parsed.customSection.c).toBeUndefined();
  });

  it("returns 2-space indented JSON with trailing newline", () => {
    const upstream = JSON.stringify({ customSection: {} });
    const current = JSON.stringify({ permissions: [] });
    const result = mergeJsonKeys(upstream, current, ["customSection"]);
    expect(result.endsWith("\n")).toBe(true);
    expect(result).toContain("  ");
  });

  it("throws a clear message on malformed upstream JSON", () => {
    expect(() => mergeJsonKeys("{bad json}", "{}", ["customSection"])).toThrow(/upstream/i);
  });

  it("throws a clear message on malformed current JSON", () => {
    expect(() => mergeJsonKeys("{}", "{bad json}", ["customSection"])).toThrow(/current/i);
  });
});

describe("mergeJsonKeys — scripts namespace-aware merge", () => {
  // Pack-owned prefixes: ds:, ci:, and exact names generate:showcase, lint:commits

  it("scripts merge preserves user scripts alongside pack scripts", () => {
    const upstream = JSON.stringify({ scripts: { "ds:check-tiers": "node --experimental-strip-types scripts/check-tier-imports.ts" } });
    const current = JSON.stringify({ name: "my-app", scripts: { test: "vitest", myproj: "echo hi" } });
    const result = mergeJsonKeys(upstream, current, ["scripts"]);
    const parsed = JSON.parse(result);
    // all 3 scripts present
    expect(parsed.scripts["test"]).toBe("vitest");
    expect(parsed.scripts["myproj"]).toBe("echo hi");
    expect(parsed.scripts["ds:check-tiers"]).toBe("node --experimental-strip-types scripts/check-tier-imports.ts");
    // other top-level keys untouched
    expect(parsed.name).toBe("my-app");
  });

  it("stale pack-owned scripts stripped and new pack scripts added on re-merge", () => {
    const upstream = JSON.stringify({ scripts: { "ds:check-tiers": "node --experimental-strip-types scripts/check-tier-imports.ts", "ci:consistency": "bash scripts/consistency-probe.sh" } });
    // current has a stale ds: script that is no longer in upstream
    const current = JSON.stringify({ scripts: { "ds:old-name": "node scripts/old.ts", test: "vitest" } });
    const result = mergeJsonKeys(upstream, current, ["scripts"]);
    const parsed = JSON.parse(result);
    // stale pack script removed
    expect(parsed.scripts["ds:old-name"]).toBeUndefined();
    // new pack scripts present
    expect(parsed.scripts["ds:check-tiers"]).toBeDefined();
    expect(parsed.scripts["ci:consistency"]).toBeDefined();
    // user script survives
    expect(parsed.scripts["test"]).toBe("vitest");
  });

  it("ds:-prefixed user script not in upstream is stripped (pack owns the namespace)", () => {
    // NOTE: we own the ds: namespace entirely. If a user writes ds:custom and it's not in
    // upstream, it gets stripped. This is intentional — document here so future-Collin isn't burned.
    const upstream = JSON.stringify({ scripts: { "ds:check-tiers": "node --experimental-strip-types scripts/check-tier-imports.ts" } });
    const current = JSON.stringify({ scripts: { "ds:custom": "echo user-script", test: "vitest" } });
    const result = mergeJsonKeys(upstream, current, ["scripts"]);
    const parsed = JSON.parse(result);
    // ds:custom stripped because ds: namespace is pack-owned
    expect(parsed.scripts["ds:custom"]).toBeUndefined();
    // user's non-namespaced script survives
    expect(parsed.scripts["test"]).toBe("vitest");
    // pack script present
    expect(parsed.scripts["ds:check-tiers"]).toBeDefined();
  });
});

describe("mergeJsonKeys — devDependencies namespace-aware merge (F8)", () => {
  // The pack-seeded test files (vitest.setup.ts, role-contracts.test.tsx) import
  // @testing-library/react and @testing-library/jest-dom. Without those deps in
  // package.json, `npm test` fails on a fresh adopt — exactly the F8 friction
  // ADR-0003 forbids the consumer from healing by hand. This merge declares the
  // pack's test devDeps idempotently, alongside any user-owned deps.

  it("pack devDeps added when consumer lacks them", () => {
    const upstream = JSON.stringify({
      devDependencies: {
        "@testing-library/react": "^15.0.0",
        "@testing-library/jest-dom": "^6.4.0",
        "jsdom": "^24.0.0",
      },
    });
    const current = JSON.stringify({
      name: "my-app",
      devDependencies: { typescript: "^5.0.0" },
    });
    const result = mergeJsonKeys(upstream, current, ["devDependencies"]);
    const parsed = JSON.parse(result);
    expect(parsed.devDependencies["@testing-library/react"]).toBe("^15.0.0");
    expect(parsed.devDependencies["@testing-library/jest-dom"]).toBe("^6.4.0");
    expect(parsed.devDependencies["jsdom"]).toBe("^24.0.0");
    // user dep preserved
    expect(parsed.devDependencies["typescript"]).toBe("^5.0.0");
    // other top-level keys untouched
    expect(parsed.name).toBe("my-app");
  });

  it("idempotent — re-running on already-merged output yields stable result", () => {
    const upstream = JSON.stringify({
      devDependencies: {
        "@testing-library/react": "^15.0.0",
        "@testing-library/jest-dom": "^6.4.0",
      },
    });
    const current = JSON.stringify({
      devDependencies: { typescript: "^5.0.0" },
    });
    const first = mergeJsonKeys(upstream, current, ["devDependencies"]);
    const second = mergeJsonKeys(upstream, first, ["devDependencies"]);
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  it("verdict skip when pack devDeps already match current (no churn on re-sync)", () => {
    const upstream = JSON.stringify({
      devDependencies: {
        "@testing-library/react": "^15.0.0",
        "@testing-library/jest-dom": "^6.4.0",
      },
    });
    const current = JSON.stringify({
      devDependencies: {
        "@testing-library/react": "^15.0.0",
        "@testing-library/jest-dom": "^6.4.0",
        typescript: "^5.0.0",
      },
    });
    const result = mergeJsonKeys(upstream, current, ["devDependencies"]);
    expect(JSON.parse(result).devDependencies).toEqual(JSON.parse(current).devDependencies);
  });

  it("missing devDependencies on current side — pack devDeps installed", () => {
    const upstream = JSON.stringify({
      devDependencies: { "@testing-library/react": "^15.0.0" },
    });
    const current = JSON.stringify({ name: "my-app" });
    const result = mergeJsonKeys(upstream, current, ["devDependencies"]);
    const parsed = JSON.parse(result);
    expect(parsed.devDependencies["@testing-library/react"]).toBe("^15.0.0");
    expect(parsed.name).toBe("my-app");
  });

  it("user's non-pack devDeps preserved alongside pack-owned ones", () => {
    const upstream = JSON.stringify({
      devDependencies: { "@testing-library/react": "^15.0.0" },
    });
    const current = JSON.stringify({
      devDependencies: { lodash: "^4.0.0", "@types/node": "^20.0.0" },
    });
    const result = mergeJsonKeys(upstream, current, ["devDependencies"]);
    const parsed = JSON.parse(result);
    expect(parsed.devDependencies["lodash"]).toBe("^4.0.0");
    expect(parsed.devDependencies["@types/node"]).toBe("^20.0.0");
    expect(parsed.devDependencies["@testing-library/react"]).toBe("^15.0.0");
  });

  it("pack version of a shared dep wins (so consumers ride pack's tested versions)", () => {
    const upstream = JSON.stringify({
      devDependencies: { "@testing-library/react": "^15.0.0" },
    });
    const current = JSON.stringify({
      devDependencies: { "@testing-library/react": "^13.0.0", typescript: "^5.0.0" },
    });
    const result = mergeJsonKeys(upstream, current, ["devDependencies"]);
    const parsed = JSON.parse(result);
    expect(parsed.devDependencies["@testing-library/react"]).toBe("^15.0.0");
    expect(parsed.devDependencies["typescript"]).toBe("^5.0.0");
  });
});

describe("mergeJsonKeys — hooks namespace-aware merge (CrewOps regression)", () => {
  // The pack's two hooks live under .claude/hooks/ namespace
  const packUpstream = JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: ".claude/hooks/atom-imports.sh" },
            { type: "command", command: ".claude/hooks/regenerate-companions.sh" },
          ],
        },
      ],
    },
  });

  it("CrewOps regression: pre-existing PreToolUse validators preserved when pack adds PostToolUse", () => {
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "scripts/ui-token-validator.sh" }],
          },
        ],
      },
    });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("scripts/ui-token-validator.sh");
    expect(parsed.hooks.PostToolUse).toBeDefined();
  });

  it("CrewOps regression: pre-existing SessionStart preserved", () => {
    const current = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "scripts/banner.sh" }] }],
      },
    });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("scripts/banner.sh");
  });

  it("user non-claude-ds entry inside shared PostToolUse matcher block preserved alongside pack entries", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "scripts/my-linter.sh" }],
          },
        ],
      },
    });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    const postEntry = parsed.hooks.PostToolUse.find((e: { matcher: string }) => e.matcher === "Edit|Write");
    expect(postEntry).toBeDefined();
    const commands = postEntry.hooks.map((h: { command: string }) => h.command);
    expect(commands).toContain("scripts/my-linter.sh");
    expect(commands).toContain(".claude/hooks/atom-imports.sh");
  });

  it("same matcher: user's hooks come first, pack's appended after", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "scripts/my-linter.sh" }],
          },
        ],
      },
    });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    const postEntry = parsed.hooks.PostToolUse.find((e: { matcher: string }) => e.matcher === "Edit|Write");
    expect(postEntry.hooks[0].command).toBe("scripts/my-linter.sh");
    expect(postEntry.hooks[1].command).toBe(".claude/hooks/atom-imports.sh");
  });

  it("claude-ds entries deduplicated by command when upstream resends on re-merge", () => {
    // First merge
    const current = JSON.stringify({ hooks: {} });
    const firstMerge = mergeJsonKeys(packUpstream, current, ["hooks"]);
    // Second merge (idempotency + dedup)
    const secondMerge = mergeJsonKeys(packUpstream, firstMerge, ["hooks"]);
    const parsed = JSON.parse(secondMerge);
    const postEntry = parsed.hooks.PostToolUse.find((e: { matcher: string }) => e.matcher === "Edit|Write");
    const atomCount = postEntry.hooks.filter(
      (h: { command: string }) => h.command === ".claude/hooks/atom-imports.sh"
    ).length;
    expect(atomCount).toBe(1);
  });

  it("user permissions still preserved (regression check on the old fix)", () => {
    const current = JSON.stringify({
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {},
    });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.permissions).toEqual({ allow: ["Bash(npm test:*)"] });
  });

  it("idempotency: re-running mergeJsonKeys on already-merged output yields stable result", () => {
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "scripts/validator.sh" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "scripts/banner.sh" }] }],
      },
    });
    const firstMerge = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const secondMerge = mergeJsonKeys(packUpstream, firstMerge, ["hooks"]);
    expect(JSON.parse(secondMerge)).toEqual(JSON.parse(firstMerge));
  });

  it("empty user hooks merges to just pack hooks", () => {
    const current = JSON.stringify({ hooks: {} });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].hooks).toHaveLength(2);
  });

  it("empty pack hooks leaves user hooks untouched", () => {
    const emptyUpstream = JSON.stringify({ hooks: {} });
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "scripts/validator.sh" }] }],
      },
    });
    const result = mergeJsonKeys(emptyUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("scripts/validator.sh");
  });

  it("missing hooks on upstream side treated as empty — user hooks untouched", () => {
    const noHooksUpstream = JSON.stringify({ someOtherKey: true });
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "scripts/validator.sh" }] }],
      },
    });
    const result = mergeJsonKeys(noHooksUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("scripts/validator.sh");
  });

  it("missing hooks on current side treated as empty — pack hooks installed", () => {
    const current = JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } });
    const result = mergeJsonKeys(packUpstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(parsed.permissions).toEqual({ allow: ["Bash(git:*)"] });
  });
});

describe("pruneHooksJson — remove dangling pack-owned hook entries", () => {
  it("removes pack-owned entries matching the predicate", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS" },
              { type: "command", command: ".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, (cmd) => cmd === ".claude/hooks/token-only.sh");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    const commands = parsed.hooks.PostToolUse[0].hooks.map((h: { command: string }) => h.command);
    expect(commands).toContain(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
    expect(commands).not.toContain(".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS");
  });

  it("preserves user hooks even when all pack hooks are pruned", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: "scripts/my-linter.sh" },
              { type: "command", command: ".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, (cmd) => cmd === ".claude/hooks/token-only.sh");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe("scripts/my-linter.sh");
  });

  it("drops empty matcher blocks when all hooks pruned", () => {
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/pre-write-ds-states.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, (cmd) => cmd === ".claude/hooks/pre-write-ds-states.sh");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.hooks.PreToolUse).toBeUndefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
  });

  it("returns null when nothing to prune", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, () => false);
    expect(result).toBeNull();
  });

  it("preserves non-hooks settings keys", () => {
    const current = JSON.stringify({
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/hooks/token-only.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, (cmd) => cmd === ".claude/hooks/token-only.sh");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.permissions).toEqual({ allow: ["Bash(npm test:*)"] });
  });

  it("returns null when no hooks key exists", () => {
    const current = JSON.stringify({ permissions: { allow: [] } });
    const result = pruneHooksJson(current, () => true);
    expect(result).toBeNull();
  });

  it("does not prune user hooks even if predicate would match their path", () => {
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: "scripts/token-only.sh $CLAUDE_FILE_PATHS" },
            ],
          },
        ],
      },
    });
    const result = pruneHooksJson(current, () => true);
    expect(result).toBeNull();
  });
});
