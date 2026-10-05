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
import { labSignature } from "./lab/door.js";

export const OVERLAY_PATH = "/lab/overlay";
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

export interface WrittenRules {
  idea: string;
  rules: string;
  coins: string;
  reason: string;
  quip: string;
  note: string;
}

export type Arm = "delivered" | "withheld";

export type Outcome =
  /** A rewrite reached the door. */
  | { kind: "delivered"; bee: string; arm: Arm; overlayId: number | null; status: number; rules: WrittenRules }
  /** A rewrite was produced and deliberately not sent: the control arm. */
  | { kind: "withheld"; bee: string; arm: Arm; rules: WrittenRules }
  /** The round ran and chose to change nothing. */
  | { kind: "quiet"; reason: string }
  /** The round could not run. Never to be confused with "quiet". */
  | { kind: "failed"; reason: string };

// ---------- pure helpers ----------

/**
 * The door does not check the character set and a JSON schema cannot express one, so it is done here.
 * Note this also removes newlines and tabs, which is why `collapse` turns whitespace into spaces first.
 */
export const toAscii = (s: string): string => s.replace(/[^\x20-\x7E]/g, "");

/**
 * Whitespace to single spaces, then non-ASCII out. The order matters: stripping first would delete the
 * newline in "spaces\nand" and glue the words together.
 */
export const collapse = (s: string): string =>
  toAscii(String(s).replace(/\s+/g, " "))
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
  /** Runs the local CLI under a pinned capability set and returns the six fields. */
  write: (prompt: string) => Promise<WrittenRules>;
  survivesRedact: (v: unknown) => boolean;
  coin: () => number;
  now: () => number;
}

export async function runRound(d: CoachDeps): Promise<Outcome> {
  const base = d.cfg.engineUrl.replace(/\/+$/, "");

  let card: Scorecard;
  try {
    const r = await d.fetch(`${base}/keeper/scorecard`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { kind: "failed", reason: `scorecard answered ${r.status}` };
    card = (await r.json()) as Scorecard;
    if (typeof card.scorecard !== "string" || typeof card.open_bees !== "string") return { kind: "failed", reason: "scorecard is not the shape this expects" };
  } catch (err) {
    return { kind: "failed", reason: `could not read the scorecard: ${(err as Error).message}` };
  }

  const open = openBees(card);
  if (!open.length) return { kind: "quiet", reason: "no bee is open for a rewrite" };

  let verdict: Verdict;
  try {
    verdict = await d.ask(card, d.cfg.confidenceFloor);
  } catch (err) {
    return { kind: "failed", reason: `Jev could not be asked: ${(err as Error).message}` };
  }

  if (verdict.bee === "unsure") return { kind: "quiet", reason: `Jev was not confident enough to name a bee (${verdict.beeConfidence.toFixed(2)})` };
  if (verdict.bee === "none") return { kind: "quiet", reason: "Jev says leave all three alone" };
  if (!open.includes(verdict.bee)) return { kind: "quiet", reason: `Jev picked ${verdict.bee}, which the scorecard does not list as open` };

  let written: WrittenRules;
  try {
    written = await d.write(renderPrompt(d.template, card, verdict.bee, verdict.anger));
  } catch (err) {
    return { kind: "failed", reason: `the rules-writing CLI failed: ${(err as Error).message}` };
  }

  const built = buildPayload(verdict.bee, verdict.anger, written, tradeableCoins(card), d.survivesRedact);
  if (!built.ok) return { kind: "failed", reason: built.reason };

  // Only now does the arm get decided, so both arms were selected and cleaned identically.
  const arm = pickArm(d.cfg.controlArm, d.coin);
  if (arm === "withheld") return { kind: "withheld", bee: verdict.bee, arm, rules: written };

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
    if (!r.ok) return { kind: "failed", reason: `the door refused the rewrite: ${r.status} ${text}` };
    return { kind: "delivered", bee: verdict.bee, arm, overlayId, status: r.status, rules: written };
  } catch (err) {
    return { kind: "failed", reason: `could not reach the door: ${(err as Error).message}` };
  }
}
