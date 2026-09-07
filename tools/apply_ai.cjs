// Validates an authored batch of AI questions, writes it into the local AI D1,
// registers the ids in the main DB, and emits SQL for the remote.
//   node tools/apply_ai.cjs tools/aiq/rw_01.jsonl        validate + import
//   node tools/apply_ai.cjs --check tools/aiq/*.jsonl    validate only, write nothing
//   node tools/apply_ai.cjs --test                       self-check, touches nothing
const fs = require('fs');
const path = require('path');

const MATH_TRAPS = ['sign-flip', 'endpoint-off-by-one', 'solved-wrong-quantity',
  'unit-mismatch', 'ratio-inverted', 'mean-vs-median', 'extraneous-root',
  'percent-wrong-base', 'slope-intercept-swap', 'axis-misread', 'unsimplified-form',
  'shortcut-trap'];
const RW_TRAPS = ['out-of-scope', 'too-extreme', 'true-but-irrelevant',
  'wrong-part-of-passage', 'reversed-relationship', 'half-right', 'vocab-collocation',
  'comma-splice-plausible', 'distant-antecedent', 'modifier-attachment',
  'transition-reversal', 'pronoun-ambiguity'];
const TRAPS = new Set([...MATH_TRAPS, ...RW_TRAPS]);

// The skills whose answer is decided by what the passage says. A Boundaries or
// Transitions answer is decided by the sentence's structure instead, so those are
// not required to quote.
const EVIDENCE = new Set(['Command of Evidence', 'Central Ideas and Details',
  'Inferences', 'Cross-Text Connections', 'Words in Context',
  'Text Structure and Purpose']);

