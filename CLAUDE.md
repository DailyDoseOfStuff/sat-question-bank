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
