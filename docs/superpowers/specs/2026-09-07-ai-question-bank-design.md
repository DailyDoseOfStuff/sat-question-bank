# AI Question Bank — design

2026-09-07. Approved in conversation. Three tasks: an AI-authored bank harder than
official Hard, per-question analytics plus an adaptive timed focus mode, then a
verify/fix loop until clean.

## 1. Where the questions live

**A second D1 database**, `sat_ai_bank`, bound as `AI_DB`. Its `questions` table
carries the same column names as the main bank's plus `level`, so the Worker's
SELECT is the same string twice.

Two consequences, both designed around:

- **D1's daily row-write cap is account-wide.** A second database buys isolation
  from the session auditing the official bank, not extra write budget.
- **D1 cannot join across databases.** `progress`, `attempts` and `notes` bound
  what an account may write with `WHERE EXISTS (SELECT 1 FROM questions WHERE
  id = ?)`. An AI question id fails that guard in the main DB, so every answer to
  an AI question would be dropped silently. The importer therefore also writes a
  one-column registry `ai_ids(id TEXT PRIMARY KEY)` into the **main** DB, and the
  guard becomes `EXISTS questions OR EXISTS ai_ids`. ~400 tiny rows, exact bound
  preserved. User data stays in one database; only question content is split.

Rejected: putting `progress`/`attempts`/`notes` in the AI DB as well. That splits
one account's history across two databases and doubles every read, write, merge
and backfill path in the client.

## 2. Question format

Same columns the player already renders, so no new render path:

| column | AI rows |
|---|---|
| `id` | `ai_<section><nnn>`, e.g. `ai_rw001` |
| `source` | `'AI'` |
| `difficulty` | `'Hard'` — keeps every existing filter, dropdown and dashboard order array working untouched |
| `level` | `4` or `5` — the ladder's rank. Official rows have no `level`; the client derives Easy/Medium/Hard = 1/2/3 at load |
| `stem_html` | prose + KaTeX `\( \)`; graphs are **inline `<svg>`** |
| `choices_json` | `[{letter, content, trap}]` — `trap` on wrong choices only |
| `explanation_html` | fixed template, below |

**Graphs are inline SVG**, not cropped images: theme-aware through `currentColor`
and the page's own CSS variables, nothing added to `/qimg`, no asset-cap risk, and
none of the worktree junction trap that has broken two deploys.

**Explanation template** (validator-enforced):

1. `<p><strong>Traps in this question</strong></p>` + `<ul>` naming each trap and
   who it catches.
2. `<p><strong>Why A is wrong</strong> …</p>` for every choice, correct one included.
3. The clean path to the answer.

**Trap taxonomy** is a fixed vocabulary so the dashboard can aggregate it. Math:
`sign-flip`, `endpoint-off-by-one`, `solved-wrong-quantity`, `unit-mismatch`,
`ratio-inverted`, `mean-vs-median`, `extraneous-root`, `percent-wrong-base`,
`slope-intercept-swap`, `axis-misread`, `unsimplified-form`, `shortcut-trap`.
Reading & Writing: `out-of-scope`, `too-extreme`, `true-but-irrelevant`,
`wrong-part-of-passage`, `reversed-relationship`, `half-right`,
`vocab-collocation`, `comma-splice-plausible`, `distant-antecedent`,
`modifier-attachment`, `transition-reversal`, `pronoun-ambiguity`.

Every RW item's correct choice must be provable from text quoted in the stem, as
official items are.

## 3. Authoring pipeline

```
tools/aiq/<batch>.jsonl        authored in batches of 25
node tools/apply_ai.cjs <f>    validate -> local AI D1 + ai_ids -> emit migration
node tools/apply_ai.cjs --test self-check
```

