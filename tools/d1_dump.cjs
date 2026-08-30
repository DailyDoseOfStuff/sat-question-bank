// Rebuild the remote questions table from the local D1 sqlite.
// Chunked so each file stays inside wrangler's per-request size limit.
const fs = require('fs'), path = require('path');
const db = require('better-sqlite3')(
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/588d9571f32b2bc46c16a0b562c8159b7083c5cdb6cb7d758ef030322bcdc2ee.sqlite',
  {readonly: true});

const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const q = v => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : "'" + String(v).replace(CTRL, '').replace(/'/g, "''") + "'";

const out = 'd1_sync';
fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out);

const rows = db.prepare('SELECT * FROM questions').all();
let buf = [], part = 0, size = 0;
const flush = () => {
  if (!buf.length) return;
  fs.writeFileSync(path.join(out, `part_${String(part).padStart(3, '0')}.sql`),
                   buf.join('\n') + '\n');
  part++; buf = []; size = 0;
};
for (const r of rows) {
  const stmt = `INSERT INTO questions (${cols.join(',')}) VALUES (${cols.map(c => q(r[c])).join(',')});`;
  buf.push(stmt); size += stmt.length;
  if (size > 900000) flush();
}
flush();
console.log(`${rows.length} rows -> ${part} parts`);
console.log(`cols: ${cols.join(',')}`);
