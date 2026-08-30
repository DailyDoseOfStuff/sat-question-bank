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

### Known Bugs

- **Spacing artifact, ~4% of Math rows measured (likely undercounted):** a
  variable glyph directly followed by a word loses its space — `"wsquare
  feet"` instead of `"w square feet"`. Same PDF-extraction spacing heuristic
  documented above (real-space vs artifact by glyph width), miscalibrated for
  some italic single-letter variables. Not yet root-caused or fixed.
- Tesseract `stem_text` (legacy OCR column) quality is mediocre: `Itfeatures`/
  `Itincludes` (lost spaces), `«` for bullets, mangled smart quotes. Still used
  as the "original image" toggle fallback for the 104 untouched Bluebook rows.
