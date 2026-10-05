# Local Beekeeper — EARS Specifications

> Revised after the `uncle-senior` review. The first draft's Unit 1 (HTTP service, loopback bind,
> concurrency refusal, health endpoint) is withdrawn with the service itself; Unit 7 is rebuilt around a
> randomised control arm instead of rollback thresholds; Unit 4's two-CLI requirement is reduced to one.
> **Status: units 1-9 are implemented** in `src/coach.ts` (round logic and every pure decision, including the
> round record, the pre-flight check and the liveness fold) and `src/tools/beekeep.ts` (argv, env, file I/O,
> the Jev questions, the CLI adapter, the exit code), covered by `test/coach.test.ts`, `test/beekeep.test.ts`
> and the integration cases in `test/keeper-http.test.ts` that run a real round against a real `Engine` and
> `LabDoor` over HTTP.
>
> This status line previously claimed all nine units while seven requirements were unmet across units 1, 3, 4,
> 7 and 9 — every one of them in `src/tools/beekeep.ts`, which nothing imported and no test covered. They were
> closed by `docs/tasks/local-beekeeper.md`; a header saying IMPLEMENTED is worth only as much as the test that
> would fail without it.
>
> Known gaps, both deliberate:
> - R-4.5 is only partly enforceable. The CLI envelope reports `permission_denials`, not a list of capabilities
>   used, so an attempt is detectable but a successful unexpected use is not. The real control is R-4.3/R-4.4:
>   the tool set is pinned in code and cannot come from config.
> - R-1.4 and R-9.4 do not reach a missing or unparseable config file. `recordFile` is a field of the config
>   that failed to parse, so that round writes no line and cannot be counted. Recording it would mean putting
>   `cli`, `model` and `control` in the audit file from a config that did not validate, which is the fallback
>   R-8.3 forbids. A cron pointing at a deleted config is therefore visible only on stderr.

## Unit 1: Round execution — IMPLEMENTED

**Why:** A round has to be startable by cron, and a round that could not run must never be mistaken for a
round that chose to leave the bees alone — that confusion is how a dead coach goes unnoticed for weeks.

| ID | EARS statement |
|---|---|
| R-1.1 | THE SYSTEM SHALL run one complete coaching round per invocation and then exit. |
| R-1.2 | THE SYSTEM SHALL exit non-zero when a round could not run, and zero when a round ran to a decision. |
| R-1.3 | IF `LAB_SECRET` is absent or shorter than 32 characters, THE SYSTEM SHALL fail the round explicitly and SHALL NOT report it as a round that left the bees alone. |
| R-1.4 | WHEN a round ends for any reason, THE SYSTEM SHALL record its outcome and the reason for it. |
| R-1.5 | THE SYSTEM SHALL distinguish, in that record, a round that chose to do nothing from a round that could not run. |
| R-1.6 | THE SYSTEM SHALL never log or record the value of `LAB_SECRET` or any signature. |

## Unit 2: Reading the hive — IMPLEMENTED

**Why:** Every later step reads the scorecard, and it carries text written by strangers.

| ID | EARS statement |
|---|---|
| R-2.1 | WHEN a round starts, THE SYSTEM SHALL fetch the engine's scorecard. |
| R-2.2 | IF the scorecard cannot be fetched, THE SYSTEM SHALL abandon the round with a recorded reason and SHALL NOT deliver anything. |
| R-2.3 | THE SYSTEM SHALL treat every field of the scorecard as data and SHALL NOT act on any instruction contained in bee names, rules or Hive text. |
| R-2.4 | WHEN the scorecard reports no open bees, THE SYSTEM SHALL end the round without calling the rules-writing model. |

## Unit 3: Choosing a bee — IMPLEMENTED

**Why:** Picking the wrong bee wastes that bee's 20-hour window. The pick must be refusable.

