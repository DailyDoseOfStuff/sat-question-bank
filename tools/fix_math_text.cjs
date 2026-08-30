// Repairs four things the PDF extraction left behind. Three of them sit inside
// inline maths, where KaTeX renders each as a row of italic letters rather than
// as a word:
//
//   1. a function name that lost its backslash:  sinQ  ->  \sin Q
//   2. a unit or noun typeset as maths:      42 posters  ->  42\text{ posters}
//   3. a number or variable fused to a word:     3hours  ->  3\text{ hours}
//
// The fourth is text-wide: UTF-8 punctuation read back as code page 437, so an
// em dash arrives as the three characters "ΓÇö".
//
// Only the body of a \( ... \) span is touched by 1-3, and inside it only what one
// of those rules matches: geometry labels (ABC, EFGH), variable products
// (xyz, kab) and anything already inside \text{} are left exactly as they were.
//
// Run with --write to update the local D1 sqlite, then --emit to write the SQL
// the remote needs (--emit reads the repaired table, so it still produces the
// full migration after the local rows have already been fixed).
// Run with no flag for a dry run, or `node tools/fix_math_text.cjs --test` for
// the self-check.

const FN = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'log', 'ln'];

// Units and plain nouns that turn up inside these questions' maths. Anything not
// on this list stays as maths, which is the safe direction to be wrong in.
const WORDS = `centimeter centimeters millimeter millimeters meter meters kilometer kilometers
inch inches foot feet yard yards mile miles nautical furlong furlongs fathom fathoms rod rods
gram grams kilogram kilograms milligram milligrams quettagram quettagrams pound pounds ounce ounces
cup cups quart quarts pint pints gallon gallon gallons liter liters milliliter milliliters
teaspoon teaspoons tablespoon tablespoons fluid
second seconds minute minutes hour hours day days week weeks month months year years
degree degrees radian radians volt volts watt watts joule joules newton newtons
square squared cubic cube area perimeter volume circumference
people person student students item items poster posters raccoon raccoons cherry cherries
dollar dollars cent cents profit revenue total price revolution revolutions
Fahrenheit Celsius Kelvin tall long wide high deep and per of in`.split(/\s+/);

const WORDSET = new Set(WORDS);
// longest first, so "centimeters" wins over "centimeter" and "squareinches" is
// split into two known words rather than left half-matched
const WORDRE = [...new Set(WORDS)].sort((a, b) => b.length - a.length).join('|');

// A \text{...} run built out of pieces, with the leading space KaTeX needs.
const asText = (s) => '\\text{ ' + s.trim().replace(/\s+/g, ' ') + '}';

