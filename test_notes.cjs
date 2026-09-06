// The two pieces of note/mistake logic that are not DOM: rebuilding a marker the
// mistake bank lost, and the notes export. Both lifted out of public/index.html by
// their markers so a copy here cannot drift from what ships.
//   node test_notes.cjs
const fs = require('fs');
const assert = require('assert');

const page = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const lift = (name) => {
  const a = page.indexOf('// --- ' + name);
  const b = page.indexOf('// --- end ' + name + ' ---');
  if (a < 0 || b < 0) throw new Error(name + ' block not found in public/index.html');
  return page.slice(a, b);
};

// ---- backfillProgress ----
const mkBackfill = () => {
  const ctx = { PROG: {}, LOG: [] };
  const fn = new Function('ctx', 'const PROG = ctx.PROG; const LOG = ctx.LOG;\n'
    + lift('backfillProgress') + '\nreturn backfillProgress;')(ctx);
  return { ctx, run: fn };
};

// 1. the real defect: a wrong attempt whose progress write was refused
{
  const { ctx, run } = mkBackfill();
  ctx.LOG.push({ question_id: '9391b7cc', ts: 'T1', correct: 0, time_taken_ms: 40 });
  run();
  assert.strictEqual(ctx.PROG['9391b7cc'].marker, 'Red', 'a lost mistake was not rebuilt');
  assert.strictEqual(ctx.PROG['9391b7cc'].attempts, 1);
  assert.strictEqual(ctx.PROG['9391b7cc'].corrects, 0);
}

// 2. a real progress row always wins - the rebuild is a floor, never an overwrite
{
  const { ctx, run } = mkBackfill();
  ctx.PROG.q1 = { question_id: 'q1', marker: 'Green', attempts: 1, corrects: 1 };
  ctx.LOG.push({ question_id: 'q1', ts: 'T1', correct: 0 });
  run();
  assert.strictEqual(ctx.PROG.q1.marker, 'Green', 'the rebuild overwrote a stored row');
}

// 3. wrong then right, no progress row: Orange, not Red. It is corrected.
{
  const { ctx, run } = mkBackfill();
  ctx.LOG.push({ question_id: 'q2', ts: 'T1', correct: 0 },
                { question_id: 'q2', ts: 'T2', correct: 1 });
  run();
  assert.strictEqual(ctx.PROG.q2.marker, 'Orange');
  assert.strictEqual(ctx.PROG.q2.attempts, 2);
  assert.strictEqual(ctx.PROG.q2.corrects, 1);
}

// 4. only ever right: not a mistake, nothing invented
{
  const { ctx, run } = mkBackfill();
  ctx.LOG.push({ question_id: 'q3', ts: 'T1', correct: 1 });
  run();
  assert.ok(!ctx.PROG.q3, 'a question only ever answered right was added to the bank');
}

// ---- notesMd ----
const notesMd = new Function(lift('notesMd') + '\nreturn notesMd;')();
const QS = [
  { id: 'a1', section: 'Math', skill: 'Linear equations', difficulty: 'Hard', answer: 'C' },
  { id: 'b2', section: 'Reading & Writing', skill: 'Transitions', difficulty: 'Easy', answer: 'B' }
];

// 5. every note is exported, whatever the mistakes page happens to be filtering to
{
  const md = notesMd({ a1: 'forgot to distribute', b2: 'misread "however"' }, QS);
  assert.ok(md.includes('2 notes'), 'the count is wrong');
  assert.ok(md.includes('forgot to distribute') && md.includes('misread "however"'));
  assert.ok(md.includes('Linear equations — a1') && md.includes('Transitions — b2'));
  assert.ok(md.includes('- Correct answer: C'));
}

// 6. an emptied note is not a note, and a note on a question the bank no longer
//    has still exports - losing what you wrote is worse than a blank heading
{
  const md = notesMd({ a1: '   ', b2: 'kept', zz: 'orphan' }, QS);
  assert.ok(!md.includes('a1'), 'a whitespace-only note was exported');
  assert.ok(md.includes('orphan') && md.includes('Unknown skill'), 'a note lost its question and was dropped');
  assert.ok(md.includes('2 notes'));
}

console.log('test_notes: 6 cases pass');
