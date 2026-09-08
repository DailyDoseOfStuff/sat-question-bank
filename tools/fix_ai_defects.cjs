#!/usr/bin/env node
// One-off repairs to tools/aiq/*.jsonl, found by reading every question rather
// than by any structural check. Each defect renders perfectly and is still
// wrong to answer, which is why the validator and the audit both passed them.
//
//   1. Two grammatically correct choices. A Boundaries item asks which choice
//      "conforms to the conventions of Standard English", so a distractor that
//      conforms is a second right answer however poorly it fits the meaning.
//      Four items offered a comma-plus-coordinating-conjunction or a comma
//      appositive that is simply correct English - and two of the four said so
//      in their own explanation ("Choice C is grammatical"). The distractor
//      keeps its teaching point with the comma removed, or becomes a splice.
//   2. A stem no choice can complete correctly: a nonrestrictive clause the
//      stem never closes, three introductory modifiers with no comma after
//      them, and a transition item whose keyed phrase collides with the words
//      after the blank ("The remaining the other four were abandoned").
//   3. A stem that asks about "the underlined sentence" and underlines nothing.
//      The audit only tested for "underlined portion", so these three passed.
//
// Every edit is an exact string replacement and every one is asserted, so a
// batch that has moved underneath this script fails loudly rather than
// silently doing nothing.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'aiq');

// id -> [ [field, find, replace], ... ]
const FIXES = {
  // --- 1. two grammatically correct choices --------------------------------
  ai_rw009: [
    ['choice', 'C', ', and the', '; and the', 'comma-splice-plausible'],
    ['explanation_html',
      '<em>A conjunction that flattens the logic.</em> Choice C is grammatical. It is still wrong for this sentence, because &ldquo;and&rdquo; presents the finding as a second event rather than as what the three seasons produced &mdash; and a question that has one grammatical distractor is where most points are lost.',
      '<em>A semicolon wearing a conjunction.</em> Choice C marks the join twice. One mark or the other does the work, and both together is an error the ear does not catch.'],
    ['explanation_html',
      "<strong>Why C is wrong</strong> Comma plus &ldquo;and&rdquo; does join two independent clauses correctly, so this is the trap: it is punctuated legally and reported as merely additive, which loses the sentence's actual relation, that the recordings are the result of the three seasons.",
      '<strong>Why C is wrong</strong> The semicolon already joins the two clauses, so the &ldquo;and&rdquo; after it is one connector too many. A semicolon joins them, or a comma and a conjunction do, but not both at once.'],
  ],
  ai_rw034: [
    ['stem_html', 'at Harvard______ she later said that the machine', 'at Harvard______ the machine'],
    ['choice', 'C', ', and', 'and', 'comma-splice-plausible'],
    ['explanation_html',
      '<em>Two grammatical choices, one right relation.</em> A and B are both legal English. The sentence needs the second clause tied to the place, and only one choice does that.',
      '<em>A restrictive &ldquo;where&rdquo; on a proper noun.</em> Dropping the comma turns the clause into one that picks out which Harvard is meant, and there is only one.'],
    ['explanation_html',
      '<strong>Why C is wrong</strong> Grammatical, and it presents the recollection as a separate fact rather than as something bound to the place and the work. It is the most chosen wrong answer for exactly that reason.',
      '<strong>Why C is wrong</strong> &ldquo;And&rdquo; can join two independent clauses, but a coordinating conjunction that joins them takes a comma in front of it, and none is offered here.'],
  ],
  ai_rw168: [
    ['choice', 'C', ', but below', 'but below', 'comma-splice-plausible'],
    ['explanation_html',
      '<em>A conjunction that shifts the contrast</em> even when it punctuates correctly.',
      '<em>A conjunction with no comma in front of it</em> still leaves two independent clauses badly joined.'],
    ['explanation_html',
      '<strong>Why C is wrong</strong> &ldquo;But&rdquo; with a comma is grammatical, and it is not offered that way here: the choice supplies a comma before &ldquo;but,&rdquo; which is correct punctuation, but the sentence then reads as though the contrast were between the two techniques rather than between two depth ranges.',
      '<strong>Why C is wrong</strong> &ldquo;But&rdquo; can carry the contrast, but a coordinating conjunction joining two independent clauses takes a comma in front of it, and none is offered here.'],
  ],
  ai_rw215: [
    ['choice', 'A', ', a', ', it was a', 'comma-splice-plausible'],
    ['explanation_html',
      '<em>The nearest noun before the break is a measurement</em>, which is what makes the comma reading wrong.',
      '<em>A comma before a full clause is a splice</em>, however naturally the second half follows the first.'],
    ['explanation_html',
      '<strong>Why A is wrong</strong> A comma would read the noun phrase as a loose appositive to &ldquo;6,000 metres,&rdquo; which is not what it renames.',
      '<strong>Why A is wrong</strong> &ldquo;It was a magnetometer&hellip;&rdquo; is an independent clause, and a comma cannot join it to the clause before it.'],
  ],
  ai_rw240: [
    ['choice', 'C', ', and the', 'and the', 'comma-splice-plausible'],
    ['explanation_html',
      '<strong>Why C is wrong</strong> The coordinator is available in principle, but the second half already carries its own &ldquo;and nothing could be moved&rdquo;, and a second <em>and</em> leaves the sentence with two coordinations at the same level and no clear grouping.',
      '<strong>Why C is wrong</strong> A coordinating conjunction joining two independent clauses takes a comma in front of it, and none is offered here.'],
  ],

  // --- 2. a stem no choice can complete ------------------------------------
  ai_rw291: [['stem_html', 'since 1994 has never recorded', 'since 1994, has never recorded']],
  ai_rw245: [['stem_html', 'two thousand years ______', 'two thousand years, ______']],
  ai_rw270: [['stem_html', 'could read ______', 'could read, ______']],
  ai_rw295: [['stem_html', 'the scent ______', 'the scent, ______']],
  ai_rw124: [['stem_html', '______ the other four were abandoned', '______ four were abandoned']],

  // --- 3. asks about an underlined sentence and underlines nothing ----------
  ai_rw020: [['stem_html',
    'But a sapling planted this spring will not shade anyone for fifteen years, and the residents of the hottest blocks are, on the whole, the residents least likely to still be living there in fifteen years.',
    '<u>But a sapling planted this spring will not shade anyone for fifteen years, and the residents of the hottest blocks are, on the whole, the residents least likely to still be living there in fifteen years.</u>']],
  ai_rw045: [['stem_html',
    "Fidelity to what: the author's sentences, the author's effect on a first reader, or the effect those sentences would have had if the author had written in the second language?",
    "<u>Fidelity to what: the author's sentences, the author's effect on a first reader, or the effect those sentences would have had if the author had written in the second language?</u>"]],
  ai_rw075: [['stem_html',
    'The broader measures already exist; the Bureau of Labor Statistics publishes six of them every month, and has for decades.',
    '<u>The broader measures already exist; the Bureau of Labor Statistics publishes six of them every month, and has for decades.</u>']],
};

