import { describe, it, expect } from "vitest";
import { mergeJsonKeys } from "../../src/lib/json-merge";

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

describe("mergeJsonKeys — hooks namespace-aware merge (CrewOps regression)", () => {
  // The pack's two hooks live under .claude/hooks/ namespace
  const packUpstream = JSON.stringify({
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
    expect(commands).toContain(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
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
    expect(postEntry.hooks[1].command).toBe(".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS");
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
      (h: { command: string }) => h.command === ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS"
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
