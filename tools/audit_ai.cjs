#!/usr/bin/env node
// Structural audit of tools/aiq/*.jsonl, beyond what apply_ai.cjs refuses on.
//
// apply_ai.cjs is the gate a batch has to pass to be written; it checks the
// things that make a row invalid (no answer, a trap tag off the vocabulary, an
// <svg> with no title). This checks the things that make a row render wrong or
// read wrong, which is a different list: unbalanced markup, a graph whose bars
// do not match its own labels, a table with a ragged row, a question that says
// "the underlined portion" with nothing underlined, an answer key that has
// drifted from the explanation.
//
// Run: node tools/audit_ai.cjs        (exit 1 on any finding)
//      node tools/audit_ai.cjs --test (self-check)
const fs = require('fs');
const path = require('path');

const VOID = new Set(['br', 'hr', 'img', 'input', 'path', 'rect', 'line', 'circle',
  'polyline', 'polygon', 'ellipse', 'use', 'stop', 'col', 'meta', 'source']);

// Stack-based tag balance. Returns an error string or null.
function unbalanced(html) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, name, selfClose] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || selfClose) continue;
    if (close) {
      if (!stack.length) return `stray </${tag}>`;
      const open = stack.pop();
      if (open !== tag) return `</${tag}> closes <${open}>`;
    } else stack.push(tag);
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ');

