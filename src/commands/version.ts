import { parseConfig } from "../lib/config.js";
import { parseLsRemote } from "../lib/tags.js";
import { semverLt } from "../lib/version-currency.js";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

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

export async function versionCmd(opts: { offline?: boolean; check?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const raw = await readIfExistsLocal(join(cwd, ".claude-ds.json"));
  const pinned = raw ? parseConfig(raw).packVersion : null;
  const installedVer = `v${pkg.version}`;

  if (opts.check) {
    if (!pinned) {
      console.log("no .claude-ds.json found — cannot check version");
      process.exit(1);
    }

    if (pinned === installedVer) {
      console.log(`up to date (${installedVer})`);
      process.exit(0);
    }

    console.log(`pinned: ${pinned}  installed: ${installedVer}`);
    console.log("");

    // Load CHANGELOG from package root (works in both dev and installed contexts)
    const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const changelogPath = join(pkgRoot, "CHANGELOG.md");
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

    console.log("Run `claude-ds reconcile` to clean stale paths.");
    process.exit(1);
  }

  const installed = pinned ?? "(none)";
  let latest = "unknown";
  if (!opts.offline) {
    const r = spawnSync("git", ["ls-remote","--tags","https://github.com/collod873/claude-ds"], { encoding: "utf8" });
    if (r.status === 0) { const tags = parseLsRemote(r.stdout); latest = tags[tags.length - 1] ?? "unknown"; }
  }
  console.log(`installed: ${installed}`);
  console.log(`latest: ${latest}`);
}
