// What a round leaves behind. The record file is the only evidence a round ever ran, and the liveness alert
// is the only thing that notices when rounds stop running at all, so both are tested here rather than left
// inside src/tools/beekeep.ts where nothing can reach them.
// See docs/ears/local-beekeeper.md units 1 and 9.
import { describe, expect, it } from "vitest";
import { roundRecord, shouldAlertOnFailures, type CoachConfig, type Outcome, type WrittenRules } from "../src/coach.js";

// The real thing is 48 hex characters, which is also exactly what the redactor reads as a secret.
const LAB_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const AT = "2026-10-05T04:00:00.000Z";
const CONFIG = "beekeeper/coach.json";

const cfg = (over: Partial<CoachConfig> = {}): CoachConfig => ({
  engineUrl: "http://127.0.0.1:8080",
  cli: "claude",
  model: "test-model",
  confidenceFloor: 0.6,
  cliTimeoutMs: 1000,
  controlArm: true,
  promptFile: "beekeeper/opus-prompt.txt",
  recordFile: "/dev/null",
  alertAfterFailures: 3,
  ...over,
});

const written = (over: Partial<WrittenRules> = {}): WrittenRules => ({
  idea: "Tighter trend gate",
  rules: "Open only when the trend score is above 4 and close the moment it drops under 1.",
  coins: "BTC, ETH",
  reason: "The old gate let it in on weak trends.",
  quip: "You are not a trend follower, you are a tourist.",
  note: "Watch it for a day.",
  ...over,
});

/** One record-file line, as the tool would have appended it. */
const line = (outcome: Outcome): string => JSON.stringify(roundRecord(AT, CONFIG, cfg(), outcome));

describe("beekeep: the round record", () => {
  it("carries the round's own metadata alongside everything a delivered outcome knows", () => {
    const r = roundRecord(AT, CONFIG, cfg(), { kind: "delivered", bee: "bee1", arm: "delivered", overlayId: 42, status: 200, rules: written() });
    expect(r).toEqual({
      at: AT,
      config: CONFIG,
      cli: "claude",
      model: "test-model",
      control: true,
      kind: "delivered",
      bee: "bee1",
      arm: "delivered",
      overlayId: 42,
      status: 200,
      rules: written(),
    });
  });

  it("keeps the full rules of a withheld round, which is the arm the comparison rests on", () => {
    const r = roundRecord(AT, CONFIG, cfg(), { kind: "withheld", bee: "bee3", arm: "withheld", rules: written() });
    expect(r).toEqual({ at: AT, config: CONFIG, cli: "claude", model: "test-model", control: true, kind: "withheld", bee: "bee3", arm: "withheld", rules: written() });
  });

  it("tells a round that chose to do nothing apart from a round that could not run", () => {
    const quiet = roundRecord(AT, CONFIG, cfg(), { kind: "quiet", reason: "Jev says leave all three alone" });
    const failed = roundRecord(AT, CONFIG, cfg(), { kind: "failed", reason: "scorecard answered 503" });
    expect(quiet).toEqual({ at: AT, config: CONFIG, cli: "claude", model: "test-model", control: true, kind: "quiet", reason: "Jev says leave all three alone" });
    expect(failed).toEqual({ at: AT, config: CONFIG, cli: "claude", model: "test-model", control: true, kind: "failed", reason: "scorecard answered 503" });
    expect(quiet.kind).not.toBe(failed.kind);
  });

  it("takes the cli, model and arm setting from the config it was given, not from a default", () => {
    const r = roundRecord(AT, "other.json", cfg({ model: "claude-opus-5", controlArm: false }), { kind: "quiet", reason: "no bee is open for a rewrite" });
    expect(r.config).toBe("other.json");
    expect(r.model).toBe("claude-opus-5");
    expect(r.control).toBe(false);
  });

  it("records no secret and no signature, for any outcome (R-9.5)", () => {
    const outcomes: Outcome[] = [
      { kind: "delivered", bee: "bee1", arm: "delivered", overlayId: 42, status: 200, rules: written() },
      { kind: "withheld", bee: "bee1", arm: "withheld", rules: written() },
      { kind: "quiet", reason: "Jev says leave all three alone" },
      // the door's own refusal text is echoed into the reason, so it is the likeliest carrier
      { kind: "failed", reason: "the door refused the rewrite: 401 bad signature" },
    ];
    for (const o of outcomes) {
      const json = line(o);
      expect(json).not.toContain(LAB_SECRET);
      // any long hex run would be a secret or an HMAC; the real signature is 64 hex characters
      expect(json).not.toMatch(/[0-9a-fA-F]{32,}/);
      expect(json.toLowerCase()).not.toContain("x-lab-sig");
    }
  });
});

describe("beekeep: the alert for rounds that could not run", () => {
  const failed = line({ kind: "failed", reason: "scorecard answered 503" });
  const quiet = line({ kind: "quiet", reason: "no bee is open for a rewrite" });

  it("fires at exactly the configured number of consecutive failures and not one short of it", () => {
    expect(shouldAlertOnFailures([failed, failed], 3)).toBe(false);
    expect(shouldAlertOnFailures([failed, failed, failed], 3)).toBe(true);
    expect(shouldAlertOnFailures([quiet, failed, failed, failed], 3)).toBe(true);
  });

  it("stays quiet while there are not yet enough rounds to judge", () => {
    expect(shouldAlertOnFailures([], 3)).toBe(false);
    expect(shouldAlertOnFailures([""], 3)).toBe(false);
  });

  it("is silenced by any round in the window that did something other than fail", () => {
    expect(shouldAlertOnFailures([failed, quiet, failed], 3)).toBe(false);
    expect(shouldAlertOnFailures([failed, failed, quiet], 3)).toBe(false);
    expect(shouldAlertOnFailures([failed, failed, failed, quiet], 3)).toBe(false);
    expect(shouldAlertOnFailures([failed, line({ kind: "delivered", bee: "bee1", arm: "delivered", overlayId: 1, status: 200, rules: written() }), failed], 3)).toBe(false);
  });

  it("survives a half-written line rather than taking the alert out with it", () => {
    expect(() => shouldAlertOnFailures([failed, failed, '{"kind":"fail'], 3)).not.toThrow();
    expect(shouldAlertOnFailures([failed, failed, '{"kind":"fail'], 3)).toBe(false);
    expect(shouldAlertOnFailures(['{"kind":"fail', failed, failed, failed], 3)).toBe(true);
    expect(shouldAlertOnFailures(["not json at all", "", "   "], 3)).toBe(false);
  });
});