function run() {
  const seen = new Set();
  let edits = 0;
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.jsonl')).sort()) {
    const p = path.join(DIR, f);
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    let touched = false;
    for (const r of rows) {
      const fixes = FIXES[r.id];
      if (!fixes) continue;
      seen.add(r.id);
      for (const fix of fixes) {
        if (fix[0] === 'choice') {
          // Choice edits go through parse/stringify: the JSON in these files is
          // written with and without spaces after the colons, so matching the
          // raw string would fire on some batches and not others.
          const [, letter, oldContent, newContent, newTrap] = fix;
          const cs = JSON.parse(r.choices_json);
          const c = cs.find(x => x.letter === letter);
          if (c && c.content === newContent) continue;   // already applied
          if (!c || c.content !== oldContent) throw new Error(`${r.id}: choice ${letter} is not ${JSON.stringify(oldContent)}`);
          c.content = newContent;
          if (newTrap) c.trap = newTrap;
          r.choices_json = JSON.stringify(cs);
        } else {
          const [field, find, repl] = fix;
          if (r[field].includes(repl)) continue;         // already applied
          if (!r[field].includes(find)) throw new Error(`${r.id}.${field}: not found: ${find.slice(0, 70)}`);
          r[field] = r[field].replace(find, repl);
        }
        edits++;
      }
      touched = true;
    }
    if (touched) fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const missing = Object.keys(FIXES).filter(id => !seen.has(id));
  if (missing.length) throw new Error('rows not found: ' + missing.join(', '));
  console.log(`${seen.size} rows repaired, ${edits} edits`);
}

run();
