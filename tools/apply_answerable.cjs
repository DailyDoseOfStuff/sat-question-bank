// The Math rows a re-extraction cannot repair on its own, so that every Math
// question in the bank can actually be answered.
//
//   1. Eleven grid-ins whose stored answer is empty. Four state the answer in
//      rationale text and the client already recovers those; the other seven
//      state it only as a picture ("The correct answer is <img>"), so nothing
//      the student types can ever match. Each crop was read off the page.
//   2. Two stems the glyph reader mangles, where the source is unambiguous.
//   3. 36f068e2, whose four choices are four scatterplots drawn as one vector
//      cluster per page - two choices to a cluster, so the extractor cannot
//      tell them apart. The four bands are cropped as `<id>_ch<letter>.webp`.
//
// Writes the local D1 sqlite and migrations/0006_math_answerable.sql.
// `--test` runs the self-check and touches nothing.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Read off the crop named in each rationale's "The correct answer is ..."
// sentence. Every one is a fraction, which is why the glyph reader cropped it
// rather than emitting text.
const ANSWERS = {
  a391ed22: '5/2',
  d1b66ae6: '3/2',
  '466b87e3': '1/2',
  '8193e8cd': '1/5',
  eeb4143c: '10/3, 15/4, 25/6',
  fb58c0db: '1/6',
  '40c09d66': '7/6',
};

// Radical indices read as ordinary digits in front of the radical, and the
// exponent on the second factor was dropped, leaving a bare "( )" behind.
const STEMS = {
  '137cc6fd': [
    '<p>\\(5\\sqrt{70n}6\\sqrt{70n}2\\) ( )</p>',
    '<p>\\(\\sqrt[5]{70n}\\left(\\sqrt[6]{70n}\\right)^{2}\\)</p>',
  ],
};

// A choice table whose last row is printed at the top of the next page.
// table_of will not read a two-rule fragment, so the row is either lost
// (4acd05cd) or left beside the table as loose text (1ee962ec). These are the
// only two in the bank; both rows were read off the source page.
const CHOICE_ROWS = {
  '1ee962ec': { letter: 'D', drop: '<p>-6 0</p>', row: ['-6', '0'] },
  '4acd05cd': { letter: 'D', row: ['2', '-1'] },
};

const CHOICES = {
  '36f068e2': JSON.stringify('ABCD'.split('').map(letter => ({
    letter,
    content: `<div class="qfig"><img src="/qimg/36f068e2_ch${letter}.webp" alt="Choice ${letter}"></div>`,
  }))),
};

// Drop the loose text the fragment came out as, and append it as a real row.
const patchRow = (content, r) =>
  (r.drop ? content.replace(r.drop, '') : content)
    .replace('</table>', `<tr><td>${r.row[0]}</td><td>${r.row[1]}</td></tr></table>`);

function selftest() {
  const a = require('assert');
  // an answer is only useful if the player can grade it: a number, or a list
  // of numbers, each of which num() can evaluate
  const num = (s) => /^-?\d*\.?\d+(\/-?\d*\.?\d+)?$/.test(s.trim());
  for (const [id, v] of Object.entries(ANSWERS)) {
    a.ok(v.split(',').every(num), `${id}: ${v}`);
  }
  for (const [id, [from, to]] of Object.entries(STEMS)) {
    a.notEqual(from, to, id);
    a.ok(!to.includes('( )'), id);
  }
  for (const [id, r] of Object.entries(CHOICE_ROWS)) {
    a.equal(r.row.length, 2, id);
    a.equal(patchRow('<div class="qtable"><table><tr><td>1</td><td>2</td></tr></table></div>', r),
            `<div class="qtable"><table><tr><td>1</td><td>2</td></tr><tr><td>${r.row[0]}</td><td>${r.row[1]}</td></tr></table></div>`, id);
  }
  a.equal(JSON.parse(CHOICES['36f068e2']).length, 4);
  a.equal(new Set(JSON.parse(CHOICES['36f068e2']).map(c => c.content)).size, 4);
  console.log('ok');
}

if (process.argv.includes('--test')) { selftest(); return; }

const Database = require('better-sqlite3');
const dbDir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const dbFile = fs.readdirSync(dbDir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const db = new Database(path.join(dbDir, dbFile));

const updates = new Map();                       // id -> {col: value}
const put = (id, col, value) => {
  if (!updates.has(id)) updates.set(id, {});
  updates.get(id)[col] = value;
};

for (const [id, v] of Object.entries(ANSWERS)) put(id, 'correct_answer', JSON.stringify([v]));
for (const [id, json] of Object.entries(CHOICES)) put(id, 'choices_json', json);
for (const [id, r] of Object.entries(CHOICE_ROWS)) {
  const row = db.prepare('SELECT choices_json FROM questions WHERE id=?').get(id);
  if (!row) { console.log('not in bank, skipped:', id); continue; }
  const ch = JSON.parse(row.choices_json);
  const c = ch.find(x => x.letter === r.letter);
  if (c.content.includes(`<td>${r.row[0]}</td><td>${r.row[1]}</td>`)) {
    console.log('choice row already present, skipped:', id); continue;
  }
  c.content = patchRow(c.content, r);
  put(id, 'choices_json', JSON.stringify(ch));
}
for (const [id, [from, to]] of Object.entries(STEMS)) {
  const row = db.prepare('SELECT stem_html FROM questions WHERE id=?').get(id);
  if (!row) { console.log('not in bank, skipped:', id); continue; }
  if (!row.stem_html.includes(from)) { console.log('stem already repaired, skipped:', id); continue; }
  put(id, 'stem_html', row.stem_html.split(from).join(to));
}

let applied = 0;
db.transaction(() => {
  for (const [id, cols] of updates) {
    const set = Object.keys(cols).map(c => `${c}=?`).join(', ');
    const info = db.prepare(`UPDATE questions SET ${set} WHERE id=?`).run(...Object.values(cols), id);
    if (!info.changes) { console.log('no such row:', id); continue; }
    applied++;
  }
})();

// The migration is the whole delta between the local Math rows and the jsonl
// the remote gets as d1_chunks - this script's fixes plus fix_math_text's and
// apply_choice_tables' - written out in full. Emitting only this script's own
// diff would leave the remote with the re-extraction and none of the repairs
// that run on top of it, which is how a row ends up right locally and wrong
// live. Apply after the chunks.
const FIELDS = ['stem_html', 'choices_json', 'correct_answer', 'explanation_html'];
const esc = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const base = new Map(fs.readFileSync(path.join(root, 'tools/math_new.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse).map(r => [r.id, r]));
const sql = [];
for (const r of db.prepare("SELECT * FROM questions WHERE section='Math'").all()) {
  const b = base.get(r.id);
  if (b && FIELDS.every(f => (r[f] || '') === (b[f] || ''))) continue;
  sql.push('UPDATE questions SET ' + FIELDS.map(f => `${f}=${esc(r[f])}`).join(', ')
           + ` WHERE id=${esc(r.id)};`);
}
const mig = path.join(root, 'migrations', '0006_math_answerable.sql');
fs.writeFileSync(mig, '-- Everything the local Math rows carry on top of the re-extraction that\n'
  + '-- goes up as d1_chunks: the text fixes, the prose unwrap, the answers that\n'
  + '-- existed only as a picture, two mangled stems, and the four-scatterplot\n'
  + '-- question. Apply after the chunks.\n' + sql.join('\n') + '\n');
console.log(`${applied} rows repaired here; ${path.relative(root, mig)} carries ${sql.length} rows`);
