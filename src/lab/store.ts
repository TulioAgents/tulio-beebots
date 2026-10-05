// The Beekeeper's rewrites ("overlays"), kept in the engine's own database with full history. The current overlay of a
// bee is a replay of its history: every "set" pushes a new overlay, every "rollback" pops back to the one before it
// (or to none, which means the owner's own rules). The door (lab/door.ts) is the only writer.
import type { BeeId } from "../config.js";
import { BEES } from "../config.js";
import type { Db } from "../db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lab_overlays (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, action TEXT NOT NULL,
  rules TEXT, coins_json TEXT, reason TEXT NOT NULL, metrics_json TEXT,
  -- For a rollback: the id of the set it undid, and the id it went back to (NULL = no overlay).
  undid INTEGER, restored INTEGER
);
CREATE INDEX IF NOT EXISTS lab_overlays_bee ON lab_overlays(bee, id);
`;

export interface Overlay {
  /** The id of the "set" history entry that made it. */
  id: number;
  bee: BeeId;
  rules: string;
  coins: string[];
  reason: string;
  updatedAt: number;
}

export interface HistoryEntry {
  id: number;
  ts: number;
  bee: BeeId;
  action: "set" | "rollback";
  rules: string | null;
  coins: string[] | null;
  reason: string;
  metrics: unknown;
  undid: number | null;
  restored: number | null;
}

interface Row {
  id: number;
  ts: number;
  bee: string;
  action: string;
  rules: string | null;
  coins_json: string | null;
  reason: string;
  metrics_json: string | null;
  undid: number | null;
  restored: number | null;
}

const toEntry = (r: Row): HistoryEntry => ({
  id: r.id,
  ts: r.ts,
  bee: r.bee as BeeId,
  action: r.action as "set" | "rollback",
  rules: r.rules,
  coins: r.coins_json ? (JSON.parse(r.coins_json) as string[]) : null,
  reason: r.reason,
  metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
  undid: r.undid,
  restored: r.restored,
});

export class LabStore {
  /** Bumped on every change, so the engine knows to rebuild the bee's brain on its next tick. */
  version = 0;
  private current = {} as Record<BeeId, Overlay | null>;
  private stacks = {} as Record<BeeId, number[]>;

  constructor(private db: Db) {
    db.raw.exec(SCHEMA);
    this.reload();
  }

  private reload(): void {
    const rows = this.db.raw.prepare(`SELECT * FROM lab_overlays ORDER BY id`).all() as unknown as Row[];
    const byId = new Map<number, Row>();
    for (const id of BEES) this.stacks[id] = [];
    for (const r of rows) {
      byId.set(r.id, r);
      const st = this.stacks[r.bee as BeeId];
      if (!st) continue;
      if (r.action === "set") st.push(r.id);
      else if (r.action === "rollback") st.pop();
    }
    for (const id of BEES) {
      const top = this.stacks[id].at(-1);
      const r = top !== undefined ? byId.get(top) : undefined;
      this.current[id] = r ? { id: r.id, bee: id, rules: r.rules ?? "", coins: r.coins_json ? (JSON.parse(r.coins_json) as string[]) : [], reason: r.reason, updatedAt: r.ts } : null;
    }
    this.version++;
  }

  overlay(bee: BeeId): Overlay | null {
    return this.current[bee] ?? null;
  }

  overlays(): Record<BeeId, Overlay | null> {
    return Object.fromEntries(BEES.map((b) => [b, this.overlay(b)])) as Record<BeeId, Overlay | null>;
  }

  /** Time of the bee's last change (set or rollback), or null. */
  lastChangeAt(bee: BeeId): number | null {
    const r = this.db.raw.prepare(`SELECT MAX(ts) AS ts FROM lab_overlays WHERE bee = ?`).get(bee) as { ts: number | null };
    return r.ts ?? null;
  }

  set(bee: BeeId, rules: string, coins: string[], reason: string, metrics: unknown, ts: number): Overlay {
    this.db.raw
      .prepare(`INSERT INTO lab_overlays (ts, bee, action, rules, coins_json, reason, metrics_json) VALUES (?,?,?,?,?,?,?)`)
      .run(ts, bee, "set", rules, JSON.stringify(coins), reason, metrics === undefined ? null : JSON.stringify(metrics));
    this.reload();
    return this.current[bee]!;
  }

  /** Back to the overlay before the current one (or none). Returns null when there is nothing to roll back. */
  rollback(bee: BeeId, reason: string, ts: number): { undid: number; restored: Overlay | null } | null {
    const st = this.stacks[bee];
    const undid = st.at(-1);
    if (undid === undefined) return null;
    const restored = st.length > 1 ? st[st.length - 2]! : null;
    this.db.raw
      .prepare(`INSERT INTO lab_overlays (ts, bee, action, reason, undid, restored) VALUES (?,?,?,?,?,?)`)
      .run(ts, bee, "rollback", reason, undid, restored);
    this.reload();
    return { undid, restored: this.current[bee] };
  }

  /**
   * Drop every overlay that was made before `ts` (the owner ran Setup again since: the new rules stand). Bees whose
   * current overlay is newer are left alone. Returns the bees that went back to their owner's rules.
   */
  dropBefore(ts: number, reason: string, now: number): BeeId[] {
    const dropped: BeeId[] = [];
    for (const bee of BEES) {
      const o = this.current[bee];
      if (!o || o.updatedAt >= ts) continue;
      while (this.rollback(bee, reason, now)) {
        /* one step back at a time, so the history shows each rewrite undone */
      }
      dropped.push(bee);
    }
    return dropped;
  }

  history(n = 50): HistoryEntry[] {
    const rows = this.db.raw.prepare(`SELECT * FROM lab_overlays ORDER BY id DESC LIMIT ?`).all(n) as unknown as Row[];
    return rows.map(toEntry);
  }
}
