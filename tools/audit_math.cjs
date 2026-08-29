// Audits a re-extracted math.jsonl: how much notation is real text, and
// whether the reconstructed tables actually add up.
//
// The sum check is the useful one. A table whose "Total" row equals the sum of
// its data rows was almost certainly read out of the PDF correctly; a grid
// invented out of a chart will not balance.
const fs = require('fs');

const rows = fs.readFileSync(process.argv[2] || 'tools/math_new.jsonl', 'utf8')
  .trim().split('\n').map(JSON.parse);

let minl = 0, tables = 0, figs = 0, mathText = 0, noAnswer = 0;
const tableRows = [];
for (const r of rows) {
  const all = r.stem_html + r.choices_json + r.explanation_html;
  if (all.includes('class="minl"')) minl++;
  if (all.includes('qtable')) tables++;
  if (all.includes('qfig')) figs++;
  if (all.includes('\\(')) mathText++;
  if (!JSON.parse(r.correct_answer || '[]').length) noAnswer++;
  for (const t of all.match(/<table>[\s\S]*?<\/table>/g) || []) tableRows.push([r.id, t]);
}

const cells = (tr) => [...tr.matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1].trim());
const num = (s) => /^-?[\d,]+(\.\d+)?$/.test(s) ? parseFloat(s.replace(/,/g, '')) : null;

let checked = 0, balanced = 0;
const bad = [];
for (const [id, t] of tableRows) {
  const grid = (t.match(/<tr>[\s\S]*?<\/tr>/g) || []).map(cells);
  const last = grid[grid.length - 1];
  if (!last || !/total/i.test(last[0] || '')) continue;      // no total row to check
  // A two-row header ("Year" over "2008 2009 ...") leaves a spanned row whose
  // label cell is empty. It is not data and must not be summed.
  const body = grid.slice(1, -1).filter(r => (r[0] || '').trim());
  let ok = true, any = false;
  for (let c = 1; c < last.length; c++) {
    const want = num(last[c]);
    const parts = body.map(r => num(r[c]));
    if (want === null || parts.some(v => v === null) || !parts.length) continue;
    any = true;
    if (Math.abs(parts.reduce((a, b) => a + b, 0) - want) > 0.001) ok = false;
  }
  if (!any) continue;
  checked++;
  if (ok) balanced++; else bad.push(id);
}

console.log({ rows: rows.length, minl, tables, figs, mathText, noAnswer });
console.log(`table totals: ${balanced}/${checked} add up`);
if (bad.length) console.log('do not add up:', bad.join(' '));
