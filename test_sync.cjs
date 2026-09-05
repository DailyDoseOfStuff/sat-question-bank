// Self-check for the write queue in public/index.html.
//
// A refused write used to be a lost answer: it was reported once per page load and
// dropped, so after the first failure the rest of a session saved nothing and said
// nothing. These assertions are the ones that stop that coming back.
//
// The code lives inside the page's IIFE, so it is lifted by its markers rather
// than copied here - a copy would drift from the one that ships.
//
//   node test_sync.cjs
const fs = require('fs');
const assert = require('assert');

const page = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const block = page.slice(page.indexOf('// --- sync'), page.indexOf('// --- end sync ---'));
if (!block) throw new Error('sync block not found in public/index.html');

// Everything the block reaches for that a page would have provided.
const PRE = `
  let authToken = 'tok';
  const els = {};
  const $ = (id) => els[id] || null;
  const document = { hidden: false, body: { appendChild: (e) => (els[e.id] = e, e) },
    createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; },
                            remove() { delete els[this.id]; } }) };
  const addEventListener = () => {};
  const sbHeaders = async () => ({ Authorization: 'Bearer tok' });
`;
const api = new Function(PRE + block +
  '\nreturn { push, flush, PENDING, unsaved, warnSync, banner: () => ($("sync-bar")||{}).textContent, ' +
  'setToken: (t) => { authToken = t; } };')();

// One fetch stub. `fail` decides what the server does; `sent` records every body.
let fail = false, sent = [];
global.fetch = async (url, opt) => {
  sent.push({ url, rows: JSON.parse(opt.body) });
  return fail ? { ok: false, status: 429 } : { ok: true, status: 200 };
};
const P = api.PENDING;
const reset = () => { fail = false; sent = []; P['/api/progress'].length = 0; P['/api/attempts'].length = 0; api.warnSync(''); };

(async () => {
  // A write the server takes leaves nothing behind and no banner.
  reset();
  await api.push('/api/progress', [{ question_id: 'a', marker: 'Red' }]);
  assert.equal(sent.length, 1);
  assert.equal(api.unsaved(), 0, 'an accepted write must not stay queued');
  assert.equal(api.banner(), undefined, 'nothing to report');

  // A refused write is kept, not dropped, and it says so.
  reset();
  fail = true;
  await api.push('/api/progress', [{ question_id: 'a', marker: 'Red' }]);
  assert.equal(api.unsaved(), 1, 'a refused write must be kept');
  assert.match(api.banner(), /1 answer not saved/);

  // The next answer re-sends it, so a session that starts failing recovers whole.
  await api.push('/api/attempts', [{ question_id: 'a', ts: '1' }]);
  assert.equal(api.unsaved(), 2);
  fail = false;
  await api.push('/api/progress', [{ question_id: 'b', marker: 'Red' }]);
  assert.equal(P['/api/progress'].length, 0, 'the queue flushes on the next push');
  assert.deepEqual(sent[sent.length - 1].rows.map(r => r.question_id), ['a', 'b'],
    'the answer that failed goes up with the one that followed it');
  // The attempts queue is a separate endpoint and is still waiting.
  assert.equal(api.unsaved(), 1);
  await api.flush('/api/attempts');
  assert.equal(api.unsaved(), 0);
  assert.equal(api.banner(), undefined, 'the banner clears itself once nothing is waiting');

  // A progress row is the question's whole state, so a later answer to the same
  // question replaces the one waiting. Attempts are history and all are kept.
  reset();
  fail = true;
  await api.push('/api/progress', [{ question_id: 'a', attempts: 1 }]);
  await api.push('/api/progress', [{ question_id: 'a', attempts: 2 }]);
  assert.equal(P['/api/progress'].length, 1);
  assert.equal(P['/api/progress'][0].attempts, 2, 'the newer state wins');
  await api.push('/api/attempts', [{ question_id: 'a', ts: '1' }]);
  await api.push('/api/attempts', [{ question_id: 'a', ts: '2' }]);
  assert.equal(P['/api/attempts'].length, 2, 'every attempt is history');

  // More than one batch's worth drains in full rather than one batch per answer.
  reset();
  fail = true;
  await api.push('/api/progress', Array.from({ length: 450 }, (_, i) => ({ question_id: 'q' + i })));
  assert.equal(api.unsaved(), 450);
  fail = false; sent = [];
  await api.flush('/api/progress');
  assert.equal(api.unsaved(), 0, 'the whole queue drains');
  assert.deepEqual(sent.map(s => s.rows.length), [200, 200, 50], 'in batches the Worker will take');

  // Signed out there is no account to write to, and nothing is queued for one.
  reset();
  api.setToken('');
  await api.push('/api/progress', [{ question_id: 'a' }]);
  assert.equal(api.unsaved(), 0);
  assert.equal(sent.length, 0);
  api.setToken('tok');

  // A read failure is its own message and survives a successful write.
  reset();
  api.warnSync('Could not load all of your saved progress.');
  await api.push('/api/progress', [{ question_id: 'a' }]);
  assert.match(api.banner(), /Could not load/, 'a read failure is not cleared by a write succeeding');

  console.log('test_sync: all assertions passed');
})();
