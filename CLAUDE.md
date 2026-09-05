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
- `public/qimg/` — 5,528 cropped WebP images (gitignored, 44MB). Every one is
  referenced by a row; there are no orphans.
- `schema.sql` — D1 tables: `questions`, `progress`, `users`.
- Local dev DB: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/588d9571....sqlite`

Run local: `npm run dev`.

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
plus new). The 17,265 orphans are deleted; 20,983 remain, all referenced. That
was over Cloudflare's 20,000-file limit for Worker static assets and blocked
`wrangler deploy`. The LaTeX pass later cut `/qimg` to 5,528 files / 68M, well
under the limit, and the deploy goes through (see below). `wrangler dev` also
hangs silently when that directory is very large; if the server never answers,
check the file count first.

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

**Partly versioned:** `tools/*.py`, `tools/glyph_labels.json` and
`tools/apply_math.cjs` are tracked (`.gitignore` negations); the build outputs
(`glyphs.json`, the jsonl, `d1_chunks/`, `d1_sync/`) and the data itself - the
local D1 file under `.wrangler/` and the crops under `public/qimg/` - are not.

### Math as text, not pictures (2026-08-28, night)

Notation is now LaTeX in the row and KaTeX in the page. Before this pass 1,610
of 1,925 Math questions showed at least one cropped picture in the stem or the
choices, and 20,279 crops existed in total; after it, 439 questions
and 4,339 crops. 1,215 questions now carry real `\( ... \)`
notation, and 105 tables that used to be pictures are `<table>`.

**Why it was pictures.** `decode_slot()` refused three things and cropped them:
a glyph run crossing a fraction bar, a run on more than one visual row, and any
run containing an unlabelled shape. That is most notation. It now builds LaTeX
instead:

* a bar with ink above and below is `\frac{}{}`, recursively, outermost (widest)
  bar first;
* a bar with a radical flush to its left is `\sqrt{}` / `\sqrt[3]{}`;
* a short glyph off the baseline is `^{}` or `_{}`, with punctuation and the
  degree sign excluded (`NOSCRIPT`) - without that list every "f(x), where"
  became `f(x)_{,}`.

Two calibration bugs found by reading the output, both of which produce
*plausible wrong* math rather than an obvious failure, so both are worth
remembering:

1. **The bar test was containment, not overlap.** A fraction bar is drawn a
   point or two wider than its digits, so `b.x0 >= box.x0 - 1.5` rejected it,
   the fraction fell through to the linear reader and "1 over 71" came out as
   `171`. Nine choices in four sampled questions were wrong this way.
2. **The linear reader had no way to refuse.** Anything it could not structure
   it read left to right. `_linear()` now returns `None` when a full-height
   glyph sits more than `STACK_TOL` off the baseline - a numerator is full
   height, a script never is - so unrecognised stacking keeps its picture
   instead of inventing digits. Wrong notation is worse than a crop.

**Glyph labels: 93 -> 332**, covering 98.6% of glyph occurrences (was 94.1%).
`tools/sheet.py` renders the most frequent unlabelled shapes as a contact sheet
and `tools/addlabels.py` merges the readings back. The ~630 shapes still
unlabelled are chart furniture - scatter markers, arrowheads, rotated axis
titles - not characters.

**Tables.** `table_of()` reconstructs a `<table>` from the ruling: horizontal
and vertical strokes give the cell grid, and a cell's text comes from the page's
own runs plus the decoded glyphs inside it. Guards, in order of how much they
matter: the block must have >= 3 rules each way; nothing inside may be drawn
*and* wide *and* tall (that is a bar, a pie slice or a plot frame, so the block
is a chart); an evenly-ruled grid both ways is a coordinate plane, not a table.
Row and column bands are taken per-cell from the rules that actually reach that
cell, which is what keeps a two-row header ("Hours practiced") in one cell.
Verified by arithmetic: of the reconstructed tables with a Total row, 20 of 21
add up, and the one that does not is wrong in the source PDF (`d89c1513`:
60 + 35 = 95, the table prints 90).

Two things the first attempt got wrong here. Measuring rule length against the
*block* found no rules at all - `figure_blocks()` grows a block to swallow its
own captions, so a real rule never spans 70% of it; measure the strokes
themselves. And a cell's pieces sorted by y alone scrambled prose against
notation: "Less than 50%" came out "50% Less than", because the glyphs sit a
fraction of a point above the words. Band the pieces into lines first.

**Three sources of stray one-letter pictures, all fixed.** A chart's rotated
axis title is drawn just outside its own box, so `fill_math` treated each letter
as loose notation and cropped it - hence the column of black letter-tiles under
every graph. Leftover glyph rows inside a figure grown by `FIG_PAD` are now
dropped. Blocks no longer reach up into the metadata banner (they were cropping
"Trigonometry" into the top of the picture). And a page whose diagram is a
*bitmap* has no vector cluster for `P.figures()` to find, so the whole diagram
was cropped inline at x-height in the middle of the sentence; `raster_figures()`
promotes any embedded image at least 80x40pt to a figure.

**The ceiling: raster pages.** 434 of the 2,030 Math pages draw no vectors at
all - College Board embedded the notation as bitmaps, which carry no glyph
identity, so hashing cannot decode them. Those 439 questions keep their crops.
Template matching was built and measured against that gap; see below.

**Frontend** (`public/index.html`):

* KaTeX auto-render on `\( \)` and `\[ \]`, loaded *without* `defer` - the page
  renders from an inline script that runs before deferred ones, and `mathify()`
  silently no-ops if the library is not there yet. `$` is deliberately not a
  delimiter; money appears all over these questions.
* Math uses the Reading two-pane layout. `splitContext()` pulls `.qfig`,
  `.qtable` and `.qimg` out of the stem into the left pane; a question with none
  of those renders one full-width pane. That pane fills the window and holds its
  measure with `max-width` on its children - a centred *pane* left bare strips of
  page background down both sides, which read as black gutters in dark mode.
* Desmos docks left (`margin-left: 540px`) and the question drops back to one
  column with the figure inline, because the split has nowhere to go.
  `renderPanes()` is split out of `loadQuestion()` so toggling the calculator
  re-lays out without restarting the question timer.
* Figures and tables open in a full-screen viewer: wheel or buttons to zoom,
  drag to pan, Escape or click-outside to close. Answer choices are deliberately
  excluded - clicking a choice is how you answer it, and a viewer opening over
  that would hijack the click.
* The crops that remain blend into the page instead of sitting in white or
  black chips (`mix-blend-mode: multiply`, and `invert` + `screen` in dark).
* `renderStem()` no longer flattens `<table>` into `<pre>`; the tables are real.

**Applying a re-extraction:** `node tools/apply_math.cjs tools/math_new.jsonl`
updates the local D1 sqlite in place and writes `d1_chunks/` for the remote.
Then delete the crops nothing references any more - the re-extraction leaves
about 15k orphans, and `public/qimg` went 136M -> 68M.

### Raster pages: template matching, measured and dropped (2026-08-29)

`tools/rastermath.py` decodes an embedded bitmap by matching each mark against
a bank rendered from the labelled vector glyphs, then hands the resulting
(character, rectangle) list to the same `_tex()` layout the vector path uses, so
a raster page would decode through the identical fraction and exponent logic.
It works. It is not accurate enough to use, and it is **not wired into the
extractor** - `extract.py` still crops those images.

**The binding constraint is resolution.** `page.get_image_info()` reports the
embedded bitmaps at 1.33 px/pt - about nine pixels to a digit. Rendering them at
any zoom is pure interpolation; there is no more information to recover.

Measured two independent ways, because "it looks right on the examples I tried"
is exactly how a silent corruption ships:

1. **Against exact ground truth.** `tools/rastersweep.py` takes the *vector*
   pages, where the glyph hash decodes exactly, renders those expressions down
   to 1.33 px/pt, and decodes them back. Over 534 expressions the best precision
   at any threshold is 67%, at 4% coverage; at 22% coverage it is 45%. The curve
   is nearly flat, which is the important part - tightening the accept
   thresholds does not buy precision, so the errors are confident, not marginal.
2. **Against real bitmaps, read by eye.** `tools/rastercheck.py` renders real
   embedded images beside the decoder's answer. Loosened to 12% coverage, 34
   sampled expressions came back 32% correct, and the misreads are the ones that
   would quietly break a question: `a` -> `c7`, `7` -> `f`, `b` -> `6`,
   `(5,5)` -> `(525)`, a square root -> `^{\circ}m`. At the conservative
   thresholds the file ships with it is ~96% right but reads 0.9% of the
   notation (`tools/rastercover.py`), all of it one or two characters.

So there is no operating point: precise enough to trust means reading almost
nothing, and reading a useful fraction means a third of it is wrong. A crop is
correct and legible; a wrong equation is neither, and the student cannot tell.

Things that made the matcher itself much better along the way, in case anyone
revisits this with a higher-resolution source: match density profiles rather
than binary stencils (crisp templates against blurry queries punish a correct
match for stroke weight), blur both by 3x3 before comparing (0.79 -> 0.91 on a
correct `x`), build the template bank through the *same* low-resolution path as
the queries, keep the aspect ratio as a separate penalty (it is the only thing
that separates `=` from `:` once both are squashed into a square grid), and
raise the ink threshold to 195 so an italic `p`'s hairline join survives
thresholding instead of splitting into three components.

### Remote D1 rebuilt, and the first successful deploy (2026-08-29)

`wrangler deploy` now works: `/qimg` is 5,528 files (68M), under the 20,000-file
asset cap that blocked it before. Live at
`https://sat-question-bank.liuallen1209.workers.dev`.

**The remote D1 had drifted off the schema and could not be patched.** It still
had the original columns - `label`, `qtype`, `rationale_html` - and none of
`explanation_html`, `source_page`, `has_figure`. So the 1,925 `UPDATE`s in
`d1_chunks/` (which set `has_figure`) would have failed on every row, and the
remote still carried the 31 authored reconstructions that were deleted locally.
Incremental patching was the wrong tool; the table was rebuilt from the local
sqlite instead.

`tools/d1_dump.cjs` writes `d1_sync/part_*.sql` - one `INSERT` per row, chunked
under 900KB so each file fits a single `wrangler d1 execute --remote --file`.
The sequence that worked, and the reason for each step:

1. `wrangler d1 export --remote --table questions` to `backup/` first. This is
   the only thing that makes the rest reversible.
2. Load into `questions_new`, not `questions`. If a part fails halfway the live
   table is still intact, and the outage is the two statements in step 4 rather
   than the whole upload.
3. Verify the staging table against local *before* swapping - row count,
   `SUM(has_figure)`, and counts of `qtable` and `\(` in the stem.
4. `DROP TABLE questions; ALTER TABLE questions_new RENAME TO questions;`

`users` and `progress` were both empty remotely, so `questions` was the only
data at risk. Check that again before repeating this - the recipe drops a table.

**Watch the shell when counting LaTeX rows.** `LIKE '%\(%'` through
`wrangler d1 execute --command` and through `node -e` do not survive the same
escaping, and the two disagreed by 500 rows for no real reason. Use
`instr(stem_html, char(92) || '(')`, which has no backslash to mangle. Both
sides then agreed at 1,156.

Final state, local and remote identical: 3,843 rows, 1,156 with `\( ... \)`
notation, 103 with reconstructed `<table>`s, 777 with figures.

### UI pass and dead-code audit (2026-08-29, later)

**Notation crops were all scaled to the same height.** `img.minl` carried
`max-height: 2.4em`, so a lone italic `a` and a two-storey fraction rendered
the same size, and both towered over the sentence around them - the "some text
much larger than others" report. Height is the wrong knob: `tools/extract.py`
renders every crop with `save_figure(..., zoom=5)`, five device pixels to a PDF
point off an 11pt source, so the crops already agree on scale and only needed
dividing by it. `zoom: .29` restores the source proportions
(5px/pt over 96/72 px/pt, times 16/14.67 to carry 11pt up to the 16px stem) and
every crop now sits at text size regardless of how tall its expression is.
KaTeX's own 1.21em default was the smaller half of the same complaint; 1.06em.

**Fields the schema rebuild had dropped.** `q.qtype` and `q.label` were still
read in five places. The grid-in branches survived on their `|| !q.choices.length`
fallback, but Browse typed every grid-in as MCQ and the preview modal never
showed their answer. Grid-in-ness is now derived once at load
(`q.spr = !q.choices.length`) and read from there.

**The domain "All" chip never turned off.** `drawFilters` skipped `data-f="dom"`
in its toggle loop, because the domain chips are re-rendered just below - but
the *static* All chip is in the markup, not in that re-render, so it kept the
`on` class it was written with. Dropping the exclusion is enough; the loop runs
before the re-render, so the chips it wipes do not care.

**Section had a typo variant.** 50 Bluebook rows were `Reading and Writing`,
reachable only through "Both" and missing from the dashboard's per-section
totals. Fixed in the data, local and remote, not in the client: one UPDATE and
every consumer is right. Sections are now Math 1,947 / Reading & Writing 1,896.

**Tables in a stem lost their borders in the preview modal**, which inserted
`renderStem()` output into an unclassed div while the table rules are scoped to
`.stem`/`.cb`/`.qtable`. The player was always fine. The one question that ships
an HTML table wraps it in `<figure class="image">`, which brings the UA's
`0 40px` margin and no scroll box, so its seventh column was unreachable;
`.cb figure` now owns the margin and the `overflow-x`.

**Removed.** `server.js` and `start_server.bat` - the server read
`questions.json`, deleted with the prototype root, and the .bat pointed at an
empty directory. The tesseract OCR experiment (`ocr_stems.cjs` and friends,
`eng.traineddata`), superseded by glyph hashing. `d1_chunks/` (the abandoned
incremental migration) and `d1_sync/` (applied, and regenerable from
`tools/d1_dump.cjs`). `package.json` lost its `start` script and the
`tesseract.js`, `sqlite3` and `canvas` dependencies, none of which anything
imports. `schema.sql` was missing `stem_text`; added.

**Kept, deliberately.** `extract_math/` and `extract_rw/` (147M of jsonl and
crops) are the extractor's output and the only copy of it short of re-running
the PDFs; `backup/` holds the pre-rebuild remote dump; the raster-matching
harness stays for the reasons recorded above.

### Accounts: email/password, and progress that actually saves (2026-08-30)

Asked for account data save for Google **and** email/password sign-ins. Two of the
three pieces were broken before the feature was even added.

**Progress never loaded for a signed-in user.** `initAuth()` is `async`; `load()`
was called on the line after it without an `await`, so `load()`'s
`fetch('/api/progress', { headers: sbHeaders() })` ran while `uid` was still
`null` and asked for the progress of user `''`. Nothing in
`onAuthStateChange` refetched it either, so signing in changed the header text and
nothing else. Now `(async () => { await initAuth(); await load(); })()`, and an
account change re-runs `loadProgress()` on its own.

**Google sign-in dropped the session.** `/auth/callback` served a hand-rolled page
that read the URL fragment and stashed the token under `localStorage['sb_token']`,
then redirected to `/`. supabase-js stores its session under
`sb-<project-ref>-auth-token` and never reads `sb_token`, and the redirect stripped
the fragment before supabase-js could parse it. The route now serves the app
itself, so supabase-js's own `detectSessionInUrl` handles it; the client tidies the
address bar afterwards. The email-confirmation link lands on the same route.

**`X-User-Id` was a client-supplied header.** Any caller could read or overwrite any
account's progress by naming its user id. The Worker now takes the Supabase access
token off `Authorization` and resolves the caller through
`GET {SUPABASE_URL}/auth/v1/user`. One extra fetch, no crypto in the Worker, and it
works whether the project signs JWTs with HS256 or an asymmetric key. `SUPABASE_URL`
and `SUPABASE_ANON_KEY` are `[vars]` in `wrangler.toml` — both are the publishable
pair the browser already ships, not secrets.

**The `users` table existed in the schema and had never been written to.** Any
authenticated request now upserts the row. The name is only overwritten when the new
one is non-empty, so signing in with email/password after Google does not blank out
the Google display name.

Other pieces:
- `/api/progress` POST accepts a row or an array and uses `DB.batch`, which is what
  lets the sign-in merge go up in one request.
- Signed out, answers are kept in `localStorage` under `satq_progress` rather than
  evaporating on reload. On sign-in, rows the account does not already have are
  pushed up and the local copy is cleared. Server rows win a collision — the
  account is the record, the local copy is a holding pen.
- `authModal()` carries Google, email/password sign-in and sign-up in one modal.
  The project has `mailer_autoconfirm: false`, so a sign-up returns a user with no
  session; that branch says to check the inbox instead of pretending to sign in.

Supabase project settings this depends on (checked via `/auth/v1/settings`):
`email: true`, `google: true`, `disable_signup: false`. The redirect allowlist must
contain `<origin>/auth/callback` for both the OAuth return and the confirmation
link.

### Dashboard: a rail, dropdowns, and topics opened out (2026-08-30)

Retheme after the Growly LMS shot: a dark navy rail pinned left in both light and
dark mode, the work on a light board beside it, mint green for anything that
reads as progress. The rail keeps its own palette either way round - that
contrast is what carries the look, so it is not wired to `data-theme`.

The horizontal `.tabs` strip is gone; navigation is the rail (Question Bank,
Browse, Dashboard) with the account pinned at its foot. Under 980px the rail
drops to a 66px icon strip and the topic table sheds its progress column.

Section, difficulty, source and count were chip rows and are now four `<select>`
controls. Domain is the one filter that opened out instead: a table of domains,
each with its skills under it, one row per skill carrying a tick, a bar for how
much of it has been seen, and accuracy. Domains collapse and the shut ones are
remembered in `satq_shut`.

`F.dom` (one domain at a time) is replaced by `F.skills`. `null` means every
topic, so a first-time visitor is not filtered down to nothing; `[]` means they
pressed Clear. Ticking the last topic collapses the list back to `null` rather
than pinning a set that goes stale the next time the bank grows. Changing
section or source clears the picks, because those change which topics exist at
all - difficulty does not.

`base()` is what the dropdowns leave on the table and `tally(list)` counts a
pass over it, so the topic table and the number beside Start practice can never
disagree. The dashboard calls the same `tally()` over the whole bank. That
replaced the copy of the counting loop that used to live in `drawDash`, and its
`QS.find` per progress row, with one `Map` lookup.

### An attempt log, a mistakes page, and graphs that mean something (2026-08-30)

**The source dropdown's "My PT Mistakes" never filtered a mistake.** It read
`(q.source === 'Bluebook') !== (F.src === 'mistakes')`, so picking it showed every
practice-test question in the bank and picking the other option hid them. Source is
now three real options: `official` (bank), `pt` (the Bluebook practice-test rows),
and `mistakes`, which is not a source at all and cuts across both. Section,
difficulty and the topic ticks narrow it the same as any other source, which is what
"only choose mistakes by section/topic" needs and takes no extra code.

**The home cards and the dashboard reported different numbers for the same thing.**
`drawHomeStats()` counted `Object.keys(PROG).length` (every row, including ones with
no attempt) and scored only `marker === 'Green'`; `tally()` requires `p.attempts` and
counts `Orange` — wrong once, right since — as correct. Answer one question wrong and
then right and the two screens disagreed. `drawHomeStats()` now reads `tally()`.

**Progress could not answer "how many questions did I do on Tuesday".** `progress`
holds one `last_reviewed` per question and overwrites it on every answer, so
re-drilling an old question silently moved it out of the day it was first done and
the count for that day went down. New `attempts` table — `(user_id, question_id, ts,
correct, time_taken_ms)`, `UNIQUE` on the first three, append-only, `INSERT OR
IGNORE`. `GET/POST /api/attempts` mirror the progress routes, including the
signed-out-in-localStorage-then-merged-on-sign-in path (`satq_log`). Every graph is
drawn from this; `progress` is still the per-question state the topic list reads.

**Coming back from practice refetched all 3,843 questions.** `showHome()` called
`load()`. It calls `refresh()` now, which redraws the four screens off the data
already in memory. `refresh()` also exists so no caller can redraw three screens and
forget the fourth.

Dashboard: a 7 / 30 / 12-month / all-time range picker, KPI cards, a stacked bar per
bucket (green correct on the bottom, red wrong above), a 26-week calendar heatmap,
and accuracy by difficulty. Days are keyed on the local calendar, not UTC, so an
11pm answer belongs to the day you were sitting there. The charts are flex columns
with percentage heights — no chart library, nothing new on the CDN allowlist. Bars
past ~12 get their x-axis label thinned out; the label spans overflow into their
empty neighbours rather than being clipped to 10px of "Aug".

**Both charts are labelled, because a bar with no scale beside it means nothing.**
The activity chart has a y-axis (0 / half / max) with a gridline at each, drawn in
CSS off `.chart`'s two borders and one background gradient. The max is rounded up
through `niceMax()` to 4, 5, 6, 8, 10, 20, 30 and so on rather than sitting at
whatever the tallest day happened to be, so the halfway label is always a whole
number and the height of a bar can be read off the axis. Under it a caption names
what each axis carries and the date range in full ("Sat, Aug 1, 2026 – Sun, Aug 30,
2026"). The heatmap gained a weekday strip down the left (Mon / Wed / Fri, lined up
because the grid runs to the end of this week and therefore starts on a Sunday), a
month row across the top placed by grid column, and a Fewer → More key.

Hovering a bar or a square shows the day, the number answered, the right / wrong
split and the accuracy. One `.tip` node lives on `document.body` and follows the
pointer; the two panels delegate `mousemove` to it, so redrawing their innerHTML
rebinds nothing. It replaced `title=` attributes, which could not show a date the
axis had thinned away.

The by-section / by-domain / by-skill bars were drawing coverage (attempted out of
the bank) next to an accuracy percentage — one number under the bar, a different
one beside it, and a scale that looked broken because it was measuring something
else. Both are accuracy now, the row reads `72% · 86/119` (right / answered), and a
skill with no attempts is left out rather than shown as an empty bar. The panel
headings say so. Domain headings and panel titles went up to 23px / 19px.

Mistakes page: every question with `marker` Red (still wrong) or Orange (corrected
since), as cards carrying section, difficulty, status and topic, filtered by
section / difficulty / topic and a Needs work / Corrected / All switch. The topic
dropdown is built with every filter applied except the topic one, so picking a topic
cannot empty the dropdown it came from and no topic is offered with nothing behind
it. Clicking a card drills that one question; **Drill these** shuffles the whole
filtered set into the player.

Not built, not asked for: the per-question notes that sit in the OnePrep screenshot
this page is modelled on.

### Extraction repairs — `tools/fix_math_text.cjs`

Both bugs that stood here are closed. What the audit actually found, once the
detector stopped firing on ordinary English (`for` is not `f` + `or`, `land` is not
`l` + `and`), was four defects, all inside or beside inline maths, and all of them
rendering in KaTeX as a row of italic single letters:

1. **A function name that lost its backslash** — `sinQ`, `tan(x)`, `cos6`, 70+
   spans. A run that is itself an English word is skipped, which is what keeps
   `cost` from becoming `\cos t` and `seconds` from becoming `\sec onds`. The one
   place the bank means `\cos t` (`\(sinp = cost\)`, complementary angles p and t)
   is why `cost` is off the word list.
2. **A unit or noun typeset as maths** — `\frac{42 posters}{1 minute}`. Wrapped in
   `\text{}`, one box per run of words, with the space in front swallowed and a
   space added behind when the next thing along is a digit or a command.
3. **A number or variable fused to a word** — `3hours`, `xhours`, `8squareinches`.
   This is the spacing artifact the old note described; it survived in 1 row as
   `xhours`, not the ~4% estimated, the rest having gone with the LaTeX pass.
4. **Mojibake** — UTF-8 punctuation read back as code page 437, so an em dash
   arrives as `ΓÇö` and a radical as `ΓêÜ`. 13 rows, seven sequences, a table.

Plus three named one-offs the rules cannot reach: two scraps the glyph extraction
emitted as maths, and a quadratic formula that had lost its discriminant (the lines
around it work out to 64 + 56, so what it should say is not in doubt).

Geometry labels (`ABCD`), variable products (`xyz`, `kab`) and anything already in
`\text{}` are left alone — the fixer only rewrites what one of its rules names.
`choices_json` goes through parse / fix / stringify, because its backslashes are
JSON-escaped and rewriting the raw string would drop them.

140 rows repaired, then 2 more for the one-offs. **Every one of the 1,390 questions
with maths in it now renders with zero KaTeX errors** (checked by putting each into
the DOM and calling `renderMathInElement`, which is the path the app uses — checking
the raw HTML instead reports false failures, because `&lt;` is still an entity until
the parser has had it).

`--test` runs the self-check, `--write` fixes the local D1, `--emit` writes
`migrations/0002_math_text_fix.sql` for the remote. `--emit` reads the repaired
table rather than the run's diff, so it still produces the whole migration after
the local rows have already been fixed.

### The OCR text column is gone from the wire

`stem_text` was Tesseract's read of the question image, shown in place of the image
with a "Show original image" toggle. Two things were true: no row's `stem_html` has
carried `<div class="qimg">` since the figures were re-extracted, so the branch that
would show it had been unreachable; and for the 241 figure-heavy rows the text is
noise (`2. . 1s 16 Pp Life 12 . 0f «`), with 15 more rows whose `stem_text` belongs
to a different question entirely. It was also being pasted into the tutor's prompt.

`hasStemText`, `stemTextView`, the toggle, the `qimg` branches and the CSS are
deleted, and `/api/questions` selects its columns instead of `SELECT *`. The column
stays in the table as the raw record. **The payload went from 9.44 MB to 7.99 MB**,
15% off every cold load.

### Chatbot out, export in; helpmeaceit.page (2026-09-02)

**The AI tutor is gone.** `/api/chat`, `TUTOR_PROMPT`, the `GEMINI_*` vars and the
`CHAT_RL` rate limiter are deleted, along with the `#ai-panel` chat UI. Nothing in
the repo calls Gemini any more, so `GEMINI_API_KEY` is a dead secret — delete it
with `wrangler secret delete GEMINI_API_KEY`.

**In its place, "⧉ Copy for AI".** One button, one clipboard write, no model and no
per-call cost. `exportPrompt()` builds a plain-text prompt — section/domain/skill/
difficulty, the stem, the lettered choices, the stored answer, the student's own
answer and whether it was right, then the official rationale. `toText()` does the
HTML→text step, and exists because a naive tag strip loses the three things the
prompt most needs: an `<img>` (the only copy of a diagram — it becomes
`[image: <absolute URL>]`), a table's shape (`</td>` → ` | `, `</tr>` → newline),
and the line breaks. LaTeX passes through untouched.

Clipboard access can be refused (an insecure origin, a denied permission), so the
catch renders the prompt in a modal with the text selected — still an export, one
Ctrl+C away. Verified: the automation browser has `clipboard-write` denied at the
profile level, which exercised exactly that path.

**Domain.** `wrangler.toml` claims `helpmeaceit.page` and `www.` as
`custom_domain` routes; the Worker 301s `www` → apex, because Supabase only returns
an OAuth or confirmation link to an origin on its allowlist and a session started
on one host and finished on the other is a session dropped. Add
`https://helpmeaceit.page/auth/callback` to that allowlist. `harden()` also sets
HSTS now.

**"Allowlist the Cloudflare IPs" does not apply here.** That protects an origin
server sitting behind Cloudflare's proxy, so attackers can't bypass it by hitting
the origin's IP. This app has no origin: the Worker *is* the edge. There is no IP
to leak and nothing to allowlist.

### Grid-in grading was wrong for ~100 questions (same pass)

Found while verifying, not reported. `isRight()` compared the stored answer string
to the typed one, so:

- **88 rows store a fraction.** A student typing `2.5` against a stored `5/2` was
  marked wrong. `num()` now evaluates `a/b`.
- **7 rows store a list** (`-.9333, -14/15`). Nothing but that exact string matched,
  so those questions could never be answered correctly at all. The answer is now
  split on `,` / `or` and any alternative counts.
- **Decimals are graded at grid precision.** `1/6` accepts `.1666` (truncated) and
  `.1667` (rounded), by rounding/truncating the true value to however many decimals
  the student gave — but only at 3+ decimals, so `.2` is still not an answer of 1/6.

**And the 11 "unscorable" grid-ins are scorable.** The note above said they state
their answer only as an image; nine of eleven state it in rationale *text*, and the
other two state it in the closing "Note that … are examples of ways to enter a
correct answer" sentence, which lists every accepted entry. All 11 recover now.
Two things the first attempt got wrong, both worth remembering: `7, 8, or 13` needs
an explicit `", or"` branch or the list silently stops at 8; and a token can open
with a dot (`.5`, `.1666`), so requiring a leading digit drops three of them.

**Rationale figures had no styling.** 926 rows carry a figure in
`explanation_html` as a bare `<img alt="Figure">` with no wrapper class, so they
picked up neither the width cap nor the dark-mode handling — a full-bleed white
block bleeding out of the explanation. The explanation container is now
`.cb.expl` and its non-`.minl` images are capped and inverted in dark mode.

`plain()` (the mistakes-card teaser) now strips the Passage/Prompt headings the
player already strips, so a card no longer reads "Passage … Quest".

`pt10_math_m2_q16` printed all four choices inside its own stem
(`migrations/0003`), and `┬▓` (CP437 for `²`) joined the `MOJIBAKE` table. Those
were the only two occurrences in the bank; `úñ` and `áñ` look like mojibake and are
not — they are "Zúñiga".

### Verification: all 3,843, in the browser

Hand-clicked a sample first (figures, reconstructed tables, KaTeX, notation crops,
MCQ and grid-in, right and wrong paths, two-passage RW, the HTML-table row, the 11
grid-ins, the rows this file lists as defective). That sample is what found the
rationale-figure bug and the grid-in grading bug — neither shows up as an error,
only as something that looks wrong.

Then a DOM sweep drove the real player through every question — click a choice or
type into the grid-in, open the explanation, assert, press Next. Per question:
non-empty render, no `Passage`/`Prompt` scaffolding, no `<img>` with
`naturalWidth === 0`, no `.katex-error` in stem or rationale, no mojibake or
replacement character, no leaked rationale, four choices for MCQ, exactly one
choice marked correct (`.right` or `.corrected` — a re-answered question marks the
right one `corrected`, not `right`), a non-blank "Correct answer" line, and a
non-empty explanation.

**3,770 official + 73 practice-test = 3,843. Zero failures.** 3,360 MCQ, 483
grid-ins, 0 not auto-scored (was 11), 73 with no explanation — all `source='Bluebook'`,
which is expected, they are in neither PDF.

Note the three stale claims this file used to make, all fixed earlier by the
extractor root-cause pass and confirmed here: `d4d513ff`/`2e8cc1c0`/`6fa593f1` read
`x` correctly, and `1efd7ef3` reads `\(\sin 42\pi\)`.

Left alone: two RW skills carry a PDF header as their name ("Assessment T est
Domain Skill Difficulty SA T Reading and Writing …", 151 questions), visible in the
topic list. A `<figure>` crop in ~583 rationales is a picture of the rationale prose
rather than a diagram — now sized and themed correctly, but still a duplicate. Both
need re-extraction, not a client patch.

### Skill names, and the rationale crops that were not duplicates (2026-09-02, later)

Two things this file had listed as "needs re-extraction". Only one of them did.

**Skill names: a migration, not an extraction.** `import_sql.cjs` never touches
`section`/`domain`/`skill`, so the garbage in that column never came from the
extractor and re-running it could not have fixed it. `migrations/0004`, 237 rows:

- 151 rows carried the PDF's own page header as their skill ("Assessment T est
  Domain Skill Difficulty SA T Reading and Writing Cr aft and Structure T ext
  Structure and Purpose"). The real skill is the tail of the string -
  `Text Structure and Purpose` (149) and `Cross-Text Connections` (2).
- 72 rows carried the narrow-space artifact in the name itself
  (`T wo-variable data: ...`, and one missing Oxford comma).
- 14 Bluebook rows spell three skills with `&` where the College Board rows
  spell them out, which split each into two entries in the topic list.

RW is now 10 skills. Left alone: 12 Bluebook Math rows storing a *domain* as
their skill (`Algebra`, `Geometry & Trigonometry`) and 7 ad-hoc names
(`Data distributions`, `Knowledge gap`) - picking the official skill for those
means reading the question, which is not a rule.

**The rationale figures were load-bearing, not duplicates.** The note above
called them "a picture of the rationale prose ... still a duplicate". They were
not. `to_html` drops the text a figure covers, so wherever a crop had swallowed
prose, the crop was the *only* copy of it:

```
c946d5bd  "...which is equivalent to \(g(b\)"  [crop]  "equation \(b+28=1\) yields..."
```

Deleting those `<img>` tags - the obvious reading of the old note - would have
thrown away the middle of 81 rationales. Checking what the surrounding text
actually said is what caught it.

**Root cause.** A paragraph's inline notation is vector art, so `P.figures()`
clusters the fraction bars of several neighbouring lines into one "figure" and
`save_figure` crops the prose behind them. `figure_blocks`'s docstring claimed
it stopped at body text and `is_prose` existed for exactly that - and was never
called. Anything the block covered was then dropped from the flow and skipped
by `fill_math`, so the notation was never decoded either.

`on_prose()` now rejects a block whose height is >=15% covered by body-text
lines. Threshold measured, not guessed: over all 1,056 Math crops joined back
to their source clusters, real charts and tables top out at 0.10 coverage (a
caption clipping the edge) and glyph swarms start at 0.20. A rejected region
falls through to `fill_math`, which decodes it as LaTeX or crops it inline.

Two calibration notes worth keeping:

1. **Aspect ratio and stroke height do not separate them.** The first attempt
   used `max drawing height / block height`, on the theory that a chart has a
   tall axis. A grid drawn as many short segments scores 0.20 (`df71424b`, a
   real graph) and a two-line prose crop scores 0.36 (`c8db0e19`). Overlap with
   the text layer is the signal; ink geometry is not.
2. **The test must run after `table_of`, not before.** A table row starts at the
   left margin and runs the full width, so it *is* prose by this test. Running
   the check inside `figure_blocks` turned 7 reconstructed `<table>`s back into
   flat prose. It lives in `build()` now, after the table branch.

Measured over all 1,925 Math rows, old extraction -> new:

| | before | after |
|---|---|---|
| figures in `explanation_html` | 724 | **32** |
| figures in `stem_html` | 332 | 330 |
| reconstructed `<table>`s | 103 | 103 |
| `choices_json` changed | - | **0** |
| `correct_answer` changed | - | **0** |
| rationale text recovered | - | **+24,263 chars over 81 rows** |
| rationale text lost | - | **0** |

The two stem crops that go were both pictures of the question itself, and the
text under them was broken: `(bh )` reads `(bhp)` now, and `1a722d7d`'s
"Let the function p be defined as ," gets its expression back.

**CSP was blocking the Desmos calculator in production.** `harden()` sets no
`frame-src`, which falls back to `default-src 'self'`, so the panel was blank on
the deployed site. Confirmed against it before fixing:

```
Framing 'https://www.desmos.com/' violates the following Content Security Policy
directive: "default-src 'self'". ... Note that 'frame-src' was not explicitly set
```

**Re-verified in the browser, all 3,843.** Same sweep as before - click a choice
or type the grid-in, open the explanation, assert, Next. One failure, and it is
pre-existing: `72ae8a87` extracts five choices, two of them labelled C, because
choice B's text is split across B and C. All 4,380 `/qimg` references resolve;
`public/qimg` is 4,843 files / 24.3M after deleting 829 orphans.

**Applying this:** `node tools/apply_math.cjs <jsonl>` writes local D1 and
`d1_chunks/`. It overwrites `stem_html`/`choices_json`/`explanation_html`
wholesale, so it **reverts `migrations/0002`** - re-run
`node tools/fix_math_text.cjs --write` (142 rows) and `--emit` straight after,
and push the regenerated 0002 to the remote *after* the chunks.

### Analytics beacon, and proving the Supabase allowlist (2026-09-03)

`static.cloudflareinsights.com` is in `script-src`, in **both** CSP sources. Cloudflare
injects the Web Analytics beacon into the HTML at the edge, so it is not something the
page can decline; without the origin the only effect is a console error and no
analytics. Its own POST goes to `/cdn-cgi/rum` on this origin, already covered by
`'self'`. The beacon is not in the served HTML yet — auto-injection is off in the
dashboard, which is the remaining half and is not settable from wrangler.

**The Supabase redirect allowlist can be checked without signing in.** `/auth/v1/authorize`
always 302s to Google whether or not `redirect_to` is allowed, and `state` is an opaque
UUID, so the response says nothing. But that UUID is the primary key of `auth.flow_state`,
and GoTrue writes the *accepted* redirect into its `referrer` column:

```sql
select id, provider_type, referrer from auth.flow_state order by created_at desc limit 4;
```

An allowed `redirect_to` is stored verbatim; a disallowed one is replaced by SITE_URL.
`https://helpmeaceit.page/auth/callback` stores verbatim, so it is on the list, and
SITE_URL is the apex.

### The deploy had no images, and 23 Math questions had no answer (2026-09-03)

Reported as "figures not rendering, weird text formatting, the eqns not popping
up". Two unrelated causes, and only one of them was in the code.

**Production was serving none of `/qimg`.** Every crop 404'd on
`helpmeaceit.page` - the figures and, because most notation is still a crop, the
equations with them. A question whose stem and choices are pictures rendered as
a sentence with a hole in it and two blank choice buttons, which is exactly what
the report showed. Locally all 4,847 references resolved. Nothing in the app or
the CSP was wrong: the last `wrangler deploy` simply went up without the
directory (`public/qimg` is gitignored, so a checkout that has never run the
extractor - a worktree, say - has no crops to upload). Deploy from a checkout
that has them, and check the file count wrangler prints.

**23 Math questions could not be answered at all.** All four choices rendered
identically - four `x 1 2 3`, four `Number Frequency`, four copies of the same
axis numbers. Found by rendering every one of the 1,925 Math questions through
the real render path and asserting the four choices differ; it is invisible to
every check that only looks for empty or broken output.

Root cause, in `tools/extract.py`: four choices printed as four small tables are
one ruled block on the page, so `table_of` reconstructs them as **one** table -
and `build()` put it in `tail_figs`, which is only ever read for
`explanation_html`. The table was thrown away and the choices kept nothing but
the shared header. Fixes, in the order they matter:

- `split_choice_table()` cuts the reconstructed table where its first cell
  repeats and gives each choice its own `<table>`. It fires only when the number
  of groups equals the number of choices, so an ordinary table in the choice
  band is left alone.
- Choice-band tables now go into `fill_math`'s `skip`. Without that the same
  region is read twice and the choice keeps the `\(x 1 2 3\)` as well.
- `CHOICE` no longer requires text after the letter. Once the notation is
  skipped the line is just `A.`, and `^([A-D])\.\s+(.*)$` does not match that -
  the choices vanished entirely.
- The skip rect is clipped to the choice band. A reconstructed table's bounds
  reach up past the "Answer" line, and masking that far erased the stem's own
  data list (52f9a246 printed `, , , , , , , ,`).
- `rationale_start()` is `rationale_top()` with the page number. Comparing y
  alone drops the choice tables of a two-page question, whose choices sit low on
  the first page and whose rationale starts near the top of the second.
- A header that is real text ("Number Frequency") is read twice - as the
  choice's own line and as the table's head row. The duplicate is dropped.

`python tools/extract.py --selftest` covers the splitter and the letter regex.

Verified against the source, not just against itself: the four choice bands were
rendered straight off the PDF and read by eye for six of them, and for all 22 the
choice stored as correct was checked to hold the numbers its own rationale names.

**Two named one-offs.** `36f068e2` offers four scatterplots, which are art with
no text to recover, so each choice's band was cropped to `36f068e2_ch<letter>.webp`.
`72ae8a87` had choice B running onto a line the extractor read as a bullet, which
opened a fifth choice also labelled C; joined back on.

**Also in `migrations/0005_math_render_fixes.sql`:** the two scraps in `5da5c665`
KaTeX cannot parse (a `\sqrt[3]` with nothing under it, and a quadratic formula
that lost its discriminant - the lines around it give 25 + 80), and 15 rows whose
`\( ... \)` holds no mathematics at all, only a unit or a phrase, so it rendered
in the maths font mid-sentence (`\(\text{ in centimeters } (cm)\)`).
`node tools/apply_choice_tables.cjs <jsonl>` writes the local D1 and that
migration; `--test` is its self-check.

**Frontend** (`public/index.html`): a `.qfig` inside a `.choice` had no styling
at all - the figure rules are scoped to `.cb`, and a choice is not inside one -
so a graph choice rendered full width on a white square. Capped, blended, and
inverted in dark mode the way the other crops are. The lightbox handler also had
to stop firing on it: clicking a choice is how you answer, and a viewer opening
over that would hijack the click.

Measured over all 1,925 Math questions, before -> after:

| | before | after |
|---|---|---|
| questions whose choices are all identical | 23 | **0** |
| MCQs with four distinct labelled choices | 1,448/1,449 | **1,449/1,449** |
| KaTeX errors in stem, choices or rationale | 1 | **0** |
| spans of raw LaTeX left on the page | 25 | **0** |
| `/qimg` references that resolve | 4,843/4,843 | 4,847/4,847 |
| orphaned crops | 2 | **0** |

Left alone, and why:
- `1ee962ec` and `4acd05cd` split their last choice's table across a page break.
  The continuation is at the very top of the next page, and `P.figures()` drops
  anything above `BANNER_BOTTOM` (the metadata banner, which only page 1 has) -
  and the fragment is under `FIG_MIN_H` besides. Choice D shows 3 of its 4 rows.
- A stacked fraction inside a table cell reads as two lines, so `1/16` prints as
  `1 16` (`f28944ff`, distractor cells only).
- ~350 stems print a space before `?` or `,`. That is what the source PDF prints.

### Every Math question is answerable (2026-09-03, later)

Asked for exactly that, whatever it took. The audit that found the gap asks one
question per row - *could a student pick the right answer?* - rather than
looking for empty or broken output, which is why the earlier sweeps missed it.

**23 rows could not be answered.**

- **12 were "which of these graphs" questions with no choices at all.** Four
  graphs in the choice band are drawn art with a bare `A.` beside each, so the
  extractor read four empty choices, `parse_choices` returned nothing, and the
  row rendered as a *grid-in* whose stored answer was the letter `D`. Nothing a
  student typed could ever match.
- **11 grid-ins had no stored answer.** Four state it in rationale text and the
  client already recovered those; seven state it only as a picture
  (`The correct answer is <img>`).

Four extractor bugs behind the twelve, each found by fixing the one before it:

1. **`build()` had nowhere to put a choice-band figure.** Clusters were bucketed
   stem / not-stem, and not-stem meant the rationale. A choice's own graph was
   therefore printed under the explanation or dropped. `attach_choice_figs()`
   hands them back in reading order, and only when there are exactly as many as
   there are choices.
2. **The banner cutoff applied to every page of a question.** `BANNER_BOTTOM`
   masks the metadata banner, which only page 1 has - so on a continuation page
   it hid whatever the question printed at the top, which is exactly where the
   fourth choice lands when the choices run over the page. `top` is now
   threaded through `P.figures`, `glyphmap.glyphs_on`, `raster_figures`,
   `figure_blocks`, `math_page`, `_grid_lines` and `table_of`, and `build()`
   passes 0 for every page but the first. This is also what had left
   `1ee962ec` and `4acd05cd` a table row short - a defect this file previously
   recorded as unfixable.
3. **A choice printed as a small picture is under the figure floor.**
   `FIG_MIN_W`/`FIG_MIN_H` reject a 91x25 mini-table, so nothing claimed it.
   `choice_images()` crops one per choice, guarded twice: every choice must be
   empty, and the band must hold exactly as many images as there are choices.
   Loosening the floor instead would turn inline notation crops into figures
   across the whole bank.
4. **`parse_choices` read a choice's own picture as a wrap of the choice above.**
   Where the page sets the letter against the side of its picture, the picture
   comes first in reading order. Absorbing it into the previous choice shifted
   every picture up one and left the last choice blank. **Overlap decides**:
   art that overlaps a bare letter's line belongs to it, art below it still
   wraps upwards. Getting this wrong in the obvious direction (always absorb)
   breaks `0b46bad5`, which prints its graphs *below* their letters - both
   layouts are in the bank, and only geometry separates them.

Also fixed at the root: **`72ae8a87`'s fifth choice**. A choice whose text wraps
onto a line the page draws a bullet against opens a phantom choice carrying the
next letter. If the real line for that letter turns up too, the phantom was a
wrap after all; it now folds back. That was previously a hand-written row in
`migrations/0005`.

`python tools/extract.py --selftest` covers all of it.

**The seven picture-only answers were read off their own crops** (5/2, 3/2, 1/2,
1/5, 10/3-15/4-25/6, 1/6, 7/6) and are named in `tools/apply_answerable.cjs`,
with `137cc6fd`'s stem, whose radical indices had come through as plain digits
(`5\sqrt{70n}6\sqrt{70n}2 ( )` for `\sqrt[5]{70n}(\sqrt[6]{70n})^{2}`), and
`36f068e2`'s four cropped scatterplots.

**Applying it.** `tools/extract.py` -> `tools/math_new.jsonl` ->
`node tools/apply_math.cjs`, then `fix_math_text.cjs --write --emit`,
`apply_choice_tables.cjs`, `apply_answerable.cjs`. The last of those emits
`migrations/0006_math_answerable.sql` as *the whole delta between the local Math
rows and the jsonl* - 153 rows - rather than its own diff, because the remote
gets the jsonl as `d1_chunks/` and would otherwise receive the re-extraction
with none of the repairs layered on top. Remote order: `d1_chunks/*.sql`, then
0006.

Measured over all 1,925 Math questions, before -> after:

| | before | after |
|---|---|---|
| questions a student cannot answer | 23 | **0** |
| MCQs (the 12 stopped being fake grid-ins) | 1,449 | 1,461 |
| MCQs with four distinct labelled choices | 1,449 | **1,461** |
| rows where `isRight()` returns "not scored" | 12 | **0** |
| grid-ins with no answer anywhere | 7 | **0** |
| KaTeX errors / raw LaTeX / mojibake | 0 | 0 |
| `/qimg` references that resolve | 4,782 | 4,915 (whole bank) |
| orphaned crops | - | 0 (98 deleted) |

Verified three ways: a DB audit; the render path in the browser over every Math
row (0 empty stems, 0 empty choices, 0 duplicate choice sets); and a grading
simulation running the player's own `isRight()` over all 1,925 - every stored
answer grades right, none returns null, and a wrong entry never grades right.
Then read against the source for a sample: `e9aed539`'s stem parabola has vertex
(2,-2) and "translated up 4 units" makes (2,2), which is choice A's crop;
`d46da42c` is `f(x)=x^2+4` and choice D's crop has vertex (0,4); `a8e6bd75`'s D
is the line of slope 2 its rationale names; `ab7740a8`'s D is the nonlinear
table 6/12/24/48; `1ee962ec`'s C is (0,0), (3,-12), (6,0), exactly the points
its rationale lists.

`1ee962ec` and `4acd05cd` print their last choice's final table row at the top
of the next page as its own ruled block, which `table_of` will not read (two
horizontal rules, not three). One showed it as loose text beside the table, the
other lost it. Both rows are now named in `apply_answerable.cjs`
(`CHOICE_ROWS`), read off the source pages. These are the only two page-broken
choice tables in the bank, so a general two-row-fragment reader would risk all
103 reconstructed tables to fix two rows.

### The choice tables all looked alike (2026-09-03, evening)

Reported as "1ee962ec shows that all the answer choices are the same". The data
was right and all four differed; the CSS was wrong. `.choice table` carried
`width: 100%`, so a 2-column, 4-row mini-table was stretched across the whole
answer pane and every choice read as the same sparse grid of x/y headers with a
digit lost in each corner. The rule was written before any question in the bank
had a table in a choice (CLAUDE.md recorded it as untested); there are 88 now,
and all 88 arrive wrapped in `<div class="qtable">`, whose own rules already
size and border them correctly. The three `.choice table` rules were duplicates
of those except for the width, so they are deleted rather than patched.

Worth remembering for the next report of this shape: the isolated harness and
the Browse preview modal both rendered these choices compactly and correctly,
because neither puts the choice inside the player's
`<span style="flex:1; min-width:0">`. Only the real player stretches them. Check
the screen the user is actually looking at.

### The 73 practice-test rows: restored, then deleted again (2026-09-04)

A branch read the bank being 3,770 rows rather than 3,843 as a regression and
restored every `source='Bluebook'` row, repairing what an audit found in them on
the way in. It was not a regression. The UI pass had deleted them on purpose -
they were one person's own practice-test mistakes, and a bank every user shares
is the wrong place for them - and retired the `pt` source filter with them.

So the restore is reverted: `migrations/0007_restore_bluebook.sql`,
`tools/restore_bluebook.cjs` and its three fix tables are gone, and the bank
stays at 3,770 CollegeBoard rows. `backup/bluebook_rows_2026-09-03.json` is still
the copy of record if they are ever wanted, and the defects the audit found in
them are recorded in that branch's history rather than lost.

Worth keeping: neither database moved either time, so this cost nothing but the
reading. Check *why* a count changed before treating the change as damage.

### UI pass: navigation, filters, answering, settings (2026-09-03)

Spec `docs/superpowers/specs/2026-09-03-ui-fixes-design.md`, plan
`docs/superpowers/plans/2026-09-03-ui-fixes.md`. `public/index.html` throughout,
plus two routes in `src/index.js` and one migration.

**The 73 `source='Bluebook'` practice-test rows are deleted.** They were one
person's own practice-test mistakes and made no sense in a bank every user
shares. Backed up first, and the remote id set was checked identical to the local
one before either delete ran: `backup/bluebook_rows_2026-09-03.json` (every
column), `backup/bluebook_rows_2026-09-03.sql` (re-runnable `INSERT`s),
`backup/bluebook_remote_ids_2026-09-03.txt`,
`backup/bluebook_remote_progress_2026-09-03.json`. The referencing `progress` and
`attempts` rows went with them.

**The delete had to be run three times, and the first two reports of success were
wrong.** The check used — "3,770 CollegeBoard rows" — is true whether or not the
73 Bluebook rows are still there, so it confirmed nothing. Count what you deleted
or `GROUP BY` the column you filtered on; do not check a number the delete cannot
change. Two further traps behind it:

- `wrangler dev` holds the local D1 in memory and flushes on shutdown, so a
  `wrangler d1 execute --local` delete run while the server is up is silently
  overwritten when the server stops. Stop it first.
- The remote delete had never run at all. It was caught only by reading
  `/api/questions` off the deployed site, which returned 3,843. **Verify a remote
  change against the deployed endpoint, not against the tool that made it.**

Both databases and the live site are now 3,770, all CollegeBoard.

Consequence, already handled: the Source filter's `pt` option matched nothing, so
it is gone, and a stored `F.src === 'pt'` is migrated to `official` at load —
without that a returning user opens the app to an empty bank. Orphaned crops
under `public/qimg/` are left; they are small and well under the asset cap.

**Landing screen and rail.** `TAB` defaults to `dash`; a new user met a filter
form before they had anything to filter. Order is Dashboard, Mistakes, Question
Bank, Browse, then Settings pinned at the foot — the old Practice/Progress group
headings no longer described it and are gone. Tab switching goes through one
`setTab()` so the boot tab and a rail click cannot drift apart.

**Filters are one multiselect component, three screens.** `dd(host, cfg)` renders
a rounded trigger over rounded-square checkboxes, with optional group headers
(domain → skills) carrying an indeterminate state, Escape and click-outside to
close. A `null` selection means everything — the convention `F.skills` already
used, so a first-time visitor is never filtered to nothing, and ticking the last
option collapses back to `null` rather than pinning a set that goes stale the
next time the bank grows.

- Question Bank: Section, Difficulty and Topic are multi; Source and Questions
  stay single. `F.sec`/`F.diff` widened from `'all' | '<value>'` strings to
  arrays, migrated in place at load.
- The topic table stopped being a filter control. It still shows coverage and
  accuracy per skill; ticking lives in the Topic dropdown. Two controls editing
  one piece of state is what made that screen confusing. `toggle()` and the
  Select all / Clear buttons went with it.
- Browse filters over its own `FB` state under its own storage key, so the
  practice set and the browse table cannot silently re-filter each other.
- Mistakes uses the same component; `MK` widened the same way. Its topic list is
  still built with every filter except the topic one, so picking a topic cannot
  empty the dropdown it came from.

**`pool()` used to shuffle unconditionally.** Random order is now a switch that
defaults off, and the default set size is All (`F.count = 0`) rather than 20.

**Answering is two steps.** A click used to grade instantly, so a misclick was a
wrong answer on the record; the `sel` class existed and was unreachable.
Selecting now takes `sel` and raises an inline **Check** button on that row only.
Selecting deliberately does *not* re-render the choice list — a re-render throws
away any highlight the student made inside a choice — so the classes and the
button are moved by hand. The `1`–`4` keyboard shortcut selects rather than
grades.

**Retry mode** (Settings, off by default): a wrong Check marks only the choice
that was picked and leaves the question open. Nothing turns green that the
student did not choose, so elimination cannot reveal the answer. Grid-ins keep
the box open and print "Not right — try again" instead of the answer; that
verdict is printed from the *un*-checked branch, because the closed-question
branch never runs in retry.

Attempt accounting, so the dashboard keeps meaning what it says: **the first
Check on a question writes the `progress` row; every Check appends an `attempts`
row.** Without the first rule a student walks any question to Green by clicking
every option in turn; without the second the heatmap loses work that was really
done. Verified: two Checks on one question gave two attempt rows and one
`progress.attempts` increment.

**A correct choice is green.** `.choice.corrected` was orange, which reads as a
warning rather than "this is the right answer". Orange stays where it still
carries information — the question map, the results pills, the mistakes cards —
where "wrong once, right now" is a distinct state.

**The explanation is no longer gated.** It printed "Hidden until you answer." in
a question bank, which is a study aid withheld for no reason. It still does not
open itself.

**Dark mode: one complaint, three defects.**

1. `--dim2` was `#6b7280` on `--panel` `#181b21` — 3.1:1, under the 4.5:1 floor,
   and it carries every chart x-label, y-axis number, heatmap month and weekday
   strip and chart caption. Now `#98a1b0`, measured 6.62:1.
2. The four dark heatmap level rules were written
   `:root[data-theme="dark"] .heat i.l1, .heat-key i.l1 { … }` — the second
   selector in each pair was never scoped, so the legend key painted dark-mode
   greens in light mode. Both halves carry the prefix now.
3. `.qfig img` keeps its own colours in dark mode (correctly — inverting a
   coloured chart misreports it), so a black-on-transparent axis vanished against
   the panel. Figures get a white plate. Notation crops (`img.minl`) keep their
   existing invert, which is right for black-on-white glyphs.

**Highlighter.** Yellow `#fff3a3`, pink `#ffc2e0`, blue `#bfe3ff` — the three
Bluebook offers. Select inside `.stem`, `.cb` or a `.choice` and a floating bar
appears; clicking an existing `<mark>` reopens it to recolour or remove.
Session-only: the question re-renders on Next and the marks go with it, which is
the wanted lifetime, so there is no storage and no API. `mark.hl` sets its ink
explicitly because the three pastels are light backgrounds and the inherited
`--text` is near-white in dark mode. Highlighting inside a choice must never
answer it — that is what the `mark` guard in the choice click handler is for.

**Settings.** One object, one storage key (`satq_settings`): theme
(light/dark/**system**, following `prefers-color-scheme` live), retry mode,
random order, default question count, and free-text AI instructions that nothing
reads yet. The old `satq_theme` key is carried over once. Signed in they go to
the account: `GET`/`POST /api/settings`, one JSON blob per user in a new
`settings` table (`migrations/0005_settings.sql`, applied local and remote), the
caller resolved from the Supabase access token exactly as `/api/progress` does —
never from a client-supplied id. A blob, not a column per toggle, because this
shape will keep changing.

**Calculator.** The header the student sees is Desmos's own, inside the
cross-origin embed, so it can be clipped but not restyled. Measured against the
live embed before cropping: `.dcg-sample-calculator__header`, 50px, containing
"Graphing Calculator" and "College Board Version" and **zero** interactive
elements — so nothing is lost. The iframe sits in an `overflow: hidden` wrapper,
pulled up by `--dp-crop` and grown by the same amount. The panel and its chrome
are white in both themes, because the College Board embed has no dark mode and a
white calculator inside a dark card reads as two surfaces.

**Verification.**

- All 3,770 rows through the app's own render path in the browser — stem,
  choices and rationale into the DOM, `renderMathInElement` over them, then
  asserted: non-empty render, no `Passage`/`Prompt` scaffolding, no mojibake, no
  `.katex-error`, four choices on every MCQ, the stored answer among them.
  **3,770 checked, 0 failures.**
- All 4,915 `/qimg` references resolve to files on disk, 0 missing.
- Contrast measured in the live page: dark `--dim2` on `--panel` is **6.62:1**;
  the heatmap legend swatch matches the grid swatch in each theme and differs
  between them; `.qfig img` computes `rgb(255,255,255)` in dark.
- Interaction paths driven by hand in the real player: select-then-Check both
  ways round, retry mode (one choice marked, nothing revealed, question stays
  open, 2 attempt rows against 1 progress increment), all three highlighter
  colours plus removal and clear-on-Next, a highlight inside a choice not
  selecting it, the calculator crop at `-50px` in both themes and on both tabs,
  and the filter counts agreeing with the payload (Medium + Hard = 1,258 + 1,269
  = 2,527, browse Math-only 1,947 with the practice count unmoved).

**Not done here, and why.** The end-to-end walk of every question through the
real player — click a choice, open the explanation, Next — could not be run: the
automation pane throttles background timers to about one question every five
seconds, which is roughly five hours for the bank. The render sweep above covers
the same assertions off the same data through the same render code; what it does
not cover is per-question layout. A partial player walk was clean as far as it
got.

Per-account isolation (two accounts, guest merge, settings round-trip) is also
untested here — it needs two real Supabase logins, and this session has no
credentials. `/api/settings` resolves its caller through the same `whoami()` the
progress and attempts routes use, so it inherits their guarantee, but that is an
argument, not a measurement.

**Typeface (2026-09-03).** `--sans` led with Inter and no webfont was ever loaded,
so the app rendered in whatever system UI font the reader had. It is Roboto now —
the College Board's own face, checked against `satsuite.collegeboard.org`, which
computes `Roboto, sans-serif` on its body and on its headings (474 elements).
`@fontsource-variable/roboto@5.3.0` off jsdelivr, which `script-src`/`style-src`/
`font-src` already allow in both CSP sources, so neither `public/_headers` nor the
`CSP` constant in `src/index.js` changed. One variable file covers 100–900 and
`unicode-range` keeps the download to latin. Pinned with an SRI hash like
supabase-js and KaTeX. KaTeX keeps `KaTeX_Main` for math.

Deployed and verified live at `helpmeaceit.page`: Roboto Variable loaded, the rail
in the new order landing on the dashboard, five filter dropdowns, select-then-Check
grading only on Check, and the explanation open on an unanswered question. The
old scalar filter shape stored by a previous visit migrated correctly in place
(`'Math'` → `['Math']`, skill pick preserved).

### Security pass: what an attacker could actually reach (2026-09-04)

Worked the app the way someone attacking it would - forge the caller, forge the
token, read someone else's rows, pull a secret out of the bundle, make the thing
expensive to run. Most of the obvious doors were already shut by the accounts
pass; four were not, and one of them was in Supabase rather than in this repo.

**Held under attack, verified against production, not read off the source:**
`X-User-Id: <anyone>` is ignored (`/api/progress` returns `[]`); a made-up bearer
token gets 401 from `/api/account`; unauthenticated POSTs to `/api/progress` and
`/api/settings` get 401; `/wrangler.toml`, `/schema.sql`, `/src/index.js` and
`/../wrangler.toml` are all 404; every security header is present on the live
response. Supabase answers a wrong password and an unknown address with the same
`invalid_credentials`, and a sign-up for an address that already exists returns an
obfuscated user, so neither path enumerates accounts. All four CDN tags carry
`integrity`, so a bad jsdelivr release cannot run in the page that holds the
session. Nothing secret is in the bundle - `SUPABASE_ANON_KEY` is the publishable
key and is meant to ship. `git log -S` over the whole history finds the *name*
`GEMINI_API_KEY` and never a literal key; no `sk-`/`AIza`/service-role string has
ever been committed.

**1. `public.rls_auto_enable()` was callable by `anon`.** It is the event-trigger
function that turns RLS on for every new table in `public`, it is
`SECURITY DEFINER`, and its ACL read
`{=X/postgres,anon=X/postgres,authenticated=X/postgres,...}` - so PostgREST
published it at `/rest/v1/rpc/rls_auto_enable` to anyone holding the publishable
key. An event trigger runs as its owner and never consults an `EXECUTE` grant, so
the grant bought nothing and revoking it costs nothing. Applied as the Supabase
migration `revoke_public_execute_on_rls_auto_enable`; the anon RPC now answers
`42501 permission denied`, and both `*_security_definer_function_executable`
advisors are gone.

**2. A signed-in account could write unbounded rows.** `MAX_ROWS = 500` caps one
request and nothing caps the number of requests, and neither write validated
`question_id` - so 500 invented ids per POST, for ever, in a database everyone
shares. Both inserts are now
`... SELECT ?,?,... WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)`, which
bounds `progress` to the bank by its own primary key. `attempts` is append-only and
keyed on a client-supplied `ts`, so the primary key bounds nothing there; it takes
one `COUNT(*)` for the whole batch against `MAX_ATTEMPTS = 100000` (~55 years at
five questions a day) and answers 429 over it.

SQLite detail worth keeping: `INSERT ... SELECT ... ON CONFLICT DO UPDATE` only
parses when the `SELECT` has a `WHERE` clause - without one the parser cannot tell
the upsert from a join. The `WHERE EXISTS` is what makes it legal, so the guard and
the syntax are the same change. `node test_worker_sql.cjs` runs both statements
against `schema.sql` and asserts a fake id writes nothing, the upsert still
updates, `stars` still takes the `MAX`, and a repeated `(question, ts)` still
collapses.

**3. `/api/questions` was a free 8.3MB.** No session needed, a full table scan and
8.3MB of egress per request, so the cost attack is a curl loop. It is the same
bytes for every visitor and changes on a deploy rather than on a request:
`Cache-Control: public, max-age=300, s-maxage=3600` moves it to Cloudflare's edge
cache.

**4. Sign out was local-only in effect, and left the account behind.**
`sb.auth.signOut()` without a scope, fire-and-forget: supabase-js clears the local
session even when the network call fails, so the page reads "signed out" while the
account is still signed in. Now `signOut({ scope: 'global' })`, which revokes the
refresh tokens server-side so this device's access token stops resolving to a user
on the Worker, and a failure is said out loud instead of swallowed. It also clears
`satq_progress`, `satq_log` and `satq_settings` and resets `SET` to the defaults -
those outlived the session, so on a shared machine the next person inherited them.

**5. The sign-in modal printed Supabase's own error text.** The credentials failure
is generic, but the neighbouring ones are not - the rate-limit message names how
long ago an address was last used. One message for every way a sign-in can fail,
detail to the console. Password `minlength` 6 -> 8.

**6. A stranger could spend the account's Supabase auth budget.** `whoami()` only
checked that an `Authorization` header was non-empty before calling
`{SUPABASE_URL}/auth/v1/user`, so one line of noise in that header bought an
outbound call - and the Worker's calls all leave from Cloudflare's addresses, so
they land on one shared rate limit rather than the attacker's. A curl loop from a
single machine is therefore an auth outage for every real user. `looksLive()` is a
pre-filter, not a verification: three dot-separated segments, a payload that
base64url-decodes to JSON, and an `exp` in the future. Supabase still checks the
signature; garbage now costs the attacker a request and this Worker nothing.
Verified on the running server - noise and an expired token are refused without
leaving the Worker, a well-formed forgery goes out and comes back 401.

**7. `/api/settings` GET still answered `{}` when the token was rejected.** The
progress and attempts reads were changed to 401 because an empty list reads as a
wiped account; the settings read kept its `{}` and defeats the client fix that came
with it - `loadSettings()` treats an empty object as "this account has no row yet"
and answers by pushing the guest's defaults up over the account's real settings. It
is 401 now, like the other two.

**Accepted, with the reason:**

- `script-src 'unsafe-inline'`. The question HTML goes from D1 into `innerHTML`,
  so an `onerror=` riding along would run. Nothing writes to `questions` over HTTP;
  it takes D1 write access to plant one, and that is already game over. A nonce
  cannot fix it either - nonces do not apply to event-handler attributes. The whole
  client-side sink audit is clean besides: every interpolation of user-typed or
  account text (`S.ans`, `SET.ai`, `opt()`, the settings rows) goes through `esc()`,
  and the sign-in messages are `textContent`.
- `public.SatQuestionBankAccounts` still trips the `rls_enabled_no_policy` INFO
  lint. RLS on with no policy is deny-all, which is the safe state and was
  confirmed by hand - anon reads `[]` and an anon insert gets
  `42501 new row violates row-level security policy`. The table is empty and
  nothing uses it; the app's data is in D1.
- D1 has no row-level security. Isolation is `WHERE user_id = ?` with the id
  resolved from the token by `whoami()`, never from anything the client sends.

**Left for the dashboard, because there is no API for it here:** leaked-password
protection is off (Settings -> Authentication -> Password security; checks
HaveIBeenPwned) and the server-side minimum password length is still 6 while the
form now asks for 8.
### Settings chrome, clipped dropdowns, and progress that belongs to the account (2026-09-04)

**Three chevrons in one `<select>`.** `.set-row select` set `background: var(--panel)`
— the *shorthand*, which resets `background-repeat` to `repeat` and the position to
`0 0`. The generic `select` rule's arrow was overridden away by specificity, but
`:root[data-theme="dark"] select` (0,2,1) outranks `.set-row select` (0,1,1), so in
dark mode the arrow came back *without* the no-repeat that shipped with it and tiled
across the control. `background-color` and it is one arrow again. `#set-body` also
had no horizontal padding, so every settings row sat flush against the card edge.

**A filter dropdown cannot escape a card that clips.** `.panel` carries
`overflow: hidden` for its rounded corners and `.dd-p` is absolutely positioned
inside it, so the Topic/Difficulty menus were cut off at the card border.
`.panel:has(> .ctrls) { overflow: visible }` — the three panels that hold filter
dropdowns, not every card.

**Progress belongs to the account, and only to the account.** The guest-merge path
is deleted. It cleared `satq_progress` / `satq_log` *before* the fire-and-forget POST
that was meant to hand them over, so a rejected token turned a sign-in into a wipe;
and a stale local blob could overwrite server rows with older counts. Now: a guest's
answers live in memory for the sitting and are gone on reload (what was asked for),
a sign-in reads the account and nothing else, and the old keys are removed at boot.
`loadLog()` folded into `loadProgress()`; `saveProgress`/`saveLog` are one `push()`.

**Silence was the other half of the bug.** Every save was `.catch(() => {})` with no
`r.ok` check, so a 401 dropped an answer without a word, and `GET /api/progress` and
`/api/attempts` returned `[]` for an unreadable token — a rejected sign-in and an
empty account looked identical. Both GETs now 401, and the client reports a failed
read or write once per session instead of showing a blank slate. `loadSettings()`
likewise pushed the guest's settings up when the read merely *failed*, overwriting
the account's own; it only does that now when the account genuinely has no row.

Not reproduced here: the remote DB holds 6 `progress` rows and **0** `attempts` rows
for the one account, from the same six answers. Both endpoints and both statements
were checked by hand and are sound, and a guest run writes both, so the likeliest
origin is that those six came through the old merge from a localStorage blob written
before `attempts` existed. That path no longer exists.

Verified locally in the browser: settings margins and a single chevron in both
themes, the Topic menu overlaying the Topics table instead of being cut off, a guest
answer graded with nothing written to localStorage and nothing left after a reload,
both GETs returning 401 without a valid token, and no console errors. The signed-in
merge/pull could not be exercised — this session has no account credentials, and
Supabase's e-mail rate limit refused a throwaway one.

**Does a deploy wipe data? No, and it is now measured rather than assumed.**
`npm run deploy` is `wrangler deploy` and nothing else: it uploads the Worker
script and `public/`. There is no CI, no post-deploy script, no `[[migrations]]`
in `wrangler.toml`, and no SQL anywhere in that path — a D1 table only changes
when someone runs `wrangler d1 execute` or `d1 migrations apply` by hand. Checked
across the deploy of these fixes: `questions` 3,770 / `progress` 6 / `attempts` 0
/ `users` 1 / `settings` 1, identical before and after, same six progress rows.
`backup/progress_2026-09-04.sql` and `backup/settings_2026-09-04.sql` were taken
first anyway. Live page verified equal to `public/index.html` byte for byte —
`wrangler` printed "No updated asset files to upload", so check the served file,
not the tool's own summary.

**Browse lost the Select all / Clear rows.** Browse is a table you narrow, not a
set you assemble: "Clear" leaves a selection matching nothing and "Select all" is
where the dropdown already starts. `dd()` takes `noBulk`; the Question Bank and
Mistakes filters keep both rows, where picking through a long topic list is the
point.

**Deployed and re-checked live.** `/api/progress`, `/api/attempts` and
`/api/settings` all answer 401 unauthenticated, a noise `Authorization` header gets
401 without leaving the Worker, `/api/questions` carries
`Cache-Control: public, max-age=300, s-maxage=3600`, and all four security headers
are still on the page. Twelve questions walked in the real player on
`helpmeaceit.page`: no empty stem, no broken image, no KaTeX error, no console
error. Supabase's advisors are down to the two items above.

**A worktree's `public/qimg` is a symlink, and wrangler's manifest skipped it.**
Every crop 404'd on the live site again - not because the files were missing from
the asset store (`wrangler` reported "4915 already uploaded") but because the
deploy that put them there was made from a checkout where `public/qimg` is a
directory junction, so the asset walker never listed them into the manifest. `find`
and `du` also report the directory as empty while `ls` and Node's `readdirSync`
both see all 4,915 files, which is what makes this easy to miss. Materialise it
before deploying - `cp -rL public/qimg public/qimg_real && rm public/qimg && mv
public/qimg_real public/qimg` - and check wrangler's own line: it should read
"Read 4918 files from the assets directory", not 3.

### The crops 404'd again, and progress would not load (2026-09-04, later)

**Images: a deploy from a sibling worktree wiped them from the asset manifest.**
Not the app, not the CSP, not the database — all 4,915 `/qimg` references resolve
locally and every one of them is referenced by a row. Deployment `78bbf6a1`
(06:24) was made from `.claude/worktrees/chatbot-ui-fixes-brainstorm-2aae49`,
where `public/qimg` is a **directory junction** (the directory is gitignored, so
a worktree gets a link rather than a copy). wrangler's asset walker does not
follow it: the deploy succeeds, reports "Read 3 files from the assets
directory", and writes a manifest with no crops in it. The Worker script and
`index.html` in that deploy were current — live HTML is byte-identical to the
local file once CRLF is normalised — which is why only the images were gone.

Two things make this easy to misdiagnose: the 404 carries the security headers,
which come from `public/_headers` and therefore look like the Worker answered;
and `find`/`du` report the junction as empty while `ls` and Node's `readdirSync`
both see all 4,915 files, so a file count proves nothing.

`tools/predeploy.cjs` now refuses the deploy if `public/qimg` is missing, is a
symlink, or holds under 4,000 files, wired as npm's `predeploy` hook so
`npm run deploy` cannot skip it. It only guards that path — `npx wrangler deploy`
still bypasses it, so deploy through npm. The junction in the sibling worktree
was materialised (`cp -rL`), and `chatbot-removal-ai-export-614748` has no crops
at all; do not deploy from there.

**Progress: `authToken` was a snapshot of a token that expires hourly.**
`sbHeaders()` read a module-level `authToken` set by `applySession()`. A Supabase
access token lasts an hour; supabase-js renews it in the background and
`onAuthStateChange` does write the new one back — but `initAuth()` awaits
`getSession()` and `load()` runs on the very next line, so a page booted while
the stored token had already expired sent the dead one to `/api/progress` and
`/api/attempts`, got 401 from both, and printed "Could not load your saved
progress" — which is the "stored but cannot load" report. The refresh landed
milliseconds later, but `onAuthStateChange` only refetches when `uid` changes,
and a token refresh does not change it, so nothing retried.

`sbHeaders()` is now `async` and asks `sb.auth.getSession()` for the live token
on each call, which refreshes it first if it has to. Five call sites await it.
This also closes the same hole on the write path, where a stale token turned an
answer into "Your last answer did not save".

Not the cause, checked and ruled out: `whoami()` and `looksLive()` are fine —
Supabase's edge logs show every Worker call to `/auth/v1/user` answering **200**
(the two 403s at 05:55 and 05:59 are this repo's own forged-token tests). The
`INSERT ... SELECT ... WHERE EXISTS` for `attempts` was run against the remote
D1 with a `PROBE` user id and inserted, so the security pass's rewrite is not
what left `attempts` empty; those 6 progress rows with no attempt rows predate
it (00:02–00:22 UTC, before the 06:11 deploy).

**"Most of them should be tables" — 103 of them are.** 952 of the 3,770 rows
still reference a crop. The table reconstruction only ever applied to ruled
blocks, and the remaining crops are the two things that cannot become text: the
439 questions whose notation College Board embedded as a **bitmap** (no glyph
identity to hash — measured and abandoned, see the raster-matching section), and
real diagrams — graphs, scatterplots, geometry figures — which are art.

### A custom 404 page (2026-09-04)

`public/404.html` - the app's own tokens, both themes, a link home and the path
that missed. No webfont and no CDN; a 404 that has to fetch something renders
twice. The theme is read from `satq_settings`, the same key the app writes, so a
reader who picked dark does not get a white flash on the way to an error page.

**`[assets] not_found_handling = "404-page"` is the wrong knob here, measured.**
The asset router applies it *before* the Worker runs, so with it set every route
the Worker owns 404s as well - `/api/questions` and `/auth/callback` both came
back as the 404 page. The fallback lives in `asset()` in `src/index.js` instead:
a miss re-fetches `/404.html` and returns it with status 404, `harden()` puts the
security headers on it like any other response.

Verified locally: `/` and `/auth/callback` 200, `/api/questions` 200 JSON,
the four authenticated routes 401 unauthenticated, `/wrangler.toml` and
`/schema.sql` the 404 page, a real crop still 200 image/webp, and a missing crop
the 404 page. Rendered in both themes.


### "Could not load your saved progress": a read that wrote (2026-09-04, later)

Reported as progress not loading, with the alert returning on every reload. Not
auth, and not the client: `wrangler tail` on production caught the real thing.

```
GET https://helpmeaceit.page/api/progress - Exception Thrown
Error: D1_ERROR: Your account has exceeded D1's free tier daily row write limit.
    at async touchUser (index.js:72:3)
    at async Object.fetch (index.js:109:7)
```

`touchUser()` upserts the `users` row and was called from **`GET /api/progress`**.
So a read spent D1's daily row-write budget, and once that budget is gone the read
*throws* — 500, not 401 — and the account's answers are unreachable while the
database is perfectly intact. `GET /api/attempts` writes nothing and answered 200
throughout, which is exactly why only half the data appeared to vanish.

Measured on production with a real signed-in token: **11 of 12** `/api/progress`
reads returned 500 before, **10 of 10** return 200 after. `touchUser` now runs only
from `POST /api/progress`, a route that is already writing.

Two things this cost time on, worth remembering:

- Supabase's edge logs show every Worker call to `/auth/v1/user` answering **200**
  through the whole failing session, so `whoami()` was never the problem. Checking
  the auth provider's own logs ruled out the entire token path in one query.
- The client's `warnSync` uses `alert()`, which **blocks the page's JS thread** —
  in the browser-automation logs that shows up as "the renderer may be frozen",
  and in Supabase's log timeline as unexplained ~6 second gaps between the
  Worker's calls. Those gaps are a human clicking OK.

Note the plan limit is account-wide and resets at midnight UTC: until it does,
*writes* still fail (saving an answer reports "Your last answer did not save"),
even though reading now works. The free tier is 100,000 rows written per day and
index updates count toward it, so a full re-import of `questions` is a large
fraction of a day's budget on its own.

### Explanations that read wrong, and a phone layout (2026-09-04, later)

`public/index.html` only. Two reports, one screenshot: an explanation "formatted
really weirdly", and a request for a mobile UI. The screenshot was a phone.

**The rationales carry three formatting artifacts.** All three are visible as
prose rather than as an error, which is why every earlier sweep - none of which
asked "does this *read* right", only "is it empty / broken / mojibake" - missed
them. Measured over all 3,770 rows:

| | rows |
|---|---|
| a space where a decoded notation run met the punctuation after it (`or 11 .`, `(0,0) , (3,-12)`) | 935 |
| a paragraph break dropped mid-sentence, so one `<p>` ends on "the" and the next opens on "population of Iceland in 2014 was" | 1,101 |
| two or more choice analyses run together in one paragraph | 2,090 |

`tidyExpl()` fixes all three at load, beside `demoji()`. Not in the data: every
consumer - the explanation modal, the browse preview, the mistakes teaser, the AI
export - reads this one field, and D1's daily row-write budget is small enough
that a 3,770-row migration costs a real fraction of a day of it.

Four things the first attempt got wrong, all of which produce *plausible* output
rather than an obvious failure:

1. **The spacing pass has to run last.** Rejoining a torn paragraph puts a space
   in front of whatever the next one opened with, and a torn paragraph very often
   opens on its own punctuation (`d28c29e1`: "...is equal to an average speed of"
   + ", or 17,136 miles per hour"). Tidying first just puts the artifact back -
   measured, it left 1,671 of the 935 rows still wrong, because the merge had
   created new ones.
2. **A leading dot can be a decimal.** `1/6, .1666, .1667` is a list of accepted
   grid-in entries, and stripping the space gives `,.1667`. The lookahead is
   `\.(?!\d)`.
3. **Collecting the paragraphs throws the lists away.** 229 rationales carry a
   `<ul>`; pulling `<p>` out with `matchAll` and rebuilding from those alone
   silently deleted them. It splits into blocks instead, so a non-paragraph
   passes through untouched *and* separates its neighbours - which is also what
   stops the rejoin reaching across a list.
4. **The check has to mask math, not strip it.** Deleting `\( ... \)` outright to
   look for " ," leaves the space that stood *in front of* the formula sitting
   against the comma behind it, so a fixed row still reads as broken. Each tag
   and formula collapses to one non-space character.

`node test_tidy_expl.cjs` runs 14 cases; `--sweep` runs the function over the
local D1 and asserts the three counts above go to 0 and that **no row's text
moves** - every edit either deletes whitespace or inserts it, so the string with
all whitespace removed is the invariant. Then all 3,770 were put through the
app's own KaTeX path in the browser: **0 KaTeX errors before and after, 0 rows
whose rendered text changed, 0 rows whose image count changed, 0 that render
empty.** 3,182 rows are rewritten.

The test lifts `tidyExpl` out of `public/index.html` by its `// --- tidyExpl`
markers rather than keeping a copy, so it cannot drift from what ships. Note
`new Function` is how it does that and the page's own CSP forbids `unsafe-eval`,
so the browser half of the sweep needs the tidied HTML written out as a file and
fetched, not evaluated in the page.

**The phone layout.** At 375px the app was unusable, not merely cramped: the top
bar alone measured 682px and pushed the whole page sideways, and the player's two
panes were 187px each, so the stem wrapped every two or three words and a table
was cut off mid-column. There was one breakpoint in the file, at 980px, and it
only narrowed the rail.

One `@media (max-width: 760px)` block, no markup and no JS:

- **The rail lies flat along the bottom, as a real tab bar.** `#view-home`
  becomes a column with `.nav` at `order: 2`; the brand, the spacer and the
  avatar go, leaving five equal tabs - Dashboard, Mistakes, Practice, Browse,
  Settings - and the sign-in arrow. The labels have to come back: they are
  hidden at 980px because the rail is a 66px strip there, and a row of bare
  glyphs reads as a toolbar rather than as navigation. Two of the five carry a
  short label of their own, because "Question Bank" does not fit in a fifth of
  375px and the gear has no label in the markup at all. `.board` needs an
  explicit `min-height: 0` - a column flex item is `min-height: auto`, so
  without it the board grows to its content and pushes the tab bar off the
  bottom of the screen.
- **The player is one column and one scroller.** `.work` takes the scrolling and
  the panes stack. Two stacked panes with a scrollbar each would mean the passage
  and the question about it can never be on screen together, which is the one
  thing the split layout exists to allow.
- Directions, Pause and Hide are dropped from the top bar - all three are
  reachable from a desk and they cost the row Calculator and More need. "Copy for
  AI" drops to its glyph, the way the rail's sign-in button already drops to an
  arrow.
- Desmos has no half-screen to dock into, so it is a sheet above the bottom bar,
  and `.work.desmos-shift .panes` loses its 540px margin.
- `100dvh`, not `100vh`: on a phone the browser's own chrome is inside `100vh`,
  so a full-height flex column puts its bottom bar under the address bar.
- Filters go one per row; the topic table drops the seen-count (the coverage bar
  already went at 980px); Browse drops Domain and Skill, which are both in its
  filters; settings rows stack so the AI textarea is not 187px wide.

Verified in the browser at 375x812 in both themes: **0 horizontal overflow on all
five tabs** (`document.body.scrollWidth === 375`), the tab bar pinned at 756 of
812 with every label legible and the active one mint - and still no overflow at
320px, where the five tabs are 50px each, a filter menu opening inside the viewport rather than clipped by its card,
select-then-Check grading a choice green, the explanation modal ending exactly
where the tab bar begins, the calculator sheet inside the margins with the panes
back at `left: 0`, and `1ee962ec` - the question in the report - rendering its
figure, its LaTeX and its now-tidy rationale with 0 KaTeX errors. Desktop
re-checked at 1280px: panes still 640/640, every top and bottom bar button back.

**A worktree needs its crops and its D1 before `wrangler dev` will show
anything.** `public/qimg` and `.wrangler/` are gitignored, so a fresh worktree has
neither: the crops were junctioned in and the local sqlite copied from the main
checkout. That junction is exactly the trap recorded above - do not deploy from
here; `tools/predeploy.cjs` refuses it, which is what that guard is for.

### Account and legal in Settings, a welcome box, and the collapsed rail (2026-09-04, later)

`public/index.html` only.

**The collapsed rail's foot overflowed its own width.** At 761-980px `.nav` is a
66px strip with 8px padding, so a nav item has 50px to sit in - but `.nav-user`
is still a *row* of a 32px avatar, a 10px gap and a 34px gear, which is 76px.
That is the "stranded, misaligned" cluster in the report: the two glyphs
overflowed the strip and neither lined up with the tab icons above. The avatar
names nobody once `.nav-um` is hidden, so it goes, and `.nav-user` stacks. The
gear now measures x=8 w=50, identical to every tab icon.

**Account and legal live in Settings.** The phone tab bar has five tabs and no
room for a sign-in button, so `#btn-auth` is `display: none` under 760px and the
Settings screen carries an Account row instead - the name/email it shows is the
same `#nav-sub` text, and the button is the same `signOut()` / `authModal()`
pair. Added for every width rather than behind the media query: one code path,
and the desktop rail keeps its own button.

Below it, a Legal row opening Terms of Service, Privacy Policy and Copyright /
DMCA in the existing modal. The text is **draft boilerplate** and says so at the
top of every one of them; `LEGAL_CONTACT` is a placeholder string, so search for
`fill this in` before launch. What it covers is what this app actually does -
Supabase auth, a practice record in D1, Cloudflare's cookieless analytics, the
Desmos embed, and that the questions are College Board's, reproduced for study,
with no affiliation claimed.

**A welcome box on the first visit.** `authModal(true)` - same modal, heading
"Welcome", and the close button reads "Continue as guest". Shown once from the
boot IIFE when there is no session and no `satq_welcomed` key. The flag is
written when the box opens, not when it is dismissed: it is a one-time offer
either way, and a reload should not nag.

`applySession()` redraws Settings when it is the open tab, or the Account row
still says "Sign in" after signing in.

Not built: "stay signed in". supabase-js already persists the session in
localStorage indefinitely, so the checkbox would either do nothing or be an
opt-out nobody asked for.

Verified in the browser at 320, 375, 761, 900 and 1280px, both themes:
0 horizontal overflow at every width, five even tabs on the phone bar (69px
each at 375, 58px at 320) with the sign-in button gone, the collapsed rail's
gear and arrow aligned with the tab icons, the desktop rail unchanged at 246px
with its avatar and full-width button, all three legal modals opening and
scrolling, and no console errors.

### The question screen on a phone: a second pass (2026-09-05)

`public/index.html` only. The previous pass measured the *home* screens at 375
and 320px and found no overflow. The **test player** was never measured at 320,
and at that width its bottom bar overflowed and clipped **Next** off the side of
the screen - the primary control, unreachable. Six defects, all found by driving
the real player rather than by reading the CSS:

1. **The bottom bar overflowed at 320px** (367px of row in 320px of screen) and
   wrapped "1228 of 3770" onto two lines at 375. Copy for AI moves into the More
   menu, which already carries the explanation, and `#pos-lbl` is `nowrap`.
   At <=360px Explanation also drops to a glyph; 375px keeps the word with 27px
   to spare. Measured after: 320 and 375 both fit with nothing clipped.
2. **The top bar wrapped to two rows at 320px** (324px of content), which is what
   put the More menu on top of Calculator. `#btn-dash` is the arrow alone there.
   The menu is also positioned off its own button's rect now rather than a fixed
   `top: 52px`, so a wrapped bar could not have put it there anyway.
3. **A dead black band under every short question.** A pane is content-height
   once `.work` stops being a row of full-height columns, so the scroller's own
   `--bg` showed below it - most of the screen on a grid-in. `.work` takes
   `--panel` on mobile and the column is one surface.
4. **Tables shrank every column to its longest word.** 343px for four columns
   meant "Talks on / cell / phone / daily", seven lines for one header, and 9 of
   the 103 still spilled past the edge into a scroll with no cue. At 13px with
   6px/9px cells **all 103 fit 375px** (0 overflow, was 9) and they are 20%
   shorter; the badly-wrapping ones go 13 -> 5. At 320px 8 still scroll - the
   widest table in the bank is 1,087px of content, and there is no layout that
   fits it in 288px. Full-bleeding the scroller was tried and reverted: with the
   pane's padding moved inside it, the content width is unchanged.
5. **Check squeezed the choice it belongs to.** The button is inside the choice
   row, so on a phone the selected choice reflowed to four short lines while its
   neighbours kept five words to a line. `.choice` wraps and `.chk-btn` takes its
   own full-width row - also a thumb-sized target instead of a 75px one.
6. **The highlighter bar opened on top of the clock.** `top: max(8, y - 44)`
   ignores the player's 53px top bar, so a highlight in a passage's first line
   put the swatches over it. It now goes below the selection when there is no
   room above. `hlBar` takes the rect instead of a point.

**408 stems carry the space-before-punctuation artifact** the rationales had -
`at \(x = 1\) ?` - and on a phone the line is short enough that the question mark
orphans onto a line of its own. `tidyExpl`'s spacing pass is now `tidySpace()`
and stems go through it at load, the same way explanations do. 0 choices carry it.

`.qnum` had no horizontal padding at all, so a four-digit question number filled
its badge edge to edge. `padding: 0 8px`; `min-width: 34px` keeps short ones square.

**Verified.** All 3,770 stems, explanations and choice lists through the app's own
KaTeX path at a 375px pane: **0 KaTeX errors, 0 overflow outside `.qtable`, 103
tables and 0 of them overflowing, 0 rows whose rendered text changed** (the
spacing pass only ever deletes or inserts whitespace, so the string with all
whitespace removed is the invariant - `node test_tidy_expl.cjs --sweep` asserts
the same for explanations). 60 questions spread across the bank walked in the
real player at 320px: 0 overflow, 0 KaTeX errors, every one with an answer
control. By hand at 320 and 375 in both themes: select-then-Check grading green
and red, the explanation modal, the question map, the Desmos sheet, the figure
lightbox, the highlighter placing and applying a mark, Copy for AI from the More
menu falling back to its modal, and the results screen. Desktop re-checked at
1280: panes 639/625, the full "← Dashboard" and "Copy for AI" labels back,
tables at 14.5px.

One caveat that could not be measured here: the highlighter is bound to `mouseup`
only. The emulator translates mouse to touch so it passes, but a real phone makes
a selection with OS handles and may never fire it. Needs a device to tell.
