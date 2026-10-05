// The Beekeeper's settings and its HTTP routes.
// Settings: a small file next to settings.json (keeper.json, readable by the engine's user only), written when the
// owner connects from the dashboard. Anything set in the environment wins over the file.
// Routes:
//   GET  /keeper/scorecard    public: what the Zap reads before a round (data that is public already, 10 s cache)
//   POST /keeper/ruleset-version  public: { bee, rules, coins } -> the ruleset version that bee runs now and the one
//                             those rules would produce. Read-only: it installs nothing and records nothing.
//   POST /keeper/connect      owner password: { hookUrl, publicUrl }, takes effect without a restart
//   POST /keeper/disconnect   owner password: no more rounds (rewrites already made stay until undone)
//   POST /keeper/round        owner password: start a round now
//   POST /keeper/rollback     owner password: { bee }, undo the Beekeeper's latest rewrite of that bee
// The hook URL is a secret (anyone who has it can start the owner's Zap): it is never served and never logged.
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { customBrain } from "./bees/custom.js";
import { BRAINS } from "./bees/index.js";
import { BEES, originOf, type BeeId } from "./config.js";
import { readJson, send, type PasswordGate } from "./gate.js";
import { KEEPER_DEFAULT_EVERY_HOURS, parseRampStart, type Keeper, type KeeperConfig } from "./keeper.js";
import { liveRules, rulesVersion, type OwnerRules } from "./lab/brain.js";
import type { LabDoor } from "./lab/door.js";
import { log } from "./log.js";
import { redact, safeError } from "./redact.js";
import { writePrivateJson } from "./settings.js";

const MAX_BODY = 16 * 1024;
const SCORECARD_CACHE_MS = 10_000;
const OWNER_UNDO_REASON = "Undone by the owner from the dashboard.";

const FileSchema = z.object({
  hookUrl: z.string().optional(),
  publicUrl: z.string().optional(),
  everyHours: z.number().min(0.25).optional(),
  rampStart: z.union([z.string(), z.number()]).optional(),
});
/** keeper.json. */
export type KeeperFile = z.infer<typeof FileSchema>;

export function keeperPath(settingsPath: string): string {
  return join(dirname(settingsPath), "keeper.json");
}

/** The Zap's Catch Hook: any https:// URL (normally https://hooks.zapier.com/...). null = not acceptable. */
export function parseHookUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** This engine's public address: http(s)://host[:port], no path. null = not acceptable. */
export function parsePublicUrl(v: unknown): string | null {
  return typeof v === "string" && v.length <= 200 ? originOf(v) : null;
}

