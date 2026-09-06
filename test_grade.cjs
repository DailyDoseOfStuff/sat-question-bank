// Self-check for grade() in public/index.html.
//
// The function lives inside the page's IIFE, so it is lifted out by its markers
// rather than duplicated here - a copy would drift from the one that ships.
// Its free variables (S, PROG, refresh, ...) resolve to globals at call time,
// which is what lets them be stubbed.
//
//   node test_grade.cjs
const fs = require('fs');
const assert = require('assert');

const page = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const block = page.slice(page.indexOf('// --- grade\n'), page.indexOf('// --- end grade ---'));
if (!block) throw new Error('grade block not found in public/index.html');
const grade = new Function(block + '\nreturn grade;')();

const Q = { id: 'q1', answer: 'B', choices: [{letter:'A'},{letter:'B'}] };
let drawn, saved, logged;

// The stem of every case: a fresh session, an empty record, and counters reset.
function setup(opts) {
  opts = opts || {};
  global.PROG = opts.prog || {};
  global.LOG = [];
  global.SET = { retry: !!opts.retry };
  global.S = { ans: {}, sel: {}, miss: {}, tried: {}, checked: {}, qStart: Date.now() };
  drawn = 0; saved = []; logged = [];
  global.refresh = () => { drawn++; drawnAt = { marker: (PROG[Q.id]||{}).marker, log: LOG.length }; };
  global.saveProgress = (r) => saved.push(...r);
  global.saveLog = (r) => logged.push(...r);
  global.renderAnswerArea = () => {};
  global.isRight = (q, v) => (v == null ? null : v === q.answer);
}
let drawnAt;

// 1. A wrong answer marks the record Red and redraws - the reported bug is that
//    it did the first and not the second, so the mistake log stayed empty until
//    the session ended.
setup();
S.ans[Q.id] = 'A';
grade(Q);
assert.strictEqual(PROG[Q.id].marker, 'Red');
assert.strictEqual(drawn, 1, 'a wrong answer must redraw the home screens');

// 2. The redraw has to come after the record moves, or it draws the old state.
assert.deepStrictEqual(drawnAt, { marker: 'Red', log: 1 });

// 3. A right answer redraws too - the dashboard and topic list moved as well.
setup();
S.ans[Q.id] = 'B';
grade(Q);
assert.strictEqual(PROG[Q.id].marker, 'Green');
assert.strictEqual(drawn, 1);

// 4. Retry mode: a miss leaves the question open, and is still logged and drawn.
setup({ retry: true });
S.ans[Q.id] = 'A';
grade(Q);
assert.strictEqual(PROG[Q.id].marker, 'Red');
assert.ok(!S.checked[Q.id], 'retry mode keeps the question open');
assert.strictEqual(drawn, 1);
//    ... and the correction that follows does not walk the record to Green,
//    but is still an attempt, so it still redraws.
S.ans[Q.id] = 'B';
grade(Q);
assert.strictEqual(PROG[Q.id].marker, 'Red', 'only the first Check moves the record');
assert.strictEqual(LOG.length, 2);
assert.strictEqual(drawn, 2);

// 5. Wrong once in an earlier sitting, right now: Orange, and still drawn.
setup({ prog: { q1: { question_id:'q1', attempts:1, corrects:0, marker:'Red' } } });
S.ans[Q.id] = 'B';
grade(Q);
assert.strictEqual(PROG[Q.id].marker, 'Orange');
assert.strictEqual(drawn, 1);

// 6. An unscorable question writes nothing, so there is nothing to redraw.
setup();
S.ans[Q.id] = null;
grade(Q);
assert.deepStrictEqual(PROG, {});
assert.strictEqual(LOG.length, 0);
assert.strictEqual(drawn, 0);

console.log('6 cases pass');
