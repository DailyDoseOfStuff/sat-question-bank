// Applies the Math repairs found by walking the bank in the browser:
//
//   1. the re-extracted rows in a jsonl (the choice tables that had collapsed
//      into one shared header, so all four choices read alike),
//   2. the two scraps in 5da5c665 that KaTeX cannot parse,
//   3. the \( ... \) spans that hold no mathematics at all - a unit or a phrase
//      typeset as maths, which renders in the maths font mid-sentence.
//
// Writes the local D1 sqlite and migrations/0005_math_render_fixes.sql for the
// remote. `--test` runs the self-check and touches nothing.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// --- 3. spans with no mathematics in them -----------------------------------
// \text{...} already renders upright; what is left beside it is the part that
// arrives in italic. If that remainder is only letters, brackets and
// punctuation, the span is prose and belongs outside the maths entirely.
const SPAN = /\\\(([\s\S]*?)\\\)/g;

function unwrapProse(html) {
  if (!html) return html;
  let hit = false;
  const out = html.replace(SPAN, (all, body) => {
    if (!body.includes('\\text{')) return all;
    const rest = body.replace(/\\text\{[^{}]*\}/g, '');
    if (!/^[A-Za-z()[\],.;:%\s-]*$/.test(rest)) return all;
    hit = true;
    return body.replace(/\\text\{([^{}]*)\}/g, '$1');
  });
  // \text{ in } keeps the padding the maths font needed; unwrapped it doubles
  // up against the space already in the sentence. Only the rewritten rows are
  // touched, so nothing else's spacing moves.
  return hit ? out.replace(/ {2,}/g, ' ') : html;
}

// --- 2. named scraps --------------------------------------------------------
// A cube root with nothing under it, and a quadratic formula that lost its
// discriminant. The lines around the formula work out to 25 + 80, so what it
// should read is not in doubt. Both are in 5da5c665; the same two shapes at
// different numbers are already named in fix_math_text.cjs.
const ONE_OFFS = [
  ['\\(\\sqrt[3] ^{2}44\\) ', ''],
  ['\\(x =\\frac{-(-5)\\pm (-5) - ( )(-5)}{2(4)}\\)',
   '\\(x =\\frac{-(-5)\\pm \\sqrt{(-5)^{2}-4(4)(-5)}}{2(4)}\\)'],
];

function fixOneOffs(html) {
  if (!html) return html;
  for (const [from, to] of ONE_OFFS) if (html.includes(from)) html = html.split(from).join(to);
  return html;
}

const fixHTML = (h) => unwrapProse(fixOneOffs(h));

function fixChoices(json) {
  if (!json) return json;
  let arr;
  try { arr = JSON.parse(json); } catch (e) { return json; }
  if (!Array.isArray(arr)) return json;
  let hit = false;
  for (const c of arr) {
    const fixed = fixHTML(c.content);
    if (fixed !== c.content) { c.content = fixed; hit = true; }
  }
  return hit ? JSON.stringify(arr) : json;
}

function selftest() {
  const a = require('assert');
  a.equal(unwrapProse('height, \\(\\text{ in centimeters } (cm)\\) , of'),
          'height, in centimeters (cm) , of');
  a.equal(unwrapProse('\\(\\text{ in } cm\\)'), ' in cm');
  // real mathematics beside the text is left alone
  const keep = '\\(\\frac{42\\text{ posters}}{1\\text{ minute}}\\)';
  a.equal(unwrapProse(keep), keep);
  a.equal(unwrapProse('\\(x + 1\\)'), '\\(x + 1\\)');
  a.equal(fixOneOffs('these values \\(\\sqrt[3] ^{2}44\\) into'), 'these values into');
  a.ok(fixOneOffs(ONE_OFFS[1][0]).includes('\\sqrt{(-5)^{2}-4(4)(-5)}'));
  a.equal(JSON.parse(fixChoices('[{"letter":"A","content":"\\\\(\\\\text{ in } cm\\\\)"}]'))[0].content, ' in cm');
  console.log('ok');
}

if (process.argv.includes('--test')) { selftest(); return; }

const Database = require('better-sqlite3');
const dbDir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const dbFile = fs.readdirSync(dbDir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const db = new Database(path.join(dbDir, dbFile));

const jsonl = process.argv[2];
const redone = jsonl ? fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(JSON.parse) : [];

const COLS = ['stem_html', 'choices_json', 'correct_answer', 'explanation_html'];
const rows = db.prepare("SELECT id, stem_html, choices_json, correct_answer, explanation_html FROM questions WHERE section='Math'").all();
const byId = new Map(rows.map(r => [r.id, r]));

const updates = new Map();          // id -> {col: value}
for (const r of redone) {
  const old = byId.get(r.id);
  if (!old) { console.log('not in bank, skipped:', r.id); continue; }
  const next = {};
  for (const c of COLS) if (old[c] !== r[c]) next[c] = r[c];
  if (Object.keys(next).length) { updates.set(r.id, next); Object.assign(old, next); }
}
for (const r of rows) {
  const next = {};
  for (const c of COLS) {
    const fixed = c === 'choices_json' ? fixChoices(r[c]) : fixHTML(r[c]);
    if (fixed !== r[c]) next[c] = fixed;
  }
  if (Object.keys(next).length) Object.assign(updates.get(r.id) || updates.set(r.id, {}).get(r.id), next);
}

const backup = path.join(root, 'backup', 'math_render_fixes_before.json');
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, JSON.stringify(
  [...updates.keys()].map(id => db.prepare('SELECT * FROM questions WHERE id=?').get(id)), null, 1));

const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sql = [];
const tx = db.transaction(() => {
  for (const [id, cols] of updates) {
    const set = Object.keys(cols).map(c => `${c}=?`).join(', ');
    db.prepare(`UPDATE questions SET ${set} WHERE id=?`).run(...Object.values(cols), id);
    sql.push(`UPDATE questions SET ${Object.entries(cols).map(([c, v]) => `${c}=${esc(v)}`).join(', ')} WHERE id=${esc(id)};`);
  }
});
tx();

const mig = path.join(root, 'migrations', '0005_math_render_fixes.sql');
fs.writeFileSync(mig, `-- Math render fixes: choice tables split back out of one\n` +
  `-- reconstructed block, two unparseable scraps, and spans holding no maths.\n` +
  sql.join('\n') + '\n');
console.log(`${updates.size} rows updated locally; backup at ${path.relative(root, backup)}; migration ${path.relative(root, mig)}`);
