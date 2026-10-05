# Beekeeper Audit Log — Low-Level Design

> Revised after the `uncle-senior` review (verdict: Reconsider Approach) and the pre-mortem.
> The engine-side work below is **implemented and green**: `pnpm typecheck`, `pnpm lint`, 514 tests.

## Architecture

```
module-level WeakMap<BeeBrain, string>          [src/engine.ts]
  └─ rulesVersionOf(brain) = sha256(brain.strategy)[0..16]
     keyed on the cached brain object, so it hashes once per rules change

Engine.stamp(id, brain, now)                    [src/engine.ts, private]
  ├─ db.upsertRuleset({version, bee, firstSeen, overlayId, strategy, rules, coins})
  └─ returns {rulesVersion, overlayId}; catches everything, returns nulls on failure

Engine.decide()        -> insertDecision({..., rulesVersion, overlayId})
Engine.decideBenched() -> insertDecision({..., rulesVersion, overlayId})

Engine.start()         -> hourly db.pruneDecisionStates(now - 14d)
```

### Why the hash is NOT computed in `brain()`

`brain()` is called from nine sites in `src/engine.ts`, including `stopFor` at 456, 560 and 706. An
exception there is not a lost audit row — it is an unprotected leveraged position. The first draft of this
design put `upsertRuleset` inside `brain()`, and the pre-mortem rated that catastrophic.

A `WeakMap` keyed on the brain object gives the same "hash once per rebuild" property for free, because the
engine already caches brain objects and only replaces them on a rebuild. The lookup therefore lives in
`decide()`, where `brain` is already in hand, and `brain()` stays byte-identical. `stamp()` additionally
catches everything, so a failing audit write degrades to `rules_version: null` and the trade is unaffected.
Covered by `test/audit.test.ts` with an injected throwing `upsertRuleset`.

### Schema

```sql
decisions += rules_version TEXT, overlay_id INTEGER     -- guarded ALTER via PRAGMA table_info
CREATE INDEX decisions_rules ON decisions(bee, rules_version);

CREATE TABLE rulesets (
  version TEXT PRIMARY KEY,   -- sha256(composed strategy)[0..16]
  bee TEXT NOT NULL, first_seen INTEGER NOT NULL,
  overlay_id INTEGER,         -- NULL = owner's own rules
  strategy TEXT NOT NULL, rules TEXT, coins_json TEXT
);
```

### Retention

`decisions` had no retention at all; only `events` was pruned (3 days, `src/engine.ts:136`). At ~26k rows/day
× ~1.2 KB of `state_json` that is roughly 31 MB/day on a $9 VPS. `pruneDecisionStates` clears the **column**
past 14 days and keeps the **row**, so every per-ruleset attribution count stays correct forever while the
bulk goes away.

### Attribution query

```sql
SELECT d.bee, d.rules_version,
       COUNT(DISTINCT d.id) AS decisions, COUNT(f.id) AS fills,
       ROUND(SUM(f.realised_usd),2) AS realised_usd, ROUND(SUM(f.fee_usd),2) AS fees_usd
FROM decisions d
LEFT JOIN orders o ON o.decision_id = d.id
LEFT JOIN fills  f ON f.order_id    = o.id
GROUP BY d.bee, d.rules_version;
```

## Why there is no per-rewrite verdict

Two independent reasons, the second decisive.

**Power.** A 20-hour window holds roughly 10 trades per bee. Detecting a realistic edge (0.05–0.2 σ of
per-trade return) at that n is out of reach by about two orders of magnitude. Any `verdict` field computed
per rewrite is a random number with a vocabulary.

**Selection bias, which no amount of logging fixes.** The coach is instructed to pick the *failing* bee
(`beekeeper/jev-questions.md` step 3, filtered against `open_bees`). The before-window is therefore
conditioned on being the minimum of three draws, and regression to the mean alone produces a large positive
before/after delta **for a coach that does nothing at all** — plausibly larger than any real effect, and in
the same direction. A naive before/after comparison does not measure coaching; it measures the selection
rule.