// Every bar chart in the bank encodes its values twice: once as a <rect> height
// and once as a printed label. If those two disagree the graph is a lie that no
// text check would catch, so compare them. Bars are matched to labels by x
// position, which is how a reader pairs them.
function barsMatchLabels(svg) {
  const rects = [...svg.matchAll(/<rect\b[^>]*>/g)].map(m => {
    const g = (k) => {
      const mm = m[0].match(new RegExp(`\\b${k}="([-\\d.]+)"`));
      return mm ? parseFloat(mm[1]) : null;
    };
    return { x: g('x'), w: g('width'), h: g('height') };
  }).filter(r => r.x !== null && r.h !== null);
  if (rects.length < 2) return null;

  const texts = [...svg.matchAll(/<text\b[^>]*\bx="([-\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map(m => ({ x: parseFloat(m[1]), s: m[2].trim() }))
    .filter(t => /^-?\d+(\.\d+)?$/.test(t.s));

  // A value label sits over its own bar; an axis label sits left of every bar.
  const minX = Math.min(...rects.map(r => r.x));
  const values = rects.map(r => {
    const near = texts.filter(t => t.x >= r.x - 12 && t.x <= r.x + (r.w || 60) + 12
      && t.x >= minX - 12);
    return near.length === 1 ? parseFloat(near[0].s) : null;
  });
  if (values.some(v => v === null)) return null;   // not a labelled bar chart

  const k = rects[0].h / values[0];
  for (let i = 1; i < rects.length; i++) {
    const want = values[i] * k;
    if (Math.abs(rects[i].h - want) > Math.max(1.5, want * 0.03))
      return `bar ${i + 1} is ${rects[i].h}px for the value ${values[i]}; ` +
        `bar 1 is ${rects[0].h}px for ${values[0]}, which implies ${want.toFixed(1)}px`;
  }
  return null;
}

function raggedTable(html) {
  for (const t of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const rows = t.match(/<tr[\s\S]*?<\/tr>/g) || [];
    const widths = rows.map(r => (r.match(/<t[dh]\b/g) || []).length);
    const n = widths[0];
    if (widths.some(w => w !== n))
      return `table rows have ${widths.join('/')} cells`;
  }
  return null;
}

function checkRow(r) {
  const bad = [];
  const choices = JSON.parse(r.choices_json || '[]');
  const all = [r.stem_html, r.explanation_html,
    ...choices.map(c => c.content)].join('\n');

  for (const [what, html] of [['stem', r.stem_html],
    ['explanation', r.explanation_html],
    ...choices.map(c => [`choice ${c.letter}`, c.content])]) {
    const u = unbalanced(html);
    if (u) bad.push(`${what}: ${u}`);
  }

  // Markup that renders as literal text. LaTeX is masked out first: an aligned
  // environment uses a bare & as its alignment marker, and the HTML parser leaves
  // one alone when it is not the start of an entity, so KaTeX still receives it.
  const prose = all.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, ' ');
  if (/&(?![a-zA-Z]+;|#\d+;)/.test(prose)) bad.push('a bare & that is not an entity');
  if (/�|Γ[êåÇ]|Ã[©¨¤]|â€/.test(all)) bad.push('mojibake or a replacement character');
  // A control character means a backslash was eaten somewhere upstream and a
  // LaTeX command was read as an escape: "\angle" arrives as BEL + "ngle",
  // which renders as a stray word and leaves the \( \) around it unparsed.
  const ctl = all.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g);
  if (ctl) bad.push('a control character (' + JSON.stringify(ctl[0]) + '), so a LaTeX command lost its backslash');
  if (/\$/.test(all.replace(/\\\$/g, ''))) bad.push('a bare $ (KaTeX is not bound to it, but the stem should escape it)');

  // Inline maths has to be paired, or KaTeX swallows the rest of the paragraph.
  const opens = (all.match(/\\\(/g) || []).length;
  const closes = (all.match(/\\\)/g) || []).length;
  if (opens !== closes) bad.push(`${opens} \\( against ${closes} \\)`);

  // A question that names an underlined portion must have one, in the passage
  // rather than in the question sentence.
  // Match "underlined" itself, not "underlined portion": three items asked
  // about "the underlined sentence" and underlined nothing, and the narrower
  // pattern passed all three.
  const saysUnderlined = /underlined/i.test(r.stem_html);
  const hasU = /<u>[\s\S]*?<\/u>/.test(r.stem_html);
  if (saysUnderlined && !hasU) bad.push('names an underlined portion but underlines nothing');
  if (hasU && !saysUnderlined) bad.push('underlines text no question asks about');
  if (hasU && /<u>[\s\S]*?Which choice[\s\S]*?<\/u>/.test(r.stem_html))
    bad.push('the underline covers the question sentence');

  for (const svg of all.match(/<svg[\s\S]*?<\/svg>/g) || []) {
    const b = barsMatchLabels(svg);
    if (b) bad.push(`graph: ${b}`);
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    if (vb) {
      const [w, h] = [parseFloat(vb[1]), parseFloat(vb[2])];
      for (const m of svg.matchAll(/<text\b[^>]*\bx="([-\d.]+)"[^>]*\by="([-\d.]+)"/g))
        if (parseFloat(m[1]) < 0 || parseFloat(m[1]) > w
          || parseFloat(m[2]) < 0 || parseFloat(m[2]) > h)
          bad.push(`graph: a label at (${m[1]}, ${m[2]}) is outside the ${w}x${h} viewBox`);
    }
  }

  const t = raggedTable(all);
  if (t) bad.push(t);

  // The answer key, the choice list and the explanation all name a letter, and
  // they have to agree. A mismatch is exactly what a rebalancing pass could
  // leave behind.
  if (choices.length) {
    const letters = choices.map(c => c.letter);
    if (letters.join('') !== 'ABCD') bad.push(`choice letters are ${letters.join('')}`);
    const seen = new Map();
    for (const c of choices) {
      const key = strip(c.content).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key) bad.push(`choice ${c.letter} is empty`);
      if (seen.has(key)) bad.push(`choices ${seen.get(key)} and ${c.letter} are identical`);
      seen.set(key, c.letter);
    }
    const right = [...r.explanation_html.matchAll(/Why ([A-D]) is right/g)].map(m => m[1]);
    if (right.length !== 1) bad.push(`${right.length} paragraphs say "is right"`);
    else if (right[0] !== r.correct_answer)
      bad.push(`the key says ${r.correct_answer} but the explanation says ${right[0]}`);
    const covered = [...r.explanation_html.matchAll(/Why ([A-D]) is (?:right|wrong)/g)]
      .map(m => m[1]).join('');
    if (covered !== 'ABCD') bad.push(`explanation covers ${covered || 'no choices'}`);
    if (choices.find(c => c.letter === r.correct_answer && c.trap))
      bad.push('the correct choice carries a trap tag');
    // A reference to a letter must name a letter that exists.
    for (const m of r.explanation_html.matchAll(/\b[Cc]hoice ([A-D])\b/g))
      if (!letters.includes(m[1])) bad.push(`refers to a choice ${m[1]} that does not exist`);
  }

  // The rationale must not have leaked into the question.
  if (/Why [A-D] is (right|wrong)|Traps in this question/.test(r.stem_html))
    bad.push('the stem carries part of the explanation');

  return bad;
}

function run(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  let n = 0, bad = 0;
  const tally = {};
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      n++;
      if (JSON.parse(r.choices_json || '[]').length)
        tally[r.correct_answer] = (tally[r.correct_answer] || 0) + 1;
      const errs = checkRow(r);
      if (errs.length) { bad++; console.log(`${r.id}: ${errs.join('; ')}`); }
    }
  }
  console.log(`\n${n} rows audited, ${bad} with findings`);
  console.log('answer key: ' + Object.keys(tally).sort()
    .map(k => `${k} ${tally[k]}`).join('  '));
  process.exit(bad ? 1 : 0);
}

