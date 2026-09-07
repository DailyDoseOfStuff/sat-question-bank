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

const NP = db.prepare(`INSERT INTO notes (user_id, question_id, body, updated_at)
   SELECT ?,?,?,datetime('now') WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
 ON CONFLICT(user_id, question_id) DO UPDATE SET
   body=excluded.body, updated_at=excluded.updated_at`);
const ND = db.prepare('DELETE FROM notes WHERE user_id = ? AND question_id = ?');
NP.run('u1', 'real1', 'first', 'real1');
NP.run('u1', 'FAKE',  'nope',  'FAKE');
NP.run('u1', 'real1', 'second', 'real1');
const nt = db.prepare('SELECT * FROM notes').all();
assert.strictEqual(nt.length, 1, 'notes accepted an id the bank does not have');
assert.strictEqual(nt[0].body, 'second', 'note upsert did not overwrite in place');
ND.run('u1', 'real1');
assert.strictEqual(db.prepare('SELECT * FROM notes').all().length, 0, 'emptying a note must delete the row');

const pr = db.prepare('SELECT * FROM progress').all();
const at = db.prepare('SELECT * FROM attempts').all();
assert.strictEqual(pr.length, 1, 'progress accepted an id the bank does not have');
assert.strictEqual(pr[0].attempts, 5, 'upsert did not update');
assert.strictEqual(pr[0].stars, 2, 'stars must stay at the MAX, not the latest');
assert.strictEqual(at.length, 1, 'attempts accepted a fake id or duplicated a row');
// --- the AI bank lives in a second database, so `questions` cannot vouch for its
// ids. `ai_ids` is the registry that keeps the guard exact across the split.
db.exec("INSERT INTO ai_ids (id) VALUES ('ai_rw001')");

const P2 = db.prepare(`INSERT INTO progress
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                             OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)
 ON CONFLICT(user_id, question_id) DO UPDATE SET
   attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
   last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
   stars=MAX(progress.stars, excluded.stars)`);
P2.run('u2', 'ai_rw001', 1, 0, 'Red', 't', 10, 0, 'ai_rw001', 'ai_rw001');
P2.run('u2', 'ai_NOPE',  1, 0, 'Red', 't', 10, 0, 'ai_NOPE',  'ai_NOPE');
assert.strictEqual(
  db.prepare("SELECT COUNT(*) n FROM progress WHERE user_id='u2'").get().n, 1,
  'progress guard must accept a registered AI id and refuse an unregistered one');

const A2 = db.prepare(`INSERT OR IGNORE INTO attempts
   (user_id, question_id, ts, correct, time_taken_ms, picked, changes)
 SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                         OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)`);
A2.run('u2', 'ai_rw001', 'T1', 0, 8000, 'C', 2, 'ai_rw001', 'ai_rw001');
A2.run('u2', 'ai_NOPE',  'T1', 0, 8000, 'C', 2, 'ai_NOPE',  'ai_NOPE');
const at2 = db.prepare("SELECT * FROM attempts WHERE user_id='u2'").all();
assert.strictEqual(at2.length, 1, 'attempts guard must refuse an unregistered id');
assert.strictEqual(at2[0].picked, 'C', 'picked not stored');
assert.strictEqual(at2[0].changes, 2, 'changes not stored');

const N2 = db.prepare(`INSERT INTO notes (user_id, question_id, body, updated_at)
   SELECT ?,?,?,datetime('now') WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
                                   OR EXISTS(SELECT 1 FROM ai_ids   WHERE id = ?)
 ON CONFLICT(user_id, question_id) DO UPDATE SET
   body=excluded.body, updated_at=excluded.updated_at`);
N2.run('u2', 'ai_rw001', 'note on an AI question', 'ai_rw001', 'ai_rw001');
N2.run('u2', 'ai_NOPE',  'nope',                  'ai_NOPE',  'ai_NOPE');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM notes WHERE user_id='u2'").get().n, 1,
  'notes guard must accept a registered AI id and refuse an unregistered one');

console.log('ok');

