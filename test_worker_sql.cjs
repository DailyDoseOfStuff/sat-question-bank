// The two write statements in src/index.js, against the real schema. They exist to
// bound what a signed-in account can write: a question_id the bank does not have
// must not create a row, and the upsert must still behave for one it does.
//   node test_worker_sql.cjs
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const assert = require('assert');

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
db.exec("INSERT INTO questions (id) VALUES ('real1')");

const P = db.prepare(`INSERT INTO progress
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
 ON CONFLICT(user_id, question_id) DO UPDATE SET
   attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
   last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
   stars=MAX(progress.stars, excluded.stars)`);
P.run('u1', 'real1', 1, 1, 'Green', 't', 10, 2, 'real1');
P.run('u1', 'FAKE', 1, 1, 'Green', 't', 10, 2, 'FAKE');
P.run('u1', 'real1', 5, 3, 'Orange', 't2', 99, 1, 'real1');

const A = db.prepare(`INSERT OR IGNORE INTO attempts (user_id, question_id, ts, correct, time_taken_ms)
 SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)`);
A.run('u1', 'real1', 'T0', 1, 5, 'real1');
A.run('u1', 'FAKE',  'T0', 1, 5, 'FAKE');
A.run('u1', 'real1', 'T0', 1, 5, 'real1');   // same (question, ts) — append-only, ignored

const pr = db.prepare('SELECT * FROM progress').all();
const at = db.prepare('SELECT * FROM attempts').all();
assert.strictEqual(pr.length, 1, 'progress accepted an id the bank does not have');
assert.strictEqual(pr[0].attempts, 5, 'upsert did not update');
assert.strictEqual(pr[0].stars, 2, 'stars must stay at the MAX, not the latest');
assert.strictEqual(at.length, 1, 'attempts accepted a fake id or duplicated a row');
console.log('ok');
