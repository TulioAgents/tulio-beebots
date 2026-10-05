// What a round leaves behind. The record file is the only evidence a round ever ran, and the liveness alert
// is the only thing that notices when rounds stop running at all, so both are tested here rather than left
// inside src/tools/beekeep.ts where nothing can reach them.
// See docs/ears/local-beekeeper.md units 1 and 9.
import { describe, expect, it } from "vitest";
import { asTrigger, CoachConfig, configProblems, preflightFailure, readCliResult, roundRecord, shouldAlertOnFailures, shouldAlertOnThisFailure, type Outcome, type PreflightInputs, type RoundRecord, type Verdict, type WrittenRules } from "../src/coach.js";

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
      // and the pre-flight checks, which are the only code that reads the secret before deciding anything
      preflightFailure(cfg(), { labSecret: LAB_SECRET.slice(0, 20), jevKey: "jev-key", promptFileExists: true })!,
      preflightFailure(cfg(), { labSecret: "", jevKey: "", promptFileExists: true })!,
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

// A round can also end before the round loop ever starts, and those are the failures that repeat on every cron
// tick rather than once: an unexported key or a deleted prompt template fails identically forever.
// See docs/ears/local-beekeeper.md unit 1.
describe("beekeep: a round that could not start", () => {
  const ready: PreflightInputs = { labSecret: LAB_SECRET, jevKey: "jev-key-xyz", promptFileExists: true };
  const blocked = (over: Partial<PreflightInputs>) => preflightFailure(cfg(), { ...ready, ...over })!;
  /** The record-file line the tool appends for a pre-flight failure. */
  const blockedLine = (over: Partial<PreflightInputs>) => JSON.stringify(roundRecord(AT, "cron", CONFIG, cfg(), blocked(over)));

  it("lets the round start when the secret, the key and the prompt template are all there", () => {
    expect(preflightFailure(cfg(), ready)).toBeNull();
  });

  it("records an absent LAB_SECRET as a round that could not run (R-1.3, R-1.4)", () => {
    const o = blocked({ labSecret: "" });
    expect(o.kind).toBe("failed");
    expect(o.reason).toContain("LAB_SECRET");
    expect(o.reason).toContain("not set");
    expect(JSON.parse(blockedLine({ labSecret: "" }))).toMatchObject({ at: AT, trigger: "cron", kind: "failed", verdict: null });
  });

  it("records a short LAB_SECRET without recording the secret, a piece of it, or its length (R-1.6)", () => {
    const short = LAB_SECRET.slice(0, 31);
    const o = blocked({ labSecret: short });
    expect(o.reason).toContain("LAB_SECRET");
    expect(o.reason).toContain("shorter than");
    const json = blockedLine({ labSecret: short });
    expect(json).not.toContain(short);
    // not even a prefix: the first few characters are as much of a secret as all of it
    expect(json).not.toContain(short.slice(0, 8));
    expect(json).not.toMatch(/[0-9a-fA-F]{32,}/);
    // and not the length either, which would narrow a guess at the value the operator actually set
    expect(json).not.toContain("31");
    // the bound it failed is the door's own, so the reason names that and nothing about the secret
    expect(o.reason).toContain("32");
  });

  it("records an absent TYPESAFE_API_KEY, which is the failure that repeats on every tick (R-1.4)", () => {
    const o = blocked({ jevKey: "" });
    expect(o.kind).toBe("failed");
    expect(o.reason).toContain("TYPESAFE_API_KEY");
    // so it counts toward the liveness alert like any failure inside the round, which it could not when it
    // wrote no line at all (R-9.4)
    const l = blockedLine({ jevKey: "" });
    expect(shouldAlertOnFailures([l, l, l], 3)).toBe(true);
  });

  it("records a missing prompt template, naming the path it looked at", () => {
    const o = preflightFailure(cfg({ promptFile: "beekeeper/deleted-prompt.txt" }), { ...ready, promptFileExists: false })!;
    expect(o.kind).toBe("failed");
    expect(o.reason).toContain("beekeeper/deleted-prompt.txt");
  });

  it("never records a round that could not start as one that chose to do nothing (R-1.5)", () => {
    const causes: Array<Partial<PreflightInputs>> = [{ labSecret: "" }, { labSecret: "too-short" }, { jevKey: "" }, { promptFileExists: false }];
    for (const over of causes) {
      const o = blocked(over);
      expect(o.kind).toBe("failed");
      expect(o.kind).not.toBe("quiet");
      // and no verdict is invented for a round that ended before Jev was asked
      expect(o.verdict).toBeNull();
      expect(JSON.parse(blockedLine(over))).toHaveProperty("kind", "failed");
    }
    // the liveness alert reads that word and nothing else, so "quiet" here would silence it outright
    expect(shouldAlertOnFailures(causes.map(blockedLine), 4)).toBe(true);
  });

  it("names the secret first, so a run with nothing set at all reports the door rather than the prompt", () => {
    expect(blocked({ labSecret: "", jevKey: "", promptFileExists: false }).reason).toContain("LAB_SECRET");
  });

  it("still lists every config problem readably, for the one round it cannot record (R-8.3)", () => {
    // A config that does not parse holds no `recordFile` to append to and no honest cli, model or control to put
    // in a line, and reading them out of it anyway is the fallback R-8.3 forbids. So this path keeps stderr and
    // exit 1 — `preflightFailure` cannot even be called without a config that validated.
    const bad = CoachConfig.safeParse({ engineUrl: "http://127.0.0.1:8080", cli: "codex" });
    expect(bad.success).toBe(false);
    const text = bad.success ? "" : configProblems(bad.error.issues);
    // one line per field, each naming its field: what the operator fixing it is reading
    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(text).toContain("cli: ");
    expect(text).toContain("recordFile: ");
    expect(text).toContain("promptFile: ");
    expect(text).toContain("alertAfterFailures: ");
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

// The round deciding whether to shout is itself one of the rounds being counted, and its line is not on disk
// when the file is read. A pre-flight failure is the case that matters: those repeat identically on every tick,
// so they are the ones that reach the threshold, and until this fold existed that exit never evaluated it at all.
// See docs/ears/local-beekeeper.md R-9.4.
describe("beekeep: the alert raised by the round that could not run", () => {
  const ready: PreflightInputs = { labSecret: LAB_SECRET, jevKey: "jev-key-xyz", promptFileExists: true };
  /** This round's record, as the tool builds it before appending. */
  const record = (outcome: Outcome): RoundRecord => roundRecord(AT, "cron", CONFIG, cfg(), outcome);
  /** A pre-flight failure: what a missing key or a deleted template records, every tick, forever. */
  const preflight = (over: Partial<PreflightInputs> = { jevKey: "" }) => preflightFailure(cfg(), { ...ready, ...over })!;
  const noKey = record(preflight());
  const noKeyLine = JSON.stringify(noKey);
  const inRound = record({ kind: "failed", verdict: null, reason: "scorecard answered 503" });
  const quietLine = JSON.stringify(record({ kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" }));

  it("fires once the configured number of pre-flight failures is reached, which it could not when that exit never looked", () => {
    expect(shouldAlertOnThisFailure([noKeyLine, noKeyLine], noKey, 3)).toBe(true);
    const deleted = record(preflight({ promptFileExists: false }));
    expect(shouldAlertOnThisFailure([JSON.stringify(deleted), JSON.stringify(deleted)], deleted, 3)).toBe(true);
  });

  it("counts the round doing the counting, so it fires on the round that reaches the threshold and not the one after", () => {
    // Two on disk plus this one is three. The file is read before this round's line is appended, so folding it
    // in is the whole point: without it the third failing round sees only two and the alert arrives a tick late.
    expect(shouldAlertOnFailures([noKeyLine, noKeyLine], 3)).toBe(false);
    expect(shouldAlertOnThisFailure([noKeyLine, noKeyLine], noKey, 3)).toBe(true);
    // and it is counted once, not twice: one failure on disk and this one is two, which is still short of three
    expect(shouldAlertOnThisFailure([noKeyLine], noKey, 3)).toBe(false);
  });

  it("does not fire one short of the configured number", () => {
    expect(shouldAlertOnThisFailure([noKeyLine], noKey, 3)).toBe(false);
    expect(shouldAlertOnThisFailure([], noKey, 3)).toBe(false);
    expect(shouldAlertOnThisFailure([noKeyLine, noKeyLine, noKeyLine], noKey, 5)).toBe(false);
  });

  it("is silenced by a round that chose to leave the bees alone (R-1.5, R-9.2)", () => {
    // A quiet round ran. It is not a round that could not run, so it breaks the streak wherever it sits.
    expect(shouldAlertOnThisFailure([noKeyLine, quietLine], noKey, 3)).toBe(false);
    expect(shouldAlertOnThisFailure([quietLine, noKeyLine], noKey, 3)).toBe(false);
    expect(shouldAlertOnThisFailure([quietLine, noKeyLine, noKeyLine], noKey, 3)).toBe(true);
  });

  it("treats a pre-flight failure and a failure inside the round as the same streak", () => {
    // Both are rounds that could not run, and a cause can move between them: the key goes missing for two ticks,
    // then is set and the door refuses. Counting them apart would silence the alert on the mixed window.
    expect(shouldAlertOnThisFailure([noKeyLine, JSON.stringify(inRound)], noKey, 3)).toBe(true);
    expect(shouldAlertOnThisFailure([JSON.stringify(inRound), noKeyLine], inRound, 3)).toBe(true);
    expect(shouldAlertOnThisFailure([noKeyLine, noKeyLine], inRound, 3)).toBe(true);
  });

  it("records no secret in the line it folds in, and says nothing of any reason when it shouts (R-9.5, R-1.6)", () => {
    // The ALERT text the tool prints is the count and nothing else, so the only thing this fold can leak is the
    // record it builds — and the pre-flight checks are the only code that reads the secret before deciding.
    const json = JSON.stringify(record(preflight({ labSecret: LAB_SECRET.slice(0, 20) })));
    expect(json).not.toContain(LAB_SECRET.slice(0, 8));
    expect(json).not.toMatch(/[0-9a-fA-F]{32,}/);
  });
});

// What the rules-writing CLI really does, as opposed to what its exit code claims. Verified against claude
// 2.1.263: a complete envelope and a non-zero exit arrive together often enough that reading the code first
// loses good rewrites. See docs/ears/local-beekeeper.md R-4.6.
describe("beekeep: reading what the CLI wrote", () => {
  const SIX = { idea: "i", rules: "r", coins: "BTC", reason: "because", quip: "q", note: "n" };
  const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({ is_error: false, permission_denials: [], structured_output: SIX, ...over });
  const died = (over: Partial<{ code: number | null; signal: string | null; killed: boolean; stderr: string }> = {}) => ({ code: 1, signal: null, killed: false, stderr: "", ...over });

  it("takes the rules from a complete envelope even when the CLI exited non-zero", () => {
    const r = readCliResult(envelope(), died({ code: 1 }));
    expect(r).toEqual({ ok: true, output: SIX });
  });

  it("believes the envelope's own verdict over its exit code, in both directions", () => {
    // says it failed, exited cleanly
    expect(readCliResult(envelope({ is_error: true }), null)).toEqual({ ok: false, reason: "the CLI reported an error" });
    // says it is fine, exited badly
    expect(readCliResult(envelope(), died({ code: 143 })).ok).toBe(true);
  });

  it("refuses an answer from a run that used a capability it was not given (R-4.3, R-4.5)", () => {
    const r = readCliResult(envelope({ permission_denials: [{ tool: "Bash" }] }), null);
    expect(r).toEqual({ ok: false, reason: "the CLI tried to use a capability it was not given" });
  });

  it("tells a timeout apart from a crash apart from silence", () => {
    expect(readCliResult("", died({ killed: true }))).toMatchObject({ ok: false, reason: expect.stringContaining("did not answer within its timeout") });
    expect(readCliResult("", died({ code: 2 }))).toMatchObject({ ok: false, reason: expect.stringContaining("exited 2") });
    expect(readCliResult("", died({ code: null, signal: "SIGKILL" }))).toMatchObject({ ok: false, reason: expect.stringContaining("SIGKILL") });
    expect(readCliResult("not json at all", null)).toEqual({ ok: false, reason: "the CLI did not return JSON" });
    expect(readCliResult(envelope({ structured_output: null }), null)).toEqual({ ok: false, reason: "the CLI returned no usable rules" });
  });

  it("keeps the reason short enough to read in a record file", () => {
    // the bug this replaces reported the whole command line, schema included, as the reason
    const r = readCliResult("", died({ code: 1, stderr: `x${"y".repeat(5000)}` }));
    if (r.ok) throw new Error("expected a failure");
    expect(r.reason.length).toBeLessThan(300);
    expect(r.reason).not.toContain("--json-schema");
  });

  it("is not fooled by stdout that parses but is not an object", () => {
    for (const s of ["[1,2]", '"a string"', "42", "null"]) {
      expect(readCliResult(s, null)).toEqual({ ok: false, reason: "the CLI did not return JSON" });
    }
  });
});
