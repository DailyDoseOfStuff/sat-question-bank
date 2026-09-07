# AI Question Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second D1 database of AI-authored SAT questions harder than official Hard, per-attempt analytics (which trap was taken, pacing, second-guessing), and an adaptive timed focus mode that drills the skills the student is most likely to miss.

**Architecture:** Question content for the AI bank lives in its own D1 database (`AI_DB`) with the same column names as the main bank plus a `level` rank; the Worker concatenates both banks into the existing `/api/questions` payload so no client render path changes. All *user* data stays in the main DB — an `ai_ids` registry there keeps the existing `WHERE EXISTS` write guards exact across the database split. Two new columns on `attempts` carry the analytics.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), wrangler, vanilla JS single-file SPA (`public/index.html`), KaTeX, `node:sqlite` / `better-sqlite3` for the offline tools and tests.

---

## File Structure

**Created**

| path | responsibility |
|---|---|
| `schema_ai.sql` | the AI database's only table |
| `migrations/0009_ai_bank.sql` | main-DB migration: `attempts.picked`, `attempts.changes`, `ai_ids` |
| `migrations_ai/0001_init.sql` | AI-DB migration (same text as `schema_ai.sql`, kept separately so the remote can be brought up by `d1 migrations apply`) |
| `tools/aiq/rw_01.jsonl` … `tools/aiq/math_01.jsonl` | authored questions, 25 per file |
| `tools/apply_ai.cjs` | validator + local importer + remote SQL emitter + `--test` |
| `test_focus.cjs` | the focus-set picker and the difficulty ladder |
| `test_metrics.cjs` | trap/pacing/second-guessing aggregation |

**Modified**

| path | change |
|---|---|
| `wrangler.toml` | second `[[d1_databases]]` block |
| `src/index.js` | `/api/questions` reads both banks; three write guards accept `ai_ids`; `attempts` insert carries `picked`/`changes` |
| `public/index.html` | level + AI flag at load, metric capture, four dashboard panels, focus mode and its popup, mistakes Bank filter, legal text |
| `test_worker_sql.cjs` | cases for the widened guard and the widened attempts insert |
| `CLAUDE.md` | a section recording what was built and what was measured |

---

### Task 1: The AI database and the main-DB migration

**Files:**
- Create: `schema_ai.sql`
- Create: `migrations_ai/0001_init.sql`
- Create: `migrations/0009_ai_bank.sql`
- Modify: `wrangler.toml`
- Test: `test_worker_sql.cjs`

- [ ] **Step 1: Write the failing test**

Append to `test_worker_sql.cjs`, before the final `console.log`:

```js
// --- the AI bank lives in a second database, so `questions` cannot vouch for its
// ids. `ai_ids` is the registry that keeps the guard exact across the split.
db.exec("INSERT INTO ai_ids (id) VALUES ('ai_rw001')");

const P2 = db.prepare(`INSERT INTO progress
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                             OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)
 ON CONFLICT(user_id, question_id) DO UPDATE SET
   attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
   last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
   stars=MAX(progress.stars, excluded.stars)`);
P2.run('u2', 'ai_rw001', 1, 0, 'Red', 't', 10, 0, 'ai_rw001', 'ai_rw001');
P2.run('u2', 'ai_NOPE',  1, 0, 'Red', 't', 10, 0, 'ai_NOPE',  'ai_NOPE');
assert.strictEqual(
  db.prepare("SELECT COUNT(*) n FROM progress WHERE user_id='u2'").get().n, 1,
  'progress guard must accept a registered AI id and refuse an unregistered one');

const A2 = db.prepare(`INSERT OR IGNORE INTO attempts
   (user_id, question_id, ts, correct, time_taken_ms, picked, changes)
 SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                         OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)`);
A2.run('u2', 'ai_rw001', 'T1', 0, 8000, 'C', 2, 'ai_rw001', 'ai_rw001');
A2.run('u2', 'ai_NOPE',  'T1', 0, 8000, 'C', 2, 'ai_NOPE',  'ai_NOPE');
const at2 = db.prepare("SELECT * FROM attempts WHERE user_id='u2'").all();
assert.strictEqual(at2.length, 1, 'attempts guard must refuse an unregistered id');
assert.strictEqual(at2[0].picked, 'C', 'picked not stored');
assert.strictEqual(at2[0].changes, 2, 'changes not stored');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test_worker_sql.cjs
```

Expected: throws — `no such table: ai_ids`.

- [ ] **Step 3: Write the main-DB migration and fold it into `schema.sql`**

`migrations/0009_ai_bank.sql`:

```sql
-- Which choice was taken, and how many times the student switched before Check.
-- `picked` is the letter for a multiple-choice question and the typed entry for a
-- grid-in. Pacing needs no column: it is time_taken_ms against a section target.
ALTER TABLE attempts ADD COLUMN picked TEXT;
ALTER TABLE attempts ADD COLUMN changes INTEGER DEFAULT 0;

-- The AI bank's question rows live in a second database and D1 cannot join across
-- one. Without this registry the `WHERE EXISTS (SELECT 1 FROM questions ...)` guard
-- on progress/attempts/notes refuses every AI id and the answer is dropped in
-- silence. One column, written by tools/apply_ai.cjs, so the bound stays exact.
CREATE TABLE IF NOT EXISTS ai_ids (id TEXT PRIMARY KEY);
```

Append the same three statements to `schema.sql` in their `CREATE TABLE` form, so a
fresh database and the migrated one agree:

```sql
CREATE TABLE IF NOT EXISTS ai_ids (id TEXT PRIMARY KEY);
```

and add `picked TEXT` / `changes INTEGER DEFAULT 0` to the `attempts` block in
`schema.sql`, after `time_taken_ms INTEGER DEFAULT 0,`.

- [ ] **Step 4: Write the AI database's schema**

`schema_ai.sql`:

```sql
-- The AI-authored bank. Same column names as the main bank's `questions` so the
-- Worker's SELECT is the same string twice and the client needs no second shape.
-- `level` is the difficulty rank the focus ladder climbs: 4 and 5 here, while
-- official Easy/Medium/Hard are derived as 1/2/3 in the client.
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  section TEXT,
  domain TEXT,
  difficulty TEXT,
  skill TEXT,
  stem_html TEXT,
  choices_json TEXT,
  correct_answer TEXT,
  explanation_html TEXT,
  source TEXT,
  source_page INTEGER,
  has_figure INTEGER DEFAULT 0,
  stem_text TEXT DEFAULT '',
  level INTEGER DEFAULT 4
);
```

Copy the same text to `migrations_ai/0001_init.sql`.

- [ ] **Step 5: Add the binding**

Append to `wrangler.toml`:

```toml
# The AI-authored bank, in its own database so the session auditing the official
# bank cannot collide with it. Note D1's daily row-write cap is account-wide, so
# this buys isolation, not extra budget. User data stays in DB — see ai_ids.
[[d1_databases]]
binding = "AI_DB"
database_name = "sat_ai_bank"
database_id = "PLACEHOLDER_UNTIL_CREATED"
```

- [ ] **Step 6: Create the databases locally**

```bash
npx wrangler d1 execute DB --local --file=migrations/0009_ai_bank.sql
npx wrangler d1 execute AI_DB --local --file=schema_ai.sql
```

Expected: two "Executed N commands" lines. `--local` needs no Cloudflare login.
Stop `wrangler dev` first if it is running — it holds the local D1 in memory and
flushes on shutdown, silently overwriting anything written underneath it.

- [ ] **Step 7: Run the test to verify it passes**

```bash
node test_worker_sql.cjs
```

Expected: PASS, ending in the file's existing `all guards hold` line.

- [ ] **Step 8: Commit**

```bash
git add schema.sql schema_ai.sql migrations/0009_ai_bank.sql migrations_ai/0001_init.sql wrangler.toml test_worker_sql.cjs
git commit -m "feat: a second D1 database for the AI bank, and the analytics columns"
```

---

### Task 2: The authoring pipeline — `tools/apply_ai.cjs`

**Files:**
- Create: `tools/apply_ai.cjs`
- Test: `node tools/apply_ai.cjs --test` (self-check inside the file)

The validator is the thing that stops a bad question shipping, so it is written
first and tested against deliberately broken rows.

- [ ] **Step 1: Write the file with its self-check**

`tools/apply_ai.cjs`:

