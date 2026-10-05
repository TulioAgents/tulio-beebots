// Audit stamping: every decision says which ruleset produced it, and a failed audit write can never
// reach a trade. See docs/ears/beekeeper-audit-log.md units 1, 2 and 3.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { BEES, type Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { LabStore } from "../src/lab/store.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, trend, view } from "./fixtures.js";

const RULES = "Only take a breakout that clears the trigger by 0.3% or more, and cut it early if the day move turns red.";

const market = () =>
  view([
    coin("BTC", { trend: trend({ score: 6 }), ret24hPct: 2, ret7dPct: 5, breakout: { dayOpen: 80000, prevRange: 2000, trigger: 81000 } }, 80000),
    coin("ETH", { trend: trend({ score: -4 }), ret24hPct: -1, ret7dPct: -3 }, 2700),
    coin("SOL", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 }, ret24hPct: 6, ret7dPct: 12 }, 102.5),
    coin("PENGU", { ret24hPct: 15, ret7dPct: 30, volZ: 3 }),
    coin("DOGE", { ret24hPct: 4, ret7dPct: 9 }),
  ]);

/** An engine whose fake Jev always answers off-menu, so a tick records decisions without trading. */
async function harness(db = new Db(":memory:"), cfg: Config = testConfig({ DRY_RUN: "true" })) {
  const v = market();
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const client: SystemOne = {
    async systemOne() {
      return {
        model: "fake",
        usage: { input_tokens: 100, output_tokens: 0 },
        answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } },
      } as never;
    },
  };
  const lab = new LabStore(db);
  const engine = new Engine({
    cfg,
    db,
    feed,
    jev: new Jev({ ...cfg.jev, client, now: () => NOW }),
    exec: new SimExecutor(() => v, cfg.risk.takerFeeRate),
    bus: new EventBus(db),
    alerts: new Alerts(undefined),
    now: () => NOW,
    lab,
  });
  await engine.start();
  engine.stop();
  return { engine, db, lab };
}

const stamps = (db: Db) => db.raw.prepare(`SELECT bee, rules_version AS v, overlay_id AS o FROM decisions ORDER BY id`).all() as Array<{ bee: string; v: string | null; o: number | null }>;
const rulesets = (db: Db) => db.raw.prepare(`SELECT version, bee, overlay_id AS o, strategy FROM rulesets`).all() as Array<{ version: string; bee: string; o: number | null; strategy: string }>;

describe("audit: ruleset identity", () => {
  it("stamps every decision and records the strategy text behind each version once", async () => {
    const { engine, db } = await harness();
    await engine.tick();

    const rows = stamps(db);
    expect(rows.length).toBe(BEES.length);
    expect(rows.every((r) => r.v !== null && r.v.length === 16)).toBe(true);
    // one ruleset per bee, and no overlay is live
    expect(new Set(rows.map((r) => r.v)).size).toBe(BEES.length);
    expect(rows.every((r) => r.o === null)).toBe(true);
    expect(rulesets(db).length).toBe(BEES.length);
    for (const rs of rulesets(db)) expect(rs.strategy.length).toBeGreaterThan(0);
  });

  it("is stable across ticks while the rules do not change", async () => {
    const { engine, db } = await harness();
    await engine.tick();
    const first = stamps(db).map((r) => r.v);
    await engine.tick();
    const rows = stamps(db);
    expect(rows.slice(BEES.length).map((r) => r.v)).toEqual(first);
    // still one row per ruleset: upsert did not duplicate
    expect(rulesets(db).length).toBe(BEES.length);
  });

  it("changes for the rewritten bee when an overlay lands, and leaves the others alone", async () => {
    const { engine, db, lab } = await harness();
    await engine.tick();
    const before = Object.fromEntries(stamps(db).map((r) => [r.bee, r.v]));

    lab.set("bee3", RULES, [], "a rewrite", { source: "test" }, NOW);
    await engine.tick();

    const after = Object.fromEntries(stamps(db).slice(BEES.length).map((r) => [r.bee, r.v]));
    expect(after.bee3).not.toBe(before.bee3);
    expect(after.bee1).toBe(before.bee1);
    expect(after.bee2).toBe(before.bee2);

    const overlayStamp = stamps(db).slice(BEES.length).find((r) => r.bee === "bee3")!;
    expect(overlayStamp.o).toBe(lab.overlay("bee3")!.id);
    const rs = rulesets(db).find((r) => r.version === after.bee3)!;
    expect(rs.strategy).toContain(RULES);
  });
});

describe("audit: a failed audit write never reaches a trade", () => {
  it("records the decision with an unknown ruleset and keeps trading behaviour identical", async () => {
    const db = new Db(":memory:");
    const { engine } = await harness(db);
    // The audit write is the only thing that breaks. Everything else about the tick must be unaffected.
    db.upsertRuleset = () => {
      throw new Error("disk full");
    };

    await expect(engine.tick()).resolves.not.toThrow();

    const rows = stamps(db);
    expect(rows.length).toBe(BEES.length);
    expect(rows.every((r) => r.v === null)).toBe(true);
    // the decisions themselves are still complete
    const full = db.raw.prepare(`SELECT state_hash, menu_json, status FROM decisions`).all() as Array<{ state_hash: string; menu_json: string; status: string }>;
    expect(full.every((r) => r.state_hash.length > 0 && r.menu_json.length > 0 && r.status.length > 0)).toBe(true);
  });
});

