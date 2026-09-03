# UI pass: navigation, filters, answering, theming — design

Date: 2026-09-03
Scope: `public/index.html` (the whole SPA), plus a small `src/index.js` addition for
per-user settings. No extractor work, no re-import.

The AI chatbot itself is being designed in a separate conversation. This spec only
reserves the place its personalization text is stored and edited.

## 0. Already carried out

The 73 `source='Bluebook'` rows ("Practice tests") are deleted from both the local D1
sqlite and the remote D1. They were one person's own practice-test mistakes and made no
sense in a bank every user shares.

Backed up first, and the remote id set was verified identical to the local one before
either delete ran:

- `backup/bluebook_rows_2026-09-03.json` — all 73 rows, every column
- `backup/bluebook_rows_2026-09-03.sql` — the same rows as re-runnable `INSERT`s
- `backup/bluebook_remote_ids_2026-09-03.txt`
- `backup/bluebook_remote_progress_2026-09-03.json` — the one `progress` row that
  referenced them

Also removed: 1 `progress` row and 1 `attempts` row pointing at deleted questions, on
the remote. Both databases now hold 3,770 rows, all `source='CollegeBoard'`.

**Consequence this spec must clean up.** `pool()` (index.html:853) branches on
`(q.source === 'Bluebook') !== (F.src === 'pt')`. The `pt` option can no longer match
anything, so the Source filter becomes two options — Question Bank and My mistakes —
and the `pt` branch goes. A stored `F.src === 'pt'` in a returning user's localStorage
must fall back to `official`, or they open the app to an empty bank.

Orphaned crops under `public/qimg/` for the deleted rows are left in place; they are
small and the directory is well under the 20,000-file asset cap.

## 1. Landing screen and rail order

`showHome()` opens the practice tab. A new user is dropped into a filter form before
they have anything to filter. Default the tab to `dash`.

Rail order becomes Dashboard, Mistakes, Question Bank, Browse. The existing
`Practice` / `Progress` group headings no longer describe that order, so they are
removed and the four entries sit in one group. A fifth entry, Settings, is pinned at the
bottom above the account block (§10).

## 2. Filter dropdowns

### The component

One implementation, three instances (Question Bank, Browse, Mistakes). A filter is
`{ label, options, selected, multi }` and renders:

- **Trigger** — rounded rect, `border-radius: 10px`, `padding: 8px 12px`, label in
  `--dim` above the value summary in `--text`. The summary reads `All difficulties` when
  nothing is picked, `Easy, Hard` for a partial pick, `Easy, Medium, Hard` when all.
  A trigger holding a non-default value takes a `--blue` border and `--blue-bg` fill, so
  an active filter is visible without opening it.
- **Panel** — `border-radius: 12px`, 1px `--border`, panel shadow, max-height with its
  own scroll. Rows are 36px, hover `--bg2`.
- **Checkbox** — rounded square, 16px, `border-radius: 5px`, 1.5px `--border2`. Checked:
  `--mint` fill, `--mint-ink` tick. Indeterminate (a domain with some but not all of its
  skills ticked): `--mint` fill, single horizontal bar.
- **Keyboard** — the trigger is a `<button>`, so it is focusable and the global
  `:focus-visible` ring applies. `Escape` closes, `Enter`/`Space` toggles a row, clicking
  outside closes. One open panel at a time.

### Which filters change

| Filter | Type | Notes |
|---|---|---|
| Section | multi | Math, Reading & Writing |
| Difficulty | multi | Easy, Medium, Hard |
| Topic (Domain → Skill) | multi, nested | Domain row toggles all its skills |
| Source | single | Question Bank, My mistakes |
| Questions | single | 10 / 20 / 30 / 50 / All |

An empty selection means "all", matching the `F.skills === null` convention already in
the code — a first-time visitor is never filtered down to nothing.

### Where topic filtering lives

The domain/skill table on the Question Bank tab keeps showing coverage and accuracy per
skill, but stops being a filter control: ticking moves into the Topic dropdown. Two
controls editing one piece of state is what makes the current screen confusing.

### Browse

Browse gets the same three multiselect dropdowns plus its existing search box, over its
own state object (`FB`), persisted under its own localStorage key. Changing the practice
set filters must not silently re-filter Browse, and vice versa.

## 3. Check button and retry mode

Today a click on a choice grades it immediately (index.html:1577); the `sel` class exists
and is unreachable. Answering becomes two steps:

1. Click a choice — it takes `sel` (blue outline). Nothing is graded, nothing is saved.
2. A small **Check** button appears inline on the right edge of that row. Click it to
   grade.

The eliminate (strike-out) button keeps its slot; Check sits beside it, and only on the
selected row.

### Retry mode

A settings toggle (§10), off by default. When on, a wrong Check marks **only the chosen
choice** wrong — red border, struck label — and leaves the question open. The correct
choice is never revealed by elimination; green appears only on a choice actually picked.
Off, the behaviour is today's: grade once, reveal the answer, move on.

Attempt accounting, so the dashboard keeps meaning what it says: the **first** Check on a
question writes both the `progress` row and one `attempts` row, exactly as `grade()` does
now. Later Checks on the same question in the same session append an `attempts` row (the
heatmap should show the work) but do not re-grade `progress` — otherwise a student walks
a question to Green by clicking every option.

Grid-ins already have a Submit button and are unchanged, except that in retry mode a
wrong entry keeps the box open instead of printing the answer.

## 4. Correct answers are green

`.choice.corrected` paints the correct choice orange when the question was wrong on an
earlier attempt. Under either theme that reads as a warning, not as "this is the right
answer". `.choice.corrected` takes the same green as `.choice.right`.

Orange stays everywhere it still carries information — the question-map grid, the
results-screen pills, the mistakes cards — where "wrong once, right now" is a distinct
state worth seeing.

