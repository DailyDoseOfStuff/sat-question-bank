#!/usr/bin/env node
// Spread the correct answer evenly over A-D across tools/aiq/*.jsonl.
//
// The batches were authored one question at a time with the answer written first,
// so 355 of 396 multiple-choice rows landed on A. A student who always picks A
// scores 90% on the bank, which makes it useless as practice.
//
// The fix is a cyclic rotation of each row's choices. Rotation is chosen over a
// shuffle because it is deterministic and self-correcting: the target letter is
// 'ABCD'[n % 4] for the nth multiple-choice row in file-then-line order, and the
// rotation amount is measured from where the answer currently sits, so running
// this twice is a no-op. Regenerating a batch from its builder and re-running
// this puts the bank back in balance without touching the other batches.
//
// Everything that names a letter moves with the choices: the choices themselves
// (content and trap tag), the per-choice "Why X is right/wrong" paragraphs, and
// any "Choice X" reference inside the Traps block. The letter references are
// remapped in one pass, not letter by letter, or A->B followed by B->C would
// carry the first substitution into the second.
const fs = require('fs');
const path = require('path');

const LETTERS = ['A', 'B', 'C', 'D'];

// Split the explanation into the block before the per-choice paragraphs and a
// map from letter to that letter's paragraph body.
function splitExplanation(ex) {
  const parts = ex.split(/(?=<p><strong>Why [A-D] is (?:right|wrong)<\/strong>)/);
  const head = parts.shift() || '';
  const why = {};
  for (const p of parts) {
    const m = p.match(/^<p><strong>Why ([A-D]) is (?:right|wrong)<\/strong>([\s\S]*)$/);
    if (!m) return null;
    why[m[1]] = m[2].replace(/<\/p>\s*$/, '');
  }
  return LETTERS.every(L => why[L] !== undefined) ? { head, why } : null;
}

// old -> new, applied simultaneously.
function remapRefs(html, map) {
  return html.replace(/\b(Choice|choice|Option|option) ([A-D])\b/g,
    (_, word, L) => `${word} ${map[L]}`);
}

function rotate(row, target) {
  const choices = JSON.parse(row.choices_json || '[]');
  if (choices.length !== 4) return false;
  const from = LETTERS.indexOf(row.correct_answer);
  const to = LETTERS.indexOf(target);
  if (from < 0 || to < 0) return false;
  const shift = (to - from + 4) % 4;
  if (shift === 0) return false;

  const split = splitExplanation(row.explanation_html);
  if (!split) throw new Error(`${row.id}: explanation has no per-choice paragraphs`);

  // map[old] = new
  const map = {};
  LETTERS.forEach((L, i) => { map[L] = LETTERS[(i + shift) % 4]; });

  const byOld = {};
  for (const c of choices) byOld[c.letter] = c;

  row.choices_json = JSON.stringify(LETTERS.map(L => {
    // The choice that ends up at L is the one that used to be shift places back.
    const old = LETTERS[(LETTERS.indexOf(L) - shift + 4) % 4];
    const c = byOld[old];
    if (!c) throw new Error(`${row.id}: no choice ${old}`);
    const out = { letter: L, content: c.content };
    if (c.trap) out.trap = c.trap;
    return out;
  }));
  row.correct_answer = target;

  const head = remapRefs(split.head, map);
  const body = LETTERS.map(L => {
    const old = LETTERS[(LETTERS.indexOf(L) - shift + 4) % 4];
    const verdict = L === target ? 'right' : 'wrong';
    return `<p><strong>Why ${L} is ${verdict}</strong>${remapRefs(split.why[old], map)}</p>`;
  }).join('');
  row.explanation_html = head + body;
  return true;
}

function run(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  let n = 0, moved = 0;
  const tally = {};
  for (const f of files) {
    const p = path.join(dir, f);
    const rows = fs.readFileSync(p, 'utf8').split('\n')
      .filter(Boolean).map(l => JSON.parse(l));
    for (const r of rows) {
      const choices = JSON.parse(r.choices_json || '[]');
      if (choices.length !== 4) continue;
      const target = LETTERS[n++ % 4];
      if (rotate(r, target)) moved++;
      tally[r.correct_answer] = (tally[r.correct_answer] || 0) + 1;
    }
    fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(`${n} multiple-choice rows, ${moved} rotated`);
  console.log(LETTERS.map(L => `${L}: ${tally[L] || 0}`).join('  '));
}

function selftest() {
  const assert = require('assert');
  const row = {
    id: 'ai_rw001',
    correct_answer: 'A',
    choices_json: JSON.stringify([
      { letter: 'A', content: 'alpha' },
      { letter: 'B', content: 'beta', trap: 'half-right' },
      { letter: 'C', content: 'gamma', trap: 'out-of-scope' },
      { letter: 'D', content: 'delta', trap: 'too-extreme' }]),
    explanation_html:
      '<p><strong>Traps in this question</strong></p><ul><li>Choice B is bait.</li></ul>' +
      '<p><strong>Why A is right</strong> a</p><p><strong>Why B is wrong</strong> b</p>' +
      '<p><strong>Why C is wrong</strong> c</p><p><strong>Why D is wrong</strong> d</p>'
  };
  const r = JSON.parse(JSON.stringify(row));
  assert.ok(rotate(r, 'C'));
  assert.strictEqual(r.correct_answer, 'C');
  const ch = JSON.parse(r.choices_json);
  assert.deepStrictEqual(ch.map(c => c.content), ['gamma', 'delta', 'alpha', 'beta']);
  // The answer keeps no trap tag and every distractor keeps its own.
  assert.strictEqual(ch.find(c => c.letter === 'C').trap, undefined);
  assert.strictEqual(ch.find(c => c.letter === 'A').trap, 'out-of-scope');
  assert.strictEqual(ch.find(c => c.letter === 'D').trap, 'half-right');
  // Exactly one "is right", and it is the new letter.
  assert.ok(/Why C is right/.test(r.explanation_html));
  assert.strictEqual((r.explanation_html.match(/ is right/g) || []).length, 1);
  // The paragraph bodies travelled with their choices.
  assert.ok(/Why C is right<\/strong> a</.test(r.explanation_html));
  assert.ok(/Why D is wrong<\/strong> b</.test(r.explanation_html));
  // The reference in the Traps block was remapped, once.
  assert.ok(/Choice D is bait/.test(r.explanation_html));

  // Rotating to where it already sits changes nothing, so the pass is idempotent.
  const again = JSON.parse(JSON.stringify(r));
  assert.strictEqual(rotate(again, 'C'), false);
  assert.deepStrictEqual(again, r);
  console.log('balance_ai_answers self-check OK');
}

if (process.argv.includes('--test')) selftest();
else run(process.argv[2] || path.join(__dirname, 'aiq'));
