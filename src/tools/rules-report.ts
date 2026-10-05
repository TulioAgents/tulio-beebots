// What each ruleset actually did. Read-only: no keys, no network, no Jev spend, no writes.
// pnpm rules-report              (DB_PATH, or ./data/bees-dry.sqlite)
// pnpm rules-report -- --bee bee2 --since 7d
//
// Reports figures per ruleset and deliberately draws no conclusion. A single rewrite cannot be judged from
// them: the Beekeeper is told to pick the FAILING bee, so a bee's "before" window is conditioned on being
// the worst of three and regression to the mean alone moves the "after" window up. Only the randomised
// deliver/withhold comparison (docs/ears/local-beekeeper.md unit 7) is unbiased.
// See docs/ears/beekeeper-audit-log.md unit 4.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const path = flag("db") ?? process.env.DB_PATH ?? "./data/bees-dry.sqlite";
if (!existsSync(path)) {
  console.error(`no database at ${path}. Pass --db <path> or set DB_PATH.`);
  process.exit(1);
}

/** `7d`, `48h`, `90m` or a plain ms count. */
function sinceMs(spec: string | undefined): number {
  if (!spec) return 0;
  const m = /^(\d+)([dhm])?$/.exec(spec.trim());
  if (!m) {
    console.error(`could not read --since ${spec}. Use 7d, 48h, 90m or a unix ms timestamp.`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const unit = m[2];
  if (!unit) return n; // already a timestamp
  return Date.now() - n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}

const since = sinceMs(flag("since"));
const onlyBee = flag("bee");

let db: DatabaseSync;
try {
  db = new DatabaseSync(path, { readOnly: true });
} catch (err) {
  console.error(`could not open ${path}: ${(err as Error).message}`);
  process.exit(1);
}

const cols = new Set((db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map((c) => c.name));
if (!cols.has("rules_version")) {
  console.error(`${path} has no rules_version column: it predates audit stamping. Start the engine once to add it.`);
  process.exit(1);
}

interface Group {
  bee: string;
  version: string | null;
  decisions: number;
  fills: number;
  realisedUsd: number;
  feesUsd: number;
  firstTs: number;
  lastTs: number;
  meanConfidence: number | null;
  meanConviction: number | null;
}

const where = [`d.ts >= ?`, ...(onlyBee ? [`d.bee = ?`] : [])].join(" AND ");
const args: Array<string | number> = onlyBee ? [since, onlyBee] : [since];

const groups = db
  .prepare(
    `SELECT d.bee AS bee, d.rules_version AS version,
            COUNT(DISTINCT d.id) AS decisions,
            COUNT(f.id)          AS fills,
            COALESCE(SUM(f.realised_usd), 0) AS realisedUsd,
            COALESCE(SUM(f.fee_usd), 0)      AS feesUsd,
            MIN(d.ts) AS firstTs, MAX(d.ts) AS lastTs,
            AVG(d.confidence) AS meanConfidence, AVG(d.conviction) AS meanConviction
     FROM decisions d
     LEFT JOIN orders o ON o.decision_id = d.id
     LEFT JOIN fills  f ON f.order_id    = o.id
     WHERE ${where}
     GROUP BY d.bee, d.rules_version
     ORDER BY d.bee, MIN(d.ts)`,
  )
  .all(...args) as unknown as Group[];

if (!groups.length) {
  console.log(`no decisions in ${path}${onlyBee ? ` for ${onlyBee}` : ""}${since ? " in that window" : ""}.`);
  process.exit(0);
}

const choices = db
  .prepare(
    `SELECT bee, rules_version AS version, COALESCE(choice, '(none)') AS choice, COUNT(*) AS n
     FROM decisions d WHERE ${where} GROUP BY bee, rules_version, choice ORDER BY n DESC`,
  )
  .all(...args) as unknown as Array<{ bee: string; version: string | null; choice: string; n: number }>;

const rulesets = new Map(
  (db.prepare(`SELECT version, rules, overlay_id AS overlayId FROM rulesets`).all() as unknown as Array<{ version: string; rules: string | null; overlayId: number | null }>).map((r) => [
    r.version,
    r,
  ]),
);

const day = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
const usd = (n: number) => (n < 0 ? "-" : "+") + Math.abs(n).toFixed(2);

console.log(`${path}${onlyBee ? ` · ${onlyBee}` : ""}${since ? ` · since ${day(since)}` : " · all time"}`);
console.log("figures only. one rewrite is not judgeable from these: see the header of this file.\n");

let currentBee = "";
for (const g of groups) {
  if (g.bee !== currentBee) {
    currentBee = g.bee;
    console.log(`\n${"=".repeat(96)}\n${g.bee}\n${"=".repeat(96)}`);
  }
  const rs = g.version ? rulesets.get(g.version) : undefined;
  const label = g.version ?? "(unknown ruleset: decisions written before audit stamping)";
  const overlay = rs?.overlayId != null ? `overlay ${rs.overlayId}` : g.version ? "owner's own rules" : "";

  console.log(`\n  ${label}${overlay ? `  ·  ${overlay}` : ""}`);
  console.log(`  ${day(g.firstTs)} → ${day(g.lastTs)}`);
  console.log(
    `  decisions ${String(g.decisions).padStart(6)} · fills ${String(g.fills).padStart(4)} · realised ${usd(g.realisedUsd).padStart(9)} · fees ${g.feesUsd.toFixed(2).padStart(7)}` +
      ` · conf ${g.meanConfidence == null ? "   -" : g.meanConfidence.toFixed(2)} · conv ${g.meanConviction == null ? "   -" : g.meanConviction.toFixed(2)}`,
  );

  const mine = choices.filter((c) => c.bee === g.bee && c.version === g.version);
  const total = mine.reduce((a, c) => a + c.n, 0) || 1;
  const mix = mine
    .slice(0, 6)
    .map((c) => `${c.choice} ${((c.n / total) * 100).toFixed(0)}%`)
    .join(" · ");
  if (mix) console.log(`  choices: ${mix}${mine.length > 6 ? ` · +${mine.length - 6} more` : ""}`);
  if (rs?.rules) console.log(`  rules: ${rs.rules.length > 150 ? `${rs.rules.slice(0, 150)}…` : rs.rules}`);
}

const unknown = groups.filter((g) => g.version === null).reduce((a, g) => a + g.decisions, 0);
console.log(`\n${"-".repeat(96)}`);
console.log(`${groups.length} ruleset-periods across ${new Set(groups.map((g) => g.bee)).size} bees.`);
if (unknown) console.log(`${unknown} decisions are unattributed and excluded from every ruleset above.`);
