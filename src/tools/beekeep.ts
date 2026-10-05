// The Beekeeper, locally. One round per invocation, meant for cron:
//   make replay-probe        -- unrelated; this is:
//   make beekeep             or  pnpm beekeep -- --config beekeeper/coach.json
//
// Pass --trigger cron (or COACH_TRIGGER=cron) from the crontab; a hand-run round records "manual".
//
// Needs LAB_SECRET (>=32 chars) and TYPESAFE_API_KEY. Spends a little Jev credit (three questions) and
// whatever the local CLI costs. Exit 0 = the round reached a decision; exit 1 = the round could not run.
// That distinction matters: a coach that dies quietly looks exactly like a coach with nothing to say.
//
// The engine enforces every safety rule at the door (lab/door.ts). This only ever sends rules text and a
// coin list, and only after a coin flip decides whether this round is a delivered or a withheld one.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { asTrigger, CoachConfig, configProblems, preflightFailure, roundRecord, runRound, shouldAlertOnThisFailure, type Outcome, type RoundRecord, type Scorecard, type Verdict } from "../coach.js";
import { redact, safeError } from "../redact.js";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// Annotated, not inferred: control-flow narrowing after a never-returning call only applies when the
// variable carries the type explicitly.
const die: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---- config, read fresh every round: a new process IS the hot reload ----
const configPath = flag("config") ?? process.env.COACH_CONFIG ?? "beekeeper/coach.json";
if (!existsSync(configPath)) die(`no config at ${configPath}. Copy beekeeper/coach.example.json and edit it.`);
const parsed = CoachConfig.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
// The one round that ends without a record: `recordFile` is a field of the config that just failed to parse.
if (!parsed.success) die(`${configPath} is not valid:\n  ${configProblems(parsed.error.issues)}`);
const cfg = parsed.data;

