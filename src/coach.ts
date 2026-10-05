// The Beekeeper, run locally: one round per call. Reads the engine's scorecard, asks Jev which bee is
// broken, has a local CLI write new rules, then — on a coin flip — either delivers them to the engine's lab
// door or records them as withheld.
//
// The coin flip is the point. The round is told to pick the FAILING bee, so a bee's "before" window is
// conditioned on being the worst of three and regression to the mean moves the "after" window up on its
// own. A delivered-vs-withheld comparison cancels that; a before-vs-after comparison does not.
// See docs/ears/local-beekeeper.md unit 7 and docs/lld/beekeeper-audit-log.md.
//
// Every guard that matters lives in the engine (lab/door.ts): this is an untrusted client of a validated
// door. Nothing here can reach leverage, stops, sizing, caps or the mode.
import { z } from "zod";
import { LAB_MIN_SECRET, labSignature } from "./lab/door.js";

export const OVERLAY_PATH = "/lab/overlay";
/** The engine's read-only ruleset-version preview (keeper-http.ts). Asked on both arms, so it must change nothing. */
export const VERSION_PATH = "/keeper/ruleset-version";
/** The door's own bounds (lab/door.ts). Checked here so a refusal never burns a round. */
export const RULES_MIN = 10;
export const RULES_MAX = 500;
export const REASON_MAX = 300;
export const COINS_MAX = 20;
export const IDEA_MAX = 80;
export const QUIP_MAX = 160;

export const CoachConfig = z
  .object({
    /** Where the engine listens. Loopback in normal use. */
    engineUrl: z.string().url(),
    /** Which local CLI writes the rules, and with which model. */
    cli: z.enum(["claude"]),
    model: z.string().min(1),
    /** Below this, an answer from Jev counts as unsure and the round stops. */
    confidenceFloor: z.number().min(0).max(1),
    cliTimeoutMs: z.number().int().positive(),
    /** false = deliver every round, which makes the result uninterpretable. Recorded either way. */
    controlArm: z.boolean(),
    /** The rules-writing prompt, with {{bee}} {{anger}} {{playbook}} {{scorecard}} {{universe}}. */
    promptFile: z.string().min(1),
    /** Where round records are appended, one JSON object per line. */
    recordFile: z.string().min(1),
    /** Raise an alert after this many consecutive rounds that could not run. */
    alertAfterFailures: z.number().int().positive(),
  })
  .strict();
export type CoachConfig = z.infer<typeof CoachConfig>;

/** What the scorecard endpoint gives us. Everything in it is data, never instructions. */
export interface Scorecard {
  scorecard: string;
  playbook: string;
  universe: string;
  open_bees: string;
}

export interface Verdict {
  /** Yes/no, logged only: it gates nothing (jev-questions.md step 5). */
  broken: "yes" | "no" | "unsure";
  brokenConfidence: number;
  bee: string;
  beeConfidence: number;
  /** 1..5, or "unsure". */
  anger: string;
  angerConfidence: number;
}

// The six fields R-4.2 declares, as a schema and not just an interface: what comes back from the rules-writing
// CLI is a local agent's stdout, so the declared shape has to be checkable at runtime, and the check belongs
// next to the type it proves rather than in the tool that happens to spawn the process. `note` is required
// because R-4.2 requires it: nothing reads it today, and a tool that stops writing it has stopped obeying the
// schema, which is the thing worth noticing. Unknown keys are dropped, so what comes out of a parse is exactly
// these six fields and nothing a model decided to add.
export const WrittenRules = z.object({
  idea: z.string(),
  rules: z.string(),
  coins: z.string(),
  reason: z.string(),
  quip: z.string(),
  note: z.string(),
});
export type WrittenRules = z.infer<typeof WrittenRules>;

export type Arm = "delivered" | "withheld";

// The ruleset version a rewrite replaced and the one it installed (R-9.3) — for a withheld round, the one it
// would have installed (R-7.3). This is the join key between a round record and the engine's `decisions` rows,
// and it cannot be reconstructed afterwards because the overlay stack moves underneath.
export interface Versions {
  replacedVersion: string | null;
  installedVersion: string | null;
}