const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Every reason a row must not ship. Returns a list of complaints; empty is a pass.
function validate(r, seen) {
  const bad = [];
  const id = r.id;
  if (!/^ai_(rw|m)\d{3}$/.test(id || '')) bad.push(`id "${id}" is not ai_rw### / ai_m###`);
  if (seen.has(id)) bad.push(`duplicate id ${id}`);
  if (!['Math', 'Reading & Writing'].includes(r.section)) bad.push(`section "${r.section}"`);
  if (!r.domain) bad.push('no domain');
  if (!r.skill) bad.push('no skill');
  if (r.level !== 4 && r.level !== 5) bad.push(`level ${r.level} is not 4 or 5`);
  if (r.difficulty !== 'Hard') bad.push(`difficulty "${r.difficulty}" must be Hard`);
  if (r.source !== 'AI') bad.push(`source "${r.source}" must be AI`);

  let ch = [];
  try { ch = JSON.parse(r.choices_json); } catch { bad.push('choices_json is not JSON'); }
  const spr = ch.length === 0;
  if (!spr && ch.length !== 4) bad.push(`${ch.length} choices, expected 4 or 0 (grid-in)`);
  const letters = ch.map(c => c.letter);
  if (!spr && letters.join('') !== 'ABCD') bad.push(`choice letters ${letters.join('')}`);
  const ans = String(r.correct_answer == null ? '' : r.correct_answer).trim();
  if (!spr && !letters.includes(ans)) bad.push(`correct_answer "${ans}" is not one of the choices`);
  if (spr && !ans) bad.push('grid-in with no answer');
  // A grid-in has to be gradeable by the player's own isRight(): a decimal, a
  // fraction, or a comma/or list of them. Anything else can never be typed.
  if (spr && ans && !/^-?[.0-9]+(\/-?[.0-9]+)?(\s*(,|or)\s*-?[.0-9]+(\/-?[.0-9]+)?)*$/.test(ans))
    bad.push(`grid-in answer "${ans}" is not a number, fraction or list of them`);
  for (const c of ch) {
    if (!String(c.content || '').trim()) bad.push(`choice ${c.letter} is empty`);
    const isRight = c.letter === ans;
    if (!isRight && !c.trap) bad.push(`choice ${c.letter} has no trap tag`);
    if (!isRight && c.trap && !TRAPS.has(c.trap)) bad.push(`unknown trap "${c.trap}"`);
    if (isRight && c.trap) bad.push(`the correct choice ${c.letter} carries a trap tag`);
  }
  // Four choices that read the same are four ways of being unanswerable. Compared
  // raw rather than through text(): a Boundaries question's choices differ only by
  // punctuation, and stripping entities would make two of them look identical.
  const bodies = ch.map(c => String(c.content).replace(/\s+/g, ' ').trim().toLowerCase());
  if (bodies.length && new Set(bodies).size !== bodies.length) bad.push('two choices are identical');

  const ex = r.explanation_html || '';
  if (!/Traps in this question/i.test(ex)) bad.push('explanation has no Traps block');
  if (!spr) {
    for (const L of ['A', 'B', 'C', 'D'])
      if (!new RegExp(`Why ${L} is`, 'i').test(ex)) bad.push(`explanation never covers choice ${L}`);
    if (/Why A is/i.test(ex) && ex.search(/Traps in this question/i) > ex.search(/Why A is/i))
      bad.push('the Traps block must come before the per-choice analysis');
  }

  const all = [r.stem_html, r.choices_json, ex].join(' ');
  const open = (all.match(/\\\(/g) || []).length;
  const close = (all.match(/\\\)/g) || []).length;
  if (open !== close) bad.push(`${open} \\( against ${close} \\)`);
  if (/[ÃâΓ�]/.test(all)) bad.push('looks like mojibake');
  if (/<img/i.test(all)) bad.push('an <img> - AI rows draw graphs as inline <svg>');
  // An SVG with no viewBox does not scale into the question pane, and one that
  // hardcodes black vanishes in dark mode.
  const svgs = (r.stem_html || '').match(/<svg[^>]*>/gi) || [];
  for (const s of svgs) {
    if (!/viewBox=/i.test(s)) bad.push('an <svg> with no viewBox');
    if (!/role="img"/i.test(s)) bad.push('an <svg> with no role="img"');
  }
  if (svgs.length && !/<title>/i.test(r.stem_html)) bad.push('an <svg> with no <title>');
  if (/(stroke|fill)="#(0{3}|0{6})"/i.test(all)) bad.push('an SVG hardcodes black - use currentColor');

  // An evidence question's answer has to be provable from the passage, not from
  // taste: some run of five or more words in the rationale must appear in the stem.
  // Grammar and synthesis questions are excluded - a Boundaries answer is proved by
  // the clause structure and a Rhetorical Synthesis answer by the notes, so demanding
  // a quotation there would reject correct rows. Compared on words alone, because a
  // quotation that ends on a comma where the passage ends on a period is still a
  // quotation.
  const words5 = (s2) => text(s2).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (EVIDENCE.has(r.skill) && !spr) {
    const stem = words5(r.stem_html);
    const w = words5(ex).split(' ');
    let quoted = false;
    for (let i = 0; i + 5 <= w.length && !quoted; i++)
      if (stem.includes(w.slice(i, i + 5).join(' '))) quoted = true;
    if (!quoted) bad.push('the rationale never quotes the passage');
  }
  return bad;
}

