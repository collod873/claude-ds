/**
 * PRD #325 sub-issue #326 — the Decision spine resolver implements the
 * three-kind matrix exactly. These tests pin every cell:
 *
 *   kind ∈ {commitment-gate, ambiguity, automatable}
 *   × env ∈ {TTY, non-TTY}
 *   × answer ∈ {supplied, absent}
 *
 * plus the Pending-decision collection arm (heal-style: `collect: true`
 * gathers unresolved Ambiguities instead of throwing) and the named-throw
 * fail-loud arm (default for non-TTY Ambiguities). The resolver does no I/O
 * beyond the injected `prompt` callback — TTY presence is a flag, the prompt
 * is a function. No pty.
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveDecisions,
  UnresolvedAmbiguityError,
  type Decision,
  type DecisionOption,
} from "../../src/lib/decision/index.js";

const OPTS_TWO: DecisionOption[] = [
  { label: "Yes", description: "do the thing" },
  { label: "No", description: "skip it" },
];

const AMBIG = (id: string): Decision => ({
  id,
  kind: "ambiguity",
  question: `q-${id}?`,
  options: OPTS_TWO,
});

const GATE = (id: string): Decision => ({
  id,
  kind: "commitment-gate",
  question: `apply ${id}?`,
  options: [{ label: "Apply", description: "write the change" }],
});

const AUTO = (id: string, defaultIndex = 0): Decision => ({
  id,
  kind: "automatable",
  question: `auto-${id}`,
  options: OPTS_TWO,
  defaultIndex,
});

describe("resolveDecisions — three-kind matrix", () => {
  describe("ambiguity", () => {
    it("TTY + answer supplied → returns supplied answer, no prompt", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [AMBIG("a1")],
        { a1: 1 },
        { isTTY: true, prompt },
      );
      expect(out.answers).toEqual({ a1: 1 });
      expect(out.pending).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
    });

    it("TTY + answer absent → calls prompt and returns its result", async () => {
      const prompt = vi.fn().mockResolvedValue(0);
      const out = await resolveDecisions(
        [AMBIG("a1")],
        {},
        { isTTY: true, prompt },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith("q-a1?", OPTS_TWO);
      expect(out.answers).toEqual({ a1: 0 });
      expect(out.pending).toEqual([]);
    });

    it("non-TTY + answer supplied → returns supplied answer, no prompt", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [AMBIG("a1")],
        { a1: "defer" },
        { isTTY: false, prompt },
      );
      expect(out.answers).toEqual({ a1: "defer" });
      expect(out.pending).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
    });

    it("non-TTY + answer absent + default mode → throws named UnresolvedAmbiguityError", async () => {
      const prompt = vi.fn();
      let caught: unknown = null;
      try {
        await resolveDecisions([AMBIG("a1")], {}, { isTTY: false, prompt });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnresolvedAmbiguityError);
      const err = caught as UnresolvedAmbiguityError;
      expect(err.decisionId).toBe("a1");
      expect(err.decisionQuestion).toBe("q-a1?");
      expect(err.message).toContain("a1");
      expect(err.message).toContain("q-a1?");
      expect(prompt).not.toHaveBeenCalled();
    });

    it("non-TTY + answer absent + collect mode → no throw; pending decision collected", async () => {
      const out = await resolveDecisions(
        [AMBIG("a1"), AMBIG("a2")],
        { a2: 0 },
        { isTTY: false, collect: true },
      );
      // a2 was answered.
      expect(out.answers).toEqual({ a2: 0 });
      // a1 was collected, not thrown for.
      expect(out.pending.map(p => p.id)).toEqual(["a1"]);
      expect(out.pending[0].question).toBe("q-a1?");
      expect(out.pending[0].options).toEqual(OPTS_TWO);
    });
  });

  describe("commitment-gate", () => {
    it("TTY + answer absent → calls prompt", async () => {
      const prompt = vi.fn().mockResolvedValue(0);
      const out = await resolveDecisions(
        [GATE("g1")],
        {},
        { isTTY: true, prompt },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(out.answers).toEqual({ g1: 0 });
      expect(out.pending).toEqual([]);
    });

    it("TTY + answer supplied → returns supplied (no prompt)", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [GATE("g1")],
        { g1: 0 },
        { isTTY: true, prompt },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(out.answers).toEqual({ g1: 0 });
    });

    it("non-TTY → auto-applies (defaultIndex falls back to 0), no prompt, never pending", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [GATE("g1")],
        {},
        { isTTY: false, prompt },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(out.answers).toEqual({ g1: 0 });
      expect(out.pending).toEqual([]);
    });

    it("non-TTY honours an explicit defaultIndex", async () => {
      const gate: Decision = {
        id: "g2",
        kind: "commitment-gate",
        question: "apply?",
        options: [
          { label: "Apply", description: "" },
          { label: "Apply (verbose)", description: "" },
        ],
        defaultIndex: 1,
      };
      const out = await resolveDecisions([gate], {}, { isTTY: false });
      expect(out.answers).toEqual({ g2: 1 });
    });
  });

  describe("automatable", () => {
    it("TTY → returns default, no prompt, never pending", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [AUTO("x1", 0)],
        {},
        { isTTY: true, prompt },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(out.answers).toEqual({ x1: 0 });
      expect(out.pending).toEqual([]);
    });

    it("non-TTY → returns default, no prompt, never pending", async () => {
      const prompt = vi.fn();
      const out = await resolveDecisions(
        [AUTO("x1", 1)],
        {},
        { isTTY: false, prompt },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(out.answers).toEqual({ x1: 1 });
      expect(out.pending).toEqual([]);
    });

    it("supplied answer overrides the default", async () => {
      const out = await resolveDecisions(
        [AUTO("x1", 0)],
        { x1: 1 },
        { isTTY: false },
      );
      expect(out.answers).toEqual({ x1: 1 });
    });
  });

  describe("mixed batches", () => {
    it("non-TTY collect mode mixes resolved automatable/commitment-gate with pending ambiguities", async () => {
      const decisions = [
        AUTO("auto1", 0),
        GATE("gate1"),
        AMBIG("amb1"),
        AMBIG("amb2"),
      ];
      const out = await resolveDecisions(
        decisions,
        { amb2: 1 },
        { isTTY: false, collect: true },
      );
      expect(out.answers).toEqual({
        auto1: 0,
        gate1: 0,
        amb2: 1,
      });
      expect(out.pending.map(p => p.id)).toEqual(["amb1"]);
    });

    it("TTY mixes prompted ambiguities with auto-applied gates and automatables", async () => {
      const prompt = vi.fn().mockResolvedValue(0);
      const decisions = [
        AUTO("auto1", 0),
        GATE("gate1"),
        AMBIG("amb1"),
      ];
      const out = await resolveDecisions(
        decisions,
        {},
        { isTTY: true, prompt },
      );
      // GATE in TTY without supplied answer → also prompted.
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(out.answers).toEqual({ auto1: 0, gate1: 0, amb1: 0 });
      expect(out.pending).toEqual([]);
    });
  });

  describe("empty input", () => {
    it("returns empty answers and pending", async () => {
      const out = await resolveDecisions([], {}, { isTTY: false });
      expect(out.answers).toEqual({});
      expect(out.pending).toEqual([]);
    });
  });
});