/** How the round was launched. Not knowable inside the round: whatever started the process supplies it. */
export const TRIGGERS = ["cron", "manual"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/**
 * Anything unrecognised reads as "manual", which is the honest answer: a value typed at a shell came from a
 * person. A typo must never be recorded as "cron", because that is the claim a later read actually leans on.
 */
export const asTrigger = (raw: string | undefined): Trigger => (TRIGGERS.includes(raw as Trigger) ? (raw as Trigger) : "manual");

// Every variant carries the verdict, because `broken` gates nothing (R-3.7) and so exists only in the
// record. `null` means the round ended before Jev was asked: an absent answer and a low-confidence answer
// are different facts, so no verdict is ever invented for those rounds.
export type Outcome =
  /** A rewrite reached the door. */
  | ({ kind: "delivered"; verdict: Verdict; bee: string; arm: Arm; overlayId: number | null; status: number; rules: WrittenRules } & Versions)
  /** A rewrite was produced and deliberately not sent: the control arm. */
  | ({ kind: "withheld"; verdict: Verdict; bee: string; arm: Arm; rules: WrittenRules } & Versions)
  /** The round ran and chose to change nothing. */
  | { kind: "quiet"; verdict: Verdict | null; reason: string }
  /** The round could not run. Never to be confused with "quiet". */
  | { kind: "failed"; verdict: Verdict | null; reason: string };

// ---------- before the round starts ----------

/** What the tool has already read from the environment and the filesystem, since none of it is knowable here. */
export interface PreflightInputs {
  labSecret: string;
  jevKey: string;
  /** Whether `cfg.promptFile` is there. The tool looks; this only decides what that means. */
  promptFileExists: boolean;
}

/**
 * Why this round cannot start, as the outcome it will be recorded under, or null when it can.
 *
 * These checks used to be stderr and an exit code only, which left the failures that repeat on every single cron
 * tick — a key that was never exported, a prompt template someone deleted — writing no line at all. R-1.4 says a
 * round that ends for any reason records its reason, and the liveness alert counts `failed` lines, so the one
 * condition R-9.4 exists to catch was the one condition it could not see.
 *
 * Returns the whole outcome rather than a bare string so that the thing R-1.5 turns on is decided here, where a
 * test can reach it: a round that could not run is `failed` and never `quiet`. `verdict` is null because Jev is
 * asked inside the round and this runs before it — an absent answer is not a low-confidence one.
 *
 * R-1.6: a reason names the problem and never the value. "Not set" and "shorter than 32" are facts about the
 * environment rather than about the secret; the actual length would narrow a guess at it, so it is not recorded.
 */
export function preflightFailure(cfg: CoachConfig, inputs: PreflightInputs): Extract<Outcome, { kind: "failed" }> | null {
  const failed = (reason: string): Extract<Outcome, { kind: "failed" }> => ({ kind: "failed", verdict: null, reason });
  if (!inputs.labSecret) return failed("LAB_SECRET is not set: without it the engine's door cannot be opened");
  if (inputs.labSecret.length < LAB_MIN_SECRET) return failed(`LAB_SECRET is shorter than the ${LAB_MIN_SECRET} characters the engine's door requires`);
  if (!inputs.jevKey) return failed("TYPESAFE_API_KEY is not set: Jev has to be asked which bee is broken");
  if (!inputs.promptFileExists) return failed(`no prompt template at ${cfg.promptFile}`);
  return null;
}

/**
 * The config error the tool prints, one line per issue and each naming its field (R-8.3): the operator fixing it
 * is reading stderr and nothing else.
 *
 * Stderr really is all there is for this one. `recordFile` is a field of the config that just failed to parse, so
 * a round that dies here has nowhere to append and no honest `cli`, `model` or `control` to put in a line — and
 * inventing them, or trusting them out of a config that did not validate, is the fallback R-8.3 forbids. It is
 * the only round that ends without a record; every check below it has a parsed config and writes one.
 */
export const configProblems = (issues: readonly z.ZodIssue[]): string => issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");

// ---------- pure helpers ----------

/**
 * The door does not check the character set and a JSON schema cannot express one, so it is done here.
 * Note this also removes newlines and tabs, which is why `collapse` turns whitespace into spaces first.
 */
export const toAscii = (s: string): string => s.replace(/[^\x20-\x7E]/g, "");

/**
 * Whitespace to single spaces, then non-ASCII out. The order matters: stripping first would delete the
 * newline in "spaces\nand" and glue the words together.
 *
 * Takes a string and nothing else, deliberately. The `String(s)` cast this used to open with turned a missing
 * field into the five-character text "undefined" and handed it on as if the model had written it; the shape is
 * checked once at the boundary instead (`runRound`), and a cast here would only hide the next one.
 */
export const collapse = (s: string): string =>
  toAscii(s.replace(/\s+/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** Uppercase, de-duplicate, drop anything the scorecard does not list, cap at the door's limit. */
export function tidyCoins(raw: string, tradeable: readonly string[]): string[] {
  const allowed = new Set(tradeable.map((c) => c.trim().toUpperCase()).filter(Boolean));
  const seen = new Set<string>();
  for (const c of raw.split(/[,\s]+/)) {
    const t = c.trim().toUpperCase();
    if (t && allowed.has(t)) seen.add(t);
  }
  return [...seen].slice(0, COINS_MAX);
}

export interface OverlayPayload {
  bee: string;
  rules: string;
  coins: string[];
  reason: string;
  metrics: Record<string, string | number>;
}

/**
 * Turn what the model wrote into something the door will accept, or say why it cannot be.
 * Runs identically whether the round will deliver or withhold, so the two arms stay comparable.
 */
export function buildPayload(
  bee: string,
  anger: string,
  written: WrittenRules,
  tradeable: readonly string[],
  survivesRedact: (v: unknown) => boolean,
): { ok: true; payload: OverlayPayload } | { ok: false; reason: string } {
  const rules = collapse(written.rules);
  if (rules.length < RULES_MIN) return { ok: false, reason: `rules too short after cleaning: ${rules.length} < ${RULES_MIN}` };
  const reason = collapse(written.reason).slice(0, REASON_MAX);
  if (!reason) return { ok: false, reason: "reason empty after cleaning" };

  const level = /[1-5]/.exec(anger);
  const payload: OverlayPayload = {
    bee,
    rules: rules.slice(0, RULES_MAX),
    coins: tidyCoins(written.coins, tradeable),
    reason,
    metrics: {
      source: "local-beekeeper",
      anger: level ? Number(level[0]) : 3,
      idea: collapse(written.idea).slice(0, IDEA_MAX),
      quip: collapse(written.quip).slice(0, QUIP_MAX),
    },
  };
  // The door refuses anything the redactor would mask, which would burn the round for nothing.
  if (!survivesRedact(payload.rules) || !survivesRedact(payload.reason) || !survivesRedact(payload.metrics)) {
    return { ok: false, reason: "rules, reason or metrics contain text the engine's redactor would mask" };
  }
  return { ok: true, payload };
}

/** The scorecard's open bees, as ids. */
export const openBees = (card: Scorecard): string[] => card.open_bees.split(",").map((b) => b.trim()).filter(Boolean);

export const tradeableCoins = (card: Scorecard): string[] => card.universe.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

/** Fill the prompt template. Scorecard content is interpolated as data; it is never executed. */
export function renderPrompt(template: string, card: Scorecard, bee: string, anger: string): string {
  return template
    .replaceAll("{{bee}}", bee)
    .replaceAll("{{anger}}", anger)
    .replaceAll("{{playbook}}", card.playbook)
    .replaceAll("{{scorecard}}", card.scorecard)
    .replaceAll("{{universe}}", card.universe);
}

/** Which arm this round takes. Called only after selection, generation and cleaning have all happened. */
export const pickArm = (control: boolean, coin: () => number): Arm => (!control ? "delivered" : coin() < 0.5 ? "delivered" : "withheld");

// ---------- the round ----------

export interface CoachDeps {
  cfg: CoachConfig;
  /** The rules-writing prompt template, already read from disk. */
  template: string;
  labSecret: string;
  fetch: typeof globalThis.fetch;
  /** Asks Jev the three questions. */
  ask: (card: Scorecard, floor: number) => Promise<Verdict>;
  /** Runs the local CLI under a pinned capability set and returns what it wrote, unvalidated: `runRound` checks it. */
  write: (prompt: string) => Promise<unknown>;
  survivesRedact: (v: unknown) => boolean;
  coin: () => number;
  now: () => number;
}

const UNKNOWN_VERSIONS: Versions = { replacedVersion: null, installedVersion: null };

/**
 * Asks the engine what version this bee runs now and what version the sanitised rules would produce.
 *
 * Never throws and never abandons the round: this is audit bookkeeping, and the engine takes the same line for
 * its own ruleset stamp (`stamp` in src/engine.ts), where a failed audit write records an unknown ruleset
 * rather than disturb a trade. An engine that went down mid-round, a 400, a reply that is not two version
 * strings — all of them record two nulls and let the round deliver or withhold exactly as it would have.
 */
async function previewVersions(d: CoachDeps, base: string, p: OverlayPayload): Promise<Versions> {
  try {
    const r = await d.fetch(`${base}${VERSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The route's schema is strict: these three fields and nothing else.
      body: JSON.stringify({ bee: p.bee, rules: p.rules, coins: p.coins }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return UNKNOWN_VERSIONS;
    const v = (await r.json()) as { current?: unknown; next?: unknown };
    // A version is 16 hex characters. Anything else is not the join key the record would be claiming to hold,
    // and a half-recognised string is worse than an honest null: it joins to nothing and nobody can tell why.
    const version = (x: unknown) => (typeof x === "string" && /^[0-9a-f]{16}$/.test(x) ? x : null);
    return { replacedVersion: version(v.current), installedVersion: version(v.next) };
  } catch {
    return UNKNOWN_VERSIONS;
  }
}

export async function runRound(d: CoachDeps): Promise<Outcome> {
  const base = d.cfg.engineUrl.replace(/\/+$/, "");

  let card: Scorecard;
  try {
    const r = await d.fetch(`${base}/keeper/scorecard`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { kind: "failed", verdict: null, reason: `scorecard answered ${r.status}` };
    card = (await r.json()) as Scorecard;
    if (typeof card.scorecard !== "string" || typeof card.open_bees !== "string") return { kind: "failed", verdict: null, reason: "scorecard is not the shape this expects" };
  } catch (err) {
    return { kind: "failed", verdict: null, reason: `could not read the scorecard: ${(err as Error).message}` };
  }

  const open = openBees(card);
  if (!open.length) return { kind: "quiet", verdict: null, reason: "no bee is open for a rewrite" };

  let verdict: Verdict;
  try {
    verdict = await d.ask(card, d.cfg.confidenceFloor);
  } catch (err) {
    return { kind: "failed", verdict: null, reason: `Jev could not be asked: ${(err as Error).message}` };
  }

  // `broken` is read nowhere below this line: it is recorded and never acted on (R-3.7).
  if (verdict.bee === "unsure") return { kind: "quiet", verdict, reason: `Jev was not confident enough to name a bee (${verdict.beeConfidence.toFixed(2)})` };
  if (verdict.bee === "none") return { kind: "quiet", verdict, reason: "Jev says leave all three alone" };
  if (!open.includes(verdict.bee)) return { kind: "quiet", verdict, reason: `Jev picked ${verdict.bee}, which the scorecard does not list as open` };

  let raw: unknown;
  try {
    raw = await d.write(renderPrompt(d.template, card, verdict.bee, verdict.anger));
  } catch (err) {
    return { kind: "failed", verdict, reason: `the rules-writing CLI failed: ${(err as Error).message}` };
  }

  // All six fields, checked here rather than inside the tool, because this is the only place a response that is
  // not the declared shape can still become a recorded failed round (R-4.6). A missing `coins` reaches
  // `tidyCoins`, whose `raw.split` throws out of `buildPayload` — called below with no try around it, so the
  // process would die on an unhandled rejection with no record line and no reason, and the liveness alert would
  // never see it. A missing `idea` or `quip` is quieter and worse: it used to be collapsed into the literal text
  // "undefined", then signed and posted to the door as a real rewrite, which is the partial rewrite R-4.6 forbids.
  const checked = WrittenRules.safeParse(raw);
  if (!checked.success) {
    const bad = checked.error.issues.map((i) => `${i.path.join(".") || "the response"}: ${i.message}`).join("; ");
    return { kind: "failed", verdict, reason: `the rules the CLI wrote are not the declared shape: ${bad}` };
  }
  const written = checked.data;

  const built = buildPayload(verdict.bee, verdict.anger, written, tradeableCoins(card), d.survivesRedact);
  if (!built.ok) return { kind: "failed", verdict, reason: built.reason };

  // Asked here, on the one path both arms take, and off the sanitised payload rather than the raw model output:
  // the version has to be the one that would really have been installed. Putting this inside the delivered
  // branch and backfilling the withheld one would make the two arms do different work, which is the thing
  // R-7.2 and R-7.6 forbid — and the comparison between them is the only reason the control arm exists.
  const versions = await previewVersions(d, base, built.payload);

  // Only now does the arm get decided, so both arms were selected, cleaned and priced identically.
  const arm = pickArm(d.cfg.controlArm, d.coin);
  if (arm === "withheld") return { kind: "withheld", verdict, bee: verdict.bee, arm, ...versions, rules: written };

  const body = JSON.stringify(built.payload);
  const ts = String(d.now());
  const sig = labSignature(d.labSecret, ts, "POST", OVERLAY_PATH, body);
  try {
    const r = await d.fetch(`${base}${OVERLAY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-ts": ts, "x-lab-sig": sig },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await r.text()).slice(0, 600);
    let overlayId: number | null = null;
    try {
      overlayId = (JSON.parse(text) as { overlay?: { id?: number } }).overlay?.id ?? null;
    } catch {
      overlayId = null;
    }
    if (!r.ok) return { kind: "failed", verdict, reason: `the door refused the rewrite: ${r.status} ${text}` };
    return { kind: "delivered", verdict, bee: verdict.bee, arm, ...versions, overlayId, status: r.status, rules: written };
  } catch (err) {
    return { kind: "failed", verdict, reason: `could not reach the door: ${(err as Error).message}` };
  }
}

// ---------- what the round leaves behind ----------

/** One line of the record file. Nothing here holds the secret or a signature, so R-9.5 holds by construction. */
export type RoundRecord = {
  at: string;
  /** Without this a cron tick and a hand-run round are indistinguishable afterwards (R-9.1). */
  trigger: Trigger;
  config: string;
  cli: string;
  model: string;
  control: boolean;
} & Outcome;

/**
 * The line a round appends. Pure and separate from the append itself, because the record is the only
 * evidence a round ever ran and its shape has to be assertable without a filesystem.
 */
export function roundRecord(at: string, trigger: Trigger, configPath: string, cfg: CoachConfig, outcome: Outcome): RoundRecord {
  return { at, trigger, config: configPath, cli: cfg.cli, model: cfg.model, control: cfg.controlArm, ...outcome };
}

/**
 * Whether the last `alertAfterFailures` rounds all failed, given the record file's lines. Total by design:
 * a round killed mid-append leaves half a line behind, and that must not be what silences the alert.
 */
export function shouldAlertOnFailures(lines: readonly string[], alertAfterFailures: number): boolean {
  const recent = lines.slice(-alertAfterFailures);
  if (recent.length < alertAfterFailures) return false;
  return recent.every((l) => {
    try {
      return (JSON.parse(l) as { kind?: unknown }).kind === "failed";
    } catch {
      return false;
    }
  });
}

/**
 * The same judgement, made by the round that is failing right now: `linesBefore` is the record file as it stood
 * before this round, and `record` is the line this round is appending.
 *
 * This round's own failure belongs in the window, which is why the fold lives here rather than in the tool.
 * Counting only the lines already on disk would always be one short — the alert would fire on the round after
 * the threshold was reached, and on a cause that persists forever that is a whole cron interval of silence.
 */
export function shouldAlertOnThisFailure(linesBefore: readonly string[], record: RoundRecord, alertAfterFailures: number): boolean {
  return shouldAlertOnFailures([...linesBefore, JSON.stringify(record)], alertAfterFailures);
}