function selftest() {
  const assert = require('assert');
  const ok = {
    id: 'ai_rw001', section: 'Reading & Writing', domain: 'Information and Ideas',
    skill: 'Command of Evidence', difficulty: 'Hard', source: 'AI', level: 5,
    stem_html: '<p>The colony persisted only where the tide pools stayed cold.</p>',
    choices_json: JSON.stringify([
      { letter: 'A', content: 'Cold pools' },
      { letter: 'B', content: 'Warm pools', trap: 'reversed-relationship' },
      { letter: 'C', content: 'All pools', trap: 'too-extreme' },
      { letter: 'D', content: 'Deep water', trap: 'out-of-scope' }]),
    correct_answer: 'A',
    explanation_html: '<p><strong>Traps in this question</strong></p><ul><li>x</li></ul>' +
      '<p><strong>Why A is right</strong> the tide pools stayed cold</p>' +
      '<p><strong>Why B is wrong</strong> b</p><p><strong>Why C is wrong</strong> c</p>' +
      '<p><strong>Why D is wrong</strong> d</p>'
  };
  assert.deepStrictEqual(validate(ok, new Set()), [], 'a good row was refused');

  const broke = (patch, needle) => {
    const bad = validate(Object.assign({}, ok, patch), new Set());
    assert.ok(bad.some(b => b.includes(needle)),
      `expected a complaint about "${needle}", got ${JSON.stringify(bad)}`);
  };
  broke({ correct_answer: 'Z' }, 'not one of the choices');
  broke({ level: 3 }, 'level 3');
  broke({ difficulty: 'Medium' }, 'must be Hard');
  broke({ id: 'rw1' }, 'is not ai_rw###');
  broke({ explanation_html: '<p>Why A is right</p><p>Why B is</p><p>Why C is</p><p>Why D is</p>' }, 'no Traps block');
  broke({ explanation_html: ok.explanation_html.replace('<p><strong>Why B is wrong</strong> b</p>', '') }, 'never covers choice B');
  broke({ stem_html: '<p>\\(x=1</p>' }, '\\(');
  broke({ stem_html: '<p><img src="x"></p>' }, '<img>');
  broke({ stem_html: '<p>Unrelated prose entirely.</p>' }, 'never quotes the passage');
  broke({ stem_html: '<svg role="img"><title>t</title></svg><p>The colony persisted only where the tide pools stayed cold.</p>' }, 'no viewBox');
  broke({ stem_html: '<svg viewBox="0 0 1 1"><title>t</title></svg><p>The colony persisted only where the tide pools stayed cold.</p>' }, 'no role="img"');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'Cold pools' }, { letter: 'B', content: 'b' },
    { letter: 'C', content: 'c', trap: 'too-extreme' },
    { letter: 'D', content: 'd', trap: 'out-of-scope' }]) }, 'choice B has no trap tag');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'Cold pools', trap: 'half-right' },
    { letter: 'B', content: 'b', trap: 'too-extreme' },
    { letter: 'C', content: 'c', trap: 'out-of-scope' },
    { letter: 'D', content: 'd', trap: 'half-right' }]) }, 'correct choice A carries a trap');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'Cold pools' },
    { letter: 'B', content: 'Cold pools', trap: 'half-right' },
    { letter: 'C', content: 'c', trap: 'out-of-scope' },
    { letter: 'D', content: 'd', trap: 'too-extreme' }]) }, 'two choices are identical');
  broke({ choices_json: JSON.stringify([
    { letter: 'A', content: 'a' }, { letter: 'B', content: 'b', trap: 'nonsense-tag' },
    { letter: 'C', content: 'c', trap: 'too-extreme' },
    { letter: 'D', content: 'd', trap: 'out-of-scope' }]) }, 'unknown trap');
  assert.ok(validate(ok, new Set(['ai_rw001'])).some(b => b.includes('duplicate')),
    'a repeated id was allowed');

  // A grid-in: no choices, an answer the player can actually type.
  const gi = Object.assign({}, ok, {
    id: 'ai_m001', section: 'Math', domain: 'Algebra', skill: 'Linear equations in one variable',
    choices_json: '[]', correct_answer: '5/2',
    stem_html: '<p>Solve.</p>',
    explanation_html: '<p><strong>Traps in this question</strong></p><ul><li>x</li></ul><p>5/2</p>'
  });
  assert.deepStrictEqual(validate(gi, new Set()), [], 'a good grid-in was refused');
  assert.ok(validate(Object.assign({}, gi, { correct_answer: 'about half' }), new Set())
    .some(b => b.includes('is not a number')), 'an untypeable grid-in answer was allowed');
  console.log('apply_ai selftest: all cases hold');
}

