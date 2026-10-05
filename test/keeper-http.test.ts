import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alerts } from "../src/alerts.js";
import { ConfigError, loadConfig, originOf, type BeeId } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { hashPassword, PasswordGate } from "../src/gate.js";
import { Hive } from "../src/hive.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { Keeper } from "../src/keeper.js";
import { isPrivateAddress, KeeperHttp, keeperPath, KeeperSettings, parseHookUrl, parsePublicUrl } from "../src/keeper-http.js";
import { effectiveCoins, liveRules, type OwnerRules } from "../src/lab/brain.js";
import { LAB_MIN_INTERVAL_MS, LabDoor, labSignature } from "../src/lab/door.js";
import { LabStore } from "../src/lab/store.js";
import type { MarketFeed } from "../src/market/data.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";
import { coin, NOW, testConfig, trend, view } from "./fixtures.js";

const PASSWORD = "correct horse";
const HASH = hashPassword(PASSWORD);
const HOOK = "https://hooks.zapier.com/hooks/catch/123456/abcdefg/";
const PUBLIC = "http://203.0.113.7";
const RULES = "Only APE a coin whose r24h_pct and r7d_pct are both positive; RIDE while upl_r is above zero.";

const SLOTS: Record<BeeId, OwnerRules & { name: string }> = {
  bee1: { name: "Rex", style: "bizzy", rules: "", coins: [] },
  bee2: { name: "Granny", style: "breezy", rules: "Buy BTC dips, then wait.", coins: ["BTC"] },
  bee3: { name: "Zip", style: "boozy", rules: "Chase the loudest coin.", coins: [] },
};
const pubBee = (bee: string) => ({ bee, equityUsd: 333, pnlPct: 0, position: null, flatMinutes: 5, tradesToday: 0, maxTradesPerDay: 3, cap: null, totals: { feesUsd: 0, orders: 0 }, last: null });
const snapshot = () => ({ startEquityUsd: 333, bees: [pubBee("bee1"), pubBee("bee2"), pubBee("bee3")], totals: { pnlUsd: 0 }, jev: { spentTodayUsd: 0 }, market: { universe: ["BTC", "ETH"] } });

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
  vi.restoreAllMocks();
});

async function rig(opts: { hash?: string | null; env?: ConstructorParameters<typeof KeeperSettings>[1]; dir?: string; snapshot?: () => unknown; hookStatus?: number; hive?: boolean } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "bees-keeper-"));
  const path = keeperPath(join(dir, "settings.json"));
  const db = new Db(":memory:");
  const store = new LabStore(db);
  const bus = new EventBus(db);
  const settings = new KeeperSettings(path, opts.env);
  const hooks: Array<{ url: string; body: Record<string, unknown> }> = [];
  const keeper = new Keeper({
    db,
    bus,
    config: () => settings.config,
    bee: (id) => ({ name: SLOTS[id].name, styleLabel: SLOTS[id].style, ...liveRules(SLOTS[id], store.overlay(id)), ownerCoins: SLOTS[id].coins }),
    lockedUntil: (id) => {
      const last = store.lastChangeAt(id);
      return last === null ? null : last + LAB_MIN_INTERVAL_MS;
    },
    snapshot: opts.snapshot ?? snapshot,
    fetch: (async (url: string, init: { body: string }) => {
      hooks.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: (opts.hookStatus ?? 200) === 200, status: opts.hookStatus ?? 200 };
    }) as unknown as typeof fetch,
  });
  const door = new LabDoor({ store, rounds: keeper, knownCoins: () => ["BTC", "ETH", "SOL"], effectiveCoins: (id, coins) => effectiveCoins(SLOTS[id].style, SLOTS[id].coins, coins) });
  const hash = opts.hash === undefined ? HASH : opts.hash;
  const gate = new PasswordGate("x-owner-password", () => hash, "owner password");
  const http = new KeeperHttp({ keeper, settings, door, gate, name: (id) => SLOTS[id].name, slot: (id) => SLOTS[id], overlay: (id) => store.overlay(id) });
  const hive = opts.hive
    ? new Hive({ path: join(dir, "hive.json"), url: "https://hive.test", mode: "dry", source: () => ({ startedAt: 0, startEquityUsd: 333, bees: [] }), db, ownerPasswordHash: () => hash, gate, fetch: (async () => new Response("{}")) as unknown as typeof fetch })
    : undefined;
  const srv = startServer({ engine: { bus, db, visitors: new Visitors(db), snapshot: opts.snapshot ?? snapshot, health: () => ({ ok: true }) }, keeper: http, lab: door, hive, profile: () => ({ bees: [] }), beeImage: () => null }, 0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  close = () => {
    srv.close();
    hive?.stop();
  };
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (p: string, body: unknown = {}, password: string | null = PASSWORD) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(password === null ? {} : { "x-owner-password": encodeURIComponent(password) }) }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { keeper?: Record<string, unknown>; error?: string } };
  };
  const get = async (p: string) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, text: await r.text() };
  };
  /** What the Zap's last step does with the round's key. */
  const deliver = async (key: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    const r = await fetch(`${base}/lab/overlay`, { method: "POST", headers: { "content-type": "application/json", "x-lab-ts": ts, "x-lab-sig": labSignature(key, ts, "POST", "/lab/overlay", raw) }, body: raw });
    return r.status;
  };
  return { base, post, get, deliver, keeper, settings, store, door, hooks, path, dir, db };
}

