# CLAUDE.md — SAT Question Bank

## Working Rules

**Tradeoff:** Rules bias caution over speed. Trivial task, use judgment.

### 1. Think Before Coding

**No assume. No hide confusion. Surface tradeoffs.**

Before build:
- State assumptions. Uncertain, ask.
- Multiple readings exist, show all — no silent pick.
- Simpler way exist, say. Push back when warranted.
- Unclear, stop. Name confusion. Ask.
- Big project + bug fix: run test before + after.

### 2. Simplicity First

**Least code that solve problem. Nothing speculative.**

- No feature past ask.
- No abstraction for single-use code.
- No "flexibility"/"configurability" not requested.
- No error handling for impossible case.
- Write 200 lines, could be 50, rewrite.

Ask self: "Senior engineer call this overcomplicated?" Yes, simplify.

### 3. Surgical Changes

**Touch only what must. Clean only own mess.**

Edit existing code:
- No "improve" nearby code, comment, format.
- No refactor thing not broken.
- Match existing style, even if you differ.
- Notice unrelated dead code, mention — no delete.

Changes make orphans:
- Remove imports/variables/functions YOUR change made unused.
- No remove pre-existing dead code unless asked.

Test: every changed line trace direct to user request.

### 4. Goal-Driven Execution

**Define success criteria. Loop till verified.**

Turn task into verifiable goal:
- "Add validation" → "Write tests for invalid input, then pass them"
- "Fix the bug" → "Write test that reproduce, then pass"
- "Refactor X" → "Tests pass before + after"

Multi-step task, state brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong criteria let you loop alone. Weak criteria ("make it work") need constant clarify.

### 5. Self-Improvement

- Find error. Log it + reason why happen.

**Rules working if:** fewer needless diff changes, fewer rewrites from overcomplication, clarify questions come before build not after mistake.

---

## Project Facts

UI modeled on **Oneprep.xyz** + **Bluebook** question display formats.

### Architecture

