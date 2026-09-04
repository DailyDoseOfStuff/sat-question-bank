// The 73 Bluebook practice-test rows, put back.
//
// They were dumped to backup/bluebook_rows_2026-09-03.json and dropped from both
// databases, leaving the bank at 3,770 and one progress row (pt10_rw_m1_q13)
// pointing at a question that no longer existed. Nothing was wrong with them
// that this script does not fix.
//
// Three repairs on the way in:
//   1. Their choices carry `id` where the rest of the bank carries `letter`.
//      The client falls back to position, so they rendered - but only by
//      accident, and only while the four are stored in order.
//   2. nx_3af5a620's answer is stored as "C - <the text of choice C>", and its
//      stem lost the blank the choices fill ("remarkable ___ so small").
//   3. Their `stem_text` is Tesseract's read of a question image and is not on
//      the wire any more; one of them is a different question's text entirely.
//      Dropped rather than restored.
//
// Writes the local D1 sqlite and migrations/0007_restore_bluebook.sql.
// `--test` runs the self-check and touches nothing.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, '..', '..', '..', 'backup', 'bluebook_rows_2026-09-03.json');
const COLS = ['id', 'external_id', 'section', 'domain', 'difficulty', 'skill', 'stem_html',
              'choices_json', 'correct_answer', 'explanation_html', 'source', 'source_page',
              'has_figure', 'stem_text'];

// id -> [find, replace] against the backed-up stem. Two rows lost the blank
// their choices fill; five carried a note-style summary that announced a table
// or a graph the row does not hold, one of them ("g(x) = 3, 0, 21") with a
// value that contradicts its own answer - f cannot be linear through all three.
// Every figure used in a replacement already appears somewhere in the row.
const STEM_FIX = require('./bluebook_stem_fixes.json');

// These rows are not in either source PDF, so there is nothing to extract a
// rationale from. Each was worked out from the question itself and checked
// against the stored answer; see the self-check below.
const EXPLANATIONS = require('./bluebook_explanations.json');

// 18 rows named a skill College Board does not use - a domain repeated as its
// own skill, or an ad-hoc label - each of which opened a topic-list entry with
// nothing official behind it. The self-check holds every restored skill to the
// vocabulary the CollegeBoard rows already use.
const SKILL_FIX = require('./bluebook_skill_fixes.json');

// "C - microsculptures. Creations" is the letter plus the choice's own text.
const ANSWER_FIX = { 'nx_3af5a62034e78102ad5ad11aaef44253': ['C'] };

// The same CP437 read-through the client patches at load time (only the
// superscript two occurs here). Fixed in the data so the row does not depend on
// that table.
const MOJIBAKE = [['┬▓', '²']];
const demoji = (h) => typeof h !== 'string' ? h
  : MOJIBAKE.reduce((a, [bad, good]) => a.split(bad).join(good), h);

function fix(r) {
  const o = {};
  for (const c of COLS) o[c] = demoji(r[c]);
  o.stem_text = null;
  const s = STEM_FIX[r.id];
  if (s) {
    if (!o.stem_html.includes(s[0])) throw new Error('stem text not found: ' + r.id);
    o.stem_html = o.stem_html.split(s[0]).join(s[1]);
  }
  if (ANSWER_FIX[r.id]) o.correct_answer = JSON.stringify(ANSWER_FIX[r.id]);
  o.explanation_html = EXPLANATIONS[r.id] || o.explanation_html;
  o.skill = SKILL_FIX[r.id] || o.skill;
  // Give every choice an explicit letter. Position is the fallback the client
  // already uses, so it cannot disagree with what was rendering before.
  const ch = JSON.parse(o.choices_json || '[]');
  ch.forEach((c, i) => {
    c.letter = String(c.letter || c.id || '').trim() || 'ABCD'[i] || String(i + 1);
    delete c.id;
  });
  o.choices_json = JSON.stringify(ch);
  return o;
}

