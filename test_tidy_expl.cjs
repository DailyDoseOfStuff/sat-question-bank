// Self-check for tidyExpl() in public/index.html.
//
// The function lives inside the page's IIFE, so it is lifted out by its markers
// rather than duplicated here - a copy would drift from the one that ships.
//
//   node test_tidy_expl.cjs              run the assertions
//   node test_tidy_expl.cjs --sweep      also run it over every row in the local
//                                        D1 and report what it changed
const fs = require('fs');
const assert = require('assert');

const page = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const block = page.slice(page.indexOf('// --- tidyExpl'), page.indexOf('// --- end tidyExpl ---'));
if (!block) throw new Error('tidyExpl block not found in public/index.html');
const tidyExpl = new Function(block + '\nreturn tidyExpl;')();

const cases = [
  // a space joining a decoded notation run to the punctuation after it
  ['<p>is 55(0.20) , or 11 .</p>', '<p>is 55(0.20), or 11.</p>'],
  ['<p>points (0,0) , (3,-12) , and (6,0).</p>', '<p>points (0,0), (3,-12), and (6,0).</p>'],
  // a run of spaces left where a figure was lifted out
  ['<p>at  is approximately 11.</p>', '<p>at is approximately 11.</p>'],
  // a space inside LaTeX is the author's and must survive, including \,
  ['<p>\\(a , b\\) , so</p>', '<p>\\(a , b\\), so</p>'],
  ['<p>\\(1\\,2\\) .</p>', '<p>\\(1\\,2\\).</p>'],
  // a tag's own attributes are never rewritten
  ['<p><img class="minl" src="/qimg/a_m2.webp" alt=""> , or 1.</p>',
   '<p><img class="minl" src="/qimg/a_m2.webp" alt="">, or 1.</p>'],
  // a paragraph whose predecessor stopped mid-sentence is a tear, not a paragraph
  ['<p>the population of Iceland in 2014 was</p><p>330,825. The increase is 80,200.</p>',
   '<p>the population of Iceland in 2014 was 330,825. The increase is 80,200.</p>'],
  // ... but a predecessor that ended its sentence is left alone
  ['<p>the median must be 5.</p><p>This is the mean, not the median.</p>',
   '<p>the median must be 5.</p><p>This is the mean, not the median.</p>'],
  // choice analyses run together get one paragraph each
  ['<p>Choices B and C are incorrect. Misread. Choice D is incorrect. This is the y-coordinate.</p>',
   '<p>Choices B and C are incorrect. Misread.</p><p>Choice D is incorrect. This is the y-coordinate.</p>'],
  // the leading analysis is not split off into an empty paragraph
  ['<p>Choice A is correct. It follows.</p>', '<p>Choice A is correct. It follows.</p>'],
  // a list is content, not a separator to be dropped
  ['<p>Consider:</p><ul><li>one</li><li>two</li></ul><p>Therefore 3.</p>',
   '<p>Consider:</p><ul><li>one</li><li>two</li></ul><p>Therefore 3.</p>'],
  // and a block between two paragraphs stops the rejoin reaching across it
  ['<p>the values are</p><ul><li>one</li></ul><p>listed above.</p>',
   '<p>the values are</p><ul><li>one</li></ul><p>listed above.</p>'],
  ['', ''],
  [null, ''],
];

let bad = 0;
for (const [input, want] of cases) {
  const got = tidyExpl(input);
  if (got !== want) { bad++; console.error('FAIL\n  in   ' + input + '\n  want ' + want + '\n  got  ' + got); }
}
assert.strictEqual(bad, 0, bad + ' case(s) failed');
console.log(cases.length + ' cases pass');

if (process.argv.includes('--sweep')) {
  // Over the whole bank: nothing may lose text, and every artifact counted in
  // the comment above tidyExpl must actually go.
  const Database = require('better-sqlite3');
  const dir = __dirname + '/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const file = fs.readdirSync(dir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  const rows = new Database(dir + '/' + file, { readonly: true })
    .prepare('select id, explanation_html from questions').all();

  // Every rewrite this function makes either deletes whitespace or inserts it,
  // so the text with all whitespace removed is the thing that must not move.
  const ink = (h) => (h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  // Math is skipped the same way tidyExpl skips it - a space in there is meant.
  // Each tag and each formula collapses to one non-space character rather than
  // to nothing: deleting them outright leaves the space that stood in front of a
  // formula sitting against the comma behind it, which reads as the artifact
  // even after it has been fixed.
  const prose = (h) => (h || '').replace(/<[^>]*>|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, '#');
  const spacePunct = (h) => /\S[ \t]+(?:[,;:!?]|\.(?!\d))/.test(prose(h));
  let changed = 0, lost = [], stillSpaced = 0, before = { sp: 0, wall: 0 }, after = { sp: 0, wall: 0 };
  const WALL = /Choices?\s+[A-D](?:(?:,|\s+and)\s+[A-D])*\s+(?:is|are)\s+(?:in)?correct\b/g;
  const wall = (h) => (h || '').split(/<\/p>/).some(p => (p.match(WALL) || []).length >= 2);

  for (const r of rows) {
    const out = tidyExpl(r.explanation_html);
    if (out !== r.explanation_html) changed++;
    if (spacePunct(r.explanation_html)) before.sp++;
    if (spacePunct(out)) { after.sp++; stillSpaced++; }
    if (wall(r.explanation_html)) before.wall++;
    if (wall(out)) after.wall++;
    // A rewrite may only ever move words, never drop one.
    if (ink(out) !== ink(r.explanation_html)) lost.push(r.id);
  }
  console.log('rows                    ' + rows.length);
  console.log('rewritten               ' + changed);
  console.log('space before punct      ' + before.sp + ' -> ' + after.sp);
  console.log('choices in one <p>      ' + before.wall + ' -> ' + after.wall);
  console.log('rows whose text moved      ' + lost.length + (lost.length ? ' ' + lost.slice(0, 5) : ''));
  assert.strictEqual(lost.length, 0, 'tidyExpl changed the text of ' + lost.length + ' rows');
  assert.strictEqual(after.sp, 0, stillSpaced + ' rows still print a space before punctuation');
  assert.strictEqual(after.wall, 0, after.wall + ' rows still run choices together');
  console.log('sweep clean');
}
