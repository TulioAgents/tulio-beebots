# Beekeeper Audit Log — EARS Specifications

> Revised after the `uncle-senior` review. **All five units are implemented**: units 1–3 and 5 in
> `src/db.ts` and `src/engine.ts` (covered by `test/audit.test.ts`), unit 4 in `src/tools/rules-report.ts`
> (`make rules-report`). The former units 4 and 5 of the first draft — JSONL exports with a same-input
> comparison and a per-rewrite verdict — are withdrawn; see the LLD sections "Why there is no per-rewrite
> verdict" and "Why the same-input comparison was dropped".

## Unit 1: Ruleset identity — IMPLEMENTED

**Why:** A decision can only be attributed to a ruleset if that ruleset has a stable identity that moves
whenever the text Jev actually sees moves — including an owner edit through Setup, which an overlay id alone
would miss.

| ID | EARS statement |
|---|---|
| R-1.1 | THE SYSTEM SHALL derive a ruleset version as the first 16 hexadecimal characters of the SHA-256 digest of the composed `brain.strategy` string. |
| R-1.2 | WHEN the engine rebuilds a bee's brain, THE SYSTEM SHALL compute that bee's ruleset version exactly once and retain it until the next rebuild. |
| R-1.3 | WHILE a bee's brain is unchanged, THE SYSTEM SHALL NOT recompute that bee's ruleset version. |
| R-1.4 | WHEN a ruleset version is observed for the first time, THE SYSTEM SHALL persist its composed strategy text, its rules clause, its coin list, the originating overlay id, and the time first seen. |
| R-1.5 | IF a ruleset version has already been persisted, THE SYSTEM SHALL leave the stored record unchanged. |
| R-1.6 | WHERE no overlay is live for a bee, THE SYSTEM SHALL record the ruleset's overlay id as null. |
| R-1.7 | WHEN the owner changes a bee's rules through Setup without any overlay being involved, THE SYSTEM SHALL produce a different ruleset version. |
| R-1.8 | WHEN an overlay lands for one bee, THE SYSTEM SHALL change only that bee's ruleset version. |

## Unit 2: Decision attribution — IMPLEMENTED

**Why:** Attribution has to be written at the moment of the decision. Reconstructing it later is impossible
because the overlay stack moves underneath. And the write sits on the path that protects open positions, so
it must be incapable of affecting one.

| ID | EARS statement |
|---|---|
| R-2.1 | WHEN the engine records a Jev decision, THE SYSTEM SHALL store the ruleset version in force for that bee at that moment. |
| R-2.2 | WHEN the engine records a Jev decision, THE SYSTEM SHALL store the overlay id in force for that bee, or null when no overlay is live. |
| R-2.3 | THE SYSTEM SHALL write the ruleset version in the same insert as the decision, before any order derived from that decision is placed. |
| R-2.4 | IF any part of the audit write fails, THE SYSTEM SHALL record the decision with an unknown ruleset, SHALL leave every other recorded field unchanged, and SHALL NOT prevent, delay or alter the trade. |
| R-2.5 | THE SYSTEM SHALL NOT perform any audit work on the code path that computes stops, trails or forced entries. |
| R-2.6 | THE SYSTEM SHALL continue to record every field it records today, unchanged. |
| R-2.7 | WHERE a decision row represents a forced close or a resumed position rather than a rules-driven choice, THE SYSTEM MAY leave it unattributed. |

## Unit 3: Schema change safety — IMPLEMENTED

**Why:** There is no migration framework, and live databases already hold trading history.

| ID | EARS statement |
|---|---|
| R-3.1 | WHEN the database is opened, THE SYSTEM SHALL add any missing audit column to the `decisions` table without recreating the table. |
| R-3.2 | IF an audit column already exists, THE SYSTEM SHALL leave it untouched and SHALL NOT error. |
| R-3.3 | WHEN opening a database whose decision rows predate this change, THE SYSTEM SHALL preserve every existing row and column value. |
| R-3.4 | THE SYSTEM SHALL be safe to run repeatedly against the same database with no cumulative effect. |

## Unit 4: Per-ruleset report — IMPLEMENTED

**Why:** The one question the stored data can answer on its own: what did each ruleset actually do? Deliberately
reports figures and no verdict, because a per-rewrite verdict is underpowered and selection-biased.

| ID | EARS statement |
|---|---|
| R-4.1 | THE SYSTEM SHALL report, per bee and per ruleset: decision count, fill count, realised USD and fees. |
| R-4.2 | THE SYSTEM SHALL report, per ruleset, the distribution of choices taken, the mean confidence and the mean conviction. |
| R-4.3 | THE SYSTEM SHALL show the rules text behind each ruleset version. |
| R-4.4 | IF decisions carry no ruleset version because they predate attribution, THE SYSTEM SHALL group them under an explicit unknown heading and SHALL NOT attribute them to any ruleset. |
| R-4.5 | THE SYSTEM SHALL NOT state or imply whether a ruleset performed better than another. |
| R-4.6 | THE SYSTEM SHALL read only from the database and SHALL NOT write to it. |
| R-4.7 | THE SYSTEM SHALL require no API key, place no network call and spend nothing. |
| R-4.8 | IF the database is missing or unreadable, THE SYSTEM SHALL exit non-zero with a readable message. |

## Unit 5: Retention — IMPLEMENTED

**Why:** `decisions` was never pruned at all. At ~31 MB/day on a small disk, the volume the engine needs in
order to keep trading runs out. The attribution counts must survive the clean-up.

| ID | EARS statement |
|---|---|
| R-5.1 | WHILE the engine is running, THE SYSTEM SHALL periodically clear the stored input snapshot of decisions older than the retention window. |
| R-5.2 | WHEN clearing an old snapshot, THE SYSTEM SHALL keep the decision row and every other column on it. |
| R-5.3 | THE SYSTEM SHALL leave per-ruleset attribution counts unaffected by retention. |
| R-5.4 | THE SYSTEM SHALL retain input snapshots for at least as long as any comparison window that depends on them. |