- `src/index.js` — Cloudflare Worker. Serves `/api/questions`, `/api/progress`, `/api/chat` (Gemini proxy), static assets. **This is the real app server.**
- `public/index.html` — entire SPA, single file (~60K). Home / test player / results.
- `public/qimg/` — 16,514 cropped WebP images (gitignored, 118MB).
- `schema.sql` — D1 tables: `questions`, `progress`, `users`.
- `server.js` — legacy local Node server, reads `questions.json` which **does not exist**. Dead path.
- Local dev DB: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/588d9571....sqlite`

Run local: `npx wrangler dev` (not `node server.js`).

### Data Source

Questions extracted from two College Board PDFs in `~/Downloads/`:
- `OfficialSatMath.pdf` — 2030 pages, 1925 questions
- `OfficialSatReading.pdf` — 1977 pages, 1845 questions

Each PDF page carries `Question ID: <hex>` matching `questions.id`. This is the join key
back to source. `source_page` in DB is 0 for every row — unusable, use the ID index instead.

**PDF text layer:** prose IS extractable via PyMuPDF (no OCR needed). Math notation is
Type3 vector glyphs with no ToUnicode map — extracts as empty gaps between prose spans.
Rationale text IS extractable.

### Known Data State (measured, 3874 rows)

| Fact | Count |
|---|---|
| Stems rendered as image | 3770 |
| Stems as real text | 104 |
| `stem_text` populated (Tesseract OCR) | 3874 |
| Answer choices as images | 3186 |
| Answer choices as text | 97 |
| No choices (grid-in / SPR) | 591 |
| **`explanation_html` empty** | **3874 (all)** |

### Re-extraction (in progress)

`tools/pdfcommon.py` + `tools/extract.py` rebuild stem/choices/answer/rationale
straight from the PDFs. Output is JSONL; **nothing writes to the DB yet.**

Measured PDF quirks, all handled:
- **Spurious spaces.** The dumps emit a narrow space glyph mid-word
  ("ar tifacts"). Real space = 2.5x fontsize, artifact = 0.24x; threshold 1.0.
  Verified bimodal across the corpus (15,292 real vs 202 artifacts, 2 ambiguous).
- **Line grouping must use vertical overlap, not fixed y-bands.** Accents and
  choice letters sit <1pt off baseline; banding tore "C." off its own choice.
- **Bullets** are 3pt filled squares left of the text; each opens a list item.
- **Charts/tables** are vector art whose labels live in the text layer and read
  as noise ("2.52.01.51.00.5"). Detected as clustered vector art, grown to
  absorb nearby labels (anything indented past x=100), cropped to WebP as
  `<id>_fig<n>.webp`, and the absorbed text dropped.
- **Math notation is not text** - raw vector paths, no font. Identical glyphs
  have identical path geometry, so a bbox-normalised path hash is a stable
  per-character key (verified: top 24 shapes read cleanly as 0-9, =, x, (, ),
  +, comma, minus...). `tools/glyphmap.py` builds that map. This beats OCR and
  needs no OCR engine. A raster signature was tried and was worse (1243
  clusters vs 327) - do not revisit it.

**RW: done and verified.** 1845/1845 rows, every one with 4 choices, a stem,
an answer and a rationale. 133 figures cropped. Remaining short paragraphs are
all legitimate ("Text 1"/"Text 2" headings, copyright lines, poetry lines).
One source-side defect worked around: `e3bbf2bf` renders choice D as a bullet.

### Re-extraction: imported (2026-08-27)

`tools/import_sql.cjs` reads `tools/math.jsonl` + `tools/rw.jsonl` and UPDATEs
`questions` by id — `stem_html`, `choices_json`, `correct_answer`,
`explanation_html`, `has_figure`. Metadata columns (`section`/`domain`/`skill`/
`difficulty`/`source`) are untouched; they were already correct in the DB.
All 3770 CollegeBoard rows updated, verified via `wrangler d1 execute --local`.
104 Bluebook rows untouched (out of scope, small enough to leave as-is).

Frontend fix: `public/index.html` read `q.rationale_html` (schema has no such
column) — explanation drawer always showed "No explanation available." Fixed
to `q.explanation_html` (2 call sites). Also `renderStem()`'s `isImg` check
matched any `/qimg/` substring, which now false-positives on the new
text-with-inline-figure rows and routes them through the old whole-stem-OCR
fallback (`stemTextView`) instead of the real HTML. Narrowed to the actual
old-format signal, `<div class="qimg">` (whole stem is one image).

Verified live: Math question renders as real prose + text choice buttons,
figure crops inline, explanation panel shows real rationale text on submit.
Remaining images are legitimate — per-notation crops (`_m<n>.webp`) for
math the 93-shape glyphmap can't resolve to text yet (fractions, radicals).

### UI overhaul (2026-08-27)

`public/index.html` only — no backend changes. Verified via `wrangler dev`
+ Claude Browser pane (DOM/computed-style inspection; screenshots are broken
in this environment).

- **Timer:** removed the session-wide countdown (`t-clock`, the home-screen
  "Timed" toggle, `S.timed`/`budget`/`remaining`). Only the per-question
  count-up (`q-clock`, resets to 0:00 each question) remains.
- **Choices:** bigger buttons (18px/20px padding, 16.5px font) and added
  `.choice table` styling so a table can render inside a choice.
- **Back/AI buttons:** swapped order in the bottom bar — AI Tutor now comes
  before Back.
- **Desmos:** replaced the generic `desmos.com/calculator?embed` with the
  real SAT-locked embeds — `desmos.com/testing/collegeboard/graphing` and
  `.../scientific` — with a tab switcher in the panel header, matching how
  Bluebook actually offers two separate calculators. Opening the panel now
  adds `.desmos-shift` to `#work`, giving the question panes a 540px right
  margin so they don't sit under the panel.
- **Dark mode:** `:root[data-theme="dark"]` variable block + a few
  hardcoded light grays consolidated into `--bg2` so nothing stays
  white-on-dark. Toggle button (🌙/☀️) in the home brand row and the test
  top bar, persisted to `localStorage`, defaults to `prefers-color-scheme`.

Two-column passage/prompt layout, centered Math layout, and the explanation
drawer were already implemented from earlier work — verified still correct,
not touched.

Not done: the `.choice table` CSS path has no live question to exercise it
yet (no re-extracted choice happens to contain a table in the current data).

### UI + data verification pass (2026-08-28)

`public/index.html` only. Verified by walking all 3,874 questions through the
real test player in a browser and asserting on the rendered DOM (not on the
DB): 0 render empty, 0 leave Passage/Prompt scaffolding, 0 leak the rationale,
0 lack a choice list or grid-in, 0 broken `<img>`. All 17,495 `/qimg/` refs
resolve to files on disk.

- **Practice chips:** `.chip.on` was `background: var(--text); color:#fff`,
  which is white-on-near-white in dark mode. Now transparent with a blue
  border + inset ring; label keeps `var(--text)`.
- **Calculator:** dropped the home-screen toggle switch (and the now-orphaned
  `.switch`/`.slider` CSS). `#btn-calc` is shown per question, on Math only,
  and the Desmos panel auto-closes when you move onto a Reading question.
- **Dashboard:** added per-domain and per-skill breakdowns beside the existing
  per-section one. `Orange` (corrected) now counts as correct, as it already
  did on the results screen.
- **Third pane removed.** `.pane-p` was never written to after the explanation
  drawer landed, but it still claimed 30% of the row in `solo` mode — that is
  the empty dark column on the right of the question screen.
