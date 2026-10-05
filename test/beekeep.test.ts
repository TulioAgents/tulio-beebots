// What a round leaves behind. The record file is the only evidence a round ever ran, and the liveness alert
// is the only thing that notices when rounds stop running at all, so both are tested here rather than left
// inside src/tools/beekeep.ts where nothing can reach them.
// See docs/ears/local-beekeeper.md units 1 and 9.
import { describe, expect, it } from "vitest";
import { asTrigger, roundRecord, shouldAlertOnFailures, type CoachConfig, type Outcome, type Verdict, type WrittenRules } from "../src/coach.js";

// The real thing is 48 hex characters, which is also exactly what the redactor reads as a secret.
const LAB_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const AT = "2026-10-05T04:00:00.000Z";
const CONFIG = "beekeeper/coach.json";
// A ruleset version is 16 hex characters: short enough that the redactor leaves it alone, which is why the
// record can hold the join key between a round and the engine's decision rows without holding a secret.
const REPLACED = "a1b2c3d4e5f60718";
const INSTALLED = "f0e1d2c3b4a59687";
const versions = { replacedVersion: REPLACED, installedVersion: INSTALLED };

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

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  broken: "yes",
  brokenConfidence: 0.91,
  bee: "bee1",
  beeConfidence: 0.84,
  anger: "4",
  angerConfidence: 0.72,
  ...over,
});

/** One record-file line, as the tool would have appended it. */
const line = (outcome: Outcome): string => JSON.stringify(roundRecord(AT, "cron", CONFIG, cfg(), outcome));