/** A made-up address on a home or office network (never a real one), for the "Zapier cannot reach this" checks. */
const lan = (...parts: number[]) => parts.join(".");
const overlay = (bee: string) => ({ bee, rules: RULES, coins: ["BTC"], reason: "Back to the majors.", metrics: { idea: "Majors only", quip: "Put the meme coins down.", anger: 3 } });
const READS = ["/snapshot", "/keeper/scorecard", "/profile", "/history?n=1000"];

describe("beekeeper routes: the owner password", () => {
  it("every write needs it: none, a wrong one, and a server without one are all refused, and nothing changes", async () => {
    const r = await rig();
    for (const p of ["/keeper/connect", "/keeper/disconnect", "/keeper/round", "/keeper/rollback"]) {
      expect((await r.post(p, { hookUrl: HOOK, publicUrl: PUBLIC, bee: "bee1" }, null)).status).toBe(401);
      const bad = await r.post(p, { hookUrl: HOOK, publicUrl: PUBLIC, bee: "bee1" }, "wrong horse!");
      expect(bad.status).toBe(401);
      expect(bad.body.error).toBe("That owner password is not right.");
      // a GET is never a write
      expect((await r.get(p)).status).toBe(405);
    }
    expect(r.keeper.enabled).toBe(false);
    expect(existsSync(r.path)).toBe(false);
    expect(r.hooks).toEqual([]);

    const unset = await rig({ hash: null });
    const res = await unset.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no owner password yet");
    expect(unset.keeper.enabled).toBe(false);
  });

  it("eight wrong passwords lock every owner action for 15 minutes, the Hive's too (one gate)", async () => {
    const r = await rig({ hive: true });
    for (let i = 0; i < 8; i++) expect((await r.post("/keeper/round", {}, "wrong horse!")).status).toBe(401);
    const locked = await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain("locked for 15 minutes");
    expect((await r.post("/keeper/rollback", { bee: "bee1" })).status).toBe(429);
    expect((await r.post("/hive/join")).status).toBe(429);
    expect(r.keeper.enabled).toBe(false);
  });
});

