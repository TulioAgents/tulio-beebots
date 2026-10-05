# Local Beekeeper — Low-Level Design

> Revised after the `uncle-senior` review. Dropped from the first draft: the pnpm workspace, the
> long-running HTTP service, the health endpoint, the concurrency guard, the two-CLI adapter, and
> threshold-based automatic rollback. Added: a randomised control arm.

## Architecture

One cron-triggered script. No service, no new package.

```
cron ──▶ pnpm beekeep         (src/tools/beekeep.ts, bare top-level ESM)
           │
           │ 1. read config file                     fresh process = hot reload, no watcher
           │ 2. GET  <engine>/keeper/scorecard        unauthenticated, loopback
           │ 3. Jev: broken? / which bee? / anger?    @typesafe-ai/sdk, already a dependency
           │ 4. filter: bee not none|unsure AND bee in open_bees
           │ 5. claude -p --json-schema ...           behind one function
           │ 6. sanitise: ASCII, collapse, clamp, coins, survivesRedact pre-check
           │ 7. COIN FLIP ───────────────┬── deliver:  HMAC(LAB_SECRET) ─▶ POST /lab/overlay
           │                             └── withhold: record only, engine untouched
           └─ 8. append one round record either way
```

### Why a script and not a service

The first draft proposed a pnpm workspace plus a loopback HTTP service on its own port. Both were cut.

- **The workspace moves no trust boundary.** The property that makes this safe is that the coach is an
  untrusted client of a validated door — enforced by HMAC, the strict Zod schema, and the 20-hour lock in
  `src/lab/door.ts`. A second package on the same machine, same OS user, holding the same `LAB_SECRET`, is
  exactly as trusted as a script in `src/tools/`. The draft conflated *separate package* with *separate
  process*; cron already gives the latter.
- **The service's own justification was backwards.** It claimed a warm process was needed so config could
  be read per round. A fresh process re-reads config by definition — strictly better, with no watcher and
  no staleness.
- Everything the service cost existed only because it was long-running: an HTTP endpoint, a loopback bind,
  a concurrency refusal, a health endpoint. All gone. Use `flock` if overlap ever becomes real.

The coach needs zero new dependencies: `node:crypto`, `fetch`, `node:child_process`, and
`@typesafe-ai/sdk` which is already at `package.json:37`.

### The control arm

```
run the full round — scorecard, bee pick, CLI call, sanitation — then:
  if (coinFlip()) deliver  else  record { delivered: false, rules, version }
```

Both arms are selected by the identical rule (worst bee, same anger threshold, same filter), so the
selection bias cancels exactly when the two arms are compared. Comparing delivered-vs-withheld on the
following window is unbiased; comparing before-vs-after within a single rewrite is not, and no amount of
logging fixes that. See `docs/lld/beekeeper-audit-log.md`, "Why there is no per-rewrite verdict".

Cost: one coin flip and a `delivered` field. Benefit: the three-month programme answers its question
instead of producing 90 uninterpretable deltas.

### Engine-side contract the coach must satisfy

All verified; all enforced server-side regardless of what the coach does.

| Constraint | Source |
|---|---|
| `LAB_SECRET` at least 32 characters, or the door ignores it | `src/lab/door.ts:24`, `src/index.ts:210` |
| `x-lab-ts` unix ms within ±5 minutes; `x-lab-sig` = hex HMAC-SHA256 over `` `${ts}.${METHOD}.${path}.${body}` `` | `src/lab/door.ts:106-126` |
| Each signature works once | `src/lab/door.ts:128-135` |
| Body is strict — only `bee`, `rules`, `coins`, `reason`, `metrics` | `src/lab/door.ts:66-75` |
| `rules` 10–500 chars **after** whitespace collapse | `src/lab/door.ts:176-177` |
| `reason` non-empty after trim, ≤300 | `src/lab/door.ts:71` |
| `coins` ≤20, uppercased, every one a live crypto X-Perp | `src/lab/door.ts:178-182` |
| `rules`, `reason`, `metrics` must survive `redact()` byte-identical | `src/lab/door.ts:184-186` |
| One overlay per bee per 20 hours; a rollback counts | `src/lab/door.ts:27`, `src/lab/store.ts:106-109` |
| `/keeper/scorecard` unauthenticated, 10 s cached | `src/keeper-http.ts:173-189` |

Runtime: pure ESM, `module: NodeNext`, Node ≥ 22.13. Child-process precedent is `src/okx/cli.ts:93-99` —
`execFile`, minimal env, timeout, `maxBuffer`, `JSON.parse` of stdout, stderr through `redactString`.

### CLI invocation

Verified on this machine (claude 2.1.263):

```
claude -p --output-format json --json-schema <schema> --tools "StructuredOutput" --model <model>
  → parse .structured_output
```

