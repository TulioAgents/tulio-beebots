# Local Beekeeper — High-Level Design

> Revised after the `uncle-senior` review (verdict: Reconsider Approach). The headline change: the point of
> this work is no longer "run the coach locally" but "find out whether the coach helps at all", and that
> requires a randomised control arm that the first draft did not have.

## Overview

The Beekeeper is the outside coach that reads all three bees every few hours and may rewrite one bee's
rules. Today it is a nine-step Zapier Zap needing a paid plan, a public HTTPS address and a webhook round
key. This change replaces it with a cron-triggered script on the same machine: read the engine's scorecard,
pick a bee, ask a local `claude` CLI to write new rules, and — on a coin flip — either deliver them to the
engine's signed lab door or record them as withheld.

The coin flip is the point. Without it there is no way to tell a coach that works from a coach that does
nothing, because the coach is instructed to pick the *worst* bee and regression to the mean alone makes a
do-nothing coach look effective.

## Stakeholders & Impact

| Who | Pain today | After this ships |
|---|---|---|
| Hive owner (single, local operator) | Needs a paid Zapier plan with Premium AI models and an engine reachable from the public internet — `docs/BEEKEEPER.md:16-23` says a laptop copy does not qualify. Coaching logic lives in a web UI, not the repo. And there is no way to know whether any of it helps. | Runs the whole loop locally against `127.0.0.1`. After ~40 rounds, has an unbiased answer to whether coaching beats not coaching. |
| The engine | Accepts rewrites from an external automation over a 15-minute round key. | Unchanged. Accepts rewrites from a local script over `LAB_SECRET`, through the same door with the same validation. |

Single operator, local only. Not shipped to other beebots users, not on the dashboard, not in
`docs/BEEKEEPER.md`.

## Goals

- A round runs end to end with no Zapier account and no public address.
- Every round is assigned at random to **deliver** or **withhold**, and both arms are recorded identically.
- After enough rounds, the pooled difference between delivered and withheld answers one question:
  does coaching help?
- A round either delivers one accepted rewrite, records one withheld rewrite, or records why it did neither.
- Coaching configuration takes effect on the next round with no restart, rebuild or recompile.
- A round that could not run is distinguishable from a round that chose to do nothing.

## Non-Goals

- **No change to the engine's safety envelope.** Strict overlay schema, 20-hour lock, 10–500 character rule
  bound, `survivesRedact`, live-coin check and the whole risk layer behave exactly as today. The coach is an
  untrusted client of a door that already exists.
- **No bypass of `/lab/overlay`.** Editing a config file must never put rules in front of Jev without
  passing the door's validation.
- **No pnpm workspace and no long-running service.** Package layout is not a trust boundary; HMAC plus the
  strict schema at the door is. A fresh process per round also re-reads config by definition, which is
  better hot-reload than a warm one.
- **No second CLI adapter yet.** One operator, one machine; the CLI call stays behind one function so a
  second can be added against a verified invocation rather than a guessed interface.
- **No automatic rollback on a P&L threshold.** That statistic carries the selection bias this design exists
  to control for, and a false rollback burns the bee's 20-hour window.
- No Zapier parity, no public exposure, no dashboard, no multi-tenant support.
- No change to how rules reach Jev at runtime — that path already works and already hot-reloads.

## Success Criteria

1. With the Zap disconnected and no `BEEKEEPER_WEBHOOK_URL` set, a cron-triggered round completes and is recorded.
2. Across many rounds, delivered and withheld are each about half, and both carry the full generated rules.
3. A delivered round results in a `200` from `/lab/overlay` and the bee trades the new rules on its next tick.
4. A withheld round changes nothing about the engine, and is distinguishable in the record from a round that picked no bee.
5. A round that picks no bee, or picks a locked bee, completes without calling the rules-writing model.
6. Editing the config file between two rounds changes the second round's behaviour with no process restart.
7. Rules that would be rejected by the door are corrected locally or the round is abandoned with a recorded reason — the door never sees an avoidable `400`.
8. Consecutive rounds that could not run raise an alert rather than looking like quiet rounds.
9. Every round's ruleset version, delivered or withheld, is recoverable against the audit evidence from `beekeeper-audit-log`.
