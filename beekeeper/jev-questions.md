# The Beekeeper Zap by hand

Most people should copy the shared Zap from https://mrc.fm/beekeeper. This folder is for people who want to build it
themselves, or check what the shared Zap does. The tutorial is in [docs/BEEKEEPER.md](../docs/BEEKEEPER.md).

The Zap has nine steps. Name them as below.

| # | app | name | what to set |
|---|---|---|---|
| 1 | Webhooks by Zapier, **Catch Raw Hook** | (trigger) | Nothing. Copy its URL when you are done. |
| 2 | Code by Zapier, **Run Javascript** | Scorecard: read all three bees | Code: [`step2-scorecard.js`](step2-scorecard.js). Input data: `hook` = step 1 raw body. |
| 3 | TypeSafe Jev, **Ask Questions** | Jev: broken, or just unlucky? | See "Step 3" below. |
| 4 | Zapier Tables, **Create Record** | Diary: log Jev's verdict | See "The diary" below. Optional. |
| 5 | Filter by Zapier | Only if Jev names a bee | See "Step 5" below. |
| 6 | AI by Zapier | Opus 5.5: write new rules | See "Step 6" below. |
| 7 | Zapier Tables, **Update Record** | Diary: log the new rules | See "The diary" below. Optional. |
| 8 | Code by Zapier, **Run Javascript** | Sign and deliver to the lab door | Code: [`step8-deliver.js`](step8-deliver.js). Input data is listed at the top of that file. |
| 9 | Zapier Tables, **Update Record** | Diary: log the delivery | See "The diary" below. Optional. |

## Step 3: the three questions for Jev

Content: `scorecard` from step 2.

Minimum confidence: `0.6`. When unsure: **Return unsure**.

1. A yes/no question, named `broken`:

   `Is at least one of the three bees losing because its rules are wrong for this market, rather than just unlucky?`

2. A pick-one question, named `bee`:

   `Which bee should the Beekeeper rewrite this round? Pick the bee whose rules are failing, and only a bee the scorecard marks Rewrite: OPEN. Pick none if all three should be left alone, or if the failing bee is LOCKED.`

   Options, exactly: `bee1`, `bee2`, `bee3`, `none`.

   These are your bees' ids. The scorecard shows each id next to the bee's name and style.

3. A scale question, named `anger`:

   `How badly is the picked bee doing? Read its "% since start" and its cap off the scorecard.`

   Levels, lowest first, exactly:

   - `1: Down less than 5% since start, or up.`
   - `2: Down 5% to 10% since start.`
   - `3: Down 10% to 18% since start.`
   - `4: Down 18% to 25% since start.`
   - `5: Down more than 25% since start, or benched, or retired.`

## Step 5: the filter

Continue only if all three are true:

1. Step 3 `bee` (Text) does not exactly match `none`.
2. Step 3 `bee` (Text) does not exactly match `unsure`.
3. Step 2 `open_bees` (Text) contains step 3 `bee`. The value is the mapped field, not typed text.

The yes/no answer `broken` is logged only. It does not gate anything.

## Step 6: the prompt for Opus 5.5

Model: **Claude Opus 5.5**. Tools: none.

Prompt: [`opus-prompt.txt`](opus-prompt.txt). Replace each `{{...}}` with a mapped field:

| placeholder | mapped field |
|---|---|
| `{{bee}}` (three times) | step 3 answer `bee` |
| `{{anger}}` | step 3 answer `anger` |
| `{{playbook}}` | step 2 `playbook` |
| `{{scorecard}}` | step 2 `scorecard` |
| `{{universe}}` | step 2 `universe` |

Output fields: `Idea`, `Rules`, `Coins`, `Reason`, `Quip`, `Note`.

## The diary (steps 4, 7 and 9)

A Zapier Table called **Beekeeper diary** keeps one row per round. It is your record of what the Beekeeper did and
why. The three diary steps are free. You can delete all three if you do not want the table.

Columns: `when`, `trigger`, `source`, `round`, `bee`, `broken`, `anger`, `confidence`, `confidence_broken`,
`confidence_anger`, `jev_model`, `scorecard`, `idea`, `rules`, `coins`, `reason`, `quip`, `note`, `door_status`,
`door_reply`, `payload`. Make `bee` and `anger` Text fields: Jev answers `unsure` when it is not confident.

- Step 4 creates the row: `trigger` = step 2 `alert`, `source` = step 2 `source`, `round` = step 2 `round`,
  `scorecard` = step 2 `scorecard`, and Jev's three answers with their confidences.
  Set `door_status` to `not sent: round still running`.
- Step 7 updates the same row with the six fields from step 6. Set `door_status` to `pending: about to deliver`.
- Step 9 updates the same row: `door_status` and `door_reply` from step 8, and `payload` = step 8 `body`.