describe("beekeeper routes: connect and disconnect", () => {
  it("connect saves the hook and this page's address, takes effect at once, and never gives the hook back", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (out.push(String(s)), true));
    const r = await rig({ hookStatus: 500 });
    expect((await r.get("/snapshot")).text).toContain('"keeper":{"on":false');
    const res = await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: `${PUBLIC}/` });
    expect(res.status).toBe(200);
    expect(res.body.keeper).toMatchObject({ on: true, everyHours: 4, rounds: 0 });
    expect(typeof res.body.keeper!.nextRoundAt).toBe("number");
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual({ hookUrl: HOOK, publicUrl: PUBLIC });
    expect(statSync(r.path).mode & 0o777).toBe(0o600);

    // a round (which fails: the hook answers 500) so every code path that touches the hook has run
    const round = await r.post("/keeper/round");
    expect(round.status).toBe(200);
    expect(r.hooks[0]).toMatchObject({ url: HOOK, body: { source: "manual", base_url: PUBLIC, round: round.body.round } });
    expect(round.body.keeper!.entries).toMatchObject([{ action: "failed" }]);

    const served = JSON.stringify([res.body, round.body, ...(await Promise.all(READS.map((p) => r.get(p)))).map((x) => x.text)]);
    for (const secret of ["hooks.zapier.com", "123456", "abcdefg", String(r.hooks[0]!.body.key)]) {
      expect(served).not.toContain(secret);
      expect(out.join("")).not.toContain(secret);
    }
    expect(out.join("")).toContain("beekeeper connected from the dashboard");
  });

  it("refuses a hook that is not https, an address with a path, and an address Zapier could never reach", async () => {
    const r = await rig();
    for (const hookUrl of ["http://hooks.zapier.com/hooks/catch/1/a/", "hooks.zapier.com/hooks/catch/1/a/", "", "https://user:pw@hooks.zapier.com/x", `https://a.test/${"x".repeat(500)}`]) {
      expect((await r.post("/keeper/connect", { hookUrl, publicUrl: PUBLIC })).status).toBe(400);
    }
    for (const publicUrl of ["http://203.0.113.7/dashboard", "ftp://203.0.113.7", "not a url", undefined, "https://bees.example.com/?x=1"]) {
      expect((await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl })).status).toBe(400);
    }
    for (const publicUrl of ["http://localhost:5173", "http://127.0.0.1", `http://${lan(192, 168, 1, 20)}`, `http://${lan(10, 0, 0, 5)}:8080`, "http://bees.local"]) {
      const res = await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Zapier cannot reach this address");
    }
    // nothing but the two fields; a body over 16 KiB; a body that is not JSON
    expect((await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC, everyHours: 0.01 })).status).toBe(400);
    expect((await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC, pad: "x".repeat(17 * 1024) })).status).toBe(400);
    expect((await r.post("/keeper/connect", "{not json")).status).toBe(400);
    expect(r.keeper.enabled).toBe(false);
    expect(existsSync(r.path)).toBe(false);
    // any https hook is fine, and so is a domain with a port
    expect((await r.post("/keeper/connect", { hookUrl: "https://example.org/my-own-hook", publicUrl: "https://bees.example.com:8443" })).status).toBe(200);
    expect(r.settings.config).toMatchObject({ hookUrl: "https://example.org/my-own-hook", publicUrl: "https://bees.example.com:8443" });
  });

  it("disconnect stops the rounds and kills the key in flight, but leaves a rewrite in place", async () => {
    const r = await rig();
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    await r.post("/keeper/round");
    expect(await r.deliver(String(r.hooks[0]!.body.key), overlay("bee3"))).toBe(200);
    await r.post("/keeper/round");
    const key2 = String(r.hooks[1]!.body.key);

    const res = await r.post("/keeper/disconnect");
    expect(res.status).toBe(200);
    expect(res.body.keeper).toMatchObject({ on: false, nextRoundAt: null, rewrites: 1 });
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual({ publicUrl: PUBLIC });
    expect(r.keeper.liveKeys()).toEqual([]);
    // the door is shut to the old key (404: nothing can open it now)
    expect(await r.deliver(key2, overlay("bee1"))).toBe(404);
    expect((await r.post("/keeper/round")).status).toBe(409);
    expect(r.store.overlay("bee3")!.rules).toBe(RULES);
    // and it comes back on from the file after a restart
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    expect(new KeeperSettings(r.path).config).toMatchObject({ hookUrl: HOOK, publicUrl: PUBLIC, everyHours: 4 });
  });

  it("settings in the environment win over the file, and the dashboard cannot change them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-keeper-"));
    writeFileSync(keeperPath(join(dir, "settings.json")), JSON.stringify({ hookUrl: "https://example.org/from-file", publicUrl: "http://203.0.113.9", everyHours: 6, rampStart: "2026-10-02T13:00:00Z" }));
    expect(new KeeperSettings(keeperPath(join(dir, "settings.json"))).config).toEqual({ hookUrl: "https://example.org/from-file", publicUrl: "http://203.0.113.9", everyHours: 6, rampStart: Date.parse("2026-10-02T13:00:00Z") });
    const r = await rig({ dir, env: { hookUrl: HOOK, publicUrl: "https://bees.example.com", everyHours: 2, rampStart: "2026-10-03T00:00:00Z" } });
    expect(r.settings.config).toEqual({ hookUrl: HOOK, publicUrl: "https://bees.example.com", everyHours: 2, rampStart: Date.parse("2026-10-03T00:00:00Z") });
    expect((await r.post("/keeper/connect", { hookUrl: "https://example.org/other", publicUrl: PUBLIC })).status).toBe(409);
    expect((await r.post("/keeper/disconnect")).status).toBe(409);
    expect(r.settings.config.hookUrl).toBe(HOOK);
    // with only the address in the environment, the page's own address is not needed and not used
    const p = await rig({ env: { publicUrl: "https://bees.example.com" } });
    expect((await p.post("/keeper/connect", { hookUrl: HOOK })).status).toBe(200);
    expect(p.settings.config).toMatchObject({ hookUrl: HOOK, publicUrl: "https://bees.example.com" });
    expect(JSON.parse(readFileSync(p.path, "utf8"))).toEqual({ hookUrl: HOOK });
  });

  it("a broken keeper.json means off, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bees-keeper-"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(keeperPath(join(dir, "settings.json")), "{nope");
    expect(new KeeperSettings(keeperPath(join(dir, "settings.json"))).config).toEqual({ hookUrl: undefined, publicUrl: undefined, everyHours: 4, rampStart: undefined });
    writeFileSync(keeperPath(join(dir, "settings.json")), JSON.stringify({ hookUrl: "http://plain.example/hook", publicUrl: "http://203.0.113.9/path" }));
    expect(new KeeperSettings(keeperPath(join(dir, "settings.json"))).config).toMatchObject({ hookUrl: undefined, publicUrl: undefined });
  });
});