## 5. Explanation is always available

`renderAnswerArea()` (index.html:1656) prints "Hidden until you answer." until the
question is graded. In a question bank that is a study aid withheld for no reason. The
explanation modal opens with real content whether or not the question has been answered.
It still does not open itself.

## 6. Dark mode legibility

Two unrelated causes under one complaint.

**Chart and axis labels.** Dark `--dim2` is `#6b7280` on `--panel` `#181b21`, about
3.1:1 — under the 4.5:1 floor for text this size. Every chart x-label, y-axis number,
heatmap month and weekday strip, and chart caption uses it. Raise dark `--dim2` to about
`#98a1b0` (~7:1). One variable, all of them fixed.

**Figures inside questions.** `.qfig img` keeps its own colours in dark mode (correctly —
inverting a coloured chart misreports it), so a black-on-transparent axis disappears
against a dark panel. Figures get a white plate in dark mode: white background, 8px
radius, 6px padding. Notation crops (`img.minl`) keep their existing invert treatment,
which is right for black-on-white glyphs.

**Bug, lines 225–226.** The dark heatmap levels are written as
`:root[data-theme="dark"] .heat i.l1, .heat-key i.l1 { ... }`. The second selector in
each pair is not scoped to the dark theme, so the legend key renders with dark-mode
greens in light mode. Split each selector so both halves carry the theme prefix.

## 7. Highlighter

Session-only, three colours, matching what Bluebook offers.

- Selecting text inside `.stem`, `.cb` or a `.choice` raises a small floating toolbar at
  the selection: three colour swatches — **yellow**, **magenta pink**, **baby blue** —
  and a remove button.
- Picking a colour wraps the Range in `<mark class="hl hl-y|hl-p|hl-b">`.
- Clicking an existing `<mark>` reopens the toolbar over it, so the colour can be changed
  or the highlight removed.
- Highlights clear when the question changes. Nothing is stored, no API, no schema
  change.
- `mark` sets an explicit dark ink colour in both themes, because the three pastels are
  light backgrounds and inherited `--text` is near-white in dark mode.
- The toolbar and the `<mark>` click handler must not reach the choice-selection handler:
  highlighting inside a choice must never answer the question.

## 8. Practice-set defaults

Default question count becomes **All**. A **Random order** switch sits beside the count
on the same panel, off by default, persisted with the other filters. On, the pool is
shuffled before the set is cut; off, order is unchanged from today.

## 9. Calculator panel

The header to remove is the one inside the Desmos embed, which is cross-origin: it cannot
be restyled, only cropped. The iframe goes in an `overflow: hidden` wrapper and is pulled
up by the header's measured height, with the iframe made correspondingly taller so the
calculator still fills the panel.

Before cropping, confirm the strip holds nothing a student needs. If it carries a control
the SAT-locked embed depends on, the crop is not worth it and the fallback is to strip
our own panel chrome instead.

The panel body takes the same colour as the Desmos canvas (white, in both themes — the
College Board embed has no dark mode) so the slide-over reads as one surface rather than
a white rectangle inside a dark card.

## 10. Settings

A Settings entry at the foot of the rail, above the account block, opening a normal board
page like the other four.

| Setting | Values | Default |
|---|---|---|
| Theme | Light / Dark / System | System |
| Retry mode | on / off | off |
| Random order | on / off | off |
| Default question count | 10 / 20 / 30 / 50 / All | All |
| AI instructions | free text | empty |

All five live in one `settings` object. Guests: `localStorage`. Signed in: sent to the
account so settings follow the user across devices, resolving the caller from the
Supabase access token exactly as `/api/progress` does. That is one new pair of routes
(`GET`/`POST /api/settings`) and one new table keyed by user id holding a single JSON
blob — the shape of these settings will keep changing, and a column per toggle is churn
for nothing.

The AI instructions field only stores and edits the text. Nothing reads it yet; the
chatbot being designed elsewhere will.

## 11. Per-user data: verification, not design

Nothing here is believed broken. The check is that it stays that way once §10 adds a new
per-user write path.

Drive two separate accounts through the real app and assert: answers made under account A
appear for A and never for B; a signed-out answer merges into whichever account signs in
next and is then cleared locally; settings round-trip per account; `/api/settings`
resolves the caller from the `Authorization` token and never from a client-supplied id,
matching the fix already made for `X-User-Id`.

## Testing

Everything here lives in one 2,064-line HTML file with no test harness, so verification is
what it has always been in this project: drive the real app in a browser and assert on the
rendered DOM.

- **Filters** — across a set of filter combinations, the count beside Start practice
  equals the length of the pool `base()`/`tally()` produce, and Browse's result count
  moves independently of the practice filters.
- **Check and retry** — a choice click grades nothing; Check grades; in retry mode a wrong
  Check leaves the question open, marks only the picked choice, reveals no green, and
  writes exactly one `progress` update across repeated Checks while appending an
  `attempts` row each time.
- **Green** — a question answered wrong then right shows the correct choice green, and the
  same question still shows orange on the results screen and in the mistakes list.
- **Dark mode** — computed contrast of `--dim2` against `--panel` is ≥ 4.5:1; the heatmap
  legend swatches match the grid swatches in both themes.
- **Highlighter** — highlighting text inside a choice does not select or answer it, all
  three colours apply, a highlight can be removed, and highlights are gone after Next.
- **Regression** — the existing full-bank DOM sweep still passes on all 3,770 rows:
  non-empty render, no scaffolding headings, no broken images, no KaTeX errors, exactly
  one choice marked correct per MCQ.

## Out of scope

The chatbot itself. Persisted highlights. Per-question notes. Any change to extraction,
import, or the question data.
