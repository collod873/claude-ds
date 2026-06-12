// Graft drift sync: stamp a GRAFT.lock baseline into a target at graft time,
// then 3-way compare (baseline → current template → target file) to keep
// grafted repos current as the template evolves. Without a recorded baseline
// there is no way to tell "template evolved" from "target intentionally
// customized" — every sync stays a hand-eyeball job (the pre-lock era:
// claude-ds #520 and friends were hand-carried).
//
// Three verbs, run FROM THE TEMPLATE ROOT against a target path:
//   stamp <target>  — write <target>/.sandcastle/GRAFT.lock (template commit +
//                     per-file content hashes). The universal "we are now in
//                     sync" declaration: run at graft time and again after a
//                     human resolves flagged conflicts.
//   plan  <target>  — classify every surface file; print what would change.
//   apply <target>  — copy clean updates/adds into the target, then rewrite
//                     the lock. Conflict/local-only/stub entries KEEP their old
//                     baseline so they keep flagging until resolved + stamped.
//                     Never deletes target files and never touches stubs.
//
// The skill layer (/graft, /graft-update) owns confirmation, commits, and PRs;
// this op owns the mechanics so they live in tested code, not skill prose.

import * as crypto from "node:crypto";

// ---------- surface ----------

// Grafted roots, per README "Grafting it onto a project" §1 Copy. ci.yml is
// the template's OWN quality gate — never grafted (the copy step deletes it).
// Template `skills/` lands at `.claude/skills/` in the target (where Claude
// Code looks); `.claude/skills/` here is the template's working set, NOT
// surface. GRAFT.lock itself is target-only state and is excluded so a stamp
// never hashes the previous lock into the next one.
const TEMPLATE_ONLY = new Set([".github/workflows/ci.yml"]);
const LOCK_PATH = ".sandcastle/GRAFT.lock";

// Per-graft fill-ins (STUBS.md): updates are never auto-applied. The file is
// two-layer (reusable core + domain stub), so a template-side change still
// surfaces — as stub-review, for a human to port into the customized copy.
export const STUB_PATHS = new Set([".sandcastle/CODING_STANDARDS.md"]);

// Map a template-relative path to its target-relative install path, or null
// if the file is not part of the grafted surface.
export const toTargetPath = (templatePath: string): string | null => {
  if (TEMPLATE_ONLY.has(templatePath)) return null;
  if (templatePath === LOCK_PATH) return null;
  if (templatePath.startsWith(".sandcastle/")) return templatePath;
  if (templatePath.startsWith(".github/")) return templatePath;
  if (templatePath.startsWith("skills/")) return `.claude/${templatePath}`;
  return null;
};

// Invert toTargetPath: where in the template does a target file come from.
export const toTemplatePath = (targetPath: string): string =>
  targetPath.startsWith(".claude/skills/")
    ? targetPath.slice(".claude/".length)
    : targetPath;

// ---------- lock ----------

export interface GraftLock {
  templateRepo: string;
  templateCommit: string;
  templateTreeClean: boolean;
  stampedAt: string;
  // target-relative path -> sha256 of the template content it was synced to
  files: Record<string, string>;
}

export const sha256 = (content: Buffer | string): string =>
  crypto.createHash("sha256").update(content).digest("hex");

// ---------- 3-way plan ----------

export type SyncAction =
  | "unchanged" // template unchanged, target matches baseline
  | "update" // template changed, target still at baseline → clean apply
  | "add" // new in template, absent in target → clean copy
  | "restamp" // target already matches current template → lock-only update
  | "local-only" // target diverged but template didn't change → leave alone
  | "stub-review" // a stub file's template side changed → human ports it
  | "conflict" // both sides moved (or a side vanished) → human decides
  | "removed-from-template"; // baseline file no longer in template → flag

export interface SyncEntry {
  path: string; // target-relative
  action: SyncAction;
  reason: string;
}

