// Applies a re-extracted math.jsonl to the local D1 sqlite, and writes the
// same UPDATEs as chunked SQL so the remote D1 can be brought in line.
// Metadata (section/domain/skill/difficulty/source) is not touched.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const jsonl = process.argv[2] || path.join(__dirname, 'math_new.jsonl');
const dbDir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const dbFile = fs.readdirSync(dbDir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');

const rows = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(JSON.parse);
// eslint-disable-next-line no-control-regex
const stripCtrl = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const esc = (s) => "'" + stripCtrl(s).replace(/'/g, "''") + "'";
const hasFig = (r) => /qfig|qimg/.test(r.stem_html + r.choices_json) ? 1 : 0;

const db = new Database(path.join(dbDir, dbFile));
const upd = db.prepare(`UPDATE questions SET stem_html=?, choices_json=?,
  correct_answer=?, explanation_html=?, has_figure=? WHERE id=?`);
let hit = 0, miss = 0;
db.transaction(() => {
  for (const r of rows) {
    const res = upd.run(stripCtrl(r.stem_html), stripCtrl(r.choices_json),
      stripCtrl(r.correct_answer), stripCtrl(r.explanation_html), hasFig(r), r.id);
    res.changes ? hit++ : miss++;
  }
})();
console.log(`local sqlite: ${hit} rows updated, ${miss} ids not present`);

const outDir = path.join(root, 'd1_chunks');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);
const CHUNK = 100;
let n = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const sql = rows.slice(i, i + CHUNK).map(r =>
    `UPDATE questions SET stem_html=${esc(r.stem_html)}, choices_json=${esc(r.choices_json)}, ` +
    `correct_answer=${esc(r.correct_answer)}, explanation_html=${esc(r.explanation_html)}, ` +
    `has_figure=${hasFig(r)} WHERE id=${esc(r.id)};`).join('\n');
  fs.writeFileSync(path.join(outDir, `chunk_${String(n).padStart(3, '0')}.sql`), sql + '\n');
  n++;
}
console.log(`d1_chunks: ${n} files for the remote database`);