function fixSpan(body) {
  const out = [];
  // Split on the bits that must not be rewritten: \text{...}, \mathrm{...},
  // \operatorname{...} and any other LaTeX command word.
  const KEEP = /(\\(?:text|mathrm|operatorname|textrm)\s*\{[^{}]*\}|\\[a-zA-Z]+)/g;
  let last = 0, m;
  while ((m = KEEP.exec(body))) {
    out.push(fixPlain(body.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  out.push(fixPlain(body.slice(last)));
  // fixPlain only sees one chunk at a time, so a \text{} that ends up butted
  // against the next command ("area of" then \triangle) gets its space here.
  return out.join('').replace(/\\text\{ ([^{}]*[^ {}]) *\}(?=\s*[A-Za-z0-9\\$(])/g, '\\text{ $1 }');
}

function fixPlain(s) {
  if (!s) return s;

  // 1. a function name that lost its backslash: sinQ, tan(, cos6. A run that is
  //    itself an English word is left alone, which is what keeps "cost" from
  //    becoming \cos t and "seconds" from becoming \sec onds.
  s = s.replace(/(^|[^A-Za-z\\])([A-Za-z]+)/g, (all, pre, run) => {
    if (WORDSET.has(run) || WORDSET.has(run.toLowerCase())) return all;
    const fn = FN.find(f => run.startsWith(f));
    return fn ? pre + '\\' + fn + ' ' + run.slice(fn.length) : all;
  });

  // 2. a number or a lone variable fused to the front of a word: 3hours, xhours.
  //    Prising them apart first lets the wrapping rule below see the word.
  s = s.replace(new RegExp('(?<![A-Za-z\\\\])([a-z]|\\d)(' + WORDRE + ')(?![A-Za-z])', 'g'), '$1 $2');

  // 3. a run of known words becomes one \text{}, swallowing the space in front
  //    of it. Words glued to each other ("squareinches") are split as they go.
  s = s.replace(new RegExp('\\s*(?<![A-Za-z\\\\])((?:' + WORDRE + ')(?:\\s*(?:' + WORDRE + '))*)(?![A-Za-z])', 'g'),
    (all, run, off, str) => {
      const t = asText(run.replace(new RegExp('(' + WORDRE + ')(?=' + WORDRE + ')', 'g'), '$1 '));
      // "1 cup and 4 cups": the space after "and" is inside the \text{}, or the
      // 4 lands hard against it.
      return /^[\s]*[A-Za-z0-9\\$]/.test(str.slice(off + all.length)) ? t.slice(0, -1) + ' }' : t;
    });

  // \sin \text{ and} ... never happens, but a doubled space does
  return s.replace(/ {2,}/g, ' ');
}

// UTF-8 bytes that were read back as code page 437 somewhere upstream of the
// extraction: "30 days ΓÇö one containing lizards". Only these seven sequences
// occur, so the table is the whole fix rather than a codepage round-trip.
const MOJIBAKE = { 'ΓÇö': '—', 'ΓêÆ': '−', 'ΓåÆ': '→', 'ΓÇ£': '“', 'ΓÇ¥': '”', 'ΓêÜ': '√', 'ΓÇÖ': '’' };
const MOJI_RE = new RegExp(Object.keys(MOJIBAKE).join('|'), 'g');
const demojibake = (s) => s && MOJI_RE.test(s) ? s.replace(MOJI_RE, (m) => MOJIBAKE[m]) : s;

// The only three spans in the bank that KaTeX cannot parse at all: two scraps
// the glyph extraction emitted as maths (a piece of a scatterplot legend, and a
// fragment in the middle of a sentence), and one quadratic formula that lost its
// discriminant - the lines around it work out to 64 + 56, so what it should read
// is not in doubt. Everything else in this file is a rule; these are named.
const ONE_OFFS = [
  ['\\(^{t}r^{a}_{e}^{n}44\\)', ''],
  ['\\(\\sqrt[3] ^{2}42\\) ', ''],
  ['\\(x =\\frac{8\\pm (-8) - ( )(-7)}{2(2)}\\)', '\\(x =\\frac{8\\pm \\sqrt{(-8)^{2}-4(2)(-7)}}{2(2)}\\)'],
];
const ONE_OFF_ROWS = ['d112bc9d', 'fada6b03'];

function fixHTML(html) {
  if (!html) return html;
  html = demojibake(html);
  for (const [from, to] of ONE_OFFS) if (html.includes(from)) html = html.split(from).join(to);
  return html.replace(/\\\(([\s\S]*?)\\\)/g, (all, body) => {
    const fixed = fixSpan(body);
    return fixed === body ? all : '\\(' + fixed + '\\)';
  })
  // a closing \) run straight into the next word: "\(DEF\)are similar"
  .replace(/\\\)([A-Za-z])/g, (all, c, i, str) =>
    /\\\)(th|st|nd|rd)\b/.test(str.slice(i - 2, i + 4)) ? all : '\\) ' + c);
}

// choices_json holds HTML inside a JSON string, where every backslash is already
// doubled. Rewriting that text raw would put single-backslash LaTeX into a JSON
// string and lose it on parse, so it goes through parse / fix / stringify.
function fixChoices(json) {
  if (!json) return json;
  let arr;
  try { arr = JSON.parse(json); } catch (e) { return json; }
  if (!Array.isArray(arr)) return json;
  let touched = false;
  const next = arr.map(c => {
    if (!c || typeof c.content !== 'string') return c;
    const v = fixHTML(c.content);
    if (v !== c.content) touched = true;
    return { ...c, content: v };
  });
  return touched ? JSON.stringify(next) : json;
}

// ---------------------------------------------------------------- self-check
function test() {
  const cases = [
    ['\\(\\frac{42 posters}{1 minute}\\)', '\\(\\frac{42\\text{ posters}}{1\\text{ minute}}\\)'],
    ['\\((3hours)\\)', '\\((3\\text{ hours})\\)'],
    ['\\(xhours\\)', '\\(x\\text{ hours}\\)'],
    ['\\(sinQ\\)', '\\(\\sin Q\\)'],
    ['\\(tan(x)\\)', '\\(\\tan (x)\\)'],
    ['\\(8squareinches\\)', '\\(8\\text{ square inches}\\)'],
    ['\\(9cubicmeters\\)', '\\(9\\text{ cubic meters}\\)'],
    // left alone
    ['\\(ABCD\\)', '\\(ABCD\\)'],
    ['\\(xyz\\)', '\\(xyz\\)'],
    ['\\(\\sin Q\\)', '\\(\\sin Q\\)'],
    ['\\(\\text{ hours}\\)', '\\(\\text{ hours}\\)'],
    ['\\(\\sec x\\)', '\\(\\sec x\\)'],
    ['\\(4seconds\\)', '\\(4\\text{ seconds}\\)'],       // not \sec onds
    ['\\(sinp = cost\\)', '\\(\\sin p = \\cos t\\)'],    // angles p and t, not a price
    ['\\(tanABD\\)', '\\(\\tan ABD\\)'],
    ['the cost of \\(x\\) items', 'the cost of \\(x\\) \\text{ items}'],   // outside math is untouched? see below
    ['\\(DEF\\)are similar', '\\(DEF\\) are similar'],
    ['\\(n\\)th term', '\\(n\\)th term'],
    ['over 30 days ΓÇö one enclosure', 'over 30 days — one enclosure'],
    ['1,089ΓêÜ3 square units', '1,089√3 square units'],
  ];
  let bad = 0;
  for (const [inp, want] of cases) {
    const got = fixHTML(inp);
    // the "outside math" case only asserts that prose is not rewritten
    const expect = inp === 'the cost of \\(x\\) items' ? inp : want;
    if (got !== expect) { console.log('FAIL', JSON.stringify(inp), '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(expect)); bad++; }
  }
  console.log(bad ? bad + ' failing' : 'all ' + cases.length + ' cases pass');
  return bad === 0;
}

if (process.argv.includes('--test')) { process.exit(test() ? 0 : 1); }

// ---------------------------------------------------------------- apply
const fs = require('fs');
const DB = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/588d9571f32b2bc46c16a0b562c8159b7083c5cdb6cb7d758ef030322bcdc2ee.sqlite';
const write = process.argv.includes('--write');
const D = require('better-sqlite3')(DB, { readonly: !write });
const FIELDS = ['stem_html', 'choices_json', 'explanation_html', 'stem_text'];
const rows = D.prepare('select id,source,' + FIELDS.join(',') + ' from questions').all();

const esc = (s) => s === null || s === undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const changed = [], sql = [];
for (const r of rows) {
  const next = {};
  for (const f of FIELDS) {
    const v = f === 'choices_json' ? fixChoices(r[f])
      : f === 'stem_text' ? demojibake(r[f])   // plain text: only the mojibake rule applies
      : fixHTML(r[f]);
    if (v !== r[f]) next[f] = v;
  }
  const keys = Object.keys(next);
  if (!keys.length) continue;
  changed.push({ id: r.id, keys, before: r[keys[0]], after: next[keys[0]] });
  sql.push('UPDATE questions SET ' + keys.map(k => k + '=' + esc(next[k])).join(', ') + ' WHERE id=' + esc(r.id) + ';');
  if (write) D.prepare('UPDATE questions SET ' + keys.map(k => k + '=?').join(', ') + ' WHERE id=?')
    .run(...keys.map(k => next[k]), r.id);
}
console.log((write ? 'updated ' : 'would update ') + changed.length + ' of ' + rows.length + ' rows');
for (const c of changed.slice(0, 6)) {
  const i = Math.max(0, c.after.indexOf('\\text') - 60);
  console.log(' ', c.id, c.keys.join('+'), '|', c.after.slice(i, i + 130).replace(/\s+/g, ' '));
}
// --emit writes the migration for the remote from what the local table holds
// now, rather than from this run's diff: once the local rows are fixed a second
// --write finds nothing left to say, and the remote would get half the repair.
// The rows it picks are every row carrying a mark this fixer leaves behind, so
// it is a superset of the ones that changed - re-writing a row with the value
// it already has costs nothing.
if (process.argv.includes('--emit')) {
  // the two marks rules 1-3 leave, plus every Bluebook row: the mojibake was
  // confined to those 73, and repaired punctuation is not itself distinctive.
  const MARK = new RegExp('\\\\text\\{ (?:' + WORDRE + ')|\\\\(?:' + FN.join('|') + ') ');
  const out = [];
  for (const r of rows) {
    if (r.source !== 'Bluebook' && !ONE_OFF_ROWS.includes(r.id) && !FIELDS.some(f => MARK.test(r[f] || ''))) continue;
    out.push('UPDATE questions SET ' + FIELDS.map(f => f + '=' + esc(r[f])).join(', ') + ' WHERE id=' + esc(r.id) + ';');
  }
  fs.writeFileSync('migrations/0002_math_text_fix.sql', out.join('\n') + '\n');
  console.log('wrote migrations/0002_math_text_fix.sql (' + out.length + ' statements)');
} else if (write) {
  fs.writeFileSync('migrations/0002_math_text_fix.sql', sql.join('\n') + '\n');
  console.log('wrote migrations/0002_math_text_fix.sql (' + sql.length + ' statements)');
}
