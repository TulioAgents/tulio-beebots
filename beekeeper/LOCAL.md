# The Beekeeper, locally

No Zapier, no public address, no webhook. A cron job on the same machine as the engine reads the scorecard,
asks Jev which bee is broken, has a local `claude` write new rules, and then **flips a coin**: half the time
it delivers them, half the time it writes them down and sends nothing.

The coin flip is not a safety feature. It is the only way to find out whether coaching works at all. Read
"Why the coin flip" below before you turn it off.

## What you need

| | |
|---|---|
| `LAB_SECRET` in `.env` | 32+ characters. This is what opens the engine's lab door. Generate one with `openssl rand -hex 24`. |
| `TYPESAFE_API_KEY` in `.env` | Jev answers the three questions. |
| `claude` on `PATH` | Writes the rules. Already installed if you use Claude Code. |
| The engine running | On `127.0.0.1:8080` by default. |
| Node >= 22.13 | `make` handles this; raw `pnpm` does not. |

Setting `LAB_SECRET` also opens `/lab/rollback`, `/lab/round` and `/lab/state` to anything that can sign with
it. On a single-operator machine that is the point; do not put it on a shared host.

## Set it up

```bash
cp beekeeper/coach.example.json beekeeper/coach.json
$EDITOR beekeeper/coach.json
make beekeep                     # one round, right now
```

`coach.json`:

| field | what it does |
|---|---|
| `engineUrl` | where the engine listens |
| `cli`, `model` | which local CLI writes the rules, and with which model |
| `confidenceFloor` | below this, Jev's answer counts as unsure and the round stops |
| `cliTimeoutMs` | how long to wait for the rules |
| `controlArm` | `true` = flip a coin. `false` = always deliver, and give up on measuring anything |
| `promptFile` | the rules-writing prompt, with `{{bee}} {{anger}} {{playbook}} {{scorecard}} {{universe}}` |
| `recordFile` | one JSON object per round, appended |
| `alertAfterFailures` | shout after this many consecutive rounds that could not run |

**The file is re-read at the start of every round.** Edit it between rounds and the next one picks it up —
no restart, no rebuild. Nothing in it can put rules in front of a bee: everything still goes through
`/lab/overlay` and all of the engine's checks.

Keep no secrets in it. `LAB_SECRET` and `TYPESAFE_API_KEY` come from the environment.

## Run it on a schedule

The engine's own Beekeeper cadence defaults to every 4 hours, so match it:

```cron
0 */4 * * * cd /path/to/tulio-beebots && /usr/bin/make beekeep ARGS="--trigger cron" >> /path/to/beekeep.log 2>&1
```

`--trigger cron` (or `COACH_TRIGGER=cron`) is what lets a later read tell scheduled rounds from the ones you
ran by hand while debugging. Without it the round records `trigger: "manual"`, which is what `make beekeep`
on its own honestly is.

Exit codes are meaningful: **0** means the round reached a decision (delivered, withheld, or deliberately
left them alone). **1** means it could not run. A coach that dies quietly looks exactly like a coach with
nothing to say, which is why those are different.

## Read what happened

Four outcomes land in `recordFile`:

| `kind` | means |
|---|---|
| `delivered` | new rules are live; the bee trades them on its next tick |
| `withheld` | the control arm. Rules were written and deliberately not sent |
| `quiet` | the round ran and chose to change nothing (no open bee, Jev said none, or Jev was unsure) |
| `failed` | the round could not run. Not the same as `quiet` |

```bash
jq -r '[.at, .kind, (.bee // "-"), (.reason // .rules.idea)] | @tsv' data/beekeeper-rounds.jsonl | column -t
jq -r 'select(.kind=="failed") | .reason' data/beekeeper-rounds.jsonl | sort | uniq -c
```

A `delivered` or `withheld` round also records `replacedVersion` and `installedVersion`: the ruleset the bee
was running when the round started, and the one those rules produce (for a withheld round, the one they
*would* have produced). That is the join key into the report below — without it a withheld round's rules
match nothing. Both are `null` when the engine could not be asked, which never stops the round.

Then, per ruleset, what the bees actually did:

```bash
make rules-report ARGS="--since 7d"
```

## Why the coin flip

The round is told to pick the **failing** bee. That means the bee's "before" window is, by construction, the
worst of three — and a bad run tends to be followed by a less bad one whatever you do. So a coach that
changes nothing at all still shows a positive before/after swing, plausibly bigger than any real effect.

Comparing *delivered* against *withheld* removes that, because both arms were picked by the identical rule
and differ only in whether the rules were sent. Comparing before against after does not.

At one rewrite per bee per 20 hours you get roughly 10 trades per window, which is nowhere near enough to
judge a single rewrite — so don't. The question worth asking is the pooled one: across ~20 delivered and
~20 withheld rounds, did delivering help? That is about a month of rounds.

Setting `controlArm: false` is recorded in every round, so a later read can exclude the uncontrolled period
instead of being silently poisoned by it.

## When it does nothing

- **"no bee is open for a rewrite"** — all three are retired or inside their 20-hour lock. Normal; most
  rounds end here.
- **"Jev was not confident enough"** — below `confidenceFloor`. Lower it only if you want more rewrites.
- **"the door refused the rewrite: 429"** — the 20-hour lock. The engine counts a rollback too.
- **"could not run" repeatedly** — usually `claude` needing a login in a headless shell, or its flags moving
  under an auto-update. Check the log; `alertAfterFailures` exists for exactly this.

## What it cannot do

Rules text and a coin list, for one bee, once per 20 hours. That is the whole surface. Leverage, stops,
sizing, trade caps, the daily loss stop, retirement, the live ramp and the mode are all code the coach
cannot reach, and the engine re-checks everything at the door regardless of what the coach sends. Rollback
is deliberately not automated yet — see `docs/lld/local-beekeeper.md`.
