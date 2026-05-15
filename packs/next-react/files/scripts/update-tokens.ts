#!/usr/bin/env node --experimental-strip-types
/**
 * update-tokens.ts — The ONLY sanctioned writer for design-system/tokens.json.
 *
 * CLI args: --set <key.path>=<json-value> (repeatable)
 * Validates JSON parses, writes back with stable key ordering and
 * 2-space indent + trailing newline.
 *
 * Refuses to write if --set flag is absent:
 *   exit 2, stderr: TOK-000: no --set provided
 *
 * Exit 0 success, 1 self-error, 2 refusal.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function parseArgs(args: string[]): string[] {
  const sets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set" && i + 1 < args.length) {
      sets.push(args[++i]);
    }
  }
  return sets;
}

/** Set a nested key using dot-path notation. Creates intermediate objects as needed. */
function setNestedKey(obj: JsonObject, keyPath: string, value: JsonValue): void {
  const parts = keyPath.split(".");
  let current: JsonObject = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as JsonObject;
  }
  current[parts[parts.length - 1]] = value;
}

/** Stable key ordering — sorts keys recursively. */
function sortKeys(obj: JsonValue): JsonValue {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === "object") {
    const sorted: JsonObject = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys((obj as JsonObject)[key]);
    }
    return sorted;
  }
  return obj;
}

function main(): void {
  const args = process.argv.slice(2);
  const sets = parseArgs(args);

  const cwd = process.cwd();
  const tokensPath = join(cwd, "design-system", "tokens.json");

  if (sets.length === 0) {
    process.stderr.write(`${tokensPath}:0: TOK-000: no --set provided; usage: update-tokens.ts --set key.path=value\n`);
    process.exit(2);
  }

  // Load existing tokens or start fresh
  let tokens: JsonObject = {};
  if (existsSync(tokensPath)) {
    try {
      tokens = JSON.parse(readFileSync(tokensPath, "utf8")) as JsonObject;
    } catch {
      process.stderr.write(`${tokensPath}:0: TOK-001: tokens.json is not valid JSON; fix manually before updating\n`);
      process.exit(1);
    }
  }

  // Apply each --set
  for (const setArg of sets) {
    const eqIdx = setArg.indexOf("=");
    if (eqIdx === -1) {
      process.stderr.write(`${tokensPath}:0: TOK-002: invalid --set format "${setArg}"; expected key.path=<json-value>\n`);
      process.exit(1);
    }
    const keyPath = setArg.slice(0, eqIdx);
    const rawValue = setArg.slice(eqIdx + 1);

    let value: JsonValue;
    try {
      value = JSON.parse(rawValue) as JsonValue;
    } catch {
      // Treat as plain string if not valid JSON
      value = rawValue;
    }

    setNestedKey(tokens, keyPath, value);
  }

  const sorted = sortKeys(tokens) as JsonObject;

  try {
    writeFileSync(tokensPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`${tokensPath}:0: TOK-003: failed to write tokens.json: ${err}\n`);
    process.exit(1);
  }

  console.log(`update-tokens: wrote ${sets.length} update(s) to ${tokensPath}`);
  process.exit(0);
}

main();