`--tools ""` must not be used: it disables the internal StructuredOutput tool and the model answers in
prose. Pinning `--tools` is also the mitigation for pre-mortem risk 3 — Hive text written by strangers
(`src/keeper.ts:572`) reaches this prompt, and the tool set must never come from config.

## Key Decisions

| Decision | Why | Rejected |
|---|---|---|
| Randomised deliver/withhold | The only unbiased way to answer "does coaching help". Costs one bit. | Before/after P&L per rewrite |
| Seam B (`LAB_SECRET`), not the round webhook | Needs no public HTTPS. `BEEKEEPER_WEBHOOK_URL` must be `https://` (`src/config.ts:246`) and the public URL may not be private (`src/keeper-http.ts:57-65`), so the webhook cannot work against `127.0.0.1`. `src/lab/door.ts:10-12` documents `LAB_SECRET` as exactly this hatch. | A local HTTPS tunnel |
| `src/tools/beekeep.ts`, cron, no service | Matches the nine existing tools; removes four requirements that existed only to support a warm process | Workspace + HTTP service |
| One CLI, behind one function | Two operators' worth of flexibility for one operator. The draft's own table shows codex and claude need different sanitising, so "switching changes nothing else" was already false. | Two-CLI adapter now |
| `claude`, not `codex` | `claude -p` with pinned `--tools` is where the prompt-injection mitigation is expressible; `codex exec` keeps shell access even under `--sandbox read-only` | codex |
| Config read fresh each round | Hot reload for free. The round boundary is the only safe point to pick up a change. | `fs.watch`, SIGHUP, restart |
| Config never bypasses `/lab/overlay` | The Q4 invariant. A file-driven rules path skips the strict schema, the lock, the coin check and `survivesRedact`. | Engine reads rules from a file |
| Reuse `@typesafe-ai/sdk` for the three questions | Already a dependency; `choice()`/`score()` (`src/jev.ts:111-121`) are exactly the primitives, `unsure` included. Costs ~18 calls/day against ~26k trading decisions — about 0.1%. | Fold the pick into the CLI call |
| Sanitise before signing | Verified necessary: codex emitted non-ASCII against an explicit instruction, and a schema cannot express a charset. The door does not check charset either. | Trust the schema |
| Reject locally what the door would reject | A `400` burns the round and the bee's 20-hour window | Let the door arbitrate |
| Hard-fail on a missing `LAB_SECRET` | A coach that quietly does nothing is indistinguishable from one that chose to | Warn and continue |
| A pre-flight failure records; a config that will not parse does not | `preflightFailure` (`src/coach.ts`) runs with a validated config, so a missing `LAB_SECRET`, key or prompt template appends a `failed` round and the liveness alert can finally see the failures that repeat on every tick. A config that is missing or invalid is the one unrecordable case: `recordFile` is a field inside it, and there is no honest `cli`, `model` or `control` for a line either. stderr and exit 1 is the whole behaviour there | Record every path, reading `recordFile` out of a config that did not validate |

## Deferred

**Automatic rollback**
*Ceiling:* a rewrite causes a hard cap event — `loss_stop` or `retired` — which is a real signal rather than
a P&L wobble. Note the engine already fires an alert round for exactly this at `src/index.ts:220-223`.
*Upgrade:* `POST /lab/rollback` is already authorised by `LAB_SECRET` (`src/lab/door.ts:216-221`), and the
manual path through `/keeper/rollback` works today. Automate on a cap trigger only, never on a 20-hour
threshold — that statistic carries the selection bias, and a false rollback costs the next real rewrite.

**pnpm workspace, HTTP service, health endpoint, concurrency guard**
*Ceiling:* a second non-engine package needs its own dependency set, or the coach must react to an engine
event within seconds rather than on a cron tick. *Upgrade:* `pnpm-workspace.yaml` plus
`git mv src/tools/beekeep.ts packages/beekeeper/` — an afternoon, moving known-working code instead of
guessing at an interface.

**codex adapter**
*Ceiling:* `claude -p --json-schema` breaks, or its OAuth proves unworkable headless (pre-mortem risk 4,
likely within three months — which is why the CLI call stays behind one function from day one).
*Upgrade:* ~40 lines against two verified-good invocations. Note the sanitiser is CLI-specific: codex
returns non-ASCII and clips at the schema cap.

**Per-bee hand-editable rules file**
*Ceiling:* the operator wants to propose rules by hand rather than via the model. *Upgrade:* read the file
at round start and push it through the same sanitise-and-sign path. It must never skip the door.

## Out of Scope

Zapier parity or running both coaches at once. Public exposure, Caddy routing, TLS. Dashboard surfacing and
`docs/BEEKEEPER.md` updates. Changing the base style strategy strings compiled into `src/bees/*`.
Statistical significance machinery. Any change to the runtime path by which rules reach Jev.