```js
// Validates an authored batch of AI questions, writes it into the local AI D1,
// registers the ids in the main DB, and emits SQL for the remote.
//   node tools/apply_ai.cjs tools/aiq/rw_01.jsonl        validate + import
//   node tools/apply_ai.cjs --test                       self-check, touches nothing
const fs = require('fs');
const path = require('path');

const MATH_TRAPS = ['sign-flip', 'endpoint-off-by-one', 'solved-wrong-quantity',
  'unit-mismatch', 'ratio-inverted', 'mean-vs-median', 'extraneous-root',
  'percent-wrong-base', 'slope-intercept-swap', 'axis-misread', 'unsimplified-form',
  'shortcut-trap'];
const RW_TRAPS = ['out-of-scope', 'too-extreme', 'true-but-irrelevant',
  'wrong-part-of-passage', 'reversed-relationship', 'half-right', 'vocab-collocation',
  'comma-splice-plausible', 'distant-antecedent', 'modifier-attachment',
  'transition-reversal', 'pronoun-ambiguity'];
const TRAPS = new Set([...MATH_TRAPS, ...RW_TRAPS]);

const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Every reason a row must not ship. Returns a list of complaints; empty is a pass.
function validate(r, seen) {
  const bad = [];
  const id = r.id;
  if (!/^ai_(rw|m)\d{3}$/.test(id || '')) bad.push(`id "${id}" is not ai_rw### / ai_m###`);
  if (seen.has(id)) bad.push(`duplicate id ${id}`);
  if (!['Math', 'Reading & Writing'].includes(r.section)) bad.push(`section "${r.section}"`);
  if (!r.domain) bad.push('no domain');
  if (!r.skill) bad.push('no skill');
  if (r.level !== 4 && r.level !== 5) bad.push(`level ${r.level} is not 4 or 5`);
  if (r.difficulty !== 'Hard') bad.push(`difficulty "${r.difficulty}" must be Hard`);
  if (r.source !== 'AI') bad.push(`source "${r.source}" must be AI`);

  let ch = [];
  try { ch = JSON.parse(r.choices_json); } catch { bad.push('choices_json is not JSON'); }
  const spr = ch.length === 0;
  if (!spr && ch.length !== 4) bad.push(`${ch.length} choices, expected 4 or 0 (grid-in)`);
  const letters = ch.map(c => c.letter);
  if (!spr && letters.join('') !== 'ABCD') bad.push(`choice letters ${letters.join('')}`);
  if (!spr && !letters.includes(String(r.correct_answer).trim()))
    bad.push(`correct_answer "${r.correct_answer}" is not one of the choices`);
  if (spr && !String(r.correct_answer || '').trim()) bad.push('grid-in with no answer');
  for (const c of ch) {
    if (!String(c.content || '').trim()) bad.push(`choice ${c.letter} is empty`);
    const isRight = c.letter === String(r.correct_answer).trim();
    if (!isRight && !c.trap) bad.push(`choice ${c.letter} has no trap tag`);
    if (!isRight && c.trap && !TRAPS.has(c.trap)) bad.push(`unknown trap "${c.trap}"`);
    if (isRight && c.trap) bad.push(`the correct choice ${c.letter} carries a trap tag`);
  }

  const ex = r.explanation_html || '';
  if (!/Traps in this question/i.test(ex)) bad.push('explanation has no Traps block');
  if (!spr) for (const L of ['A', 'B', 'C', 'D'])
    if (!new RegExp(`Why ${L} is`, 'i').test(ex)) bad.push(`explanation never covers choice ${L}`);
  if (ex.indexOf('Traps in this question') > ex.search(/Why A is/i) && !spr)
    bad.push('the Traps block must come before the per-choice analysis');

  const all = [r.stem_html, r.choices_json, ex].join(' ');
  const open = (all.match(/\\\(/g) || []).length, close = (all.match(/\\\)/g) || []).length;
  if (open !== close) bad.push(`${open} \\( against ${close} \\)`);
  if (/[ÃâΓ]/.test(all)) bad.push('looks like mojibake');
  if (/<img/i.test(all)) bad.push('an <img> — AI rows draw graphs as inline <svg>');

  // A Reading & Writing answer has to be provable from the passage, not from taste:
  // some run of five or more words in the rationale must appear in the stem.
  if (r.section !== 'Math' && !spr) {
    const stem = text(r.stem_html).toLowerCase();
    const words = text(ex).toLowerCase().split(' ');
    let quoted = false;
    for (let i = 0; i + 5 <= words.length && !quoted; i++)
      if (stem.includes(words.slice(i, i + 5).join(' '))) quoted = true;
    if (!quoted) bad.push('the rationale never quotes the passage');
  }
  return bad;
}

function selftest() {
  const assert = require('assert');
  const ok = {
    id: 'ai_rw001', section: 'Reading & Writing', domain: 'Information and Ideas',
    skill: 'Central Ideas and Details', difficulty: 'Hard', source: 'AI', level: 5,
    stem_html: '<p>The colony persisted only where the tide pools stayed cold.</p>',
    choices_json: JSON.stringify([
      { letter: 'A', content: 'Cold pools' },
      { letter: 'B', content: 'Warm pools', trap: 'reversed-relationship' },
      { letter: 'C', content: 'All pools', trap: 'too-extreme' },
      { letter: 'D', content: 'Deep water', trap: 'out-of-scope' }]),
    correct_answer: 'A',
    explanation_html: '<p><strong>Traps in this question</strong></p><ul><li>x</li></ul>' +
      '<p><strong>Why A is right</strong> the tide pools stayed cold</p>' +
      '<p><strong>Why B is wrong</strong> b</p><p><strong>Why C is wrong</strong> c</p>' +
      '<p><strong>Why D is wrong</strong> d</p>'
  };
  assert.deepStrictEqual(validate(ok, new Set()), [], 'a good row was refused');
  const broke = (patch, needle) => {
    const bad = validate(Object.assign({}, ok, patch), new Set());
    assert.ok(bad.some(b => b.includes(needle)), `expected a complaint about ${needle}, got ${bad}`);
  };
  broke({ correct_answer: 'Z' }, 'not one of the choices');
  broke({ level: 3 }, 'level 3');
  broke({ explanation_html: '<p>Why A is right</p>' }, 'no Traps block');
  broke({ stem_html: '<p>\\(x=1</p>' }, '\\(');
  broke({ stem_html: '<p><img src="x"></p>' }, '<img>');
  broke({ stem_html: '<p>Unrelated prose entirely.</p>' }, 'never quotes the passage');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'Cold pools' }, { letter: 'B', content: 'b' },
    { letter: 'C', content: 'c', trap: 'too-extreme' },
    { letter: 'D', content: 'd', trap: 'out-of-scope' }]) }, 'no trap tag');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'Cold pools', trap: 'half-right' },
    { letter: 'B', content: 'b', trap: 'too-extreme' },
    { letter: 'C', content: 'c', trap: 'out-of-scope' },
    { letter: 'D', content: 'd', trap: 'half-right' }]) }, 'correct choice A carries a trap');
  assert.ok(validate(ok, new Set(['ai_rw001'])).some(b => b.includes('duplicate')));
  console.log('apply_ai selftest: all cases hold');
}