The only unbiased comparison is a randomised control: run the full round, then deliver or withhold the
rewrite on a coin flip. Both arms are selected identically, so the bias cancels exactly. That belongs to
`local-beekeeper`; this document exists to make it measurable.

## Why the same-input (`state_hash`) comparison was dropped

Verified: `src/snapshot.ts:26-35` hashes `utc` at HH:MM resolution together with `beeLine`
(`src/bees/common.ts:52-69`), which carries `held_min`, `flat_min`, `upl_r`, `at_stop_usd`, `trades` and
`fee_left`. Every one of those moves each tick. Two decisions separated by the mandatory 20-hour gap can
never collide, so the comparison would have reported zero forever and been read as "the rewrite changed
nothing" rather than "the instrument is broken".

A market-only hash would not save it either — those columns are floats and would essentially never repeat.

The cheap substitute needs no new storage: compare the **choice distribution** per ruleset — HOLD / OPEN /
CLOSE mix, mean confidence, mean conviction, trades per hour. That answers "is this rewrite cosmetic?" in
plain SQL. It is confounded by regime for any single rewrite, but so was the original.

## Constraints

- Decision writes precede order placement ("Hard rule 10", `src/db.ts:1`). Nothing added may throw or block.
- No migration framework: `src/db.ts` ran `CREATE TABLE IF NOT EXISTS` only. Live DBs hold rows, so the two
  columns go in through a guarded `ALTER TABLE` driven by `PRAGMA table_info`.
- `node:sqlite` (`DatabaseSync`), WAL, pure ESM, `module: NodeNext`, Node ≥ 22.13.
- `src/tools/` convention: bare top-level ESM, no `main()`, no arg parser, `console.log`, exit codes.

## Key Decisions

| Decision | Why | Rejected |
|---|---|---|
| Identity = sha256 of the **composed** strategy string | Moves on an owner Setup edit too, which an overlay id alone misses | `overlay_id` as sole key |
| `WeakMap` keyed on the brain object, looked up in `decide()` | Same "once per rebuild" guarantee without putting audit code on the `stopFor` path | `upsertRuleset` inside `brain()` |
| `stamp()` swallows every error | An audit write must never be able to affect a trade | Let it propagate |
| Ruleset text stored once in `rulesets` | ~1 KB × 26k rows/day of duplication otherwise | Denormalise per decision |
| Clear the `state_json` column, keep the row | Retains every attribution count forever while removing ~95% of the bytes | Delete whole rows |
| Forced-close and resume rows left unstamped | They carry synthetic empty state and no Jev call; they are not rules-driven | Stamp all four insert sites |
| No JSONL exports | `sqlite3 -json "<query>"` is one line and needs no code | Build File A and File B |
| No per-rewrite verdict | Underpowered and selection-biased; see above | An arithmetic verdict field |

## Deferred

**JSONL exports (File A / File B)**
*Ceiling:* analysis must happen on a machine that cannot see the SQLite file, or a consumer appears that
cannot speak SQL. *Upgrade:* `sqlite3 data/bees-*.sqlite -json "<query>" > out.json`. A weekly copy of the
`.sqlite` beats a daily 30 MB export written to the volume the engine trades from.

**Counterfactual replay**
*Ceiling:* the self-disagreement probe returns under 15%, and only then. Jev answers from a distribution, so
re-running ruleset A against A's own stored states will disagree with itself at an unknown rate; if that
rate is 18% and A-vs-B is 21%, nothing has been measured. *Upgrade:* ~80 lines re-running stored
`state_json` + `menu_json` through Jev. The 14-day retention gives 16× headroom over a 20-hour window.
*Probe first:* ~30 lines, ~400 Jev calls, ~$0.02 — re-run the same strategy text against 200 stored states
and measure self-disagreement before committing to anything.

**Full-fidelity `state_json` retention**
*Ceiling:* replay gets built, or something needs states older than 14 days. *Upgrade:* widen the window, or
ship the column to cold storage. Clearing the column rather than the row keeps attribution intact either way.

## Out of Scope

Tamper-evidence and append-only guarantees. Backfilling pre-change rows. Dashboard display. Statistical
significance testing. Acting on the evidence — that is `local-beekeeper`.