/** One record line, appended. A record that cannot be written is reported, never thrown: the round still happened. */
const appendRecord = (record: RoundRecord): void => {
  try {
    appendFileSync(cfg.recordFile, `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.error(`could not append to ${cfg.recordFile}: ${safeError(err).message}`);
  }
};

// How this process was started. The round itself cannot know it, so it is sourced here and recorded as
// metadata: cron ticks are the rounds the experiment rests on, hand-run ones are the ones being debugged.
const trigger = asTrigger(flag("trigger") ?? process.env.COACH_TRIGGER);

// Stamped before the pre-flight checks, because a round that dies in them is still a round that was attempted at
// a particular time — and on a broken cron that is the only thing distinguishing one tick's record from the next.
const startedAt = new Date().toISOString();

/**
 * The one way out of a round that could not run, wherever it gave up: record it, judge the record file with this
 * round's own line in it, and exit 1 (R-1.2).
 *
 * Both ends of the file come through here because a pre-flight failure and a failure inside the round are the
 * same thing to R-9.4 — a round that could not run — and the pre-flight ones are the causes that repeat on every
 * single tick. While this exit was a bare `die`, a missing key wrote N identical lines and never once read them.
 */
const failRound = (outcome: Extract<Outcome, { kind: "failed" }>): never => {
  // Read before the append, not after: `shouldAlertOnThisFailure` folds in this round's line itself, so a file
  // already holding it would count this failure twice and shout one round early.
  const linesBefore = existsSync(cfg.recordFile) ? readFileSync(cfg.recordFile, "utf8").trim().split("\n") : [];
  const record = roundRecord(startedAt, trigger, configPath, cfg, outcome);
  appendRecord(record);
  // The count and nothing else. A reason can carry whatever the door or the CLI said, and this is the line a log
  // watcher forwards onward, so it stays a fact about rounds rather than about any one of them (R-9.5, R-1.6).
  if (shouldAlertOnThisFailure(linesBefore, record, cfg.alertAfterFailures)) {
    console.error(`ALERT: the last ${cfg.alertAfterFailures} rounds could not run. The Beekeeper is not coaching.`);
  }
  return die(`could not run: ${outcome.reason}`);
};

// Everything the round needs that the config file does not hold. A failure here is recorded like any other round
// that could not run (R-1.4), as `failed` and never as `quiet` (R-1.5), and still exits 1 (R-1.2).
const labSecret = process.env.LAB_SECRET ?? "";
const jevKey = process.env.TYPESAFE_API_KEY ?? "";
const blocked = preflightFailure(cfg, { labSecret, jevKey, promptFileExists: existsSync(cfg.promptFile) });
if (blocked) failRound(blocked);
const template = readFileSync(cfg.promptFile, "utf8");

// ---- Jev: the three questions (beekeeper/jev-questions.md step 3) ----
const require = createRequire(import.meta.url);
const { TypeSafeClient, choice, score, noul } = require("@typesafe-ai/sdk") as typeof import("@typesafe-ai/sdk");
const jev = new TypeSafeClient({ apiKey: jevKey, defaultModel: process.env.JEV_MODEL || "jev-1.13.0", timeout: 20_000, retry: { maxRetries: 0 }, logLevel: "off" });

const ANGER = [
  "Down less than 5% since start, or up.",
  "Down 5% to 10% since start.",
  "Down 10% to 18% since start.",
  "Down 18% to 25% since start.",
  "Down more than 25% since start, or benched, or retired.",
] as const;

async function ask(card: Scorecard, floor: number): Promise<Verdict> {
  const r = await jev.systemOne({
    state: card.scorecard,
    questions: {
      broken: noul("Is at least one of the three bees losing because its rules are wrong for this market, rather than just unlucky?"),
      bee: choice(
        "Which bee should the Beekeeper rewrite this round? Pick the bee whose rules are failing, and only a bee the scorecard marks Rewrite: OPEN. Pick none if all three should be left alone, or if the failing bee is LOCKED.",
        { bee1: null, bee2: null, bee3: null, none: null },
      ),
      anger: score('How badly is the picked bee doing? Read its "% since start" and its cap off the scorecard.', ANGER),
    },
  });
  const b = r.answers.broken;
  const bee = r.answers.bee;
  const anger = r.answers.anger;
  // noul reports the probability of yes, so its confidence is how far it sits from a coin flip.
  const brokenConfidence = Math.max(b.noul, 1 - b.noul);
  return {
    broken: brokenConfidence < floor ? "unsure" : b.noul >= 0.5 ? "yes" : "no",
    brokenConfidence,
    bee: bee.confidence < floor ? "unsure" : bee.choice,
    beeConfidence: bee.confidence,
    anger: anger.confidence < floor ? "unsure" : String(Math.max(1, Math.min(5, Math.round(anger.score) + 1))),
    angerConfidence: anger.confidence,
  };
}

// ---- the local CLI, behind one function ----
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["idea", "rules", "coins", "reason", "quip", "note"],
  properties: {
    idea: { type: "string", maxLength: 80 },
    rules: { type: "string", maxLength: 400 },
    coins: { type: "string" },
    reason: { type: "string", maxLength: 200 },
    quip: { type: "string", maxLength: 90 },
    note: { type: "string" },
  },
};

/**
 * The capability set is pinned here and deliberately NOT read from config: the prompt carries Hive text
 * typed by strangers (keeper.ts), and this is the only thing standing between that text and a local agent
 * with a filesystem. `--tools ""` would disable the structured-output tool itself, so it is named.
 *
 * Reports only an envelope that cannot be read at all. Whether the structured output is the six fields SCHEMA
 * declares is `runRound`'s check (`WrittenRules` in src/coach.ts), where a bad answer becomes a recorded failed
 * round instead of an exception thrown out of the top-level await below.
 */
function writeRules(prompt: string): Promise<unknown> {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--tools", "StructuredOutput", "--model", cfg.model, prompt];
  return new Promise((resolve, reject) => {
    execFile(
      cfg.cli,
      args,
      { timeout: cfg.cliTimeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
      (err, stdout) => {
        if (err) return reject(new Error(safeError(err).message));
        let env: { structured_output?: unknown; is_error?: boolean; permission_denials?: unknown[] };
        try {
          env = JSON.parse(stdout) as typeof env;
        } catch {
          return reject(new Error("the CLI did not return JSON"));
        }
        if (env.is_error) return reject(new Error("the CLI reported an error"));
        if (env.permission_denials?.length) return reject(new Error("the CLI tried to use a capability it was not given"));
        const o = env.structured_output;
        if (!o) return reject(new Error("the CLI returned no usable rules"));
        resolve(o);
      },
    );
  });
}

// ---- run it ----
const outcome = await runRound({
  cfg,
  template,
  labSecret,
  fetch: globalThis.fetch,
  ask,
  write: writeRules,
  survivesRedact: (v) => JSON.stringify(redact(v)) === JSON.stringify(v),
  coin: Math.random,
  now: Date.now,
});

// ---- say what happened, recording it on the way out; secrets and signatures excluded by construction ----
// A failed round records inside `failRound`, which also evaluates the alert and exits 1. A quiet round records
// here and exits 0: it chose to leave the bees alone, so it is not a round that could not run (R-1.5, R-9.2).
if (outcome.kind === "failed") failRound(outcome);

appendRecord(roundRecord(startedAt, trigger, configPath, cfg, outcome));
if (outcome.kind === "delivered") console.log(`delivered: ${outcome.bee} now runs new rules (overlay ${outcome.overlayId ?? "?"}) — "${outcome.rules.idea}"`);
else if (outcome.kind === "withheld") console.log(`withheld (control arm): ${outcome.bee} keeps its rules — "${outcome.rules.idea}" was written and not sent`);
else console.log(`left them alone: ${outcome.reason}`);