describe("beekeep: the round record", () => {
  it("carries the round's own metadata alongside everything a delivered outcome knows", () => {
    const r = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "delivered", verdict: verdict(), bee: "bee1", arm: "delivered", ...versions, overlayId: 42, status: 200, rules: written() });
    expect(r).toEqual({
      at: AT,
      trigger: "cron",
      config: CONFIG,
      cli: "claude",
      model: "test-model",
      control: true,
      kind: "delivered",
      verdict: verdict(),
      bee: "bee1",
      arm: "delivered",
      replacedVersion: REPLACED,
      installedVersion: INSTALLED,
      overlayId: 42,
      status: 200,
      rules: written(),
    });
  });

  it("keeps the full rules of a withheld round, and the version they would have installed (R-7.3)", () => {
    const r = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "withheld", verdict: verdict({ bee: "bee3" }), bee: "bee3", arm: "withheld", ...versions, rules: written() });
    expect(r).toEqual({
      at: AT,
      trigger: "cron",
      config: CONFIG,
      cli: "claude",
      model: "test-model",
      control: true,
      kind: "withheld",
      verdict: verdict({ bee: "bee3" }),
      bee: "bee3",
      arm: "withheld",
      replacedVersion: REPLACED,
      installedVersion: INSTALLED,
      rules: written(),
    });
  });

  it("tells a round that chose to do nothing apart from a round that could not run", () => {
    const quiet = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "quiet", verdict: verdict({ bee: "none" }), reason: "Jev says leave all three alone" });
    const failed = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "failed", verdict: null, reason: "scorecard answered 503" });
    expect(quiet).toEqual({ at: AT, trigger: "cron", config: CONFIG, cli: "claude", model: "test-model", control: true, kind: "quiet", verdict: verdict({ bee: "none" }), reason: "Jev says leave all three alone" });
    expect(failed).toEqual({ at: AT, trigger: "cron", config: CONFIG, cli: "claude", model: "test-model", control: true, kind: "failed", verdict: null, reason: "scorecard answered 503" });
    expect(quiet.kind).not.toBe(failed.kind);
  });

  it("takes the cli, model and arm setting from the config it was given, not from a default", () => {
    const r = roundRecord(AT, "manual", "other.json", cfg({ model: "claude-opus-5", controlArm: false }), { kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" });
    expect(r.config).toBe("other.json");
    expect(r.model).toBe("claude-opus-5");
    expect(r.control).toBe(false);
  });

  it("writes every answer Jev gave, including the broken answer that gates nothing (R-3.7, R-9.1)", () => {
    const delivered = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "delivered", verdict: verdict({ broken: "no" }), bee: "bee1", arm: "delivered", ...versions, overlayId: 42, status: 200, rules: written() });
    const quiet = roundRecord(AT, "manual", CONFIG, cfg(), { kind: "quiet", verdict: verdict({ bee: "unsure", beeConfidence: 0.4 }), reason: "Jev was not confident enough to name a bee (0.40)" });
    for (const r of [delivered, quiet]) {
      // all five answers, not just the two the round acted on
      expect(Object.keys(r.verdict!).sort()).toEqual(["anger", "angerConfidence", "bee", "beeConfidence", "broken", "brokenConfidence"]);
      expect(typeof r.trigger).toBe("string");
    }
    expect(delivered.verdict!.broken).toBe("no");
    expect(delivered.trigger).toBe("cron");
    expect(quiet.verdict!.beeConfidence).toBe(0.4);
    expect(quiet.trigger).toBe("manual");
  });

  it("leaves the verdict null when the round ended before Jev was asked, rather than inventing one", () => {
    const noBees = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" });
    const noCard = roundRecord(AT, "cron", CONFIG, cfg(), { kind: "failed", verdict: null, reason: "scorecard answered 503" });
    // an absent answer and a low-confidence answer are different facts, so neither gets a fabricated 0
    expect(noBees.verdict).toBeNull();
    expect(noCard.verdict).toBeNull();
    expect(JSON.parse(line({ kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" }))).toHaveProperty("verdict", null);
  });

  it("records a round whose CLI answer was the wrong shape as one that could not run (R-4.6)", () => {
    const shape = { kind: "failed", verdict: verdict(), reason: "the rules the CLI wrote are not the declared shape: coins: Required" } as const;
    const r = roundRecord(AT, "cron", CONFIG, cfg(), shape);
    // the reason names the field, and the round is failed rather than quiet: it could not run, it did not choose to
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("coins");
    expect(r).not.toHaveProperty("rules");
    // so it counts toward the liveness alert exactly like any other failure (R-1.4)
    expect(shouldAlertOnFailures([line(shape), line(shape), line(shape)], 3)).toBe(true);
  });

  it("records no secret and no signature, for any outcome (R-9.5)", () => {
    const outcomes: Outcome[] = [
      { kind: "delivered", verdict: verdict(), bee: "bee1", arm: "delivered", ...versions, overlayId: 42, status: 200, rules: written() },
      { kind: "withheld", verdict: verdict(), bee: "bee1", arm: "withheld", ...versions, rules: written() },
      { kind: "quiet", verdict: verdict({ bee: "none" }), reason: "Jev says leave all three alone" },
      // the door's own refusal text is echoed into the reason, so it is the likeliest carrier
      { kind: "failed", verdict: verdict(), reason: "the door refused the rewrite: 401 bad signature" },
    ];
    for (const o of outcomes) {
      const json = line(o);
      expect(json).not.toContain(LAB_SECRET);
      // any long hex run would be a secret or an HMAC; the real signature is 64 hex characters
      expect(json).not.toMatch(/[0-9a-fA-F]{32,}/);
      expect(json.toLowerCase()).not.toContain("x-lab-sig");
      // and the two ruleset versions are still there: at 16 hex they sit under that rule rather than bending it
      if ("installedVersion" in o) expect(json).toContain(`"replacedVersion":"${REPLACED}","installedVersion":"${INSTALLED}"`);
    }
  });
});

describe("beekeep: how the round was launched", () => {
  it("defaults to manual, because that is what an unflagged run honestly is", () => {
    expect(asTrigger(undefined)).toBe("manual");
    expect(asTrigger("")).toBe("manual");
  });

  it("takes the value given by --trigger or COACH_TRIGGER", () => {
    expect(asTrigger("cron")).toBe("cron");
    expect(asTrigger("manual")).toBe("manual");
  });

  it("refuses to read anything else as cron, since that is the claim a later read leans on", () => {
    expect(asTrigger("crron")).toBe("manual");
    expect(asTrigger("CRON")).toBe("manual");
    expect(asTrigger("systemd")).toBe("manual");
  });
});

describe("beekeep: the alert for rounds that could not run", () => {
  const failed = line({ kind: "failed", verdict: null, reason: "scorecard answered 503" });
  const quiet = line({ kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" });

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
    expect(shouldAlertOnFailures([failed, line({ kind: "delivered", verdict: verdict(), bee: "bee1", arm: "delivered", ...versions, overlayId: 1, status: 200, rules: written() }), failed], 3)).toBe(false);
  });

  it("survives a half-written line rather than taking the alert out with it", () => {
    expect(() => shouldAlertOnFailures([failed, failed, '{"kind":"fail'], 3)).not.toThrow();
    expect(shouldAlertOnFailures([failed, failed, '{"kind":"fail'], 3)).toBe(false);
    expect(shouldAlertOnFailures(['{"kind":"fail', failed, failed, failed], 3)).toBe(true);
    expect(shouldAlertOnFailures(["not json at all", "", "   "], 3)).toBe(false);
  });
});