// The local D1 directory holds one hashed .sqlite per database. Tell them apart by
// what they contain rather than by name: only the AI bank's `questions` has `level`.
function localDbs() {
  const Database = require('better-sqlite3');
  const dir = path.join(__dirname, '..', '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  let main = null, ai = null;
  for (const f of files) {
    const db = new Database(path.join(dir, f));
    const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
    if (!cols.length) { db.close(); continue; }
    if (cols.includes('level')) ai = db; else main = db;
  }
  if (!ai) throw new Error('no local AI database - run: npx wrangler d1 execute AI_DB --local --file=schema_ai.sql');
  if (!main) throw new Error('no local main database');
  return { main, ai };
}

const esc = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const fig = (r) => /<svg/i.test(String(r.stem_html) + String(r.choices_json)) ? 1 : 0;

function main() {
  if (process.argv.includes('--test')) return selftest();
  const checkOnly = process.argv.includes('--check');
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tools/apply_ai.cjs [--check] <batch.jsonl> [...]'); process.exit(2); }

  const rows = [], seen = new Set(), problems = [];
  for (const f of files)
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (e) { problems.push(`${f}: a line is not JSON - ${e.message}`); continue; }
      const bad = validate(r, seen);
      if (bad.length) problems.push(`${r.id}: ${bad.join('; ')}`);
      seen.add(r.id); rows.push(r);
    }
  if (problems.length) {
    console.error(`REFUSED - ${problems.length} row(s):\n` + problems.join('\n'));
    process.exit(1);
  }
  console.log(`${rows.length} row(s) validated`);
  if (checkOnly) return;

  const { main: mainDb, ai } = localDbs();
  const put = ai.prepare(`INSERT INTO questions
    (id, section, domain, difficulty, skill, stem_html, choices_json, correct_answer,
     explanation_html, source, has_figure, level)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      section=excluded.section, domain=excluded.domain, difficulty=excluded.difficulty,
      skill=excluded.skill, stem_html=excluded.stem_html, choices_json=excluded.choices_json,
      correct_answer=excluded.correct_answer, explanation_html=excluded.explanation_html,
      has_figure=excluded.has_figure, level=excluded.level`);
  const reg = mainDb.prepare('INSERT OR IGNORE INTO ai_ids (id) VALUES (?)');
  ai.transaction(() => { for (const r of rows) put.run(r.id, r.section, r.domain, r.difficulty,
    r.skill, r.stem_html, r.choices_json, String(r.correct_answer), r.explanation_html,
    'AI', fig(r), r.level); })();
  mainDb.transaction(() => { for (const r of rows) reg.run(r.id); })();
  console.log(`local: ${rows.length} rows into the AI bank, ${rows.length} ids registered`);

  // The remote gets every authored row, not just this run's - a partial file would
  // leave the two databases disagreeing about which questions exist.
  const all = ai.prepare('SELECT * FROM questions ORDER BY id').all();
  const out = path.join(__dirname, '..', 'd1_ai');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'questions.sql'), all.map(r =>
    `INSERT INTO questions (id, section, domain, difficulty, skill, stem_html, choices_json,` +
    ` correct_answer, explanation_html, source, has_figure, level) VALUES (${esc(r.id)},` +
    `${esc(r.section)},${esc(r.domain)},${esc(r.difficulty)},${esc(r.skill)},${esc(r.stem_html)},` +
    `${esc(r.choices_json)},${esc(r.correct_answer)},${esc(r.explanation_html)},'AI',${r.has_figure | 0},` +
    `${r.level}) ON CONFLICT(id) DO UPDATE SET section=excluded.section, domain=excluded.domain,` +
    ` difficulty=excluded.difficulty, skill=excluded.skill, stem_html=excluded.stem_html,` +
    ` choices_json=excluded.choices_json, correct_answer=excluded.correct_answer,` +
    ` explanation_html=excluded.explanation_html, has_figure=excluded.has_figure,` +
    ` level=excluded.level;`).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'ids.sql'),
    all.map(r => `INSERT OR IGNORE INTO ai_ids (id) VALUES (${esc(r.id)});`).join('\n') + '\n');
  console.log(`d1_ai/questions.sql and d1_ai/ids.sql written for the remote (${all.length} rows)`);
}

main();