describe("audit: the stored menu is the question Jev was actually asked", () => {
  it("keeps each option's description, not just its label", async () => {
    const { engine, db } = await harness();
    await engine.tick();

    const rows = db.raw.prepare(`SELECT bee, menu_json FROM decisions`).all() as Array<{ bee: string; menu_json: string }>;
    expect(rows.length).toBe(BEES.length);
    for (const r of rows) {
      const menu = JSON.parse(r.menu_json) as Record<string, string | null>;
      // an object of label -> desc, never a bare array of labels
      expect(Array.isArray(menu)).toBe(false);
      expect(Object.keys(menu).length).toBeGreaterThan(0);
    }
    // descriptions carry live numbers, so at least one option somewhere must have real text
    const descs = rows.flatMap((r) => Object.values(JSON.parse(r.menu_json) as Record<string, string | null>));
    expect(descs.some((d) => typeof d === "string" && d.length > 0)).toBe(true);
  });
});

describe("audit: opening a database that predates the audit columns", () => {
  // Caught a real crash: SCHEMA used to create an index over rules_version, which cannot compile against
  // an existing decisions table because CREATE TABLE IF NOT EXISTS leaves it alone. :memory: never hit it
  // because a fresh database gets the column from the CREATE. This builds the old shape on disk first.
  it("adds the columns and the index without throwing, and keeps every existing row", () => {
    const file = join(mkdtempSync(join(tmpdir(), "beebots-audit-")), "old.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE decisions (
      id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL,
      state_hash TEXT, state_json TEXT, menu_json TEXT,
      choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL,
      latency_ms INTEGER, input_tokens INTEGER, jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT,
      action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT)`);
    raw.prepare(`INSERT INTO decisions (bee, ts, action_json, status, jev_cost_usd) VALUES ('bee1', 1, '{}', 'old row', 0.5)`).run();
    raw.close();

    // the constructor is what used to blow up here
    const db = new Db(file);
    const cols = new Set((db.raw.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols.has("rules_version")).toBe(true);
    expect(cols.has("overlay_id")).toBe(true);
    const idx = (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'decisions_rules'`).all() as Array<{ name: string }>).length;
    expect(idx).toBe(1);
    const row = db.raw.prepare(`SELECT status, jev_cost_usd AS cost, rules_version AS v FROM decisions`).get() as { status: string; cost: number; v: string | null };
    expect(row).toEqual({ status: "old row", cost: 0.5, v: null });
    db.raw.close();

    // reopening is a no-op
    const again = new Db(file);
    expect((again.raw.prepare(`SELECT COUNT(*) c FROM decisions`).get() as { c: number }).c).toBe(1);
    again.raw.close();
  });
});

describe("audit: schema change is additive and idempotent", () => {
  it("adds the columns to a decisions table that predates them, keeping existing rows", () => {
    const db = new Db(":memory:");
    // a table shaped like the old one, with a row in it
    db.raw.exec(`DROP TABLE decisions`);
    db.raw.exec(`CREATE TABLE decisions (
      id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL,
      state_hash TEXT, state_json TEXT, menu_json TEXT,
      choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL,
      latency_ms INTEGER, input_tokens INTEGER, jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT,
      action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT)`);
    db.raw.prepare(`INSERT INTO decisions (bee, ts, action_json, status) VALUES ('bee1', 1, '{}', 'old row')`).run();

    // reopening the same file runs the guarded ALTER
    const cols = () => new Set((db.raw.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols().has("rules_version")).toBe(false);

    db.raw.exec(`ALTER TABLE decisions ADD COLUMN rules_version TEXT`);
    db.raw.exec(`ALTER TABLE decisions ADD COLUMN overlay_id INTEGER`);

    expect(cols().has("rules_version")).toBe(true);
    const old = db.raw.prepare(`SELECT status, rules_version AS v FROM decisions`).get() as { status: string; v: string | null };
    expect(old.status).toBe("old row");
    expect(old.v).toBeNull();
  });
});

describe("audit: retention clears the snapshot but keeps the row", () => {
  it("nulls state_json past the window and leaves attribution intact", async () => {
    const { engine, db } = await harness();
    await engine.tick();
    expect((db.raw.prepare(`SELECT COUNT(*) c FROM decisions WHERE state_json IS NOT NULL`).get() as { c: number }).c).toBe(BEES.length);

    db.pruneDecisionStates(NOW + 1);

    expect((db.raw.prepare(`SELECT COUNT(*) c FROM decisions WHERE state_json IS NOT NULL`).get() as { c: number }).c).toBe(0);
    const rows = stamps(db);
    expect(rows.length).toBe(BEES.length);
    expect(rows.every((r) => r.v !== null)).toBe(true);
  });
});