// The local D1 directory holds one hashed .sqlite per database. Tell them apart by
// what they contain rather than by name: only the AI bank's `questions` has `level`.
function localDbs() {
  const Database = require('better-sqlite3');
  const dir = path.join(__dirname, '..', '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  let main = null, ai = null;
  for (const f of files) {
    const db = new Database(path.join(dir, f));
    const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
    if (!cols.length) { db.close(); continue; }
    if (cols.includes('level')) ai = db; else main = db;
  }
  if (!ai) throw new Error('no local AI database — run: npx wrangler d1 execute AI_DB --local --file=schema_ai.sql');
  if (!main) throw new Error('no local main database');
  return { main, ai };
}

const esc = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

function main() {
  if (process.argv.includes('--test')) return selftest();
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tools/apply_ai.cjs <batch.jsonl> [...]'); process.exit(2); }

  const rows = [], seen = new Set(), problems = [];
  for (const f of files)
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      const r = JSON.parse(line);
      const bad = validate(r, seen);
      if (bad.length) problems.push(`${r.id}: ${bad.join('; ')}`);
      seen.add(r.id); rows.push(r);
    }
  if (problems.length) {
    console.error(`REFUSED — ${problems.length} row(s):\n` + problems.join('\n'));
    process.exit(1);
  }

  const { main: mainDb, ai } = localDbs();
  const put = ai.prepare(`INSERT INTO questions
    (id, section, domain, difficulty, skill, stem_html, choices_json, correct_answer,
     explanation_html, source, has_figure, level)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      section=excluded.section, domain=excluded.domain, difficulty=excluded.difficulty,
      skill=excluded.skill, stem_html=excluded.stem_html, choices_json=excluded.choices_json,
      correct_answer=excluded.correct_answer, explanation_html=excluded.explanation_html,
      has_figure=excluded.has_figure, level=excluded.level`);
  const reg = mainDb.prepare('INSERT OR IGNORE INTO ai_ids (id) VALUES (?)');
  const fig = (r) => /<svg/i.test(r.stem_html + r.choices_json) ? 1 : 0;
  ai.transaction(() => { for (const r of rows) put.run(r.id, r.section, r.domain, r.difficulty,
    r.skill, r.stem_html, r.choices_json, r.correct_answer, r.explanation_html, 'AI', fig(r), r.level); })();
  mainDb.transaction(() => { for (const r of rows) reg.run(r.id); })();
  console.log(`local: ${rows.length} rows into the AI bank, ${rows.length} ids registered`);

  const out = path.join(__dirname, '..', 'd1_ai');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'questions.sql'), rows.map(r =>
    `INSERT INTO questions (id, section, domain, difficulty, skill, stem_html, choices_json,` +
    ` correct_answer, explanation_html, source, has_figure, level) VALUES (${esc(r.id)},` +
    `${esc(r.section)},${esc(r.domain)},${esc(r.difficulty)},${esc(r.skill)},${esc(r.stem_html)},` +
    `${esc(r.choices_json)},${esc(r.correct_answer)},${esc(r.explanation_html)},'AI',${fig(r)},` +
    `${r.level}) ON CONFLICT(id) DO UPDATE SET stem_html=excluded.stem_html,` +
    ` choices_json=excluded.choices_json, correct_answer=excluded.correct_answer,` +
    ` explanation_html=excluded.explanation_html, level=excluded.level;`).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'ids.sql'),
    rows.map(r => `INSERT OR IGNORE INTO ai_ids (id) VALUES (${esc(r.id)});`).join('\n') + '\n');
  console.log('d1_ai/questions.sql and d1_ai/ids.sql written for the remote');
}

main();
```

- [ ] **Step 2: Run the self-check**

```bash
node tools/apply_ai.cjs --test
```

Expected: `apply_ai selftest: all cases hold`.

- [ ] **Step 3: Verify it refuses an empty run**

```bash
node tools/apply_ai.cjs
```

Expected: exit 2, `usage: node tools/apply_ai.cjs <batch.jsonl> [...]`.

- [ ] **Step 4: Commit**

```bash
git add tools/apply_ai.cjs
git commit -m "feat: validator and importer for the AI question bank"
```

---

### Task 3: Authored batch 1 — 25 Reading & Writing questions

**Files:**
- Create: `tools/aiq/rw_01.jsonl`

Skills must be spelled exactly as the official bank spells them. Get the list first:

```bash
node -e "const D=require('better-sqlite3');const fs=require('fs');const d='.wrangler/state/v3/d1/miniflare-D1DatabaseObject';const f=fs.readdirSync(d).find(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite');const db=new D(d+'/'+f);console.log(db.prepare(\"select section,domain,skill,count(*) n from questions group by 1,2,3 order by 1,2,3\").all());"
```

- [ ] **Step 1: Write 25 rows, one JSON object per line**

Each line has exactly these keys: `id`, `section`, `domain`, `skill`, `difficulty`
(`"Hard"`), `source` (`"AI"`), `level` (4 or 5), `stem_html`, `choices_json`,
`correct_answer`, `explanation_html`.

Worked example of the required shape (`ai_rw001`, one line in the file):

```json
{"id":"ai_rw001","section":"Reading & Writing","domain":"Information and Ideas","skill":"Command of Evidence","difficulty":"Hard","source":"AI","level":5,"stem_html":"<p>A researcher studying urban crows claimed that the birds' tool use spreads by imitation rather than by independent discovery. She noted that in the Sendai population, the behavior of dropping walnuts onto crosswalks appeared in a single park in 1997 and was recorded in every adjacent park within four years, while no isolated population more than twenty kilometers away performed it before 2004. A skeptic responded that the timing is equally consistent with each population inventing the behavior once traffic volume passed a threshold, and noted that traffic in the outlying districts reached the Sendai 1997 level only in 2003.</p><p>Which finding, if true, would most directly undermine the skeptic's objection?</p>","choices_json":"[{\"letter\":\"A\",\"content\":\"Two outlying districts whose traffic passed the 1997 Sendai level in 1999 showed no walnut-dropping until crows from Sendai were observed visiting them in 2004.\"},{\"letter\":\"B\",\"content\":\"Traffic volume in Sendai's central parks continued to rise after 1997, and walnut-dropping became more frequent there each year.\",\"trap\":\"true-but-irrelevant\"},{\"letter\":\"C\",\"content\":\"Crows in every studied population are capable of learning novel foraging behaviors by watching other crows.\",\"trap\":\"out-of-scope\"},{\"letter\":\"D\",\"content\":\"No population has ever been observed to drop walnuts onto roads that carry no traffic.\",\"trap\":\"reversed-relationship\"}]","correct_answer":"A","explanation_html":"<p><strong>Traps in this question</strong></p><ul><li><em>Answering the wrong question.</em> The task is to undermine the skeptic, not to support the researcher in general. Three choices help the researcher's thesis in a loose way and do nothing to the objection.</li><li><em>Capacity mistaken for cause.</em> Showing that crows <em>can</em> imitate never shows that in this case they <em>did</em>.</li><li><em>Timing pressure.</em> The passage hands you two dates on purpose; a student reading quickly matches any choice containing a date.</li></ul><p><strong>Why A is right</strong> The skeptic's claim is that the traffic threshold alone explains the timing. A names districts that crossed that threshold in 1999 and still produced no walnut-dropping until contact with Sendai crows in 2004 &mdash; the threshold was met and the behavior did not appear, so the threshold is not sufficient, which is exactly the objection's load-bearing assumption.</p><p><strong>Why B is wrong</strong> It reports that behavior intensified where it already existed. That is consistent with both explanations and touches neither.</p><p><strong>Why C is wrong</strong> Capacity, not cause. Every population being <em>able</em> to imitate is equally compatible with each one inventing the behavior independently.</p><p><strong>Why D is wrong</strong> It confirms that traffic is necessary, which is the skeptic's own premise. Strengthening the objection is the reverse of undermining it.</p>"}
```

Requirements every row must meet, because the validator enforces them:

- exactly four choices lettered A–D; every wrong one carries a `trap` from the
  vocabulary in `tools/apply_ai.cjs`; the correct one carries none;
- `explanation_html` opens with a `Traps in this question` block and then covers
  `Why A is …` through `Why D is …` in order;
- the rationale quotes at least five consecutive words from the stem — the answer
  must be provable from the passage, as in official items;
- graphs, where a question needs one, are inline `<svg>` using `currentColor` for
  strokes and text, never an `<img>`.

Spread the 25 across the Reading & Writing domains in proportion to the official
bank (Information and Ideas, Craft and Structure, Expression of Ideas, Standard
English Conventions). Roughly two thirds at `level` 5.

- [ ] **Step 2: Validate and import**

```bash
node tools/apply_ai.cjs tools/aiq/rw_01.jsonl
```

Expected: `local: 25 rows into the AI bank, 25 ids registered`. Any `REFUSED` line
names the row and the complaint — fix the JSONL and re-run; the import is an upsert
so re-running is safe.

- [ ] **Step 3: Confirm the rows landed**

```bash
node -e "const D=require('better-sqlite3');const fs=require('fs');const d='.wrangler/state/v3/d1/miniflare-D1DatabaseObject';for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite')){const db=new D(d+'/'+f);const c=db.prepare('PRAGMA table_info(questions)').all().map(x=>x.name);if(c.includes('level'))console.log(db.prepare('select level,count(*) n from questions group by 1').all());}"
```

Expected: a count per level summing to 25.

- [ ] **Step 4: Commit**

```bash
git add tools/aiq/rw_01.jsonl
git commit -m "feat: 25 Reading and Writing questions for the AI bank"
```

---

### Task 4: Authored batches 2 and 3 — 50 more Reading & Writing questions

**Files:**
- Create: `tools/aiq/rw_02.jsonl`, `tools/aiq/rw_03.jsonl`

- [ ] **Step 1: Write `tools/aiq/rw_02.jsonl`** — 25 rows, `ai_rw026`–`ai_rw050`, same
  shape and rules as Task 3 Step 1. Do not reuse a passage subject from batch 1.

- [ ] **Step 2: Validate and import**

```bash
node tools/apply_ai.cjs tools/aiq/rw_02.jsonl
```

Expected: `local: 25 rows into the AI bank, 25 ids registered`.

- [ ] **Step 3: Write `tools/aiq/rw_03.jsonl`** — 25 rows, `ai_rw051`–`ai_rw075`.
  This batch carries the Standard English Conventions weight: at least eight rows
  whose distractors are `comma-splice-plausible`, `distant-antecedent`,
  `modifier-attachment` or `pronoun-ambiguity`.

- [ ] **Step 4: Validate and import**

```bash
node tools/apply_ai.cjs tools/aiq/rw_03.jsonl
```

Expected: `local: 25 rows into the AI bank, 25 ids registered`.

- [ ] **Step 5: Commit**

```bash
git add tools/aiq/rw_02.jsonl tools/aiq/rw_03.jsonl
git commit -m "feat: 50 more Reading and Writing questions for the AI bank"
```

---

### Task 5: Authored batch 4 — 25 Math questions

**Files:**
- Create: `tools/aiq/math_01.jsonl`

- [ ] **Step 1: Write 25 rows**, `ai_m001`–`ai_m025`, sections `"Math"`, skills spelled
  as the official bank spells them. At least six carry an inline `<svg>` graph
  (parabola with a marked vertex, a scatter with a misleading axis break, a piecewise
  line, a circle with a chord, a box plot, a histogram whose bin width changes).
  Every SVG uses `stroke="currentColor"` and `fill="none"` for the plot and
  `fill="currentColor"` for text, so it is legible in both themes, and carries
  `viewBox` plus `role="img"` and an `<title>`.

  Grid-in rows are allowed: `choices_json` is `"[]"` and `correct_answer` is the
  entry, in the form the player's `isRight()` accepts (a decimal, or `a/b`).

- [ ] **Step 2: Validate and import**

```bash
node tools/apply_ai.cjs tools/aiq/math_01.jsonl
```

Expected: `local: 25 rows into the AI bank, 25 ids registered`.

- [ ] **Step 3: Check every stored answer actually grades right**

```bash
node -e "
const D=require('better-sqlite3'),fs=require('fs');
const d='.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
let db;for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.sqlite')&&x!=='metadata.sqlite')){const t=new D(d+'/'+f);if(t.prepare('PRAGMA table_info(questions)').all().map(x=>x.name).includes('level'))db=t;}
const rows=db.prepare('select id,choices_json,correct_answer from questions').all();
let bad=0;
for(const r of rows){const ch=JSON.parse(r.choices_json);
  if(ch.length&&!ch.some(c=>c.letter===r.correct_answer.trim())){console.log('unanswerable',r.id);bad++;}
  if(!ch.length&&!/^[-.0-9\/]+$/.test(r.correct_answer.trim())){console.log('ungradeable grid-in',r.id);bad++;}}