- **Explanation** moved from a docked drawer to a modal opened by a new
  `#btn-expl` next to the AI button (also in the More menu). It no longer
  opens itself on submit; the inline verdict already reports right/wrong.
- **Top bar:** Hide and the clock swapped.
- **Question number** uses `color: var(--bg)`, so it is dark on the light
  badge in dark mode instead of white-on-white.
- **Passage/Prompt headings** are extractor scaffolding and are stripped at
  render (`H3_LABEL`). The old rule deleted everything between `<h3>Passage</h3>`
  and `<h3>Question</h3>`, which threw away the question body on the rows that
  used that pairing.
- **Mojibake:** 27 rows carry UTF-8 read back through CP437 (`ΓêÆ` for `−`,
  `ΓåÆ` for `→`, …). Mapped back at load time via `demoji()`.
- **Leaked rationale:** 70 stems had the rationale appended, printing the
  answer above the choices. Stripped at load (`LEAKED_RATIONALE`); all 70 keep
  a separate populated `explanation_html`, and none render empty afterwards.
- **Unanswerable grid-ins:** 81 SPR rows had an empty `correct_answer`, and
  `grade()` marked every attempt Red. 59 state the answer plainly in their own
  rationale and are recovered at load; the other 22 state it only as an image
  and are now reported as "Not auto-scored" and excluded from the score,
  the markers, the question map and the results tally.

**Answerability pass (same day).** Clicking through every multiple-choice
question in the player and asserting exactly one choice comes back marked
correct found 103 that could never be answered right:

- 65 rows have blank choice letters, so every badge rendered "?" and the click
  recorded an empty letter that no stored answer could match. All 65 have
  exactly four non-empty choices, so the letter now falls back to position.
- 22 rows store the answer as `B - <the full text of choice B>`. `isRight()`
  compares the whole string, so it never matched. Now reduced to the leading
  letter; all 22 were validated by checking that the trailing text matches the
  text of the choice at that letter.
- 16 rows lost choices in extraction and the choice recorded as correct is one
  of the missing ones. These are unanswerable, so `isRight()` returns null for
  them and they are reported as "Not auto-scored" rather than marking every
  attempt wrong.

Re-verified end to end: 3,356 multiple-choice questions, 3,340 grade correctly,
16 report as not scored, 0 misbehave. Full render sweep after the change is
still 0 empty / 0 scaffolding / 0 leaks / 0 broken images / 0 "?" badges.

Data defects left alone (cannot be fixed without re-extraction):
- 22 grid-ins still have no machine-readable answer (answer is a figure).
- 104 rows have no `explanation_html` (the 50 `Reading and Writing` legacy
  rows plus 27 RW + 27 Math).
- 3 rows read a variable `x` as `i` (`d4d513ff`, `2e8cc1c0`, `6fa593f1`).
- `1efd7ef3` stem is garbled (`What is the value ofS(n42π?`).
- 33 rows have fewer than four choices; 16 of those are the unanswerable ones
  above, the rest merely offer a short list.
- 2 rows contradict themselves: the rationale names a different choice than
  `correct_answer` (`bf5f80c6` stores A, rationale says D; `1e11190a` stores B,
  rationale says C). Both stems depend on notation that only exists as images,
  so neither can be resolved here without the source PDF. Left as stored.
- 36 rows have no choices but store a bare letter as the answer, i.e. the
  choice list was lost entirely. They render as grid-ins and are not scored.

Note: `questions` has no `qtype` or `label` column, but the frontend reads
`q.qtype` and `q.label`. Both are always undefined — the grid-in branch works
only because it also tests `!q.choices.length`, and the "My PT Mistakes"
filter can therefore never match anything.

### Extractor root-cause pass (2026-08-28, later)

The previous pass patched symptoms in `public/index.html`. This one fixed the
three extractor bugs that produced them and re-imported all 3,770 CollegeBoard
rows. Verified by walking every question through the real player.

**1. Figures were not assigned to a section.** `build()` handed *every* vector
cluster on the page to `to_html(stem, figs)`. A cluster in the choices band or
the rationale band therefore printed as a picture above the question, and -
worse - `fill_math(skip=figs)` then refused to decode that region, so those
choices lost their notation entirely (`bdb0aa23` rendered as `['4','x C.','']`
with all four real choices glued into one image in the stem). **545 Math
questions** hit this; RW, scanned the same way, has none. `build()` now buckets
each cluster by `section_end()` and only stem-band clusters become figures;
rationale-band ones go to `explanation_html`, and choice-band notation is left
for `fill_math` to crop per choice.