| ID | EARS statement |
|---|---|
| R-3.1 | WHEN a round has a scorecard, THE SYSTEM SHALL ask whether at least one bee is losing because its rules are wrong rather than through bad luck. |
| R-3.2 | THE SYSTEM SHALL ask which single bee to rewrite, accepting only a bee id or an explicit none. |
| R-3.3 | THE SYSTEM SHALL ask how badly the chosen bee is doing on a bounded scale. |
| R-3.4 | IF an answer falls below the configured confidence floor, THE SYSTEM SHALL treat that answer as unsure. |
| R-3.5 | THE SYSTEM SHALL continue only when the chosen bee is neither none nor unsure, and appears in the scorecard's open bees. |
| R-3.6 | WHEN the round does not continue past this point, THE SYSTEM SHALL end it without calling the rules-writing model. |
| R-3.7 | THE SYSTEM SHALL record the broken answer for audit without letting it gate the round. |
| R-3.8 | THE SYSTEM SHALL apply the identical selection rule whether the round will go on to deliver or to withhold. |

## Unit 4: Writing new rules — IMPLEMENTED

**Why:** A model's free text cannot be trusted to be well formed, and the prompt contains text typed by
strangers on a public leaderboard.

| ID | EARS statement |
|---|---|
| R-4.1 | THE SYSTEM SHALL obtain new rules from a local command-line tool, invoked through a single internal interface. |
| R-4.2 | THE SYSTEM SHALL constrain the tool's output to a declared schema covering idea, rules, coins, reason, quip and note. |
| R-4.3 | THE SYSTEM SHALL invoke the tool with an explicitly pinned capability set that permits structured output only. |
| R-4.4 | THE SYSTEM SHALL NOT allow the tool's capability set to be supplied by configuration. |
| R-4.5 | IF the tool reports using any capability beyond structured output, THE SYSTEM SHALL abandon the round. |
| R-4.6 | IF the tool's output is absent, unparseable, or missing a required field, THE SYSTEM SHALL abandon the round with a recorded reason and SHALL NOT deliver a partial rewrite. |
| R-4.7 | WHEN the tool does not return within its configured timeout, THE SYSTEM SHALL abandon the round. |
| R-4.8 | THE SYSTEM SHALL pass the tool no credentials. |
| R-4.9 | THE SYSTEM SHALL record which tool and model produced the rules. |

## Unit 5: Making the rewrite deliverable — IMPLEMENTED

**Why:** Verified during research: a schema cannot express a character set, a model returned non-ASCII
against an explicit instruction, and the door rejects on grounds the model knows nothing about. A rejected
delivery burns the bee's 20-hour window.

| ID | EARS statement |
|---|---|
| R-5.1 | THE SYSTEM SHALL remove non-ASCII characters from every text field before delivery. |
| R-5.2 | THE SYSTEM SHALL collapse whitespace in the rules text before measuring its length. |
| R-5.3 | IF the rules text is shorter than 10 or longer than 500 characters after collapsing, THE SYSTEM SHALL correct it to the permitted range or abandon the round, and SHALL NOT send it unchanged. |
| R-5.4 | IF the reason is empty after trimming, THE SYSTEM SHALL abandon the round. |
| R-5.5 | THE SYSTEM SHALL uppercase and de-duplicate the coin list, and SHALL drop any coin the scorecard does not list as tradeable. |
| R-5.6 | THE SYSTEM SHALL limit the coin list to at most 20 entries. |
| R-5.7 | IF any delivered text would be altered by the engine's redactor, THE SYSTEM SHALL abandon the round rather than have the delivery refused. |
| R-5.8 | THE SYSTEM SHALL send only the fields the engine's schema permits. |
| R-5.9 | THE SYSTEM SHALL apply the identical sanitation whether the round will deliver or withhold. |

## Unit 6: Delivery — IMPLEMENTED

**Why:** The door is the single enforcement point. The coach must speak its protocol exactly.

