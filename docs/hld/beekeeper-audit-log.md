# Beekeeper Audit Log — High-Level Design

## Overview

Every Jev decision is already recorded before it is acted on, but a decision row does not say which ruleset
produced it. That single missing field makes the question "did the Beekeeper's rewrite actually help?"
unanswerable. This change stamps each decision with a ruleset identity, keeps the ruleset text once, and
exports two JSONL files for offline adversarial validation: one line per decision, and one line per rules
change joined to its outcome.

## Stakeholders & Impact

| Who | Pain today | After this ships |
|---|---|---|
| Hive owner (single, local operator) | Can see that a bee's rules changed and that P&L moved, but cannot attribute one to the other. Judging a rewrite is guesswork. | Can attribute realised P&L, trade count and decision behaviour to a specific ruleset, and compare two rulesets on identical market inputs. |
| The local Beekeeper coach (separate initiative, `local-beekeeper`) | No evidence base, so it cannot decide whether to keep or roll back its own previous rewrite. The Zapier Zap is stateless between rounds and structurally cannot do this. | Reads the rules-change export to decide rollback. |

No other consumer. This is a private, single-hive tool; it is not surfaced on the dashboard and not
documented for other beebots users.

## Goals

- Every decision row written from this change onward carries a ruleset identity.
- The realised P&L, fees, trade count and decision count of any ruleset can be computed from the database alone.
- The decision *behaviour* of two rulesets can be compared — choice mix, confidence, conviction, trade rate — not only their P&L.
- The full input, the offered menu, Jev's answer and what the risk layer did with it are all recoverable per decision.
- Rulesets whose text is already in the database before this change are reported as unknown rather than silently attributed.
- Decision history stops growing without bound on a small disk.

## Non-Goals

- **No change to the engine's safety envelope.** The strict overlay schema, the 20-hour per-bee lock, the
  10–500 character rule bound, `survivesRedact`, the coin validation and the risk layer all behave exactly
  as they do today. The only engine change is additive.
- **Not tamper-evident.** Files are exported from SQLite on demand, not appended live in the tick path.
- No log rotation, no fsync policy, no writer in the decision hot path.
- No dashboard surfacing, no HTTP endpoint, no `.env.example` entry.
- No automatic rollback. This change produces evidence; acting on it belongs to `local-beekeeper`.
- No backfill of existing decision rows.
- **No per-rewrite verdict.** With ~10 trades per 20-hour window, a single rewrite cannot be judged; see
  "Why there is no per-rewrite verdict" in the LLD. Only the pooled, controlled comparison in
  `local-beekeeper` is answerable.
- **No same-input (`state_hash`) comparison.** It cannot work — see the LLD.
- No JSONL export files. `sqlite3 -json` covers it until something needs more.

## Success Criteria

1. A decision written after this change has a non-null `rules_version`, and the text behind that version is recoverable.
2. `rules_version` changes when, and only when, the composed strategy string changes — including an owner edit made through Setup, not just a Beekeeper overlay.
3. A single SQL query returns per-ruleset decisions, fills, realised USD and fees.
4. The rules-change export carries, for each change: the previous and next ruleset text, the originating round, and a before/after window.
5. The rules-change export reports how many decisions shared an identical input state across the two rulesets, and how many of those produced a different choice.
6. An existing database with a populated `decisions` table opens and runs without error or data loss.
7. `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass.