The validator refuses a batch on any of: duplicate id, a skill outside the
official taxonomy, not exactly one correct choice, a stored answer letter absent
from the choices, a wrong choice with no trap tag or a tag outside the vocabulary,
a missing Traps block or a missing per-choice paragraph, unbalanced `\(` `\)`,
`level` outside 4–5, and — for RW — a correct choice whose supporting text is not
quoted in the stem.

v1 ships **100 verified rows, 75 Reading & Writing / 25 Math**. The pipeline
carries the rest to 400 in later batches.

## 4. Metrics

```
migrations/0009_ai_bank.sql   (main DB)
  ALTER TABLE attempts ADD COLUMN picked  TEXT;
  ALTER TABLE attempts ADD COLUMN changes INTEGER DEFAULT 0;
  CREATE TABLE ai_ids (id TEXT PRIMARY KEY);
```

`picked` is the choice letter or the grid-in entry. `changes` counts selection
switches before Check. Pacing needs no column — it is `time_taken_ms` against a
per-section target (Math 95s, Reading & Writing 71s).

Dashboard gains four panels, each a number and a graph:

| panel | reads |
|---|---|
| Traps you fall for | `picked` joined to the wrong choice's `trap`, ranked bars |
| Pacing | rushed / on-pace / slow split, plus mean time vs target per section |
| Second-guessing | mean `changes`, and accuracy when changed vs not |
| Accuracy by level | levels 1–5, extending the existing by-difficulty bars |

## 5. Focus practice

**Weakness score** per skill, `(misses + 1) / (attempts + 2)` — Laplace-smoothed,
so a skill with no attempts scores 0.5 and surfaces rather than being invisible.
Ties break toward fewer attempts. Slots are allocated across skills in proportion
to score.

**Ladder.** `target` starts at the student's median correct level, `+1` after two
consecutive correct answers (cap 5), `-1` on a miss (floor 1). Each slot is filled
with the nearest available level in that skill, preferring never-seen questions
then oldest-seen.

**Pool** is official + AI, weighted to weak skills. AI items naturally dominate
levels 4–5.

**Popup**, opened by Start practice while Focus mode is selected. Rounded rects,
visual pass through `ui-ux-pro-max`:

- Sections — Reading & Writing / Math / Both
- Bank — Official / AI / Both
- Size — 30 / 35 / 40
- Timing — Untimed / Whole set / Per question at 1×, 1.5×, 2×
- Auto-advance — toggle, enabled only under per-question timing

Whole-set time is `n × section target`. Per-question timing reuses the existing
`#q-clock`, counting down and turning red past target; it only auto-advances when
the toggle is on.

## 6. Mistake bank

Adds a Bank dropdown (Official / AI / All) beside the existing Section,
Difficulty, Topic and Status controls. Section already toggles Reading & Writing /
Math / Both. AI mistakes need no new plumbing — the marker path is keyed on
`question_id`.

## 7. Legal

Terms and Privacy gain a section: AI-generated items are labeled as such in the
app, are not College Board material, are provided for practice, and may contain
errors; no affiliation is claimed.

## 8. Verification loop (task 3)

Repeat until a pass is clean:

1. `node tools/apply_ai.cjs --test` and the batch validator over every JSONL.
2. Grading simulation: the player's own `isRight()` over all AI rows — every
   stored answer grades right, no row returns "not scored", a wrong entry never
   grades right.
3. Browser render sweep through the app's own path: 0 KaTeX errors, 0 empty
   stems, 0 duplicate choice sets, 0 broken images, 0 mojibake.
4. UI walk at 1280 / 375 / 320px: focus popup, timing modes, auto-advance, the
   four dashboard panels, the mistakes Bank filter, both themes.
5. `node test_sync.cjs`, `test_grade.cjs`, `test_notes.cjs`, `test_worker_sql.cjs`
   still pass, plus new cases for the changed guard and the focus picker.

## 9. Ship

Local D1 for both databases plus the migration files. AI rows are pushed to the
remote AI database. Application code is not deployed from this worktree —
`public/qimg` here is a junction and `tools/predeploy.cjs` refuses it.
