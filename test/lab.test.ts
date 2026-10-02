import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { customBrain } from "../src/bees/custom.js";
import { BRAINS } from "../src/bees/index.js";
import type { BeeId, Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { effectiveCoins, liveRules } from "../src/lab/brain.js";
import { LAB_MIN_INTERVAL_MS, LabDoor, labSignature } from "../src/lab/door.js";
import { LabStore } from "../src/lab/store.js";
import type { MarketFeed } from "../src/market/data.js";
import { redact } from "../src/redact.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";
import { bee, coin, ctx, NOW, testConfig, trend, view } from "./fixtures.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const RULES = "Only take a breakout that clears the trigger by 0.3% or more, and cut it early if the day move turns red.";
const OWNER_RULES = "Chase the loudest coin, but never anything that fell this week.";

// A market where all three bees have something to ask Jev: SOL is through its breakout trigger, BTC/ETH trend,
// and every coin has momentum numbers for the Momentum bee.
const lvl = { dayOpen: 100, prevRange: 4, trigger: 102 };
const market = () =>
  view([
    coin("BTC", { trend: trend({ score: 6 }), ret24hPct: 2, ret7dPct: 5, breakout: { dayOpen: 80000, prevRange: 2000, trigger: 81000 } }, 80000),
    coin("ETH", { trend: trend({ score: -4 }), ret24hPct: -1, ret7dPct: -3 }, 2700),
    coin("SOL", { breakout: lvl, ret24hPct: 6, ret7dPct: 12 }, 102.5),
    coin("PENGU", { ret24hPct: 15, ret7dPct: 30, volZ: 3 }),
    coin("DOGE", { ret24hPct: 4, ret7dPct: 9 }),
  ]);

/** bee1 = Breakout, bee2 = Trend, bee3 = Momentum. `owner` gives bee3 rules and coins of its owner's own. */
function config(owner: { rules?: string; coins?: string[] } = {}): Config {
  const cfg = testConfig({ DRY_RUN: "true" });
  cfg.slots.bee3 = { ...cfg.slots.bee3, rules: owner.rules ?? "", coins: owner.coins ?? [] };
  return cfg;
}

/** An engine on a fixed market with a recording fake Jev that always answers off-menu (so nobody trades). */
async function harness(withLab: boolean, cfg = config(), db = new Db(":memory:")) {
  const v = market();
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const calls: string[] = [];
  const client: SystemOne = {
    async systemOne(req) {
      calls.push(JSON.stringify(req));
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const store = withLab ? new LabStore(db) : null;
  const engine = new Engine({
    cfg,
    db,
    feed,
    jev: new Jev({ ...cfg.jev, client, now: () => NOW }),
    exec: new SimExecutor(() => v, cfg.risk.takerFeeRate),
    bus: new EventBus(db),
    alerts: new Alerts(undefined),
    now: () => NOW,
    ...(store ? { lab: store } : {}),
  });
  await engine.start();
  engine.stop(); // clear the loop timers; ticks are driven by hand below
  return { engine, calls, db, store };
}

const instructions = (call: string) => (JSON.parse(call) as { questions: { action: { instructions: string } } }).questions.action.instructions;
const criteria = (call: string) => Object.keys((JSON.parse(call) as { questions: { action: { criteria: object } } }).questions.action.criteria);
const callOf = (calls: string[], who: "bizzy" | "breezy" | "boozy") => calls.find((c) => instructions(c).includes(`You are ${who}-bee`))!;

describe("beekeeper overlay: no overlay = the engine as it was, byte for byte", () => {
  it("the Jev requests are identical with an empty store and with no store at all", async () => {
    const a = await harness(false, config({ rules: OWNER_RULES, coins: ["PENGU", "DOGE"] }));
    const b = await harness(true, config({ rules: OWNER_RULES, coins: ["PENGU", "DOGE"] }));
    await a.engine.tick();
    await b.engine.tick();
    expect(a.calls.length).toBe(3);
    expect(b.calls).toEqual(a.calls);
    expect(instructions(callOf(a.calls, "boozy"))).toContain(`Owner's rules for this bee (they come first, within the moves offered): ${OWNER_RULES}`);
  });

  it("no overlay leaves the owner's rules and coins exactly as Setup saved them", () => {
    const slot = { style: "boozy" as const, rules: OWNER_RULES, coins: ["PENGU", "DOGE"] };
    expect(liveRules(slot, null)).toEqual({ rules: OWNER_RULES, coins: ["PENGU", "DOGE"] });
    expect(liveRules(slot, null).coins).toBe(slot.coins);
    // a bee with nothing of its owner's own keeps the built-in brain object itself
    expect(customBrain(BRAINS.bizzy, liveRules({ style: "bizzy", rules: "", coins: [] }, null))).toBe(BRAINS.bizzy);
  });
});

describe("beekeeper overlay: applied on the next tick, no restart", () => {
  it("an overlay REPLACES the owner's rules for Jev, for that bee only, and a rollback restores them byte for byte", async () => {
    const h = await harness(true, config({ rules: OWNER_RULES }));
    await h.engine.tick();
    const before = [...h.calls];
    expect(instructions(callOf(before, "boozy"))).toContain(OWNER_RULES);

    h.calls.length = 0;
    h.store!.set("bee3", RULES, [], "test", undefined, NOW);
    await h.engine.tick();
    const rewritten = callOf(h.calls, "boozy");
    expect(instructions(rewritten)).toContain(`Owner's rules for this bee (they come first, within the moves offered): ${RULES}`);
    // replaced, not appended: the owner's own words are gone from the prompt while the overlay is live
    expect(instructions(rewritten)).not.toContain(OWNER_RULES);
    for (const c of h.calls.filter((x) => x !== rewritten)) {
      expect(instructions(c)).not.toContain(RULES);
      expect(before).toContain(c);
    }

    h.calls.length = 0;
    h.store!.rollback("bee3", "test", NOW);
    await h.engine.tick();
    expect(h.calls).toEqual(before);
  });

  it("a second rewrite stacks on the first, and each rollback steps back one", async () => {
    const h = await harness(true, config({ rules: OWNER_RULES }));
    const second = "Second set of rules: only RIDE, never DOUBLE_DOWN.";
    h.store!.set("bee3", RULES, [], "one", undefined, NOW);
    h.store!.set("bee3", second, [], "two", undefined, NOW + 1);
    await h.engine.tick();
    expect(instructions(callOf(h.calls, "boozy"))).toContain(second);
    h.calls.length = 0;
    h.store!.rollback("bee3", "undo", NOW + 2);
    await h.engine.tick();
    expect(instructions(callOf(h.calls, "boozy"))).toContain(RULES);
    expect(instructions(callOf(h.calls, "boozy"))).not.toContain(second);
    h.calls.length = 0;
    h.store!.rollback("bee3", "undo", NOW + 3);
    await h.engine.tick();
    expect(instructions(callOf(h.calls, "boozy"))).toContain(OWNER_RULES);
    expect(h.store!.rollback("bee3", "undo", NOW + 4)).toBeNull();
  });

  it("coins narrow a Momentum bee's menu and snapshot, and say so to Jev", async () => {
    const h = await harness(true);
    h.store!.set("bee3", "Only chase meme coins with real volume behind the move.", ["PENGU", "DOGE"], "test", undefined, NOW);
    await h.engine.tick();
    const call = callOf(h.calls, "boozy");
    expect(criteria(call).sort()).toEqual(["APE_DOGE", "APE_PENGU"]);
    expect(instructions(call)).toContain("This bee only ever trades PENGU, DOGE.");
    const state = (JSON.parse(call) as { state: { coins: { rows: Record<string, unknown> } } }).state;
    expect(Object.keys(state.coins.rows).sort()).toEqual(["DOGE", "PENGU"]);
  });

  it("the overlay survives a restart (it lives in the engine DB)", async () => {
    const db = new Db(":memory:");
    new LabStore(db).set("bee2", "Stay long only while both BTC and ETH trend up.", ["BTC"], "test", { returnPct: 1.2 }, NOW);
    const h = await harness(true, config(), db);
    await h.engine.tick();
    expect(instructions(callOf(h.calls, "breezy"))).toContain("Stay long only while both BTC and ETH trend up. This bee only ever trades BTC.");
  });
});

describe("beekeeper overlay: running Setup again", () => {
  it("drops every rewrite made before the new Setup, and keeps the ones made after it", () => {
    const store = new LabStore(new Db(":memory:"));
    store.set("bee1", RULES, [], "old", undefined, NOW);
    store.set("bee1", "A second, also old, set of rules.", [], "old", undefined, NOW + 1000);
    store.set("bee3", RULES, [], "new", undefined, NOW + 60_000);
    const before = store.version;
    expect(store.dropBefore(NOW + 30_000, "Setup was run again", NOW + 90_000)).toEqual(["bee1"]);
    expect(store.overlay("bee1")).toBeNull();
    expect(store.overlay("bee3")!.rules).toBe(RULES);
    // the engine is told to rebuild, and the bee is left alone for 20 hours from now
    expect(store.version).toBeGreaterThan(before);
    expect(store.lastChangeAt("bee1")).toBe(NOW + 90_000);
    expect(store.history().filter((h) => h.bee === "bee1").map((h) => h.action)).toEqual(["rollback", "rollback", "set", "set"]);
    expect(store.dropBefore(NOW + 30_000, "again", NOW + 99_000)).toEqual([]);
  });
});

describe("beekeeper overlay: the coin rule", () => {
  it("keeps only coins the bee's style can trade", () => {
    expect(effectiveCoins("breezy", [], ["ETH", "SOL"])).toEqual(["ETH"]);
    expect(effectiveCoins("breezy", [], ["SOL", "DOGE"])).toEqual([]);
    expect(effectiveCoins("bizzy", [], ["hype", "PENGU"])).toEqual(["HYPE"]);
    expect(effectiveCoins("boozy", [], ["PENGU", " pengu ", ""])).toEqual(["PENGU"]);
  });

  it("and only coins inside the owner's own list, when the owner set one", () => {
    expect(effectiveCoins("boozy", ["PENGU", "DOGE"], ["DOGE", "SOL"])).toEqual(["DOGE"]);
    expect(effectiveCoins("boozy", ["PENGU", "DOGE"], ["SOL", "BTC"])).toEqual([]);
    expect(effectiveCoins("breezy", ["BTC"], ["BTC", "ETH"])).toEqual(["BTC"]);
    expect(effectiveCoins("bizzy", ["SOL", "HYPE"], ["BTC", "HYPE", "PENGU"])).toEqual(["HYPE"]);
  });

  it("an empty result means: keep the owner's coins", () => {
    const slot = { style: "boozy" as const, rules: OWNER_RULES, coins: ["PENGU", "DOGE"] };
    expect(liveRules(slot, { rules: RULES, coins: ["SOL", "BTC"] })).toEqual({ rules: RULES, coins: ["PENGU", "DOGE"] });
    expect(liveRules(slot, { rules: RULES, coins: [] })).toEqual({ rules: RULES, coins: ["PENGU", "DOGE"] });
    expect(liveRules(slot, { rules: RULES, coins: ["DOGE", "SOL"] })).toEqual({ rules: RULES, coins: ["DOGE"] });
    // an owner without a coin list: the overlay's coins stand, inside the style
    expect(liveRules({ style: "breezy", rules: "", coins: [] }, { rules: RULES, coins: ["ETH", "SOL"] })).toEqual({ rules: RULES, coins: ["ETH"] });
    expect(liveRules({ style: "breezy", rules: "", coins: [] }, { rules: RULES, coins: ["SOL"] })).toEqual({ rules: RULES, coins: [] });
  });

  it("the engine never offers a rewritten bee a coin its owner ruled out", async () => {
    const h = await harness(true, config({ rules: OWNER_RULES, coins: ["PENGU", "DOGE"] }));
    h.store!.set("bee3", RULES, ["DOGE", "SOL", "BTC"], "test", undefined, NOW);
    await h.engine.tick();
    expect(criteria(callOf(h.calls, "boozy"))).toEqual(["APE_DOGE"]);
    h.calls.length = 0;
    h.store!.rollback("bee3", "undo", NOW);
    h.store!.set("bee3", RULES, ["SOL", "BTC"], "test", undefined, NOW);
    await h.engine.tick();
    expect(criteria(callOf(h.calls, "boozy")).sort()).toEqual(["APE_DOGE", "APE_PENGU"]);
  });

  it("a Breakout bee with an overlay coin list is only offered those coins", () => {
    const b = customBrain(BRAINS.bizzy, liveRules({ style: "bizzy", rules: "", coins: [] }, { rules: "", coins: ["SOL"] }));
    const c = ctx("bizzy", bee("bizzy"), market());
    expect(Object.keys(b.menu(c))).toEqual(["BREAKOUT_SOL", "WAIT"]);
    const all = customBrain(BRAINS.bizzy, liveRules({ style: "bizzy", rules: "", coins: [] }, { rules: RULES, coins: ["PENGU"] }));
    expect(Object.keys(all.menu(c)).sort()).toEqual(Object.keys(BRAINS.bizzy.menu(c)).sort());
  });
});

describe("beekeeper overlay: the engine's own feed never carries it", () => {
  it("snapshot, health and history hold no rules text and no overlay", async () => {
    const h = await harness(true);
    h.store!.set("bee3", "Secret sauce: only DOGE when volume spikes hard.", ["DOGE"], "why", { returnPct: 3 }, NOW);
    await h.engine.tick();
    const out = JSON.stringify([h.engine.snapshot(), h.engine.health(), h.db.recentEvents(1000)]);
    expect(out).not.toContain("Secret sauce");
    expect(out).not.toContain("only DOGE");
    expect(out).not.toMatch(/overlay/i);
  });
});

/** A signed request against a running server. */
async function call(base: string, method: string, path: string, body: unknown, opts: { secret?: string; ts?: number; sig?: string } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(opts.ts ?? Date.now());
  const sig = opts.sig ?? labSignature(opts.secret ?? SECRET, ts, method, path, raw);
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-lab-ts": ts, "x-lab-sig": sig }, ...(method === "GET" ? {} : { body: raw }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, sig, ts };
}

async function server(secret: string | undefined, now = () => Date.now()) {
  const db = new Db(":memory:");
  const store = new LabStore(db);
  const lab = new LabDoor({ store, secret, knownCoins: () => ["BTC", "ETH", "SOL", "HYPE", "PENGU", "DOGE"], effectiveCoins: (_bee, coins) => effectiveCoins("boozy", [], coins), now });
  const srv = startServer({ engine: { bus: new EventBus(null), db, visitors: new Visitors(db), snapshot: () => ({ bees: [] }), health: () => ({ ok: true }) }, lab, profile: () => ({}), beeImage: () => null }, 0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, srv, store };
}

describe("the door: HMAC auth", () => {
  it("is a plain 404 when nothing could open it (no LAB_SECRET, Beekeeper off)", async () => {
    const s = await server(undefined);
    try {
      for (const [m, p] of [["GET", "/lab/state"], ["POST", "/lab/overlay"], ["POST", "/lab/rollback"]] as const) {
        const r = await call(s.base, m, p, m === "GET" ? undefined : { bee: "bee1" });
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: "not found" });
      }
    } finally {
      s.srv.close();
    }
  });

  it("LabDoor.enabled needs at least 32 characters", () => {
    expect(LabDoor.enabled(undefined)).toBe(false);
    expect(LabDoor.enabled("x".repeat(31))).toBe(false);
    expect(LabDoor.enabled("x".repeat(32))).toBe(true);
  });

  it("the signature is hex HMAC-SHA256(key, ts.METHOD.path.body): the scheme the Zap's last step uses", () => {
    // Fixed vector: if this changes, every published copy of the Zap stops working.
    expect(labSignature("k".repeat(64), "1790000000000", "POST", "/lab/overlay", '{"bee":"bee1"}')).toBe("9186d76de390e1c1a6ad2085426504104e3e83df6cf10fc6486394a559d15cae");
  });

  it("refuses a wrong secret, a stale or future time, a tampered body, a wrong method or path in the signature, and a replay", async () => {
    const s = await server(SECRET);
    try {
      expect((await call(s.base, "GET", "/lab/state", undefined)).status).toBe(200);
      expect((await call(s.base, "GET", "/lab/state", undefined, { secret: "f".repeat(48) })).status).toBe(401);
      expect((await call(s.base, "GET", "/lab/state", undefined, { ts: Date.now() - 6 * 60_000 })).status).toBe(401);
      expect((await call(s.base, "GET", "/lab/state", undefined, { ts: Date.now() + 6 * 60_000 })).status).toBe(401);
      expect((await call(s.base, "GET", "/lab/state", undefined, { sig: "zz" })).status).toBe(401);
      // no headers at all
      expect((await fetch(`${s.base}/lab/state`)).status).toBe(401);
      // signature made for another body
      const ts = String(Date.now());
      const sig = labSignature(SECRET, ts, "POST", "/lab/overlay", JSON.stringify({ bee: "bee1", rules: RULES, coins: [], reason: "a" }));
      const tampered = await fetch(`${s.base}/lab/overlay`, { method: "POST", headers: { "content-type": "application/json", "x-lab-ts": ts, "x-lab-sig": sig }, body: JSON.stringify({ bee: "bee3", rules: RULES, coins: [], reason: "a" }) });
      expect(tampered.status).toBe(401);
      // signature made for another path
      const ts2 = String(Date.now());
      const sig2 = labSignature(SECRET, ts2, "GET", "/lab/other", "");
      expect((await fetch(`${s.base}/lab/state`, { headers: { "x-lab-ts": ts2, "x-lab-sig": sig2 } })).status).toBe(401);
      // replay: the exact same signed request twice
      const first = await call(s.base, "GET", "/lab/state", undefined);
      expect(first.status).toBe(200);
      const again = await fetch(`${s.base}/lab/state`, { headers: { "x-lab-ts": first.ts, "x-lab-sig": first.sig } });
      expect(again.status).toBe(401);
      // right signature, wrong method for the route
      expect((await call(s.base, "POST", "/lab/state", {})).status).toBe(405);
      // unknown lab path
      expect((await call(s.base, "GET", "/lab/nope", undefined)).status).toBe(404);
      // a body over 16 KiB is refused before anything is read into it
      expect((await call(s.base, "POST", "/lab/overlay", { bee: "bee1", rules: "x".repeat(17 * 1024), coins: [], reason: "a" })).status).toBe(413);
    } finally {
      s.srv.close();
    }
  });
});

describe("the door: overlay, rollback, state", () => {
  it("round-trips an overlay through redact() intact (rules, coins, reason, metrics)", async () => {
    const s = await server(SECRET);
    try {
      const metrics = { batch: "b-20260925-1800", returnPct: 1.83, shadowReturnPct: 0.41, trades: 2, feesUsd: 0.31, maxDdPct: -0.9, window: "2026-09-25T18:00Z..2026-09-26T18:00Z" };
      const set = await call(s.base, "POST", "/lab/overlay", { bee: "bee3", rules: "  Chase the top   momentum coin,\nbut skip anything under $5M volume.  ", coins: ["pengu", "DOGE"], reason: "manual push", metrics });
      expect(set.status).toBe(200);
      const st = await call(s.base, "GET", "/lab/state", undefined);
      expect(st.status).toBe(200);
      const o = (st.body.overlays as Record<string, Record<string, unknown> | null>).bee3!;
      expect(o).toMatchObject({ rules: "Chase the top momentum coin, but skip anything under $5M volume.", coins: ["PENGU", "DOGE"], effectiveCoins: ["PENGU", "DOGE"], reason: "manual push" });
      expect((st.body.overlays as Record<string, unknown>).bee1).toBeNull();
      const h = (st.body.history as Array<Record<string, unknown>>)[0]!;
      expect(h).toMatchObject({ bee: "bee3", action: "set", metrics });
      expect(JSON.stringify(redact(st.body))).toBe(JSON.stringify(st.body));
    } finally {
      s.srv.close();
    }
  });

  it("validates: rules 10-500 chars, live crypto coins only, no other fields (leverage, stops, caps...)", async () => {
    const s = await server(SECRET);
    try {
      const ok = { bee: "bee1", rules: RULES, coins: [], reason: "r" };
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, rules: "too short" })).status).toBe(400);
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, rules: "x".repeat(501) })).status).toBe(400);
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, coins: ["AAPL"] })).status).toBe(400);
      // the bee is a slot id: the old style names are not bees here
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, bee: "bizzy" })).status).toBe(400);
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, bee: "bee4" })).status).toBe(400);
      for (const extra of [{ leverage: 5 }, { maxLeverage: 3 }, { stopAtrMult: 9 }, { maxTradesPerDay: 50 }, { dailyLossStopPct: 90 }, { mode: "live" }, { maxNotionalUsd: 1e6 }]) {
        const r = await call(s.base, "POST", "/lab/overlay", { ...ok, ...extra });
        expect(r.status).toBe(400);
      }
      // nested metrics are refused (flat numbers and short text only)
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, metrics: { a: { b: 1 } } })).status).toBe(400);
      // text the redactor would mask can't be stored (it would come back altered)
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, rules: "Trade only when 0xdeadbeefdeadbeefdeadbeef says so." })).status).toBe(400);
      expect((await call(s.base, "POST", "/lab/overlay", { ...ok, metrics: { apiKey: "abc" } })).status).toBe(400);
      expect(s.store.overlay("bee1")).toBeNull();
      expect((await call(s.base, "POST", "/lab/overlay", ok)).status).toBe(200);
    } finally {
      s.srv.close();
    }
  });

  it("allows one change per bee per 20 hours (server clock), a rollback always, and keeps the full history", async () => {
    let now = NOW;
    const s = await server(SECRET, () => now);
    const at = () => ({ ts: now });
    try {
      const set = (b: BeeId, rules: string) => call(s.base, "POST", "/lab/overlay", { bee: b, rules, coins: [], reason: "promo" }, at());
      expect((await set("bee2", "First new rules for bee2 here.")).status).toBe(200);
      expect((await set("bee2", "Second new rules for bee2 here.")).status).toBe(429);
      // other bees are independent
      expect((await set("bee3", "First new rules for bee3 here.")).status).toBe(200);
      now += LAB_MIN_INTERVAL_MS - 1000;
      expect((await set("bee2", "Second new rules for bee2 here.")).status).toBe(429);
      now += 2000;
      expect((await set("bee2", "Second new rules for bee2 here.")).status).toBe(200);
      expect(s.store.overlay("bee2")!.rules).toBe("Second new rules for bee2 here.");
      // rollback right away is allowed, goes back to the first overlay, then to none, then 409
      const rb = await call(s.base, "POST", "/lab/rollback", { bee: "bee2", reason: "worse than before" }, at());
      expect(rb.status).toBe(200);
      expect(s.store.overlay("bee2")!.rules).toBe("First new rules for bee2 here.");
      expect((await call(s.base, "POST", "/lab/rollback", { bee: "bee2", reason: "again" }, at())).status).toBe(200);
      expect(s.store.overlay("bee2")).toBeNull();
      expect((await call(s.base, "POST", "/lab/rollback", { bee: "bee2", reason: "once more" }, at())).status).toBe(409);
      // a rollback counts as a change: no new overlay within 20 h of it
      expect((await set("bee2", "Third new rules for bee2 here.")).status).toBe(429);
      const st = await call(s.base, "GET", "/lab/state", undefined, at());
      const hist = st.body.history as Array<{ action: string; bee: string }>;
      expect(hist.map((x) => `${x.bee}:${x.action}`)).toEqual(["bee2:rollback", "bee2:rollback", "bee2:set", "bee3:set", "bee2:set"]);
    } finally {
      s.srv.close();
    }
  });
});