console.log(rows.length+' rows, '+bad+' broken');"
```

Expected: `100 rows, 0 broken`.

- [ ] **Step 4: Commit**

```bash
git add tools/aiq/math_01.jsonl
git commit -m "feat: 25 Math questions for the AI bank"
```

---

### Task 6: The Worker serves both banks and records the new metrics

**Files:**
- Modify: `src/index.js:140-155` (`/api/questions`), `:174-203` (progress POST),
  `:213-238` (attempts POST), `:247-274` (notes POST)
- Test: `test_worker_sql.cjs` (already extended in Task 1)

- [ ] **Step 1: Serve both banks**

Replace the body of the `/api/questions` branch with:

```js
    if (p === '/api/questions' && req.method === 'GET') {
      // Not SELECT *: stem_text is a legacy OCR column nothing renders, and it
      // is 15% of a payload the client downloads whole.
      const cols = 'id, external_id, section, domain, difficulty, skill, stem_html,' +
        ' choices_json, correct_answer, explanation_html, source, source_page, has_figure';
      // The AI bank is a second database — D1 cannot join across one, so the two
      // banks are concatenated here rather than in SQL. `level` only exists there.
      const [core, ai] = await Promise.all([
        env.DB.prepare(`SELECT ${cols} FROM questions`).all(),
        env.AI_DB
          ? env.AI_DB.prepare(`SELECT ${cols}, level FROM questions`).all().catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] })
      ]);
      const res = json([...(core.results || []), ...(ai.results || [])]);
      res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
      return res;
    }