function selftest() {
  const assert = require('assert');
  const ok = {
    id: 'ai_rw001', correct_answer: 'B',
    stem_html: '<p>A passage with <u>a marked clause</u> in it.</p>' +
      '<p>Which choice best describes the function of the underlined portion?</p>',
    choices_json: JSON.stringify([{ letter: 'A', content: 'a', trap: 'half-right' },
      { letter: 'B', content: 'b' }, { letter: 'C', content: 'c', trap: 'half-right' },
      { letter: 'D', content: 'd', trap: 'half-right' }]),
    explanation_html: '<p><strong>Traps in this question</strong></p><ul><li>x</li></ul>' +
      '<p><strong>Why A is wrong</strong> a</p><p><strong>Why B is right</strong> b</p>' +
      '<p><strong>Why C is wrong</strong> c</p><p><strong>Why D is wrong</strong> d</p>'
  };
  assert.deepStrictEqual(checkRow(ok), [], 'a good row was flagged');

  const broke = (patch, needle) => {
    const errs = checkRow(Object.assign({}, ok, patch));
    assert.ok(errs.some(e => e.includes(needle)),
      `expected "${needle}", got ${JSON.stringify(errs)}`);
  };
  broke({ correct_answer: 'C' }, 'the key says C');
  broke({ stem_html: ok.stem_html.replace(/<\/?u>/g, '') }, 'underlines nothing');
  broke({ stem_html: '<p>A passage <u>x</u>.</p>' }, 'underlines text no question');
  broke({ stem_html: '<p>a <em>b</p>' }, '</p> closes <em>');
  broke({ stem_html: '<p>a <em>b</em>' }, 'unclosed <p>');
  broke({ stem_html: '<p>\\(x + 1</p>' }, '1 \\( against 0 \\)');
  broke({ stem_html: '<p>Fish &amp chips</p>' }, 'bare &');
  broke({ choices_json: JSON.stringify([{ letter: 'A', content: 'a' },
    { letter: 'B', content: 'a' }, { letter: 'C', content: 'c' },
    { letter: 'D', content: 'd' }]) }, 'are identical');

  // A bar chart whose second bar contradicts its own label.
  const chart = (h2) => ok.stem_html +
    `<svg viewBox="0 0 200 120"><rect x="10" y="20" width="30" height="80"/>` +
    `<rect x="60" y="60" width="30" height="${h2}"/>` +
    `<text x="14" y="16">80</text><text x="64" y="56">40</text></svg>`;
  assert.deepStrictEqual(checkRow(Object.assign({}, ok, { stem_html: chart(40) })), []);
  const errs = checkRow(Object.assign({}, ok, { stem_html: chart(75) }));
  assert.ok(errs.some(e => /bar 2 is 75px for the value 40/.test(e)),
    `expected a bar mismatch, got ${JSON.stringify(errs)}`);

  broke({ stem_html: ok.stem_html + '<table><tr><td>a</td><td>b</td></tr>' +
    '<tr><td>c</td></tr></table>' }, 'table rows have 2/1 cells');
  console.log('audit_ai self-check OK');
}

if (process.argv.includes('--test')) selftest();
else run(process.argv[2] || path.join(__dirname, 'aiq'));
