// Does Jev agree with itself? Re-runs the SAME ruleset against its own recorded decisions and counts how
// often the choice differs. No orders, no overlays, no writes: it only reads the DB and calls Jev.
//
//   pnpm jev-replay-probe -- --db ./data/bees-dry.sqlite --n 100
//
// SPENDS REAL JEV CREDIT: one decision call per sampled row (~$0.00004 each on the default rate, so ~$0.004
// for n=100). Needs TYPESAFE_API_KEY.
//
// Why this exists. Comparing two rulesets by replaying them against the same stored market states is only
// meaningful if we know the floor: Jev answers from a probability distribution, so re-running one ruleset
// against its own states already disagrees at some unknown rate. If that floor is 18% and an A-vs-B
// comparison shows 21%, nothing has been measured. Run this before building any replay comparison.
// Decision rule: a floor under ~15% makes replay worth building; above that it does not.
// See docs/lld/beekeeper-audit-log.md, "Deferred -> Counterfactual replay".
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BRAINS } from "../bees/index.js";
import type { Menu } from "../bees/types.js";
import { loadConfig, type BeeId } from "../config.js";
import { Jev } from "../jev.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const path = flag("db") ?? process.env.DB_PATH ?? "./data/bees-dry.sqlite";
const n = Number(flag("n") ?? 100);
const onlyBee = flag("bee");
if (!existsSync(path)) {
  console.error(`no database at ${path}. Pass --db <path> or set DB_PATH.`);
  process.exit(1);
}

// loadConfig throws when the Jev key is missing, and its own message already names what is blank.
function config() {
  try {
    return loadConfig({ ...process.env, DRY_RUN: "true" });
  } catch (err) {
    console.error(`${(err as Error).message}\n\nThis probe makes real Jev calls, so it needs a Jev key.`);
    process.exit(1);
  }
}
const cfg = config();

const db = new DatabaseSync(path, { readOnly: true });
if (!new Set((db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map((c) => c.name)).has("rules_version")) {
  console.error(`${path} predates audit stamping: no rules_version column.`);
  process.exit(1);
}

interface Row {
  id: number;
  bee: string;
  version: string;
  stateJson: string;
  menuJson: string;
  choice: string;
  strategy: string;
}

const rows = db
  .prepare(
    `SELECT d.id AS id, d.bee AS bee, d.rules_version AS version, d.state_json AS stateJson,
            d.menu_json AS menuJson, d.choice AS choice, r.strategy AS strategy
     FROM decisions d JOIN rulesets r ON r.version = d.rules_version
     WHERE d.rules_version IS NOT NULL AND d.state_json IS NOT NULL AND d.state_json != '{}'
       AND d.choice IS NOT NULL AND d.menu_json LIKE '{%'
       ${onlyBee ? "AND d.bee = ?" : ""}
     ORDER BY d.id DESC LIMIT ?`,
  )
  .all(...(onlyBee ? [onlyBee, n] : [n])) as unknown as Row[];

if (!rows.length) {
  console.error(
    `no replayable decisions in ${path}.\n` +
      `A row is replayable when it has a rules_version, a real state_json, a recorded choice, and a\n` +
      `menu_json storing label->description (older rows stored only labels and cannot be replayed).\n` +
      `Run the engine for a while after the menu_json change, then try again.`,
  );
  process.exit(1);
}

const jev = new Jev({ ...cfg.jev, timeoutMs: Math.max(cfg.jev.timeoutMs, 8000), dailyUsdCap: Number.POSITIVE_INFINITY });

let same = 0;
let differed = 0;
let failed = 0;
let tokens = 0;
let costUsd = 0;
const byBee: Record<string, { same: number; differed: number }> = {};
const flips: Array<{ id: number; bee: string; was: string; now: string }> = [];

for (const row of rows) {
  const descs = JSON.parse(row.menuJson) as Record<string, string | null>;
  // jev.decide only reads menu[label].desc; intent plays no part in the question Jev is asked.
  const menu = Object.fromEntries(Object.entries(descs).map(([label, desc]) => [label, { desc, intent: { kind: "hold" } }])) as unknown as Menu;
  const style = cfg.slots[row.bee as BeeId].style;
  const r = await jev.decide({ strategy: row.strategy, state: JSON.parse(row.stateJson) as Record<string, unknown>, menu, convictionLabels: BRAINS[style].convictionLabels });
  if (!r.ok) {
    failed++;
    continue;
  }
  tokens += r.inputTokens;
  costUsd += r.costUsd;
  byBee[row.bee] ??= { same: 0, differed: 0 };
  if (r.choice === row.choice) {
    same++;
    byBee[row.bee]!.same++;
  } else {
    differed++;
    byBee[row.bee]!.differed++;
    if (flips.length < 10) flips.push({ id: row.id, bee: row.bee, was: row.choice, now: r.choice });
  }
}

const judged = same + differed;
if (!judged) {
  console.error(`every one of the ${rows.length} calls failed. Nothing measured.`);
  process.exit(1);
}

const rate = (differed / judged) * 100;
console.log(`\nJev self-disagreement: re-ran each ruleset against its OWN recorded decisions.`);
console.log(`${path}${onlyBee ? ` · ${onlyBee}` : ""} · model ${cfg.jev.model}\n`);
console.log(`  sampled    ${rows.length}${failed ? ` (${failed} call(s) failed, excluded)` : ""}`);
console.log(`  agreed     ${same}`);
console.log(`  differed   ${differed}`);
console.log(`  FLOOR      ${rate.toFixed(1)}%  of decisions change with the rules held constant`);
console.log(`  cost       $${costUsd.toFixed(5)} · ${tokens} input tokens\n`);

for (const [bee, b] of Object.entries(byBee)) {
  const t = b.same + b.differed;
  console.log(`  ${bee}  ${((b.differed / t) * 100).toFixed(1)}% differed  (${b.differed}/${t})`);
}

if (flips.length) {
  console.log(`\n  examples:`);
  for (const f of flips) console.log(`    #${f.id} ${f.bee}  ${f.was} -> ${f.now}`);
}

console.log(
  `\n  Any A-vs-B replay comparison must beat this floor to mean anything.\n` +
    `  ${rate < 15 ? "Under 15%: replay is worth building." : "At or over 15%: replay cannot separate a real rules change from Jev's own variance. Do not build it."}`,
);
