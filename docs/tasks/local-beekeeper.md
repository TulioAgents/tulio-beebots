# Local Beekeeper — Tasks

> Closes the seven requirements the spec audit found unmet while `docs/ears/local-beekeeper.md` marked all
> nine units IMPLEMENTED. Units 2, 5, 6 and 8 are met and have no stories here. The audit-log spec
> (`docs/ears/beekeeper-audit-log.md`) is met in full and is touched only as a read-only authority in 7.1.
>
> Every unmet requirement lives in `src/tools/beekeep.ts`, which nothing imports and no test covers. That is
> the shape of this plan: 0.1 makes the wiring testable, then each story closes one requirement with a test
> that would have caught it.

## Unit 0: Testable wiring

- [ ] 0.1 Move record-building and the failure alert into coach.ts (est: ~25m) (mutex: round-record)
  - why: `src/tools/beekeep.ts` is a bare top-level ESM script imported by nothing, so the record append
    (`:143`), the alert (`:157-163`) and the pre-flight `die()` paths cannot be asserted on. Every story
    below needs to prove behaviour that currently lives only in that file. Extracting the pure parts into
    `src/coach.ts` matches the split the LLD already relies on — tested logic in `coach.ts`, wiring in the
    tool — rather than inventing a new boundary.
  - acceptance: no EARS requirement of its own; it is the precondition for verifying R-1.4, R-3.7, R-9.1,
    R-9.3 and R-9.4. `beekeep.ts` keeps only argv, env, file I/O and process exit; `roundRecord()` and the
    consecutive-failure check become importable pure functions.
  - verify: `test/beekeep.test.ts` exists and imports from `src/coach.js`; `pnpm typecheck` clean;
    `pnpm vitest run` still green with no change to `test/coach.test.ts` (540 → 549).
  - landed:

## Unit 4: Writing new rules

- [ ] 4.1 Reject a CLI response missing any of the six required fields (est: ~25m)
  - why: `src/tools/beekeep.ts:121` validates only `rules` and `reason`. A response missing `coins` reaches
    `tidyCoins`, whose `raw.split` (`src/coach.ts:107`) throws a TypeError from `buildPayload` — called
    outside any try at `src/coach.ts:227` — so the process dies on an unhandled rejection with no record and
    no reason. A response missing `idea` or `quip` is worse: `collapse(String(undefined))` yields the literal
    text `"undefined"`, which is then signed and delivered to the door as a real rewrite.
  - acceptance: R-4.6 — IF the tool's output is absent, unparseable, or missing a required field, THE SYSTEM
    SHALL abandon the round with a recorded reason and SHALL NOT deliver a partial rewrite. All six fields
    named in R-4.2 (`idea`, `rules`, `coins`, `reason`, `quip`, `note`) are checked before `buildPayload`.
  - verify: a test per missing field asserts `kind: "failed"` with a reason naming the field, and asserts the
    door received no request. No input reaches `tidyCoins` as `undefined`, and no payload field ever holds
    the string `"undefined"`.
  - landed:

## Unit 9: Auditability liveness

- [ ] 9.1 Record the trigger and every answer Jev gave (deps: 0.1, est: ~30m) (mutex: round-record)
  - why: `Outcome` (`src/coach.ts:76-84`) carries no verdict fields, so the record built at
    `src/tools/beekeep.ts:143` never writes `broken`, `brokenConfidence`, `beeConfidence`, `anger` or
    `angerConfidence`. R-3.7 names the broken answer specifically, and it is the one answer that gates
    nothing — which is exactly why it is worthless unless recorded. There is also no trigger field at all, so
    a cron round and a `make beekeep` round are indistinguishable after the fact.
  - acceptance: R-3.7 — THE SYSTEM SHALL record the broken answer for audit without letting it gate the
    round. R-9.1 — WHEN a round ends, THE SYSTEM SHALL record its trigger, every answer, the chosen bee, the
    generated fields, the arm taken and the delivery outcome.
  - verify: a test asserts the record of a quiet round and of a delivered round each carry all five verdict
    fields plus a trigger; a test asserts `broken: "no"` still reaches the CLI (it must not become a gate);
    R-9.5 holds — assert no record contains `LAB_SECRET` or an `x-lab-sig` value.
  - landed:

- [ ] 9.2 Record the ruleset version replaced and the one installed or withheld (deps: 7.1, 9.1, est: ~25m) (mutex: round-record)
  - why: `grep ruleset src/coach.ts src/tools/beekeep.ts` returns nothing. A delivered round records only
    `overlayId`; a withheld round records no version at all. The withheld arm is the comparison baseline the
    whole three-month programme rests on, and the ruleset version is its join key against the `decisions`
    table — without it the control arm produces rules nobody can match to anything. The audit-log LLD already
    establishes that this cannot be reconstructed later because the overlay stack moves underneath.
  - acceptance: R-7.3 — WHEN a round is withheld, THE SYSTEM SHALL record the full generated rules and the
    ruleset version they would have produced. R-9.3 — THE SYSTEM SHALL record the ruleset version a rewrite
    replaced and the one it installed or would have installed.
  - verify: a test asserts both arms record `replacedVersion` and `installedVersion`; an integration test
    against the real door asserts the version a delivered round recorded equals the `rules_version` the
    engine then stamps on that bee's next decision row. R-7.2/R-7.6 still hold — the preview is called before
    `pickArm`, so a test asserts both arms make the identical preview call.
  - landed:

- [ ] 9.3 Alert on consecutive rounds that could not run, including pre-flight failures (deps: 1.1, est: ~20m) (mutex: round-record)
  - why: the alert at `src/tools/beekeep.ts:157-163` counts `kind === "failed"` lines in the record file. The
    failures that persist across every single cron tick — a missing `TYPESAFE_API_KEY`, a deleted prompt
    template — currently write no line at all, so the one condition the alert exists to catch is the one
    condition it cannot see. This is the liveness hole behind R-1.3's rationale: a coach that dies quietly
    looks exactly like a coach with nothing to say.
  - acceptance: R-9.4 — WHEN a configured number of consecutive rounds could not run, THE SYSTEM SHALL raise
    an alert. Pre-flight failures count toward `alertAfterFailures`; a quiet round does not.
  - verify: a test seeds `alertAfterFailures` records of pre-flight failures and asserts the alert fires; a
    test interleaves one quiet round and asserts it does not; a test asserts the alert does not fire at
    `n - 1`.
  - landed:

## Unit 1: Round execution

- [ ] 1.1 Record a round that ends before the round loop starts (deps: 0.1, 9.1, est: ~25m) (mutex: round-record)
  - why: five `die()` paths (`src/tools/beekeep.ts:31,33,37,39,40`) end a round with stderr and an exit code
    only — invalid config, `LAB_SECRET` missing or short, `TYPESAFE_API_KEY` missing, prompt file missing.
    R-1.4 says "for any reason", and R-1.5's distinction between a round that chose to do nothing and one
    that could not run is unusable if the second kind is sometimes invisible. A missing config file is the
    honest exception: `recordFile` is defined inside it, so there is nowhere to write. The other four have
    `cfg.recordFile` already loaded.
  - acceptance: R-1.4 — WHEN a round ends for any reason, THE SYSTEM SHALL record its outcome and the reason
    for it. R-1.5 — THE SYSTEM SHALL distinguish, in that record, a round that chose to do nothing from a
    round that could not run. Scope: the four `die()` paths reached after the config parses. A missing or
    invalid config file keeps stderr-and-exit, documented in the LLD as the one unrecordable case.
  - verify: a test per path asserts one `kind: "failed"` record with a reason naming the cause, and asserts
    exit 1 (R-1.2); a test asserts the `LAB_SECRET` path records nothing resembling the secret (R-1.6) and is
    never recorded as quiet (R-1.3).
  - landed:

## Unit 7: Control arm

- [ ] 7.1 Expose a read-only ruleset-version preview from the engine (est: ~35m) (mutex: engine-hash)
  - why: the version is the first 16 hex of sha256 over the composed `brain.strategy` (`src/engine.ts:44`), a
    string the coach never sees — it is built from the style's base strategy compiled into `src/bees/*`,
    which the LLD puts out of scope for the coach to know. `liveRules` (`src/lab/brain.ts:36`) and
    `customBrain` are pure, so the engine can answer "what version would these rules produce" without
    installing anything. The hash must be extracted to one shared function: two copies would drift silently
    and every attribution figure in `make rules-report` would quietly stop joining.
  - acceptance: beekeeper-audit-log R-1.1 — the preview returns the identical value the engine stamps for the
    same composed strategy. R-7.4 — WHEN a round is withheld, THE SYSTEM SHALL make no request that changes
    engine state: the endpoint is read-only, installs no overlay, rebuilds no brain, and leaves the
    `RULES_VERSIONS` cache untouched (audit-log R-1.3).
  - verify: a test asserts preview output equals the `rules_version` the engine writes after the same rules
    land for real; a test asserts calling the preview leaves `rulesets`, `decisions` and the bee's live rules
    unchanged, and does not perturb the WeakMap cache; `pnpm vitest run test/keeper-http.test.ts` passes.
  - landed:

## Not in this plan

Units 2, 5, 6 and 8 are met. R-4.5 infers "used a capability beyond structured output" from
`permission_denials.length`, which reports denied rather than granted use — adequate while `--tools
StructuredOutput` is pinned in code, and not worth a story until that pin moves. The spec headers in
`docs/ears/local-beekeeper.md` claim all nine units IMPLEMENTED and should be corrected to match reality as
each story lands, not before.