const txt = (h) => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function selftest() {
  const a = require('assert');
  const rows = JSON.parse(fs.readFileSync(SRC, 'utf8')).map(fix);
  a.equal(rows.length, 73);
  for (const r of rows) {
    a.ok(txt(r.stem_html), r.id + ': empty stem');
    a.equal(r.stem_text, null, r.id);
    const ch = JSON.parse(r.choices_json);
    const ans = JSON.parse(r.correct_answer);
    a.ok(ans.length && String(ans[0]).trim(), r.id + ': no answer');
    if (!ch.length) continue;                       // grid-in
    a.equal(ch.length, 4, r.id + ': ' + ch.length + ' choices');
    a.equal(new Set(ch.map(c => c.letter)).size, 4, r.id + ': letters');
    a.equal(new Set(ch.map(c => txt(c.content))).size, 4, r.id + ': duplicate choice');
    ch.forEach(c => a.ok(txt(c.content), r.id + ': empty choice ' + c.letter));
    // the stored answer has to name one of them, or nothing the student clicks
    // can ever be right
    a.ok(ch.some(c => c.letter === String(ans[0]).trim().toUpperCase()),
         r.id + ': answer ' + JSON.stringify(ans[0]) + ' names no choice');
  }
  // a blank for every "which choice completes the text" question
  for (const r of rows) {
    if (/completes the text/i.test(txt(r.stem_html))) {
      a.ok(r.stem_html.includes('______'), r.id + ': no blank');
    }
  }
  // every row gets a rationale, and it has to name the answer that is stored -
  // an explanation arguing for a different choice is worse than none
  for (const r of rows) {
    const e = r.explanation_html;
    a.ok(e && txt(e).length > 80, r.id + ': no explanation');
    const ans = String(JSON.parse(r.correct_answer)[0]).trim();
    const ch = JSON.parse(r.choices_json);
    if (ch.length) a.ok(e.includes('Choice ' + ans + ' is the best answer'), r.id + ': names the wrong choice');
    else a.ok(/The correct answer is/.test(e), r.id + ': no stated answer');
  }
  // nothing may still promise a table or a graph it does not carry
  for (const r of rows) {
    if (!/(the table|the graph|Table:|Graph:)/i.test(txt(r.stem_html))) continue;
    a.ok(/<table|<svg|<img/i.test(r.stem_html), r.id + ': names a visual it does not have');
  }
  a.ok(!rows.some(r => (r.stem_html + r.choices_json).includes('┬▓')), 'mojibake left');
  // no restored row may invent a topic. The vocabulary comes from the rows the
  // extractor produced, so this also catches a typo in the replacement.
  const Database = require('better-sqlite3');
  const dbDir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const dbFile = fs.readdirSync(dbDir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  const db = new Database(path.join(dbDir, dbFile), { readonly: true });
  const official = new Set(db.prepare(
    "SELECT section || '|' || domain || '|' || skill k FROM questions WHERE source='CollegeBoard'").all().map(r => r.k));
  db.close();
  for (const r of rows) {
    a.ok(official.has(r.section + '|' + r.domain + '|' + r.skill),
         r.id + ': ' + r.domain + ' / ' + r.skill + ' is not a College Board topic');
  }
  console.log('ok');
}

if (process.argv.includes('--test')) { selftest(); return; }

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8')).map(fix);
const Database = require('better-sqlite3');
const dbDir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const dbFile = fs.readdirSync(dbDir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const db = new Database(path.join(dbDir, dbFile));

const marks = COLS.map(() => '?').join(', ');
const ins = db.prepare(`INSERT OR REPLACE INTO questions (${COLS.join(', ')}) VALUES (${marks})`);
db.transaction(() => { for (const r of rows) ins.run(...COLS.map(c => r[c])); })();

const esc = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v)
  : "'" + String(v).replace(/'/g, "''") + "'";
const sql = rows.map(r =>
  `INSERT OR REPLACE INTO questions (${COLS.join(', ')}) VALUES (${COLS.map(c => esc(r[c])).join(', ')});`);
const mig = path.join(root, 'migrations', '0007_restore_bluebook.sql');
fs.writeFileSync(mig, '-- The 73 Bluebook practice-test rows, restored. They were dumped and dropped,\n'
  + '-- leaving the bank at 3,770 and one progress row pointing at nothing. Choices\n'
  + '-- gain an explicit letter, nx_3af5a620 gains the blank its choices fill, and\n'
  + '-- the dead stem_text column is left null.\n' + sql.join('\n') + '\n');
console.log(`${rows.length} rows restored; ${path.relative(root, mig)} written`);