**2. Seven wrong entries in `glyph_labels.json`.** A five-shape rotation plus
two case errors: `x`->`i`, `i`->`(`, `)`->`x`, `r`->`)`, `(`->`r`, `s`->`S`,
`o`->`O`. That is where `If 4i = 3`, `What is the value ofS(n42pi?` and the 8
rows reading `cOS` came from. Verified by rendering five occurrences of each
signature out of the PDF and reading them (`labels_check` contact sheet).

**3. `fill_math` dropped word spaces.** It rebuilt each line by concatenating
run texts with no separator, throwing away the space `lines_of` had already
inferred from geometry - hence `wsquare feet`, `Iff(x)`, `ofS(n`. Parts now
carry their x-extents and are rejoined wherever the measured gap exceeds
`SPACE_GAP` (1pt), the same threshold `lines_of` uses.

**4. `sections()` dropped whole choice blocks.** Some pages print no
`Correct Answer:` line. `choices = lines[ia+1:ic]` needed both markers, so all
four choices were discarded and the row rendered as an answerless grid-in -
that is what the "36 rows lost the choice list entirely" note was. Choices now
run to the `Rationale` marker when `ic` is missing, and `answer_from_rationale()`
recovers the answer from `Choice X is correct` / `The correct answer is N`.

Measured before -> after, over all 3,874 rows:

| | before | after |
|---|---|---|
| multiple-choice rows | 3,356 | 3,391 |
| ... that grade correctly | 3,340 | **3,391** |
| rows with fewer than 4 choices | 33 | **0** |
| rows with an empty or junk choice | 11 | **0** |
| grid-ins with no machine-readable answer | 81 | **11** |
| stems rendering with no text and no image | 0 | 0 |
| broken `<img>` | 0 | 0 |

The 11 remaining grid-ins state their answer only as a notation image in the
rationale; they still report "Not auto-scored". The 104 rows with no
`explanation_html` are all `source='Bluebook'` - they are not in either PDF, so
there is nothing to re-extract from.

**Frontend, same pass** (`public/index.html`):
- `pool()` filtered on `q.label`, which is not a column, so "My PT Mistakes"
  could never match anything and "Question Bank" returned the legacy rows too.
  It now filters on `source`, which is exactly the split (3,770 CollegeBoard /
  104 Bluebook).
- `img.minl` was scoped to `.cb`, so the notation crops inside a `.choice` were
  unscaled - one rendered 407px wide. Now capped everywhere.
- Dark mode inverts `img.minl`; the crops are black-on-white and were showing as
  white boxes. Figures keep their colours.

**Housekeeping:** re-extraction wrote 38,248 files into `public/qimg` (old crops
plus new). The 17,265 orphans are deleted; 20,983 remain, all referenced. Note
that is over Cloudflare's 20,000-file limit for Worker static assets, so a
`wrangler deploy` will now be rejected - `/qimg` needs to move to R2, or the
crops need to be fewer, before the next deploy. `wrangler dev` also hangs
silently when that directory is very large; if the server never answers, check
the file count first.

**31 authored reconstructions deleted.** Bank is 3,843 rows (3,770 CollegeBoard
+ 73 Bluebook). The removed rows all declared themselves in their own stem -
"Authored replacement. The original question's passage and choices were never
logged", "Reconstructed question. The original source page was not stored. This
is an authored reconstruction built from the logged sentence, the correct answer
and the saved rule - not the original wording", "Passage stored in abbreviated
form". They were not College Board questions and the home pill counts every row
as one. No `progress` row referenced any of them. Full rows are backed up to
`tools/deleted_reconstructed_rows.json` if they are ever wanted back.

Two false leads while doing this: matching on "reconstruct"/"authored" alone
hits seven real passages (the Globe Theatre, Zelda Fitzgerald, the
Reconstruction period). Match the boilerplate sentences, not the words.

**Not versioned:** `tools/` is in `.gitignore`, so the extractor fixes above
live only on disk, and the data itself lives only in the local D1 file under
`.wrangler/`. Neither is in git.

### Known Bugs

- **Spacing artifact, ~4% of Math rows measured (likely undercounted):** a
  variable glyph directly followed by a word loses its space — `"wsquare
  feet"` instead of `"w square feet"`. Same PDF-extraction spacing heuristic
  documented above (real-space vs artifact by glyph width), miscalibrated for
  some italic single-letter variables. Not yet root-caused or fixed.
- Tesseract `stem_text` (legacy OCR column) quality is mediocre: `Itfeatures`/
  `Itincludes` (lost spaces), `«` for bullets, mangled smart quotes. Still used
  as the "original image" toggle fallback for the 104 untouched Bluebook rows.
- `section` has three values, one is a typo variant: `Math` (1952),
  `Reading & Writing` (1872), `Reading and Writing` (50).