// Pure 3-way classifier. All three maps are keyed by target-relative path;
// a missing key means the file is absent on that side. `baseline` comes from
// the lock, `template` from hashing the template surface, `target` from
// hashing what's on disk in the target.
export const planSync = (
  baseline: Record<string, string>,
  template: Record<string, string>,
  target: Record<string, string>,
  stubs: Set<string> = STUB_PATHS,
): SyncEntry[] => {
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(template)])].sort();
  const entries: SyncEntry[] = [];
  for (const p of paths) {
    const b = baseline[p];
    const t = template[p];
    const g = target[p];

    if (t === undefined) {
      entries.push({
        path: p,
        action: "removed-from-template",
        reason: "in the lock but no longer in the template — delete in target, then stamp",
      });
      continue;
    }

    if (stubs.has(p)) {
      entries.push(
        t === b
          ? { path: p, action: "unchanged", reason: "stub — template side unchanged" }
          : {
              path: p,
              action: "stub-review",
              reason: "stub file changed in the template — port manually, never auto-applied",
            },
      );
      continue;
    }

    if (b === undefined) {
      if (g === undefined) {
        entries.push({ path: p, action: "add", reason: "new in template, absent in target" });
      } else if (g === t) {
        entries.push({ path: p, action: "restamp", reason: "already matches template — lock catches up" });
      } else {
        entries.push({
          path: p,
          action: "conflict",
          reason: "new in template but a different file already exists in target",
        });
      }
      continue;
    }

    if (t === b) {
      if (g === b) {
        entries.push({ path: p, action: "unchanged", reason: "in sync" });
      } else if (g === undefined) {
        entries.push({ path: p, action: "conflict", reason: "grafted file deleted in target" });
      } else {
        entries.push({
          path: p,
          action: "local-only",
          reason: "target customized, template unchanged — leaving alone",
        });
      }
      continue;
    }

    // template moved past the baseline
    if (g === b) {
      entries.push({ path: p, action: "update", reason: "template changed, target untouched — clean apply" });
    } else if (g === t) {
      entries.push({ path: p, action: "restamp", reason: "already matches template — lock catches up" });
    } else if (g === undefined) {
      entries.push({ path: p, action: "conflict", reason: "template changed but file deleted in target" });
    } else {
      entries.push({ path: p, action: "conflict", reason: "template and target both changed since baseline" });
    }
  }
  return entries;
};

// Actions apply will copy into the target.
export const APPLIES = new Set<SyncAction>(["add", "update"]);

// Lock contents after an apply: applied/clean entries advance to the current
// template hash; conflict/local-only/stub-review/removed entries KEEP the old
// baseline so the next plan still flags them. Resolution is always: fix by
// hand, then `stamp`.
export const nextLockFiles = (
  plan: SyncEntry[],
  baseline: Record<string, string>,
  template: Record<string, string>,
): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const e of plan) {
    const advance =
      e.action === "add" || e.action === "update" || e.action === "restamp" || e.action === "unchanged";
    const hash = advance ? template[e.path] : (baseline[e.path] ?? template[e.path]);
    if (hash !== undefined) files[e.path] = hash;
  }
  return files;
};

export const summarize = (plan: SyncEntry[]): string => {
  const order: SyncAction[] = [
    "update",
    "add",
    "conflict",
    "stub-review",
    "removed-from-template",
    "local-only",
    "restamp",
    "unchanged",
  ];
  const byAction = new Map<SyncAction, SyncEntry[]>();
  for (const e of plan) {
    byAction.set(e.action, [...(byAction.get(e.action) ?? []), e]);
  }
  const lines: string[] = [];
  for (const action of order) {
    const entries = byAction.get(action);
    if (!entries) continue;
    lines.push(`${action} (${entries.length}):`);
    // unchanged is the bulk and carries no decision — count only
    if (action !== "unchanged") {
      for (const e of entries) lines.push(`  ${e.path} — ${e.reason}`);
    }
  }
  return lines.join("\n");
};

// ---------- CLI ----------

