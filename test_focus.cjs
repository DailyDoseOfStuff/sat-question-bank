// The focus-set picker and the difficulty ladder, lifted out of public/index.html
// by their markers so a copy here cannot drift from what ships.
//   node test_focus.cjs
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const m = src.match(/\/\/ --- focus[\s\S]*?\n([\s\S]*?)\/\/ --- end focus/);
if (!m) throw new Error('no // --- focus block in public/index.html');
const build = (QS, PROG) => new Function('QS', 'PROG',
  'const levelOf = (q) => q.level || ({easy:1,medium:2,hard:3})[String(q.difficulty||"").toLowerCase()] || 2;'
  + m[1] + '; return { weakness, focusSet, nextLevel };')(QS, PROG);

const QS = [];
for (let i = 0; i < 40; i++)
  QS.push({ id: 'w' + i, section: 'Math', skill: 'Weak', source: 'CollegeBoard',
            difficulty: 'Hard', level: 3 + (i % 3) });
for (let i = 0; i < 40; i++)
  QS.push({ id: 's' + i, section: 'Math', skill: 'Strong', source: 'CollegeBoard',
            difficulty: 'Hard', level: 3 });
for (let i = 0; i < 20; i++)
  QS.push({ id: 'ai' + i, section: 'Reading & Writing', skill: 'Weak', source: 'AI',
            difficulty: 'Hard', level: 5 });
const PROG = {};
for (let i = 0; i < 10; i++) PROG['w' + i] = { attempts: 1, corrects: 0, last_reviewed: '2026-09-01' };
for (let i = 0; i < 10; i++) PROG['s' + i] = { attempts: 1, corrects: 1, last_reviewed: '2026-09-01' };
const f = build(QS, PROG);

const w = f.weakness(QS);
assert.ok(w.get('Weak') > w.get('Strong'),
  'a skill that is always missed must outrank one that is always right');

// A skill with no attempts at all scores 0.5 rather than 0, so it is still offered.
const fresh = build([{ id: 'n1', section: 'Math', skill: 'New', difficulty: 'Hard' }], {});
assert.strictEqual(fresh.weakness([{ id: 'n1', skill: 'New' }]).get('New'), 0.5,
  'an untouched skill must not score zero, or it can never be practiced');

const set = f.focusSet({ n: 30, sections: null, bank: 'both' });
assert.strictEqual(set.length, 30, 'the set must be the requested size');
assert.strictEqual(new Set(set.map(q => q.id)).size, 30, 'no question may repeat inside one set');
const weakShare = set.filter(q => q.skill === 'Weak').length / 30;
assert.ok(weakShare > 0.5, `the weak skill should dominate the set, got ${weakShare}`);
assert.ok(set.slice(0, 6).every(q => !PROG[q.id]),
  'questions never seen before come ahead of ones already drilled');

// Section and bank narrow the pool.
const mathOnly = f.focusSet({ n: 30, sections: ['Math'], bank: 'both' });
assert.ok(mathOnly.every(q => q.section === 'Math'), 'the section filter leaked');
const aiOnly = f.focusSet({ n: 30, sections: null, bank: 'ai' });
assert.ok(aiOnly.every(q => q.source === 'AI'), 'the bank filter leaked');
assert.strictEqual(aiOnly.length, 20, 'an AI-only set is bounded by how many AI rows exist');
const official = f.focusSet({ n: 10, sections: null, bank: 'official' });
assert.ok(official.every(q => q.source !== 'AI'), 'the official filter let an AI row through');
assert.deepStrictEqual(f.focusSet({ n: 10, sections: ['Nonexistent'], bank: 'both' }), [],
  'an impossible combination must give an empty set, not a wrong one');

// The ladder can only move if the set spans levels. With thousands of unseen rows
// the unseen-first sort used to collapse every skill onto its easiest questions, so
// every focus set was one level deep and the ladder was decorative.
const spread = new Set(mathOnly.map(q => q.level));
assert.ok(spread.size >= 3, 'the set must span levels for the ladder to climb, got ' + [...spread]);
assert.ok(mathOnly.slice(0, 6).some(q => q.level > 3),
  'a harder question must appear early enough for the ladder to reach it');

assert.strictEqual(f.nextLevel(3, 1, true), 3, 'one correct answer does not promote');
assert.strictEqual(f.nextLevel(3, 2, true), 4, 'two in a row promotes');
assert.strictEqual(f.nextLevel(5, 2, true), 5, 'level is capped at 5');
assert.strictEqual(f.nextLevel(3, 0, false), 2, 'a miss demotes');
assert.strictEqual(f.nextLevel(1, 0, false), 1, 'level floors at 1');
console.log('focus: all cases hold');