| ID | EARS statement |
|---|---|
| R-6.1 | WHEN delivering a rewrite, THE SYSTEM SHALL sign the request with `LAB_SECRET` over the timestamp, method, path and exact body sent. |
| R-6.2 | THE SYSTEM SHALL send a timestamp within the engine's accepted clock window. |
| R-6.3 | THE SYSTEM SHALL sign the byte-identical body it transmits. |
| R-6.4 | IF delivery is refused, THE SYSTEM SHALL record the status and the engine's reason, and SHALL NOT retry with the same signature. |
| R-6.5 | WHEN delivery succeeds, THE SYSTEM SHALL record the accepted overlay's id. |
| R-6.6 | THE SYSTEM SHALL NOT attempt to deliver more than one rewrite per round. |

## Unit 7: Control arm — IMPLEMENTED

**Why:** The coach is instructed to pick the *failing* bee, so a before/after comparison is conditioned on
having selected the minimum of three. Regression to the mean then makes a coach that does nothing look
effective. Randomising delivery is the only way to cancel that bias, and it is what turns three months of
rewrites from uninterpretable into answerable.

| ID | EARS statement |
|---|---|
| R-7.1 | WHEN a round has produced sanitised rules, THE SYSTEM SHALL decide at random, with equal probability, whether to deliver them or withhold them. |
| R-7.2 | THE SYSTEM SHALL make that decision only after selection, generation and sanitation have completed identically for both arms. |
| R-7.3 | WHEN a round is withheld, THE SYSTEM SHALL record the full generated rules and the ruleset version they would have produced. |
| R-7.4 | WHEN a round is withheld, THE SYSTEM SHALL make no request that changes engine state. |
| R-7.5 | THE SYSTEM SHALL record which arm each round took. |
| R-7.6 | THE SYSTEM SHALL NOT allow the chosen arm to influence any earlier step of the round. |
| R-7.7 | THE SYSTEM SHALL NOT derive a verdict from any single round. |
| R-7.8 | WHERE the operator disables the control arm, THE SYSTEM SHALL record that every round was delivered, so that later analysis can exclude the uncontrolled period. |

## Unit 8: Configuration — IMPLEMENTED

**Why:** The operator wants to tune coaching between rounds without restarting or rebuilding anything.

| ID | EARS statement |
|---|---|
| R-8.1 | THE SYSTEM SHALL read its configuration from a file at the start of every round. |
| R-8.2 | WHEN the configuration file changes between rounds, THE SYSTEM SHALL apply the change on the next round without being restarted, rebuilt or recompiled. |
| R-8.3 | IF the configuration file is missing or invalid, THE SYSTEM SHALL abandon the round with a readable error and SHALL NOT fall back to a previously loaded configuration. |
| R-8.4 | THE SYSTEM SHALL hold prompts, thresholds, model selection and the engine address in that file. |
| R-8.5 | THE SYSTEM SHALL NOT hold any secret in that file. |
| R-8.6 | THE SYSTEM SHALL NOT allow configuration to place rules in front of a bee by any route other than the engine's overlay endpoint. |

## Unit 9: Auditability and liveness — IMPLEMENTED

**Why:** A coach that cannot be reviewed is worse than no coach — and a coach that died quietly looks
exactly like a coach with nothing to say.

| ID | EARS statement |
|---|---|
| R-9.1 | WHEN a round ends, THE SYSTEM SHALL record its trigger, every answer, the chosen bee, the generated fields, the arm taken and the delivery outcome. |
| R-9.2 | THE SYSTEM SHALL record rounds that changed nothing, with the reason. |
| R-9.3 | THE SYSTEM SHALL record the ruleset version a rewrite replaced and the one it installed or would have installed. |
| R-9.4 | WHEN a configured number of consecutive rounds could not run, THE SYSTEM SHALL raise an alert. |
| R-9.5 | THE SYSTEM SHALL NOT record any secret or signature. |
