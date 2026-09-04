// The dashboard is drawn from `attempts`, but an account can hold `progress`
// rows with no attempt behind them (the log only started being written on
// 2026-08-30, and a refused write drops a row). backfillLog() reconstructs one
// attempt per such question so the dashboard stops reporting 0 answered while
// progress holds the answers. Run: node test_backfill.cjs
const fs = require('fs'), assert = require('assert');

const src = fs.readFileSync('public/index.html', 'utf8');
const body = src.match(/function backfillLog\(\)[\s\S]*?\n\}/)[0];
// Evaluate the declaration with PROG/LOG in scope, the way the page has them.
const make = new Function('getState', `
  let PROG, LOG;
  ${body}
  return (p, l) => { PROG = p; LOG = l; backfillLog(); return LOG; };
`)();

// The real remote shape: six progress rows, an empty log.
const prog = {};
for (let i = 0; i < 6; i++)
  prog['q' + i] = { question_id: 'q' + i, attempts: 1, corrects: i % 2,
                    last_reviewed: `2026-09-04T00:0${i}:00.000Z`, time_taken_ms: 1000 * i };
let out = make(prog, []);
assert.strictEqual(out.length, 6, 'every progress row becomes one attempt');
assert.strictEqual(out.filter(x => x.correct).length, 3, 'corrects carry over');
assert.deepStrictEqual(out.map(x => x.ts), out.map(x => x.ts).slice().sort(), 'sorted by ts');

// A question the log already covers is never doubled, however many attempts.
out = make({ a: { question_id: 'a', attempts: 3, corrects: 2, last_reviewed: 'T2' } },
           [{ question_id: 'a', ts: 'T1', correct: 1 }]);
assert.strictEqual(out.length, 1, 'log wins for questions it already covers');

// Rows that record no answer are not answers.
out = make({ a: { question_id: 'a', attempts: 0, corrects: 0, last_reviewed: 'T1' },
             b: { question_id: 'b', attempts: 1, corrects: 0 } }, []);
assert.strictEqual(out.length, 0, 'no attempts, or no timestamp, means nothing to fill');

console.log('ok');
