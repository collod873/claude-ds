import { parseConfig } from "../lib/config.js";
import { parseLsRemote } from "../lib/tags.js";
import { semverLt } from "../lib/version-currency.js";
import { printNextStep } from "../lib/log.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

const DEFAULT_REMOTE = "https://github.com/collod873/claude-ds";

async function readIfExistsLocal(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Extract all version headings from CHANGELOG that fall between pinned (exclusive) and installed (inclusive). */
export function extractChangelogSections(changelog: string, pinned: string, installed: string): string[] {
  const lines = changelog.split("\n");
  const sections: string[] = [];
  let capturing = false;
  let currentSection: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (headingMatch) {
      // Save previous section if we were capturing
      if (capturing && currentSection.length > 0) {
        sections.push(currentSection.join("\n").trim());
        currentSection = [];
      }
      const ver = `v${headingMatch[1]}`;
      // Include versions strictly after pinned and at most installed
      // i.e. pinned < ver <= installed
      const afterPinned = semverLt(pinned, ver);
      const atMostInstalled = !semverLt(installed, ver);
      if (afterPinned && atMostInstalled) {
        capturing = true;
        currentSection = [line];
      } else {
        capturing = false;
      }
    } else if (capturing) {
      currentSection.push(line);
    }
  }
  if (capturing && currentSection.length > 0) {
    sections.push(currentSection.join("\n").trim());
  }
  return sections;
}

export type LatestTagResult =
  | { ok: true; tag: string | null }
  | { ok: false; reason: string };

export interface SpawnRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GitRunner = (cmd: string, args: string[]) => SpawnRunResult;

const defaultRunner: GitRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
};

/** Resolve the latest v-prefixed semver tag at a remote. Caller distinguishes
 *  network/CLI failure (ok:false) from "remote has no v-tags" (ok:true, tag:null). */
export function fetchLatestTag(remote: string, runner: GitRunner = defaultRunner): LatestTagResult {
  const r = runner("git", ["ls-remote", "--tags", remote]);
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status !== 0) {
    const detail = r.stderr.trim() || `(no stderr)`;
    return { ok: false, reason: `git ls-remote exited ${r.status ?? "null"}: ${detail}` };
  }
  const tags = parseLsRemote(r.stdout);
  return { ok: true, tag: tags[tags.length - 1] ?? null };
}

export async function versionCmd(opts: { offline?: boolean; check?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const raw = await readIfExistsLocal(join(cwd, ".claude-ds.json"));
  const pinned = raw ? parseConfig(raw).packVersion : null;
  const installedVer = `v${pkg.version}`;

  if (opts.check) {
    if (!pinned) {
      console.log("no .claude-ds.json found — cannot check version");
      printNextStep("version", { versionState: "no-config" });
      process.exit(1);
    }

    if (pinned === installedVer) {
      console.log(`up to date (${installedVer})`);
      printNextStep("version", { versionState: "up-to-date" });
      process.exit(0);
    }

    console.log(`pinned: ${pinned}  installed: ${installedVer}`);
    console.log("");

    // Resolve CHANGELOG.md via the same relative URL pattern the package.json
    // import already uses — `../../CHANGELOG.md` from src|dist/commands/version.{ts,js}
    // lands at the package root in dev, dist, and installed layouts. The previous
    // `dirname(dirname(...))` approach mis-landed at dist/ (issue #357).
    const changelogPath = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
    const changelog = await readIfExistsLocal(changelogPath);

    if (changelog) {
      const sections = extractChangelogSections(changelog, pinned, installedVer);
      if (sections.length > 0) {
        console.log("Changes between your pinned version and installed version:\n");
        for (const s of sections) {
          // Print just the heading line for brevity
          const heading = s.split("\n")[0];
          console.log(`  ${heading}`);
        }
        console.log("");
      }
    }

    // #363: replace the free-form "Run `claude-ds upgrade`..." line with the
    // canonical `→ Next:` breadcrumb. Route based on direction: pinned <
    // installed → upgrade; pinned > installed → update the CLI binary.
    const state: "behind" | "ahead" = semverLt(pinned, installedVer) ? "behind" : "ahead";
    printNextStep("version", { versionState: state });
    process.exit(1);
  }

  // Default mode. `installed` is the CLI binary version (consistent with
  // --check — issue #367). `pinned` is .claude-ds.json#packVersion, or
  // `(none)` when no config is present. `latest` is the highest tag at the
  // remote; failures print a hint on stderr instead of silently rendering
  // `latest: unknown` (issue #368).
  console.log(`installed: ${installedVer}`);
  console.log(`pinned: ${pinned ?? "(none)"}`);

  if (opts.offline) {
    console.log(`latest: unknown`);
    printNextStep("version", { versionState: defaultVersionState(pinned, installedVer) });
    return;
  }

  const result = fetchLatestTag(DEFAULT_REMOTE);
  if (result.ok) {
    console.log(`latest: ${result.tag ?? "unknown"}`);
  } else {
    console.log(`latest: unknown`);
    console.error(`(latest tag check failed: ${result.reason}; pass --offline to skip)`);
  }
  printNextStep("version", { versionState: defaultVersionState(pinned, installedVer) });
}

/**
 * #363: pick the breadcrumb routing for the default `version` mode. Mirrors
 * the `--check` branch — no pin → adopt, pin behind → upgrade, pin ahead →
 * update the CLI, equal → audit — so both surfaces land on the same next step
 * for the same project state.
 */
function defaultVersionState(
  pinned: string | null,
  installedVer: string,
): "no-config" | "up-to-date" | "behind" | "ahead" {
  if (!pinned) return "no-config";
  if (pinned === installedVer) return "up-to-date";
  return semverLt(pinned, installedVer) ? "behind" : "ahead";
}