/** An address only this machine or its own network can reach: Zapier could never call it. */
export function isPrivateAddress(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function loadFile(path: string): KeeperFile {
  if (!existsSync(path)) return {};
  try {
    const f = FileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const hookUrl = f.hookUrl === undefined ? undefined : (parseHookUrl(f.hookUrl) ?? undefined);
    const publicUrl = f.publicUrl === undefined ? undefined : (parsePublicUrl(f.publicUrl) ?? undefined);
    if ((f.hookUrl && !hookUrl) || (f.publicUrl && !publicUrl)) log.warn("keeper.json holds an address that is not valid; ignoring it");
    return { ...f, hookUrl, publicUrl };
  } catch {
    log.warn("keeper.json is not valid; the Beekeeper stays off until it is connected again");
    return {};
  }
}

/** The Beekeeper's settings: the environment first, then keeper.json. */
export class KeeperSettings {
  private file: KeeperFile;
  private current: KeeperConfig;

  constructor(
    private path: string,
    private env: { hookUrl?: string; publicUrl?: string; everyHours?: number; rampStart?: string } = {},
  ) {
    this.file = loadFile(path);
    this.current = this.resolve();
  }

  private resolve(): KeeperConfig {
    return {
      hookUrl: this.env.hookUrl ?? this.file.hookUrl,
      publicUrl: this.env.publicUrl ?? this.file.publicUrl,
      everyHours: this.env.everyHours ?? this.file.everyHours ?? KEEPER_DEFAULT_EVERY_HOURS,
      rampStart: parseRampStart(this.env.rampStart ?? this.file.rampStart),
    };
  }

  /** What is in force right now. */
  get config(): KeeperConfig {
    return this.current;
  }

  /** The hook comes from the environment: the dashboard cannot change it. */
  get hookFromEnv(): boolean {
    return !!this.env.hookUrl;
  }

  get publicUrlFromEnv(): boolean {
    return !!this.env.publicUrl;
  }

  connect(hookUrl: string, publicUrl: string | undefined): void {
    this.file = { ...this.file, hookUrl, ...(publicUrl ? { publicUrl } : {}) };
    writePrivateJson(this.path, this.file);
    this.current = this.resolve();
  }

  disconnect(): void {
    const rest = { ...this.file };
    delete rest.hookUrl;
    this.file = rest;
    writePrivateJson(this.path, this.file);
    this.current = this.resolve();
  }
}

const ConnectReq = z.object({ hookUrl: z.string().max(500), publicUrl: z.string().max(200).optional() }).strict();
const RollbackReq = z.object({ bee: z.enum(BEES) }).strict();
// The same three fields the door's own overlay schema calls rules and coins, so a caller can ask about exactly what
// it is about to deliver. Bounds are the door's too (lab/door.ts): the 16 KiB body cap does the rest.
const VersionReq = z.object({ bee: z.enum(BEES), rules: z.string(), coins: z.array(z.string()).max(20) }).strict();

export interface KeeperHttpDeps {
  keeper: Keeper;
  settings: KeeperSettings;
  door: LabDoor;
  /** The owner password gate, shared with the Hive's join and leave so wrong tries count once. */
  gate: PasswordGate;
  name: (bee: BeeId) => string;
  /** The bee as Setup left it: the half of the composed strategy no caller of /keeper/ruleset-version can know. */
  slot: (bee: BeeId) => OwnerRules;
  /** The Beekeeper's rewrite in force for that bee, or null when it is on its owner's own rules. */
  overlay: (bee: BeeId) => { rules: string; coins: string[] } | null;
  now?: () => number;
}

const OWNER_ROUTES = new Set(["/keeper/connect", "/keeper/disconnect", "/keeper/round", "/keeper/rollback"]);

export class KeeperHttp {
  private scorecardCache: { at: number; body: string } | null = null;
  private now: () => number;

  constructor(private d: KeeperHttpDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The `keeper` block of /snapshot. Never throws. */
  publicState() {
    return this.d.keeper.publicState();
  }

  /** Handles /keeper/*. Returns false for a path it does not know. Never rejects: every failure is an HTTP answer. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    try {
      return await this.route(req, res, path);
    } catch (err) {
      log.error("beekeeper request failed", { path, err: safeError(err) });
      if (!res.headersSent) send(res, 500, { error: "The Beekeeper could not do that. See the engine's log." });
      else res.end();
      return true;
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === "/keeper/scorecard") {
      if (req.method !== "GET") return this.reply(res, 405, { error: "method not allowed" });
      const now = this.now();
      if (!this.scorecardCache || now - this.scorecardCache.at > SCORECARD_CACHE_MS) {
        let card: unknown;
        try {
          card = await this.d.keeper.freshScorecard();
        } catch (err) {
          log.warn("beekeeper scorecard not built", { err: safeError(err) });
          return this.reply(res, 503, { error: "The scorecard is not ready yet. Try again shortly." });
        }
        this.scorecardCache = { at: now, body: JSON.stringify(redact(card)) };
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(this.scorecardCache.body);
      return true;
    }
    if (path === "/keeper/ruleset-version") {
      if (req.method !== "POST") return this.reply(res, 405, { error: "method not allowed" });
      let raw: unknown;
      try {
        raw = await readJson(req, MAX_BODY);
      } catch {
        return this.reply(res, 400, { error: "bad request" });
      }
      const p = VersionReq.safeParse(raw);
      if (!p.success) return this.reply(res, 400, { error: "Name the bee (bee1, bee2 or bee3), the rules text and the coin list." });
      const slot = this.d.slot(p.data.bee);
      // The version a rewrite of this bee would replace, and the one it would install (or would have installed, for a
      // round that is recorded but never delivered). `liveRules` and `customBrain` are pure and the hash is the one the
      // engine stamps with, so this answers for a ruleset without installing it, rebuilding a brain or writing a row.
      const version = (o: { rules: string; coins: string[] } | null) => rulesVersion(customBrain(BRAINS[slot.style], liveRules(slot, o)).strategy);
      return this.reply(res, 200, { current: version(this.d.overlay(p.data.bee)), next: version(p.data) });
    }
    if (!OWNER_ROUTES.has(path)) return false;
    if (req.method !== "POST") return this.reply(res, 405, { error: "method not allowed" });

    const gate = this.d.gate.check(req);
    if (gate === "locked") return this.reply(res, 429, { error: "Too many wrong passwords. Owner actions are locked for 15 minutes." });
    if (gate === "unset") return this.reply(res, 409, { error: "This server has no owner password yet. Run Setup again to pick one (see the README), or set OWNER_PASSWORD." });
    if (gate === "bad") return this.reply(res, 401, { error: "That owner password is not right." });
    let body: unknown;
    try {
      body = await readJson(req, MAX_BODY);
    } catch {
      return this.reply(res, 400, { error: "bad request" });
    }
    const { keeper, settings } = this.d;
    const done = (extra: Record<string, unknown> = {}) => this.reply(res, 200, { ok: true, ...extra, keeper: keeper.publicState() });

    if (path === "/keeper/connect") {
      if (settings.hookFromEnv) return this.reply(res, 409, { error: "BEEKEEPER_WEBHOOK_URL is set in this server's environment. Change it there." });
      const p = ConnectReq.safeParse(body);
      const hookUrl = p.success ? parseHookUrl(p.data.hookUrl) : null;
      if (!p.success || !hookUrl) return this.reply(res, 400, { error: "That is not a hook URL. Copy the Catch Hook URL from step 1 of your Zap. It starts with https://." });
      let publicUrl: string | undefined;
      if (!settings.publicUrlFromEnv) {
        const given = parsePublicUrl(p.data.publicUrl);
        if (!given) return this.reply(res, 400, { error: "This page's address is missing or not valid. Open the dashboard on its public address and connect again." });
        if (isPrivateAddress(given)) return this.reply(res, 400, { error: "Zapier cannot reach this address. Open the dashboard on its public address (your server's IP or domain) and connect again." });
        publicUrl = given;
      }
      settings.connect(hookUrl, publicUrl);
      keeper.reconfigured();
      this.scorecardCache = null;
      log.info("beekeeper connected from the dashboard");
      return done();
    }
    if (path === "/keeper/disconnect") {
      if (settings.hookFromEnv) return this.reply(res, 409, { error: "BEEKEEPER_WEBHOOK_URL is set in this server's environment. Remove it there to disconnect." });
      settings.disconnect();
      keeper.reconfigured();
      this.scorecardCache = null;
      log.info("beekeeper disconnected from the dashboard");
      return done();
    }
    if (path === "/keeper/round") {
      if (!keeper.enabled) return this.reply(res, 409, { error: "The Beekeeper is not connected." });
      if (keeper.busy()) return this.reply(res, 409, { error: "A round is already running. Give him a few minutes." });
      const round = await keeper.start("manual", "The owner asked for a round.");
      if (round === null) return this.reply(res, 409, { error: "No round was started. The experiment may be closing. See the engine's log." });
      return done({ round });
    }
    // /keeper/rollback
    const p = RollbackReq.safeParse(body);
    if (!p.success) return this.reply(res, 400, { error: "Name the bee: bee1, bee2 or bee3." });
    const r = this.d.door.rollback({ bee: p.data.bee, reason: OWNER_UNDO_REASON });
    if (r.status === 409) return this.reply(res, 409, { error: `${this.d.name(p.data.bee)} has no Beekeeper rewrite to undo.` });
    if (r.status !== 200) return this.reply(res, r.status, r.body);
    this.scorecardCache = null;
    const restored = (r.body as { overlay: unknown }).overlay === null ? "owner" : "previous";
    log.info("beekeeper rewrite undone by the owner", { bee: p.data.bee, restored });
    return done({ bee: p.data.bee, restored });
  }

  private reply(res: ServerResponse, status: number, body: unknown): true {
    send(res, status, body);
    return true;
  }
}