```

- [ ] **Step 2: Widen the three write guards**

In the progress POST, change the statement to:

```js
      const stmt = env.DB.prepare(
        `INSERT INTO progress
           SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                                     OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
           last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
           stars=MAX(progress.stars, excluded.stars)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), r.attempts | 0, r.corrects | 0,
        str(r.marker, 16) || 'Red', str(r.last_reviewed, 32) || null,
        r.time_taken_ms | 0, r.stars | 0, str(r.question_id, 64), str(r.question_id, 64))));
```

In the notes POST, change `put` the same way — one extra `OR EXISTS(SELECT 1 FROM
ai_ids WHERE id = ?)` in the `WHERE`, and one extra `str(r.question_id, 64)` bound
at the end of that statement's arguments.

- [ ] **Step 3: Record `picked` and `changes`**

In the attempts POST, replace the statement and its binding with:

```js
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO attempts
           (user_id, question_id, ts, correct, time_taken_ms, picked, changes)
         SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                                 OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), str(r.ts, 32), r.correct ? 1 : 0, r.time_taken_ms | 0,
        str(r.picked, 32) || null, r.changes | 0,
        str(r.question_id, 64), str(r.question_id, 64))));
```

And widen the GET one line above the POST so the client gets the columns back:

```js
      const r = await env.DB.prepare(
        'SELECT question_id, ts, correct, time_taken_ms, picked, changes FROM attempts WHERE user_id = ? ORDER BY ts'
      ).bind(u.id).all();
```

- [ ] **Step 4: Run the SQL tests**

```bash
node test_worker_sql.cjs
```

Expected: PASS — the Task 1 assertions now exercise the exact statements the Worker
ships.

- [ ] **Step 5: Check the served payload**

```bash
npx wrangler dev --port 8787
```

then in another shell:

```bash
curl -s localhost:8787/api/questions | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const q=JSON.parse(s);const by={};q.forEach(x=>by[x.source]=(by[x.source]||0)+1);console.log(by, 'levels', new Set(q.filter(x=>x.level).map(x=>x.level)));})"
```

Expected: `{ CollegeBoard: 3770, AI: 100 } levels Set(2) { 4, 5 }`.

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: serve the AI bank alongside the official one, record picked and changes"
```

---

### Task 7: Client — level, the AI flag, and metric capture

**Files:**
- Modify: `public/index.html` — `load()` at `:1253`, `renderAnswerArea()` at `:2355`,
  `grade()` at `:2464`, `start()` at `:2132`, `saveLog()` at `:1176`
- Test: `test_metrics.cjs` (created here)

- [ ] **Step 1: Write the failing test**

`test_metrics.cjs`:

```js
// The three derived metrics, lifted out of public/index.html by their markers so a
// copy here cannot drift from what ships.
//   node test_metrics.cjs
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const block = (name) => {
  const m = src.match(new RegExp(`// --- ${name}([\\s\\S]*?)// --- end ${name}`));
  if (!m) throw new Error(`no // --- ${name} block in public/index.html`);
  return m[1];
};
const api = new Function('QS', 'PROG', 'LOG', block('metrics') + '; return { trapCounts, pacing, guessing, levelOf };');

const QS = [
  { id: 'q1', section: 'Math', difficulty: 'Hard',
    choices: [{ letter: 'A', content: 'a' }, { letter: 'B', content: 'b', trap: 'sign-flip' }] },
  { id: 'ai_rw001', section: 'Reading & Writing', difficulty: 'Hard', level: 5,
    choices: [{ letter: 'A', content: 'a' }, { letter: 'C', content: 'c', trap: 'too-extreme' }] }
];
const LOG = [
  { question_id: 'q1', ts: '2026-09-01T10:00:00Z', correct: 0, time_taken_ms: 40000, picked: 'B', changes: 0 },
  { question_id: 'q1', ts: '2026-09-01T10:02:00Z', correct: 1, time_taken_ms: 95000, picked: 'A', changes: 3 },
  { question_id: 'ai_rw001', ts: '2026-09-01T10:05:00Z', correct: 0, time_taken_ms: 200000, picked: 'C', changes: 1 }
];
const m = api(QS, {}, LOG);

assert.deepStrictEqual(m.trapCounts(), [['sign-flip', 1], ['too-extreme', 1]],
  'a wrong pick must be counted against the trap its choice carries');
const pace = m.pacing();
assert.strictEqual(pace.rushed, 1, '40s on a 95s Math target is rushed');
assert.strictEqual(pace.slow, 1, '200s on a 71s RW target is slow');
assert.strictEqual(pace.onPace, 1, '95s on a 95s Math target is on pace');
const g = m.guessing();
assert.strictEqual(g.mean, 4 / 3, 'mean changes over three attempts');
assert.strictEqual(g.changedAcc, 50, 'one of the two changed attempts was right');
assert.strictEqual(m.levelOf(QS[0]), 3, 'official Hard is level 3');
assert.strictEqual(m.levelOf(QS[1]), 5, 'an AI row keeps its stored level');
console.log('metrics: all cases hold');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test_metrics.cjs
```

Expected: throws `no // --- metrics block in public/index.html`.

- [ ] **Step 3: Add the metrics block**

In `public/index.html`, immediately after the `tally()` function (ends near `:1609`),
insert:

```js
// --- metrics (test_metrics.cjs reads this block)
// Official rows have no `level`; their difficulty is the rank. AI rows carry 4 or 5.
const LVL = { easy: 1, medium: 2, hard: 3 };
const levelOf = (q) => q.level || LVL[String(q.difficulty || '').toLowerCase()] || 2;

// SAT pacing: 35 minutes for 22 Math questions, 32 for 27 Reading & Writing.
const TARGET_MS = { Math: 95000, 'Reading & Writing': 71000 };
const targetOf = (q) => TARGET_MS[q.section] || 85000;

// Which trap each miss walked into. A wrong pick is looked up in that question's
// own choices, so the tag travels with the question rather than being re-derived.
function trapCounts() {
  const byId = new Map(QS.map(q => [q.id, q]));
  const n = {};
  LOG.forEach(x => {
    if (x.correct || !x.picked) return;
    const q = byId.get(x.question_id); if (!q || !q.choices) return;
    const c = q.choices.find(c => c.letter === x.picked);
    if (c && c.trap) n[c.trap] = (n[c.trap] || 0) + 1;
  });
  return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Under 60% of target is rushed, over 140% is slow. Anything between is on pace.
function pacing() {
  const byId = new Map(QS.map(q => [q.id, q]));
  const out = { rushed: 0, onPace: 0, slow: 0, ms: {}, n: {} };
  LOG.forEach(x => {
    const q = byId.get(x.question_id); if (!q || !x.time_taken_ms) return;
    const t = targetOf(q), r = x.time_taken_ms / t;
    out[r < 0.6 ? 'rushed' : r > 1.4 ? 'slow' : 'onPace']++;
    out.ms[q.section] = (out.ms[q.section] || 0) + x.time_taken_ms;
    out.n[q.section] = (out.n[q.section] || 0) + 1;
  });
  return out;
}

// Second-guessing: how often a selection is switched before Check, and whether
// switching helps. Attempts logged before this shipped have no `changes` at all.
function guessing() {
  const seen = LOG.filter(x => x.changes != null);
  const tot = seen.reduce((n, x) => n + (x.changes | 0), 0);
  const ch = seen.filter(x => (x.changes | 0) > 0), st = seen.filter(x => !(x.changes | 0));
  const acc = (l) => l.length ? Math.round(l.filter(x => x.correct).length / l.length * 100) : null;
  return { mean: seen.length ? tot / seen.length : 0, n: seen.length,
           changedAcc: acc(ch), steadyAcc: acc(st), changedN: ch.length };
}
// --- end metrics
```

- [ ] **Step 4: Capture `picked` and `changes` in the player**

In `start()` (`:2132`), add `changes: {}` to the session object, beside `sel: {}`.

In `renderAnswerArea()`'s choice click handler (`:2396`), where the selection is
moved by hand, increment the counter — insert immediately after
`const letter = el.dataset.letter;`:

```js
      // Counts switches, not first picks: selecting for the first time is not a
      // second guess. Read back by the Second-guessing panel.
      if (S.sel[q.id] && S.sel[q.id] !== letter) S.changes[q.id] = (S.changes[q.id] || 0) + 1;
```

In `grade()` (`:2464`), where the attempt event is built (`const ev = {...}`, `:2500`),
carry both fields:

```js
  const ev = { question_id: q.id, ts: now, correct: ok === true ? 1 : 0, time_taken_ms: ms,
               picked: String(S.ans[q.id] == null ? '' : S.ans[q.id]).slice(0, 32),
               changes: S.changes[q.id] | 0 };
```

- [ ] **Step 5: Parse `trap` and `level` at load**

In `load()` (`:1253`), inside the per-question mapping where `choices` is parsed
from `choices_json`, keep the `trap` key — the existing map builds objects from the
parsed JSON; ensure the mapped choice object carries `trap: c.trap` alongside
`letter` and `content`. Immediately after the `q.spr` line, add:

```js
        q.ai = q.source === 'AI';
        q.level = q.level || LVL[String(q.difficulty || '').toLowerCase()] || 2;
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
node test_metrics.cjs
```

Expected: `metrics: all cases hold`.

- [ ] **Step 7: Show the badge**

In `renderPanes()`'s `qhead` template (`:2333`), after the existing difficulty chip,
add:

```js
    ${q.ai ? `<span class="chip-ai">AI &middot; Level ${q.level}</span>` : ''}
```

and in the stylesheet, beside the other chip rules:

```css
.chip-ai { display:inline-block; padding:3px 9px; border-radius:999px; font-size:11.5px;
  font-weight:600; letter-spacing:.02em; background:var(--mint-d); color:var(--mint-t);
  border:1px solid var(--mint-b); }
```

If `--mint-d` / `--mint-t` / `--mint-b` are not already defined, reuse the existing
mint tokens the rail uses for the active tab; do not introduce a new palette.

- [ ] **Step 8: Commit**

```bash
git add public/index.html test_metrics.cjs
git commit -m "feat: question level, AI badge, and per-attempt trap and pacing capture"
```

---

### Task 8: Dashboard — four panels

**Files:**
- Modify: `public/index.html` — `drawDash()` at `:1846`, and the dashboard markup

- [ ] **Step 1: Add the panel markup**

In the dashboard view's markup, after the existing accuracy-by-difficulty panel, add
four panels with the same `.panel` / `.panel-h` / `.panel-b` structure the file
already uses:

```html
<div class="panel"><div class="panel-h">Traps you fall for<span class="sub" id="trap-n"></span></div><div class="panel-b" id="trap-body"></div></div>
<div class="panel"><div class="panel-h">Pacing<span class="sub" id="pace-n"></span></div><div class="panel-b" id="pace-body"></div></div>
<div class="panel"><div class="panel-h">Second-guessing<span class="sub" id="guess-n"></span></div><div class="panel-b" id="guess-body"></div></div>
<div class="panel"><div class="panel-h">Accuracy by level</div><div class="panel-b" id="level-body"></div></div>
```

- [ ] **Step 2: Fill them in `drawDash()`**

At the end of `drawDash()`, before its closing brace:

```js
  // Traps. Reuses bars() so the row shape matches every other breakdown on the page.
  const traps = trapCounts();
  const worst = traps[0];
  $('trap-n').textContent = worst ? `${worst[0]} ×${worst[1]}` : 'no misses logged';
  $('trap-body').innerHTML = traps.length
    ? traps.slice(0, 10).map(([name, n]) => {
        const w = Math.round(n / traps[0][1] * 100);
        return `<div class="brow"><span class="blab">${esc(name)}</span>` +
          `<span class="bbar"><i style="width:${w}%"></i></span>` +
          `<span class="bval">${n}</span></div>`;
      }).join('')
    : '<div class="empty">Nothing yet. Miss a question and the trap it used shows up here.</div>';

  const pc = pacing(), pn = pc.rushed + pc.onPace + pc.slow;
  $('pace-n').textContent = pn ? `${Math.round(pc.onPace / pn * 100)}% on pace` : '';
  $('pace-body').innerHTML = pn
    ? ['rushed', 'onPace', 'slow'].map(k => {
        const lab = k === 'onPace' ? 'On pace' : k[0].toUpperCase() + k.slice(1);
        return `<div class="brow"><span class="blab">${lab}</span>` +
          `<span class="bbar"><i style="width:${Math.round(pc[k] / pn * 100)}%"></i></span>` +
          `<span class="bval">${pc[k]}</span></div>`;
      }).join('') +
      Object.keys(pc.n).map(s => `<div class="brow"><span class="blab">${esc(s)} mean</span>` +
        `<span class="bval">${Math.round(pc.ms[s] / pc.n[s] / 1000)}s vs ${Math.round((TARGET_MS[s] || 85000) / 1000)}s</span></div>`).join('')
    : '<div class="empty">No timed answers yet.</div>';

  const g = guessing();
  $('guess-n').textContent = g.n ? `${g.mean.toFixed(2)} switches per question` : '';
  $('guess-body').innerHTML = g.n
    ? `<div class="brow"><span class="blab">Changed answer</span><span class="bval">${g.changedAcc == null ? '&mdash;' : g.changedAcc + '%'} &middot; ${g.changedN}</span></div>` +
      `<div class="brow"><span class="blab">Stuck with first pick</span><span class="bval">${g.steadyAcc == null ? '&mdash;' : g.steadyAcc + '%'} &middot; ${g.n - g.changedN}</span></div>`
    : '<div class="empty">No answers logged since switch tracking shipped.</div>';

  // Accuracy by level, 1-5, over the attempt log rather than the marker.
  const byId = new Map(QS.map(q => [q.id, q]));
  const lv = {};
  LOG.forEach(x => {
    const q = byId.get(x.question_id); if (!q) return;
    const k = levelOf(q), v = lv[k] = lv[k] || { a: 0, c: 0 };
    v.a++; if (x.correct) v.c++;
  });
  const ks = Object.keys(lv).sort();
  $('level-body').innerHTML = ks.length
    ? ks.map(k => {
        const v = lv[k], pct = Math.round(v.c / v.a * 100);
        return `<div class="brow"><span class="blab">Level ${k}${k > 3 ? ' (AI)' : ''}</span>` +
          `<span class="bbar"><i style="width:${pct}%"></i></span>` +
          `<span class="bval">${pct}% &middot; ${v.c}/${v.a}</span></div>`;
      }).join('')
    : '<div class="empty">No answers yet.</div>';
```

If the class names `.brow` / `.blab` / `.bbar` / `.bval` differ in this file, use
whatever `bars()` at `:1838` emits — read it first and match it exactly rather than
inventing a second bar style.

- [ ] **Step 3: Verify in the browser**

```bash
npx wrangler dev --port 8787
```

Open `http://localhost:8787`, answer three AI questions (one wrongly, one after
switching your pick, one very fast), then open Dashboard. Expected: Traps names the
trap you took, Pacing shows a rushed count of at least 1, Second-guessing shows a
non-zero mean, Accuracy by level shows a Level 4 or 5 row.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: trap, pacing, second-guessing and by-level dashboard panels"
```

---

### Task 9: Focus practice — picker, ladder, popup, timing

**Files:**
- Modify: `public/index.html` — practice controls near `:733`, `pool()` at `:1585`,
  `start()` at `:2132`, `loadQuestion()` at `:2296`, the timer at `:2152`
- Test: `test_focus.cjs`

- [ ] **Step 1: Write the failing test**

`test_focus.cjs`:

```js
// The focus-set picker and the difficulty ladder, lifted out of public/index.html.
//   node test_focus.cjs
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const m = src.match(/\/\/ --- focus([\s\S]*?)\/\/ --- end focus/);
if (!m) throw new Error('no // --- focus block in public/index.html');
const api = new Function('QS', 'PROG', 'LOG',
  'const levelOf = (q) => q.level || ({easy:1,medium:2,hard:3})[String(q.difficulty||"").toLowerCase()] || 2;' +
  m[1] + '; return { weakness, focusSet, nextLevel };');

const QS = [];
for (let i = 0; i < 40; i++) QS.push({ id: 'w' + i, section: 'Math', skill: 'Weak', difficulty: 'Hard', level: 3 + (i % 3) });
for (let i = 0; i < 40; i++) QS.push({ id: 's' + i, section: 'Math', skill: 'Strong', difficulty: 'Hard', level: 3 });
const PROG = {};
for (let i = 0; i < 10; i++) PROG['w' + i] = { attempts: 1, corrects: 0, marker: 'Red' };
for (let i = 0; i < 10; i++) PROG['s' + i] = { attempts: 1, corrects: 1, marker: 'Green' };
const f = api(QS, PROG, []);

const w = f.weakness(QS);
assert.ok(w.get('Weak') > w.get('Strong'), 'a skill that is always missed must outrank one always right');

const set = f.focusSet({ n: 30, sections: null, bank: 'both' });
assert.strictEqual(set.length, 30, 'the set must be the requested size');
assert.ok(new Set(set.map(q => q.id)).size === 30, 'no question may repeat inside one set');
const weakShare = set.filter(q => q.skill === 'Weak').length / 30;
assert.ok(weakShare > 0.5, `the weak skill should dominate, got ${weakShare}`);
assert.ok(set.slice(0, 5).every(q => !PROG[q.id]), 'unseen questions come before ones already drilled');

assert.strictEqual(f.nextLevel(3, 1, true), 3, 'one correct answer does not promote');
assert.strictEqual(f.nextLevel(3, 2, true), 4, 'two in a row promotes');
assert.strictEqual(f.nextLevel(5, 2, true), 5, 'level is capped at 5');
assert.strictEqual(f.nextLevel(3, 0, false), 2, 'a miss demotes');
assert.strictEqual(f.nextLevel(1, 0, false), 1, 'level floors at 1');

const only = f.focusSet({ n: 10, sections: ['Math'], bank: 'ai' });
assert.strictEqual(only.length, 0, 'no AI rows in this fixture, so an AI-only set is empty');
console.log('focus: all cases hold');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node test_focus.cjs
```

Expected: throws `no // --- focus block in public/index.html`.

- [ ] **Step 3: Add the focus block**

In `public/index.html`, after `pool()` (`:1591`):

```js
// --- focus (test_focus.cjs reads this block)
// How likely this skill is to be missed next, Laplace-smoothed so a skill with no
// attempts scores 0.5 and surfaces instead of being invisible.
function weakness(list) {
  const acc = new Map();
  list.forEach(q => { const k = q.skill || 'Other'; if (!acc.has(k)) acc.set(k, { a: 0, m: 0 }); });
  Object.entries(PROG).forEach(([id, p]) => {
    const q = list.find(x => x.id === id); if (!q || !p.attempts) return;
    const v = acc.get(q.skill || 'Other'); if (!v) return;
    v.a += p.attempts; v.m += p.attempts - (p.corrects || 0);
  });
  const out = new Map();
  acc.forEach((v, k) => out.set(k, (v.m + 1) / (v.a + 2)));
  return out;
}

// The set: slots allocated across skills in proportion to how weak they are, then
// filled with never-seen questions before ones already drilled.
function focusSet(cfg) {
  const secs = cfg.sections ? new Set(cfg.sections) : null;
  const pool = QS.filter(q =>
    (!secs || secs.has(q.section)) &&
    (cfg.bank === 'both' || (cfg.bank === 'ai' ? q.source === 'AI' : q.source !== 'AI')));
  if (!pool.length) return [];
  const w = weakness(pool);
  const skills = [...new Set(pool.map(q => q.skill || 'Other'))]
    .sort((a, b) => w.get(b) - w.get(a));
  const total = skills.reduce((n, s) => n + w.get(s), 0);
  const bySkill = {};
  pool.forEach(q => (bySkill[q.skill || 'Other'] = bySkill[q.skill || 'Other'] || []).push(q));
  // Unseen first, then longest since last seen, then easiest — the ladder raises
  // the level as the set is played, so it starts at the bottom of each skill.
  const rank = (q) => {
    const p = PROG[q.id];
    return [p ? 1 : 0, p && p.last_reviewed ? p.last_reviewed : '', levelOf(q)];
  };
  skills.forEach(s => bySkill[s].sort((a, b) => {
    const x = rank(a), y = rank(b);
    return x[0] - y[0] || String(x[1]).localeCompare(String(y[1])) || x[2] - y[2];
  }));
  const out = [], want = {};
  skills.forEach(s => (want[s] = Math.round(cfg.n * w.get(s) / total)));
  // Round-robin over the skills so a rounding error cannot starve one of them and
  // the set always reaches n while questions remain.
  let guard = 0;
  while (out.length < cfg.n && guard++ < cfg.n * 20) {
    let moved = false;
    for (const s of skills) {
      if (out.length >= cfg.n) break;
      if (want[s] <= 0 && out.length < cfg.n && guard < cfg.n) continue;
      const q = bySkill[s].shift();
      if (!q) continue;
      out.push(q); want[s]--; moved = true;
    }
    if (!moved) break;
  }
  return out.slice(0, cfg.n);
}

// Two straight correct promotes, any miss demotes. 1..5.
const nextLevel = (lvl, streak, ok) =>
  ok ? (streak >= 2 ? Math.min(5, lvl + 1) : lvl) : Math.max(1, lvl - 1);
// --- end focus
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test_focus.cjs
```

Expected: `focus: all cases hold`.

- [ ] **Step 5: Add the mode switch and the popup**

Beside `#btn-start` (`:733`), add a mode control and keep the existing button as the
entry point for both modes:

```html
<div class="seg" id="mode-seg">
  <button class="seg-b on" data-mode="all">All questions</button>
  <button class="seg-b" data-mode="focus">Focus</button>
</div>
```

```css
.seg { display:inline-flex; gap:4px; padding:4px; border-radius:12px; background:var(--bg2); }
.seg-b { padding:7px 14px; border-radius:9px; border:0; background:transparent;
  color:var(--dim); font-size:13.5px; font-weight:600; cursor:pointer; }
.seg-b.on { background:var(--panel); color:var(--text); box-shadow:0 1px 3px rgba(0,0,0,.12); }

.fx-modal { width:min(560px,calc(100vw - 32px)); border-radius:20px; background:var(--panel);
  padding:22px; box-shadow:0 24px 60px rgba(0,0,0,.28); }
.fx-h { font-size:19px; font-weight:700; margin:0 0 4px; }
.fx-sub { color:var(--dim2); font-size:13px; margin:0 0 18px; }
.fx-row { margin-bottom:16px; }
.fx-lab { display:block; font-size:12.5px; font-weight:600; letter-spacing:.04em;
  text-transform:uppercase; color:var(--dim); margin-bottom:8px; }
.fx-opts { display:flex; flex-wrap:wrap; gap:8px; }
.fx-o { padding:9px 15px; border-radius:12px; border:1.5px solid var(--line);
  background:transparent; color:var(--text); font-size:13.5px; cursor:pointer; }
.fx-o.on { border-color:var(--acc); box-shadow:inset 0 0 0 1px var(--acc); font-weight:600; }
.fx-o[disabled] { opacity:.4; cursor:not-allowed; }
.fx-foot { display:flex; gap:10px; justify-content:flex-end; margin-top:22px; }
@media (max-width:760px){ .fx-modal{ padding:18px; } .fx-o{ flex:1 1 auto; text-align:center; } }
```

The popup itself, next to `confirmModal()` (`:2772`) so it sits with the other
modals:

```js
const FX_DEFAULT = { sections: null, bank: 'both', n: 35, timing: 'off', mult: 1, auto: false };
let FX = Object.assign({}, FX_DEFAULT, LS.get('focus', {}));

function focusModal() {
  const root = $('modal-root');
  const opt = (k, v, lab, dis) =>
    `<button class="fx-o${String(FX[k]) === String(v) ? ' on' : ''}" data-k="${k}" data-v="${v}"${dis ? ' disabled' : ''}>${lab}</button>`;
  const secOn = (v) => (FX.sections || ['Math', 'Reading & Writing']).join() ===
    (v === 'both' ? 'Math,Reading & Writing' : v);
  const draw = () => {
    const perQ = FX.timing === 'perq';
    root.innerHTML = `<div class="modal-bg"><div class="fx-modal" role="dialog" aria-label="Focus practice">
      <h2 class="fx-h">Focus practice</h2>
      <p class="fx-sub">Drills the skills you are statistically most likely to miss, and steps the difficulty up as you get them right.</p>
      <div class="fx-row"><span class="fx-lab">Section</span><div class="fx-opts">
        <button class="fx-o${secOn('Reading & Writing') ? ' on' : ''}" data-sec="Reading &amp; Writing">Reading &amp; Writing</button>
        <button class="fx-o${secOn('Math') ? ' on' : ''}" data-sec="Math">Math</button>
        <button class="fx-o${!FX.sections ? ' on' : ''}" data-sec="both">Both</button></div></div>
      <div class="fx-row"><span class="fx-lab">Bank</span><div class="fx-opts">
        ${opt('bank', 'official', 'Official')}${opt('bank', 'ai', 'AI')}${opt('bank', 'both', 'Both')}</div></div>
      <div class="fx-row"><span class="fx-lab">Questions</span><div class="fx-opts">
        ${opt('n', 30, '30')}${opt('n', 35, '35')}${opt('n', 40, '40')}</div></div>
      <div class="fx-row"><span class="fx-lab">Timing</span><div class="fx-opts">
        ${opt('timing', 'off', 'Untimed')}${opt('timing', 'set', 'Whole set')}${opt('timing', 'perq', 'Per question')}</div></div>
      <div class="fx-row"><span class="fx-lab">Per-question limit</span><div class="fx-opts">
        ${opt('mult', 1, 'Realistic', !perQ)}${opt('mult', 1.5, '1.5&times;', !perQ)}${opt('mult', 2, '2&times;', !perQ)}</div></div>
      <div class="fx-row"><span class="fx-lab">Out of time</span><div class="fx-opts">
        ${opt('auto', false, 'Keep going', !perQ)}${opt('auto', true, 'Auto-advance', !perQ)}</div></div>
      <div class="fx-foot"><button class="btn-s" data-x="1">Cancel</button>
        <button class="btn-p" data-go="1">Start focus set</button></div></div></div>`;
    root.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => {
      FX.sections = b.dataset.sec === 'both' ? null : [b.dataset.sec.replace('&amp;', '&')];
      draw();
    });
    root.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const v = b.dataset.v;
      FX[b.dataset.k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
      draw();
    });
    root.querySelector('[data-x]').onclick = () => (root.innerHTML = '');
    root.querySelector('[data-go]').onclick = () => {
      LS.set('focus', FX);
      const items = focusSet({ n: FX.n, sections: FX.sections, bank: FX.bank });
      if (!items.length) { alert('No questions match that combination.'); return; }
      root.innerHTML = '';
      start(items, { focus: true, timing: FX.timing, mult: FX.mult, auto: FX.auto });
    };
    root.querySelector('.modal-bg').onclick = (e) => { if (e.target === root.querySelector('.modal-bg')) root.innerHTML = ''; };
  };
  draw();
}
```

Wire the mode buttons and the start button (`:1706`):

```js
let PRACTICE_MODE = LS.get('mode', 'all');
document.querySelectorAll('#mode-seg .seg-b').forEach(b => {
  if (b.dataset.mode === PRACTICE_MODE) b.classList.add('on'); else b.classList.remove('on');
  b.onclick = () => {
    PRACTICE_MODE = b.dataset.mode; LS.set('mode', PRACTICE_MODE);
    document.querySelectorAll('#mode-seg .seg-b').forEach(x => x.classList.toggle('on', x === b));
  };
});
$('btn-start').onclick = () => (PRACTICE_MODE === 'focus' ? focusModal() : start(pool()));
```

- [ ] **Step 6: Teach `start()` the options, and the ladder**

Change the signature to `function start(items, opts)` and add to the session object:

```js
    focus: !!(opts && opts.focus),
    timing: (opts && opts.timing) || 'off',
    mult: (opts && opts.mult) || 1,
    auto: !!(opts && opts.auto),
    lvl: 3, streak: 0,
    setEnds: opts && opts.timing === 'set'
      ? Date.now() + items.reduce((n, q) => n + (TARGET_MS[q.section] || 85000), 0)
      : null,
```

In `grade()`, after the verdict is known and before `refresh()`, drive the ladder and
re-order what is left of a focus set:

```js
  if (S.focus) {
    S.streak = ok === true ? S.streak + 1 : 0;
    S.lvl = nextLevel(S.lvl, S.streak, ok === true);
    if (ok === true && S.streak >= 2) S.streak = 0;   // one promotion per two, not per answer
    // Bring the question nearest the new target level to the front of what is left.
    const rest = S.items.slice(S.i + 1);
    if (rest.length) {
      rest.sort((a, b) => Math.abs(levelOf(a) - S.lvl) - Math.abs(levelOf(b) - S.lvl));
      S.items = S.items.slice(0, S.i + 1).concat(rest);
    }
  }
```

- [ ] **Step 7: Make the clock count down when the set is timed**

In `renderQTimer()` (`:2159`), replace the elapsed-seconds computation with:

```js
  const el = $('q-clock'); if (!el) return;
  const q = curQ();
  let s, over = false;
  if (S.timing === 'perq') {
    const limit = (TARGET_MS[q.section] || 85000) * S.mult;
    const left = limit - (Date.now() - S.qStart);
    over = left < 0; s = Math.round(Math.abs(left) / 1000);
    if (over && S.auto && !S.checked[q.id]) { next(); return; }
  } else if (S.timing === 'set') {
    const left = S.setEnds - Date.now();
    over = left < 0; s = Math.round(Math.abs(left) / 1000);
  } else {
    s = Math.round((Date.now() - S.qStart) / 1000);
  }
  const m = Math.floor(s / 60), sec = s % 60;
  el.textContent = (over ? '+' : '') + m + ':' + String(sec).padStart(2, '0');
  el.classList.toggle('over', over);
```

with, in the stylesheet:

```css
#q-clock.over { color: var(--red); }
```

If `next()` is not the name of the advance function in this file, use whatever the
Next button's handler calls — read `:2676` first and match it.

- [ ] **Step 8: Verify by hand**

```bash
npx wrangler dev --port 8787
```

- Focus → popup opens, every control toggles, the three per-question controls are
  disabled until Timing is Per question.
- Start focus set → the set is the chosen size and the first questions are ones you
  have never seen.
- Answer two correctly in a row → the next question's level chip goes up.
- Per question + Realistic + Auto-advance → the clock counts down, turns red at 0,
  and moves on.
- Whole set → one countdown across the set that does not reset per question.

- [ ] **Step 9: Commit**

```bash
git add public/index.html test_focus.cjs
git commit -m "feat: adaptive timed focus practice and its setup popup"
```

---

### Task 10: Mistakes — a Bank filter

**Files:**
- Modify: `public/index.html` — `MK` at `:1917`, `wrongSet.one` at `:1933`,
  `drawMistakes()` at `:1945`

- [ ] **Step 1: Widen the filter state**

```js
const MK = { sec:null, diff:null, skills:null, status:'wrong', bank:'all' };
```

- [ ] **Step 2: Apply it in the predicate**

Inside `wrongSet.one`, alongside the section and difficulty tests:

```js
  if (MK.bank !== 'all' && (q.source === 'AI') !== (MK.bank === 'ai')) return false;
```

- [ ] **Step 3: Render the dropdown**

In `drawMistakes()`, beside the existing Section/Difficulty/Topic dropdowns, add a
fourth built with the same `dd()` component:

```js
  dd($('mk-bank'), {
    label: 'Bank', noBulk: true,
    opts: [{ v:'all', label:'All questions' }, { v:'official', label:'Official only' }, { v:'ai', label:'AI only' }],
    get: () => [MK.bank],
    set: (v) => { MK.bank = v[v.length - 1] || 'all'; LS.set('mistakes', MK); drawMistakes(); }
  });
```

and a host element `<div id="mk-bank"></div>` in the mistakes `.ctrls` row at `:796`.

If `dd()`'s `set` contract in this file differs (read `:1323` first), match it — the
component is single-select here, so the handler takes the last value.

- [ ] **Step 4: Verify by hand**

Answer one official and one AI question wrongly, open Mistakes, and switch the Bank
dropdown through all three values. Expected: All shows both, Official only shows the
official one, AI only shows the AI one, and the Status counts beside the buttons
change with it.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: filter the mistake bank by official or AI questions"
```

---

### Task 11: Legal

**Files:**
- Modify: `public/index.html` — `LEGAL` at `:1406`

- [ ] **Step 1: Add the section to the Terms entry**

Insert into the Terms body, before its closing text:

```html
<h3>AI-generated practice questions</h3>
<p>Part of this bank is written by an AI model rather than taken from a College Board
publication. Those questions are labeled in the app with an <em>AI</em> chip on the
question itself and can be filtered separately everywhere the bank is filtered. They
are provided for practice only. They are not College Board material, they are not
retired exam content, and they may contain errors in their questions, their answers
or their explanations. Treat a disagreement between an AI question and an official
one as a reason to check the official one.</p>
```

- [ ] **Step 2: Add the matching Privacy paragraph**

Insert into the Privacy body, in the section describing what is stored:

```html
<p>For each answer this app records the question, the time you took, whether you were
right, which choice you picked and how many times you changed your selection before
checking. That record is what the dashboard's accuracy, pacing and trap breakdowns
are drawn from. It is stored against your account and is not shared.</p>
```

- [ ] **Step 3: Verify by hand**

Open Settings → Legal → Terms and Privacy. Expected: both new sections render, scroll
and are readable in both themes.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "docs: legal text for AI-generated questions and the new attempt metrics"
```

---

### Task 12: The verification loop, and the remote push

**Files:**
- Modify: `CLAUDE.md`
- Create: `d1_ai/questions.sql`, `d1_ai/ids.sql` (emitted by Task 2's tool)

- [ ] **Step 1: Run every test**

```bash
node tools/apply_ai.cjs --test && node test_worker_sql.cjs && node test_metrics.cjs && node test_focus.cjs && node test_sync.cjs && node test_grade.cjs && node test_notes.cjs && node test_backfill.cjs && node test_tidy_expl.cjs
```

Expected: every file prints its own pass line and the chain exits 0. Fix and re-run
until it does — this is the loop.

- [ ] **Step 2: Grade every AI row through the player's own `isRight()`**

With `wrangler dev` running, in the browser console on `http://localhost:8787`:

```js
const ai = QS.filter(q => q.source === 'AI');
const bad = ai.filter(q => isRight(q, q.answer) !== true);
const falsePos = ai.filter(q => q.choices.length &&
  q.choices.some(c => c.letter !== q.answer && isRight(q, c.letter) === true));
console.log(ai.length, 'AI rows,', bad.length, 'that do not grade right,', falsePos.length, 'that grade a wrong choice right');
```

Expected: `100 AI rows, 0 that do not grade right, 0 that grade a wrong choice right`.

- [ ] **Step 3: Render sweep**

In the same console:

```js
const box = document.createElement('div'); document.body.appendChild(box);
let empty = 0, katex = 0, dup = 0, moji = 0;
for (const q of QS.filter(x => x.source === 'AI')) {
  box.innerHTML = renderStem(q) + (q.explanation_html || '');
  renderMathInElement(box, { delimiters: [{left:'\\(',right:'\\)',display:false},{left:'\\[',right:'\\]',display:true}] });
  if (!box.textContent.trim()) empty++;
  if (box.querySelector('.katex-error')) katex++;
  if (/[�ÃΓ]/.test(box.textContent)) moji++;
  const cs = q.choices.map(c => (c.content || '').trim());
  if (cs.length && new Set(cs).size !== cs.length) dup++;
}
box.remove();
console.log({ empty, katex, dup, moji });
```

Expected: `{ empty: 0, katex: 0, dup: 0, moji: 0 }`.

- [ ] **Step 4: Responsive walk**

At 1280, 375 and 320px in both themes: the focus popup fits with nothing clipped and
`document.body.scrollWidth` equals the viewport width on every tab; the four new
dashboard panels do not overflow; an AI question renders its SVG graph legibly in
both themes; the Bank dropdown opens inside the viewport.

Expected: no horizontal overflow at any of the three widths, no console errors.

- [ ] **Step 5: Push the AI rows to the remote**

The remote AI database has to exist first:

```bash
npx wrangler d1 create sat_ai_bank
```

Put the `database_id` it prints into `wrangler.toml` in place of
`PLACEHOLDER_UNTIL_CREATED`, then:

```bash
npx wrangler d1 execute AI_DB --remote --file=schema_ai.sql
npx wrangler d1 execute AI_DB --remote --file=d1_ai/questions.sql
npx wrangler d1 execute DB    --remote --file=migrations/0009_ai_bank.sql
npx wrangler d1 execute DB    --remote --file=d1_ai/ids.sql
```

Then verify against the remote rather than against the tool that wrote it:

```bash
npx wrangler d1 execute AI_DB --remote --command "SELECT level, COUNT(*) n FROM questions GROUP BY 1"
npx wrangler d1 execute DB    --remote --command "SELECT COUNT(*) n FROM ai_ids"
```

Expected: the level counts sum to 100, and `ai_ids` holds 100.

If `wrangler d1 create` fails for want of a login, stop: the local half is complete
and correct, and these four commands are what remains. Say so rather than reporting
the push as done.

- [ ] **Step 6: Record what was built**

Append a section to `CLAUDE.md` covering: the second database and why `ai_ids`
exists, the trap vocabulary, the two new `attempts` columns and what each dashboard
panel reads, the focus picker's scoring and ladder rules, and the measured results of
Steps 1–4 as a before/after table.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md d1_ai wrangler.toml
git commit -m "docs: record the AI bank, its analytics and the focus mode"
```
