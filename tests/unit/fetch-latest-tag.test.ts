import { describe, it, expect } from "vitest";
import { fetchLatestTag } from "../../src/commands/version.js";

describe("fetchLatestTag", () => {
  it("returns the highest semver tag when ls-remote succeeds", () => {
    const result = fetchLatestTag("https://example.invalid/repo", () => ({
      status: 0,
      stdout: [
        "abc123\trefs/tags/v0.5.0",
        "def456\trefs/tags/v1.0.0",
        "ghi789\trefs/tags/v0.9.0",
      ].join("\n"),
      stderr: "",
    }));
    expect(result).toEqual({ ok: true, tag: "v1.0.0" });
  });

  it("returns ok:false with reason when ls-remote exits non-zero", () => {
    const result = fetchLatestTag("https://example.invalid/repo", () => ({
      status: 128,
      stdout: "",
      stderr: "fatal: unable to access 'https://example.invalid/repo/': could not resolve host",
    }));
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toMatch(/128/);
      expect(result.reason).toMatch(/could not resolve host/);
    }
  });

  it("returns ok:false when the spawn itself errors (e.g. git not on PATH)", () => {
    const err = new Error("spawn git ENOENT");
    const result = fetchLatestTag("https://example.invalid/repo", () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: err,
    }));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toMatch(/ENOENT/);
  });

  it("returns ok:true with tag=null when remote has no v-tags", () => {
    const result = fetchLatestTag("https://example.invalid/repo", () => ({
      status: 0,
      stdout: "abc123\trefs/heads/main\n",
      stderr: "",
    }));
    expect(result).toEqual({ ok: true, tag: null });
  });
});