describe("beekeeper routes: a round now", () => {
  it("starts one round, and refuses a second while the first is with the Zap", async () => {
    const r = await rig();
    expect((await r.post("/keeper/round")).status).toBe(409);
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    const first = await r.post("/keeper/round");
    expect(first.status).toBe(200);
    expect(first.body.keeper!.entries).toMatchObject([{ id: first.body.round, action: "calling" }]);
    const second = await r.post("/keeper/round");
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already running");
    expect(r.hooks.length).toBe(1);
  });

  it("a broken engine snapshot is an answer, never an unhandled rejection", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await rig({
      snapshot: () => {
        throw new Error("snapshot boom");
      },
    });
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    expect((await r.post("/keeper/round")).status).toBe(409);
    expect((await r.get("/keeper/scorecard")).status).toBe(503);
    expect(r.hooks).toEqual([]);
  });
});

describe("beekeeper routes: the owner's rollback", () => {
  it("undoes the latest rewrite of a bee: to the rewrite before it, then to the owner's own rules", async () => {
    const r = await rig();
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    const nothing = await r.post("/keeper/rollback", { bee: "bee3" });
    expect(nothing.status).toBe(409);
    expect(nothing.body.error).toBe("Zip has no Beekeeper rewrite to undo.");
    expect((await r.post("/keeper/rollback", { bee: "boozy" })).status).toBe(400);
    expect((await r.post("/keeper/rollback", { bee: "bee3", reason: "mine" })).status).toBe(400);

    // two rewrites of bee3 (the second set straight into the store: the door would make the Zap wait 20 h)
    await r.post("/keeper/round");
    expect(await r.deliver(String(r.hooks[0]!.body.key), overlay("bee3"))).toBe(200);
    r.store.set("bee3", "Second rewrite: only RIDE, never DOUBLE_DOWN.", [], "second", undefined, Date.now());
    expect(liveRules(SLOTS.bee3, r.store.overlay("bee3")).rules).toBe("Second rewrite: only RIDE, never DOUBLE_DOWN.");

    const one = await r.post("/keeper/rollback", { bee: "bee3" });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ ok: true, bee: "bee3", restored: "previous" });
    expect(liveRules(SLOTS.bee3, r.store.overlay("bee3"))).toEqual({ rules: RULES, coins: ["BTC"] });
    expect(one.body.keeper!.entries).toMatchObject([{ action: "rolled_back", bee: "bee3", quip: "Zip is back on the rules from before. That one didn't work.", reason: "Undone by the owner from the dashboard." }, { action: "rewrote", bee: "bee3" }]);

    const two = await r.post("/keeper/rollback", { bee: "bee3" });
    expect(two.body).toMatchObject({ ok: true, restored: "owner" });
    expect(r.store.overlay("bee3")).toBeNull();
    // byte for byte the owner's own
    expect(liveRules(SLOTS.bee3, r.store.overlay("bee3"))).toEqual({ rules: SLOTS.bee3.rules, coins: SLOTS.bee3.coins });
    expect((two.body.keeper!.entries as Array<{ quip: string }>)[0]!.quip).toBe("Zip is back on its owner's rules.");
    expect((await r.post("/keeper/rollback", { bee: "bee3" })).status).toBe(409);
    // an undo counts as a change: the Beekeeper leaves that bee alone for 20 hours
    expect(r.keeper.openBees()).toEqual(["bee1", "bee2"]);
    // other bees were never touched
    expect(r.store.overlay("bee1")).toBeNull();
  });

  it("works with the Beekeeper disconnected: the owner can always undo", async () => {
    const r = await rig();
    r.store.set("bee2", RULES, [], "left over", undefined, Date.now());
    expect(r.keeper.enabled).toBe(false);
    expect((await r.post("/keeper/rollback", { bee: "bee2" })).body).toMatchObject({ ok: true, restored: "owner" });
    expect(r.store.overlay("bee2")).toBeNull();
  });
});

