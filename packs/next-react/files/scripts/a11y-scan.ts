#!/usr/bin/env node --experimental-strip-types
/**
 * a11y-scan.ts — Playwright + axe-core WCAG AA scan of showcase routes.
 *
 * Usage: node --experimental-strip-types scripts/a11y-scan.ts <port> <component...>
 *
 * Scans /design/<component> on localhost:<port> for each component.
 * Exits 0 if all clean, 1 if any axe violations found or scan error.
 * Exits 2 on bad args or setup failure.
 *
 * Called by scripts/run-a11y.sh after the dev server is confirmed reachable.
 */

import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function scanComponent(
  port: string,
  component: string
): Promise<boolean> {
  const url = `http://localhost:${port}/design/${component}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle" });

    if (!response || response.status() === 404) {
      // Component not in showcase manifest — skip with warning, don't block
      process.stderr.write(
        `a11y-scan: WARNING — /design/${component} returned 404; not in showcase manifest, skipping.\n`
      );
      return true;
    }

    if (!response.ok()) {
      process.stderr.write(
        `a11y-scan: ERROR — /design/${component} returned ${response.status()}\n`
      );
      return false;
    }

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .analyze();

    if (results.violations.length === 0) {
      process.stdout.write(`a11y-scan: ${component} — PASS (${url})\n`);
      return true;
    }

    process.stderr.write(
      `a11y-scan: ${component} — FAIL: ${results.violations.length} violation(s)\n`
    );
    for (const v of results.violations) {
      process.stderr.write(`  [${v.impact}] ${v.id}: ${v.description}\n`);
      for (const node of v.nodes) {
        process.stderr.write(`    target: ${node.target.join(", ")}\n`);
      }
    }
    return false;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const [, , port, ...components] = process.argv;

  if (!port || components.length === 0) {
    process.stderr.write("Usage: a11y-scan.ts <port> <component...>\n");
    process.exit(2);
  }

  let allPassed = true;
  for (const component of components) {
    const passed = await scanComponent(port, component);
    if (!passed) allPassed = false;
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`a11y-scan: fatal error: ${String(err)}\n`);
  process.exit(1);
});