const isMain = async (): Promise<boolean> => {
  const entry = process.argv[1];
  if (!entry) return false;
  // pathToFileURL, not `file://${entry}` — paths with spaces URL-encode (%20)
  // and a string-built URL never matches, silently skipping the CLI.
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(entry).href;
};

if (await isMain()) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const [verb, targetRoot] = [process.argv[2], process.argv[3]];
  const asJson = process.argv.includes("--json");
  const usage = "usage: tsx graft-sync.ts <stamp|plan|apply> <target-repo-path> [--json]";
  if (!verb || !targetRoot || !["stamp", "plan", "apply"].includes(verb)) {
    console.error(usage);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    console.error(`${targetRoot} is not a git repo root — refusing.`);
    process.exit(2);
  }
  // Must run from the template root: the surface is enumerated from cwd.
  if (!fs.existsSync("skills") || !fs.existsSync(".sandcastle")) {
    console.error("run from the Sandcastle template root (needs ./skills and ./.sandcastle).");
    process.exit(2);
  }

  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8" }).trim();

  // Template surface: tracked files only, so .env/logs/worktrees never leak in.
  const templateHashes: Record<string, string> = {};
  for (const f of git("ls-files", "-z", ".sandcastle", ".github", "skills").split("\0")) {
    if (!f) continue;
    const targetPath = toTargetPath(f);
    if (!targetPath) continue;
    templateHashes[targetPath] = sha256(fs.readFileSync(f));
  }

  const lockFile = path.join(targetRoot, LOCK_PATH);
  const templateCommit = git("rev-parse", "HEAD");
  const templateTreeClean =
    git("status", "--porcelain", "--", ".sandcastle", ".github", "skills") === "";
  const templateRepo = (() => {
    try {
      const m = git("remote", "get-url", "origin").match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
      return m?.[1] ?? "unknown";
    } catch {
      return "unknown";
    }
  })();

  const writeLock = (files: Record<string, string>): void => {
    const lock: GraftLock = {
      templateRepo,
      templateCommit,
      templateTreeClean,
      stampedAt: new Date().toISOString(),
      files,
    };
    fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  };

  if (verb === "stamp") {
    writeLock(templateHashes);
    if (!templateTreeClean) {
      console.error("::warning::template tree dirty under the graft surface — lock records HEAD but hashes the working tree.");
    }
    console.log(`Stamped ${Object.keys(templateHashes).length} files at ${templateCommit.slice(0, 7)} → ${lockFile}`);
    process.exit(0);
  }

  if (!fs.existsSync(lockFile)) {
    console.error(`${lockFile} not found — this target has no graft baseline. Run \`stamp\` first (at graft time, or backfilled).`);
    process.exit(2);
  }
  const lock: GraftLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));

  const targetHashes: Record<string, string> = {};
  for (const p of new Set([...Object.keys(lock.files), ...Object.keys(templateHashes)])) {
    const abs = path.join(targetRoot, p);
    if (fs.existsSync(abs)) targetHashes[p] = sha256(fs.readFileSync(abs));
  }

  const plan = planSync(lock.files, templateHashes, targetHashes);

  if (verb === "plan") {
    console.log(asJson ? JSON.stringify(plan, null, 2) : summarize(plan));
    process.exit(0);
  }

  // apply
  let copied = 0;
  for (const e of plan) {
    if (!APPLIES.has(e.action)) continue;
    const src = toTemplatePath(e.path);
    const dst = path.join(targetRoot, e.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  writeLock(nextLockFiles(plan, lock.files, templateHashes));
  const flagged = plan.filter(
    (e) => e.action === "conflict" || e.action === "stub-review" || e.action === "removed-from-template",
  );
  console.log(`Applied ${copied} file(s); lock rewritten at ${templateCommit.slice(0, 7)}.`);
  if (flagged.length > 0) {
    console.log(`NOT applied — resolve by hand, then \`stamp\`:\n${summarize(flagged)}`);
  }
}