describe("beekeeper routes: the scorecard", () => {
  it("is public, and anything else under /keeper/ is a 404", async () => {
    const r = await rig();
    const card = await r.get("/keeper/scorecard");
    expect(card.status).toBe(200);
    expect(JSON.parse(card.text)).toMatchObject({ open_bees: "bee1,bee2,bee3", universe: "BTC,ETH" });
    expect((await r.get("/keeper/nope")).status).toBe(404);
    expect((await r.post("/keeper/nope")).status).toBe(404);
    expect((await r.post("/keeper/scorecard")).status).toBe(405);
  });
});

/**
 * A real engine and the Beekeeper's routes over one database, so the preview can be held against the version the
 * engine actually stamps on a decision row. The routes are given the engine's own slots and overlay store, as
 * src/index.ts does. The fake Jev always answers off-menu, so a tick records decisions without trading.
 */
async function engineRig() {
  const cfg = testConfig({ DRY_RUN: "true" });
  cfg.slots.bee3 = { ...cfg.slots.bee3, rules: "Chase the loudest coin, but never anything that fell this week.", coins: [] };
  const db = new Db(":memory:");
  const store = new LabStore(db);
  const bus = new EventBus(db);
  const v = view([
    coin("BTC", { trend: trend({ score: 6 }), ret24hPct: 2, ret7dPct: 5, breakout: { dayOpen: 80000, prevRange: 2000, trigger: 81000 } }, 80000),
    coin("ETH", { trend: trend({ score: -4 }), ret24hPct: -1, ret7dPct: -3 }, 2700),
    coin("SOL", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 }, ret24hPct: 6, ret7dPct: 12 }, 102.5),
    coin("PENGU", { ret24hPct: 15, ret7dPct: 30, volZ: 3 }),
    coin("DOGE", { ret24hPct: 4, ret7dPct: 9 }),
  ]);
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const client: SystemOne = {
    async systemOne() {
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const engine = new Engine({
    cfg,
    db,
    feed,
    jev: new Jev({ ...cfg.jev, client, now: () => NOW }),
    exec: new SimExecutor(() => v, cfg.risk.takerFeeRate),
    bus,
    alerts: new Alerts(undefined),
    now: () => NOW,
    lab: store,
  });
  await engine.start();
  engine.stop(); // ticks are driven by hand below

  const settings = new KeeperSettings(keeperPath(join(mkdtempSync(join(tmpdir(), "bees-keeper-")), "settings.json")));
  const keeper = new Keeper({
    db,
    bus,
    config: () => settings.config,
    bee: (id) => ({ name: cfg.slots[id].name, styleLabel: cfg.slots[id].style, ...liveRules(cfg.slots[id], store.overlay(id)), ownerCoins: cfg.slots[id].coins }),
    lockedUntil: () => null,
    snapshot: () => engine.snapshot(),
    fetch: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
  });
  const door = new LabDoor({ store, rounds: keeper, knownCoins: () => ["BTC", "ETH", "SOL"], effectiveCoins: (id, coins) => effectiveCoins(cfg.slots[id].style, cfg.slots[id].coins, coins) });
  const gate = new PasswordGate("x-owner-password", () => HASH, "owner password");
  const http = new KeeperHttp({ keeper, settings, door, gate, name: (id) => cfg.slots[id].name, slot: (id) => cfg.slots[id], overlay: (id) => store.overlay(id) });
  const srv = startServer({ engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine.snapshot(), health: () => engine.health() }, keeper: http, lab: door, profile: () => ({ bees: [] }), beeImage: () => null }, 0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  close = () => srv.close();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  /** No owner password: this route is public, like the scorecard next to it. */
  const preview = async (body: unknown, password: string | null = null) => {
    const res = await fetch(`${base}/keeper/ruleset-version`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(password === null ? {} : { "x-owner-password": encodeURIComponent(password) }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { current?: string; next?: string; error?: string } };
  };
  const get = async (p: string) => (await fetch(`${base}${p}`)).status;
  /** The ruleset the engine stamped on that bee's latest decision. */
  const stamp = (bee: BeeId) => (db.raw.prepare(`SELECT rules_version AS v FROM decisions WHERE bee = ? ORDER BY id DESC LIMIT 1`).get(bee) as { v: string | null }).v;
  /** Everything the preview must leave alone. */
  const state = (bee: BeeId) => ({
    rulesets: db.raw.prepare(`SELECT version, bee, strategy FROM rulesets ORDER BY version`).all(),
    decisions: db.raw.prepare(`SELECT bee, rules_version AS v, overlay_id AS o FROM decisions ORDER BY id`).all(),
    overlay: store.overlay(bee),
    live: liveRules(cfg.slots[bee], store.overlay(bee)),
  });
  return { engine, store, preview, get, stamp, state };
}

describe("beekeeper routes: the ruleset-version preview", () => {
  it("answers with the version the engine stamps now, and the one it stamps once those rules land for real", async () => {
    const r = await engineRig();
    await r.engine.tick();

    const p = await r.preview({ bee: "bee3", rules: RULES, coins: ["BTC"] });
    expect(p.status).toBe(200);
    expect(p.body.current).toBe(r.stamp("bee3"));
    expect(p.body.next).toMatch(/^[0-9a-f]{16}$/);
    expect(p.body.next).not.toBe(p.body.current);

    // the very same rules, landed for real: the engine's own stamp must be the version the preview promised
    r.store.set("bee3", RULES, ["BTC"], "for real", undefined, NOW);
    await r.engine.tick();
    expect(r.stamp("bee3")).toBe(p.body.next);
    // and the other bees are unmoved by any of it
    expect((await r.preview({ bee: "bee1", rules: RULES, coins: [] })).body.current).toBe(r.stamp("bee1"));
  });

  it("changes nothing: no ruleset row, no decision row, and the bee's live rules are untouched", async () => {
    const r = await engineRig();
    await r.engine.tick();
    const before = r.state("bee2");

    expect((await r.preview({ bee: "bee2", rules: RULES, coins: ["BTC"] })).status).toBe(200);
    expect((await r.preview({ bee: "bee2", rules: "Only RIDE, never DOUBLE_DOWN, and never after a red day.", coins: [] })).status).toBe(200);

    expect(r.state("bee2")).toEqual(before);
    expect(r.store.overlay("bee2")).toBeNull();
  });

  it("does not change what the engine stamps next: the hypothetical brain never reaches the engine's cache", async () => {
    const r = await engineRig();
    await r.engine.tick();
    const first = r.stamp("bee1");

    for (const rules of [RULES, "Only RIDE, never DOUBLE_DOWN, and never after a red day."]) {
      expect((await r.preview({ bee: "bee1", rules, coins: ["BTC"] })).status).toBe(200);
    }
    await r.engine.tick();
    expect(r.stamp("bee1")).toBe(first);
  });

  it("an unknown bee, rules that are not text and coins that are not a list are all 4xx, never a 500", async () => {
    const r = await engineRig();
    for (const body of [{}, { bee: "bee4", rules: RULES, coins: [] }, { bee: "bee1", rules: 42, coins: [] }, { bee: "bee1", rules: RULES, coins: "BTC" }, { bee: "bee1", rules: RULES, coins: new Array(21).fill("BTC") }, { bee: "bee1", rules: RULES, coins: [], reason: "not a field here" }, "{not json", { bee: "bee1", rules: RULES, coins: [], pad: "x".repeat(17 * 1024) }]) {
      const res = await r.preview(body);
      expect(res.status).toBe(400);
      expect(res.body.current).toBeUndefined();
    }
    expect(await r.get("/keeper/ruleset-version")).toBe(405);
    // public, like the scorecard: a wrong owner password is not even looked at
    expect((await r.preview({ bee: "bee1", rules: RULES, coins: [] }, "wrong horse!")).status).toBe(200);
  });
});

describe("the Zap's two code steps (beekeeper/*.js), run the way Code by Zapier runs them", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (inputData: Record<string, string>, fetch: typeof globalThis.fetch, require: NodeRequire) => Promise<Array<Record<string, string>>>;
  const step = (file: string) => new AsyncFunction("inputData", "fetch", "require", `let output;\n${readFileSync(new URL(`../beekeeper/${file}`, import.meta.url), "utf8")}\nreturn output;`);
  const nodeRequire = createRequire(import.meta.url);

  it("step 2 reads the scorecard from the address in the hook, and step 8's signature opens the door once", async () => {
    const r = await rig();
    await r.post("/keeper/connect", { hookUrl: HOOK, publicUrl: PUBLIC });
    await r.post("/keeper/round");
    // Zapier would call the engine's public address; here that address is this test's server.
    const viaZapier = ((url: string, init?: RequestInit) => fetch(url.replace(PUBLIC, r.base), init)) as typeof fetch;

    const [two] = await step("step2-scorecard.js")({ hook: JSON.stringify(r.hooks[0]!.body) }, viaZapier, nodeRequire);
    expect(two).toMatchObject({ open_bees: "bee1,bee2,bee3", base_url: PUBLIC, source: "manual", round: "1", key: r.hooks[0]!.body.key });
    expect(two!.scorecard).toMatch(/^BEEKEEPER ROUND .*Why the Beekeeper was called early: The owner asked for a round\.$/s);
    expect(two!.playbook).toContain("bee1, bee2 or bee3");

    const input = { rules: `  ${RULES}\n`, idea: "Majors only", coins: "btc, ETH", reason: "Back to the majors.", note: "Sorted.", quip: "Zip, put the meme coins down.", bee: "bee3", anger: "4: Down 18% to 25% since start.", key: two!.key!, base_url: two!.base_url!, reply_to: "", scorecard: two!.scorecard! };
    const [eight] = await step("step8-deliver.js")(input, viaZapier, nodeRequire);
    expect(eight).toMatchObject({ door_status: "200", reply_status: "no reply_to in the trigger" });
    expect(r.store.overlay("bee3")).toMatchObject({ rules: RULES, coins: ["BTC", "ETH"], reason: "Back to the majors." });
    expect(r.keeper.publicState().entries[0]).toMatchObject({ action: "rewrote", bee: "bee3", quip: "Zip, put the meme coins down.", idea: "Majors only", anger: 4 });

    // the key is spent: the same step run again gets nowhere
    const [again] = await step("step8-deliver.js")({ ...input, bee: "bee1" }, viaZapier, nodeRequire);
    expect(again!.door_status).toBe("401");
    expect(r.store.overlay("bee1")).toBeNull();
    // and with no key (a hand-made test run) nothing is sent at all
    const [dry] = await step("step8-deliver.js")({ ...input, key: "" }, viaZapier, nodeRequire);
    expect(dry!.door_status).toBe("skipped: this round came with no key");
    await expect(step("step2-scorecard.js")({ hook: "{}" }, viaZapier, nodeRequire)).rejects.toThrow("no base_url");
  });
});

describe("beekeeper settings: addresses", () => {
  it("a hook is any https URL; a public address is an origin with no path", () => {
    expect(parseHookUrl(HOOK)).toBe(HOOK);
    expect(parseHookUrl("http://hooks.zapier.com/x")).toBeNull();
    expect(parseHookUrl(42)).toBeNull();
    expect(parsePublicUrl("https://bees.example.com/")).toBe("https://bees.example.com");
    expect(parsePublicUrl("http://203.0.113.7:8080")).toBe("http://203.0.113.7:8080");
    expect(parsePublicUrl("https://bees.example.com/x")).toBeNull();
    expect(parsePublicUrl("https://user@bees.example.com")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    const home = [lan(10, 1, 2, 3), lan(172, 16, 0, 1), lan(172, 31, 255, 1), lan(192, 168, 0, 1), lan(169, 254, 1, 1)].map((a) => `http://${a}`);
    for (const a of ["http://localhost", "http://127.0.0.1:8080", ...home, "http://[::1]", "http://[fd00::1]", "http://box.local"]) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["http://203.0.113.7", "https://bees.example.com", `http://${lan(172, 32, 0, 1)}`, `http://${lan(11, 0, 0, 1)}`, "http://[2001:db8::1]"]) expect(isPrivateAddress(a)).toBe(false);
  });

  it("the environment: the hook must be https, the interval at least a quarter hour, and PUBLIC_DOMAIN gives the address", () => {
    const cfg = (env: Record<string, string>) => loadConfig({ TYPESAFE_API_KEY: "test-key", ...env }).keeper;
    expect(cfg({})).toEqual({ hookUrl: undefined, publicUrl: undefined, everyHours: undefined, rampStart: undefined });
    expect(cfg({ PUBLIC_DOMAIN: "bees.example.com" }).publicUrl).toBe("https://bees.example.com");
    expect(cfg({ PUBLIC_DOMAIN: "bees.example.com", PUBLIC_URL: "http://203.0.113.7:8080/" }).publicUrl).toBe("http://203.0.113.7:8080");
    // PUBLIC_DOMAIN is Caddy's site address: anything that is not a plain domain is simply not used
    expect(cfg({ PUBLIC_DOMAIN: ":80" }).publicUrl).toBeUndefined();
    expect(cfg({ BEEKEEPER_WEBHOOK_URL: HOOK, BEEKEEPER_EVERY_HOURS: "6", BEEKEEPER_RAMP_START: "2026-10-02T13:00:00Z" })).toMatchObject({ hookUrl: HOOK, everyHours: 6, rampStart: "2026-10-02T13:00:00Z" });
    expect(() => cfg({ BEEKEEPER_WEBHOOK_URL: "http://hooks.zapier.com/x" })).toThrow(ConfigError);
    expect(() => cfg({ BEEKEEPER_EVERY_HOURS: "0.1" })).toThrow(ConfigError);
    expect(() => cfg({ BEEKEEPER_EVERY_HOURS: "often" })).toThrow(ConfigError);
    expect(() => cfg({ PUBLIC_URL: "bees.example.com/x" })).toThrow(ConfigError);
    // a config error names the setting, never its value
    try {
      cfg({ BEEKEEPER_WEBHOOK_URL: "http://hooks.zapier.com/secret-path" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-path");
    }
  });
});
