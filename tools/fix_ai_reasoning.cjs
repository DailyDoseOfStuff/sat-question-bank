#!/usr/bin/env node
// A second reading pass over tools/aiq/*.jsonl. Every defect here renders
// perfectly, grades correctly and passes both apply_ai.cjs --check and
// audit_ai.cjs. They are only wrong to *read*.
//
//   1. Math: a distractor whose value does not follow from the derivation its
//      own explanation gives for it. "Why B is wrong: this comes from 3(x-2)=
//      5(x+6), which gives -36=2x and not 4" - the explanation is describing a
//      different number from the one printed on the button. A student who works
//      the named error out gets a value that is not offered, so the explanation
//      teaches nothing. Fixed by moving the choice to the value the derivation
//      actually produces, or by naming the error that actually produces the
//      printed value. 25 rows.
//
//   2. Math, ai_m053: the question was unanswerable. Line l is 3x+4y=20 and the
//      point given for the parallel line k was (8,-1), which lies on l - so k IS
//      l, the keyed x-intercept was wrong, and the true answer (20/3, 0) was
//      sitting in choice D. The point is now (4,6), off l, and k is
//      y = -3/4 x + 9 crossing the x-axis at (12, 0).
//
//   3. RW: a stale bare-letter cross-reference. tools/balance_ai_answers.cjs
//      rotates the choices and remaps "Choice X", but a reference written as a
//      bare "D contains 'grief'" or "A gives the edge contrast" was left
//      pointing at whatever now sits at that letter. 20 rows, ~35 references.
//      Each is rewritten into "Choice X" form as well as corrected, so the next
//      rebalance moves it with the choice it names.
//
// Every edit is an exact string replacement and every one is asserted, so a
// batch that has moved underneath this script fails loudly rather than silently
// doing nothing. Re-running is a no-op.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'aiq');

// id -> [ ['choice', letter, oldContent, newContent, newTrap?]
//       | [field, find, replace], ... ]
const FIXES = {
  // --- 1. Math: distractors that do not follow from their own derivation ----

  // C was 7/3. Dropping the 8 from 5(t+2) gives 5t+2-3 = 2t+18, i.e. 3t = 19.
  ai_m002: [
    ['choice', 'C', '\\(\\frac{7}{3}\\)', '\\(19\\)', 'shortcut-trap'],
    ['explanation_html',
      '\\(5(t+2)=5t+10\\); dropping the 10 changes the constant and produces \\(\\frac{7}{3}\\).',
      '\\(5(t+2)=5t+10\\); writing \\(5t+2\\) instead changes the constant and produces \\(3t=19\\).'],
    ['explanation_html',
      'which drops 8 from the left side and gives \\(3t = 7\\).',
      'which drops 8 from the left side and gives \\(3t = 19\\).'],
  ],

  // C was y = x + 1. The line runs 6 gridlines and rises 3, so counting
  // gridlines gives 1/2, never 1. Each x gridline is 2 units, so the run is 12.
  ai_m008: [
    ['choice', 'C', '\\(y = x + 1\\)', '\\(y = \\frac{1}{2}x + 1\\)'],
    ['explanation_html',
      'The line rises one gridline for every gridline it runs, so it looks like slope 1. One horizontal gridline is 2 units and one vertical gridline is 1 unit, so the real slope is \\(\\frac{1}{2}\\) per gridline pair &mdash; and reading actual coordinates gives \\(\\frac{1}{4}\\).',
      'The line rises 3 gridlines for every 6 it runs, so counting gridlines gives \\(\\frac{1}{2}\\). One horizontal gridline is 2 units, so that run is 12 units and the real slope is \\(\\frac{1}{4}\\).'],
    ['explanation_html',
      'This is what the picture looks like if both axes are assumed to have the same scale. Counting gridlines instead of units gives slope 1.',
      'This is what the picture looks like if both axes are assumed to have the same scale: 3 gridlines up over 6 across. Each horizontal gridline is 2 units, so the run is 12, not 6.'],
  ],

  // A was -8, but the error its explanation names (h read as -2) gives
  // 1 - 2 - 9 = -10. D (6) had no derivation at all; it is the answer with its
  // sign dropped, and 12 already covers taking k as +9.
  ai_m014: [
    ['choice', 'A', '\\(-8\\)', '\\(-10\\)'],
    ['explanation_html',
      'is the standard error and gives \\(-10\\) or \\(6\\) depending on where else it propagates.',
      'is the standard error and gives \\(1-2-9=-10\\).'],
    ['explanation_html',
      '<strong>Why D is wrong</strong> This comes from taking \\(k = 9\\) instead of \\(-9\\), which reads the depth of the vertex as a distance rather than as a coordinate.',
      '<strong>Why D is wrong</strong> 6 is the correct sum with its sign dropped. \\(a+h+k=1+2-9=-6\\), and the value asked for is negative.'],
  ],

  // A was 2*sqrt(34). Subtracting instead of adding gives 2 - 34 = -32, whose
  // magnitude has square root 4*sqrt(2).
  ai_m017: [
    ['choice', 'A', '\\(2\\sqrt{34}\\)', '\\(4\\sqrt{2}\\)'],
    ['explanation_html',
      'giving \\(2 - 34\\) and then taking a magnitude.',
      'giving \\(2-34=-32\\) and then taking a magnitude, \\(\\sqrt{32}=4\\sqrt{2}\\).'],
  ],

  // A was 60%, which no stated error produces; subtracting both percentages
  // from 100 gives 40. And 1.30 x 1.30 is 169%, not the 109% it was offered as.
  ai_m021: [
    ['choice', 'A', '\\(60\\%\\)', '\\(40\\%\\)'],
    ['explanation_html',
      'treating them as multiplying to \\(1 + 0.09\\) gives 109.',
      'putting the 9 percent difference on the wrong side of 100 gives 109.'],
    ['explanation_html',
      '<strong>Why A is wrong</strong> This subtracts both percentages from 100 as if each were 30% of the original, treating the changes as sequential subtractions of the same amount.',
      '<strong>Why A is wrong</strong> This subtracts both percentages from 100 as if each were 30% of the original: \\(100-30-30=40\\).'],
    ['explanation_html',
      '<strong>Why D is wrong</strong> This has the sign of the second change wrong, giving \\(1.30 \\times 1.30\\) or an equivalent addition of the 9% correction in the wrong direction.',
      '<strong>Why D is wrong</strong> The product \\(1.30\\times 0.70=0.91\\) is 9% below the original, and this puts the 9% above it instead.'],
  ],

  // The value -14/3 is right for D, but multiplying the right side by 6 gives
  // x+9, not 2x+9. The error that gives 2x+9 is mis-distributing the 2.
  ai_m026: [
    ['explanation_html',
      'Multiplying the left side by 12 but the right side by 6, so that \\(x+9\\) becomes \\(2x+9\\), leaves \\(5x+23=2x+9\\) and \\(x=-\\dfrac{14}{3}\\). Every term has to be multiplied by the same number.',
      'Mis-distributing the right side, writing \\(2(x+9)=2x+9\\), leaves \\(5x+23=2x+9\\) and \\(x=-\\dfrac{14}{3}\\). The 2 multiplies both terms.'],
  ],

  // B (-8) and C (-7) were both hand-waved "mis-additions". The two real
  // near-misses on this question are the sum of both roots (-6, the -b/a
  // shortcut the trap block already names) and the extraneous root itself (-5).
  ai_m033: [
    ['choice', 'B', '\\(-8\\)', '\\(-6\\)'],
    ['choice', 'C', '\\(-7\\)', '\\(-5\\)'],
    ['explanation_html',
      '\\(-8\\) is the coefficient of \\(x\\) in the expanded square with its sign kept, and it is also what a student reports after mis-summing the two roots. The roots sum to \\(-6\\) before the check, not \\(-8\\).',
      '\\(-6\\) is \\(-\\dfrac{b}{a}\\) for \\(x^{2}+6x+5=0\\), the sum of both roots of the squared equation. One of those roots is not a solution of the original, so it must not be counted.'],
    ['explanation_html',
      '\\(-7\\) is a mis-addition of the two roots. Even the correct sum of both roots, \\(-6\\), would be wrong here, because one of them does not satisfy the original equation.',
      '\\(-5\\) is the extraneous root itself. It satisfies the squared equation and not the original, where it gives \\(\\sqrt{1}=1\\) on the left and \\(-1\\) on the right.'],
  ],

  // C was 11/2, but 5 - 3/2 is 7/2, which is already choice B. The subtraction
  // in the wrong order gives s - r = -13/2, which is what the trap tag says.
  ai_m036: [
    ['choice', 'C', '\\(\\dfrac{11}{2}\\)', '\\(-\\dfrac{13}{2}\\)'],
    ['explanation_html',
      '\\(\\dfrac{11}{2}\\) is \\(5-\\dfrac{3}{2}\\) rather than \\(\\dfrac{3}{2}-(-5)\\). Subtracting in the wrong order and then correcting the sign by hand loses the \\(+5\\).',
      '\\(-\\dfrac{13}{2}\\) is \\(s-r\\), the subtraction in the wrong order. \\(r>s\\) is given, so \\(r-s\\) is positive.'],
  ],

  // B was 169, which nothing produces; squaring the sum 16+9 gives 625. Adding
  // the differences before squaring gives (4+3)^2 = 49.
  ai_m047: [
    ['choice', 'B', '\\((x+3)^{2}+(y-4)^{2}=169\\)', '\\((x+3)^{2}+(y-4)^{2}=49\\)'],
    ['explanation_html',
      'This squares the sum \\(16+9=25\\) instead of adding the squares of the separate differences.',
      'This adds the two differences and then squares: \\((4+3)^{2}=49\\). The distance formula squares each difference first.'],
  ],

  // C is 3, which is a cylinder over a cone, not a cone over a cylinder.
  ai_m049: [
    ['explanation_html',
      'This is the ratio of the cone to a cylinder of the same radius and height, which the question does not mention.',
      'This is the ratio of a cylinder to a cone of the same radius and height, which the question does not mention.'],
  ],

  // B was 4 and its own explanation admitted the named error "gives -36=2x and
  // not 4". That error gives x = -18.
  ai_m052: [
    ['choice', 'B', '4', '-18'],
    ['explanation_html',
      '<strong>Why B is wrong</strong> 4 comes from cross-multiplying the numerators against the wrong denominators, \\(3(x-2)=5(x+6)\\), which gives \\(-36=2x\\) and not 4; it is also what a student reaches by setting \\(x-2\\) and \\(x+6\\) proportional to 3 and 5 in the wrong order.',
      '<strong>Why B is wrong</strong> \\(-18\\) comes from pairing each numerator with the denominator beside it, \\(3(x-2)=5(x+6)\\), so \\(3x-6=5x+30\\) and \\(x=-18\\). Cross-multiplication pairs each numerator with the opposite denominator.'],
  ],

  // Why A described two contradictory sign slips and landed nowhere.
  ai_m055: [
    ['explanation_html',
      'Moving the \\(x\\) terms to the left instead gives \\(-7x\\ge -21\\), and dividing by \\(-7\\) requires reversing the symbol. Keeping it gives \\(x\\ge 3\\) written as \\(x\\le -3\\) after a further sign slip.',
      'Collecting the \\(x\\) terms on the left gives \\(-7x\\ge -21\\). Dividing by \\(-7\\) reverses the symbol and gives \\(x\\le 3\\); carrying the minus sign into the answer as well gives \\(x\\le -3\\).'],
  ],

  // B was 24, described as "extending back only two hours", which gives 25.
  ai_m057: [
    ['choice', 'B', '24', '25'],
    ['explanation_html',
      "<strong>Why B is wrong</strong> 24 subtracts one hour's burn too few, using \\(21+2(3)-3\\) or extending back only two hours instead of three.",
      '<strong>Why B is wrong</strong> 25 extends back only two hours instead of three: \\(21+2(2)=25\\). From \\(t=3\\) to \\(t=0\\) is three hours.'],
  ],

  ai_m058: [
    ['explanation_html',
      'This is the largest value of \\(k^{2}-1\\), not of \\(k\\). The question asks for \\(k\\) itself.',
      '63 is \\(k^{2}-1\\) at the boundary \\(k=8\\). The question asks for \\(k\\) itself, not for a value built from the discriminant.'],
  ],

  // --- 2. ai_m053: the question could not be answered ----------------------
  // (8,-1) satisfies 3x+4y=20, so line k was line l. The keyed answer 4/3 came
  // out of an arithmetic slip in the worked solution, and the true intercept
  // (20/3, 0) was choice D. Moving the point to (4,6) puts it off l; k is then
  // y = -3/4 x + 9, crossing the x-axis at (12, 0).
  ai_m053: [
    ['stem_html', 'passes through \\((8,\\,-1)\\)', 'passes through \\((4,\\,6)\\)'],
    ['choice', 'A', '\\(\\left(\\dfrac{4}{3},\\,0\\right)\\)', '\\((12,\\,0)\\)'],
    ['choice', 'B', '\\(\\left(-\\dfrac{4}{3},\\,0\\right)\\)', '\\((-12,\\,0)\\)'],
    ['choice', 'C', '\\((0,\\,-5)\\)', '\\((0,\\,9)\\)'],
    ['explanation_html',
      'Through \\((8,-1)\\): \\(y+1=-\\dfrac{3}{4}(x-8)\\), which is \\(y=-\\dfrac{3}{4}x+5\\). Setting \\(y=0\\) gives \\(\\dfrac{3}{4}x=5\\) and \\(x=\\dfrac{20}{3}\\cdot\\dfrac{1}{5}=\\dfrac{4}{3}\\).',
      'Through \\((4,6)\\): \\(y-6=-\\dfrac{3}{4}(x-4)\\), which is \\(y=-\\dfrac{3}{4}x+9\\). Setting \\(y=0\\) gives \\(\\dfrac{3}{4}x=9\\) and \\(x=12\\).'],
    ['explanation_html',
      'This drops a sign while solving \\(0=-\\tfrac{3}{4}x+5\\).',
      'This drops a sign while solving \\(0=-\\tfrac{3}{4}x+9\\).'],
  ],

  // C (105) and D (85) both had explanations that admitted no computation
  // produces them. The two real near-misses are the 2023 figure (120) and the
  // decrease applied to the wrong base (75).
  ai_m065: [
    ['choice', 'C', '105', '120', 'solved-wrong-quantity'],
    ['choice', 'D', '85', '75'],
    ['explanation_html',
      '<strong>Why C is wrong</strong> 105 applies the decrease first and the increase second in the wrong proportion, or subtracts 25 from 120 and then adds 10.',
      '<strong>Why C is wrong</strong> 120 is the 2023 revenue as a percent of 2022. The second change has not been applied yet.'],
    ['explanation_html',
      '<strong>Why D is wrong</strong> 85 subtracts 25 percent of 100 from 120 minus 10, mixing bases again. No consistent computation produces it.',
      '<strong>Why D is wrong</strong> 75 applies the 25 percent decrease to the 2022 revenue. That decrease is taken of the 2023 revenue, which is 120.'],
  ],

  // D was 4, reached in the explanation by "adjusting by 2". The number a
  // student really reports here is 5, the count given for neither.
  ai_m071: [
    ['choice', 'D', '4', '5', 'solved-wrong-quantity'],
    ['explanation_html',
      '<em>Every wrong choice comes from using 30 where 25 belongs.</em>',
      '<em>The numbers in the stem are also answers.</em> 32 is the raw sum and 5 is the count who study neither.'],
    ['explanation_html',
      '<strong>Why D is wrong</strong> 4 subtracts 5 from the overlap or uses 30 rather than 25 as the union: \\(18+14-30=2\\) and adjusting by 2 gives 4. The union is 25.',
      '<strong>Why D is wrong</strong> 5 is the number who study neither, which the question gives. The overlap is what is asked for.'],
  ],

  // theta/r is 2pi/27, not 3pi. 3pi is the sector-area formula with r^2 as r.
  ai_m072: [
    ['explanation_html',
      '\\(3\\pi\\) divides by the radius instead of multiplying, using \\(\\dfrac{\\theta}{r}\\) scaled up.',
      '\\(3\\pi\\) is \\(\\dfrac12 r\\theta=\\dfrac12\\cdot 9\\cdot\\dfrac{2\\pi}{3}\\), the sector-area formula with \\(r^{2}\\) written as \\(r\\). Arc length is \\(r\\theta\\).'],
  ],

  // B was 32, "4/25 inverted and rounded". The real error on a similar-figures
  // question that is not already offered is cubing rather than squaring.
  ai_m075: [
    ['choice', 'B', '32', '312.5'],
    ['explanation_html',
      '<strong>Why B is wrong</strong> 32 applies \\(\\dfrac{4}{25}\\) inverted and rounded, again scaling down.',
      '<strong>Why B is wrong</strong> 312.5 applies the cube of the ratio, \\(20\\cdot\\left(\\dfrac{5}{2}\\right)^{3}\\). Volumes scale by the cube; areas scale by the square.'],
  ],

  // B and C had each other's derivations: 3x = -21-9 gives -10, and
  // 3x = 9-21 gives -4.
  ai_m076: [
    ['explanation_html',
      '<strong>Why B is wrong</strong> &minus;10 comes from moving the 21 to the wrong side: \\(3x=9-21\\).',
      '<strong>Why B is wrong</strong> &minus;10 comes from subtracting the 9 instead of adding the 21: \\(3x=-21-9=-30\\).'],
    ['explanation_html',
      '<strong>Why C is wrong</strong> &minus;4 combines both errors.',
      '<strong>Why C is wrong</strong> &minus;4 comes from moving the 21 to the wrong side: \\(3x=9-21=-12\\).'],
  ],

  // A was 14 and D was -2; the errors their explanations name give -19 and 20.
  ai_m082: [
    ['choice', 'A', '14', '&minus;19', 'shortcut-trap'],
    ['choice', 'D', '&minus;2', '20'],
    ['explanation_html',
      '<strong>Why A is wrong</strong> 14 comes from multiplying only the left side by 6 and leaving the 3 alone.',
      '<strong>Why A is wrong</strong> &minus;19 comes from multiplying only the left side by 6 and leaving the 3 alone: \\(x+22=3\\).'],
    ['explanation_html',
      '<strong>Why D is wrong</strong> &minus;2 comes from distributing \\(-3\\) as \\(-3x-12\\), which flips the sign of the 4.',
      '<strong>Why D is wrong</strong> 20 comes from distributing \\(-3\\) as \\(-3x-12\\): \\(4x+10-3x-12=18\\) gives \\(x-2=18\\). The minus sign applies to both terms, so \\(-3(x-4)=-3x+12\\).'],
  ],

  // 45 - 2(3) = 39 forgets the square; squaring after doubling gives 45 - 36.
  ai_m086: [
    ['explanation_html',
      'This computes \\(45-2(3)=39\\), squaring after doubling instead of before. The exponent applies to \\(t\\) alone.',
      'This computes \\(45-2(3)=39\\), forgetting the square altogether. The exponent applies to \\(t\\) before the coefficient multiplies.'],
  ],

  // A was 196; adding the discounts back onto 126 gives 180.18. Dividing by 0.9
  // alone gives 140, which is the discount the question is built to hide.
  ai_m090: [
    ['choice', 'A', '196', '140'],
    ['explanation_html',
      '<strong>Why A is wrong</strong> 196 adds 30% and then 10% back onto 126, which uses the wrong base for each step.',
      "<strong>Why A is wrong</strong> 140 is \\(\\dfrac{126}{0.9}\\), which removes only the member's 10% and leaves the 30% markdown in."],
  ],

  // 1,890 is 52.5% of 3,600 - the average of the two percentages - not
  // "105% of nothing meaningful applied to half the register".
  ai_m094: [
    ['explanation_html',
      '<strong>Why A is wrong</strong> 1,890 adds the two percentages, \\(105\\%\\) of nothing meaningful, and applies the result to half the register.',
      '<strong>Why A is wrong</strong> 1,890 is \\(52.5\\%\\) of 3,600, the average of the two percentages applied once to the whole register. The two act in sequence on different bases.'],
  ],

  // --- 3. RW: stale bare-letter cross-references ---------------------------

  ai_rw001: [
    ['explanation_html', 'It also imports an judgement', 'It also imports a judgement'],
  ],
  ai_rw004: [
    ['explanation_html', 'A names districts that crossed that threshold in 1999',
      'Choice D names districts that crossed that threshold in 1999'],
  ],
  ai_rw006: [
    ["explanation_html", "B supplies what that observation needs",
      "Choice B supplies what that observation needs"],
  ],
  ai_rw007: [
    ['explanation_html', 'D contains &ldquo;grief&rdquo; and even defines it',
      'Choice A contains &ldquo;grief&rdquo; and even defines it'],
    ['explanation_html', 'A depicts the daughter crying', 'Choice B depicts the daughter crying'],
    ['explanation_html', 'C describes objects, but no feeling is being carried by them.',
      'Choice D describes objects, but no feeling is being carried by them.'],
  ],
  ai_rw011: [
    ['explanation_html', 'D mentions the genetic modeling without saying what it found',
      'Choice A mentions the genetic modeling without saying what it found'],
    ['explanation_html', 'B uses both, and it concedes the low count',
      'Choice C uses both, and it concedes the low count'],
  ],
  ai_rw012: [
    ['explanation_html', 'C gives only the display convention and D only a fact about the making.',
      'Choice A gives only the display convention and choice B only a fact about the making.'],
    ['explanation_html', 'B gives the making, a bead sealed inside',
      'Choice D gives the making, a bead sealed inside'],
  ],
  // These four name the right letter already; they are bare, which is the state
  // that goes stale on the next rotation. audit_ai.cjs now refuses them.
  ai_rw013: [
    ['explanation_html', 'B is a summary of what happened',
      'Choice B is a summary of what happened'],
    ['explanation_html', 'D makes the canopy the reason',
      'Choice D makes the canopy the reason'],
  ],
  ai_rw074: [
    ['explanation_html', 'D would predict lower bottom concentrations',
      'Choice D would predict lower bottom concentrations'],
  ],
  ai_rw085: [
    ['explanation_html', 'first clause of B make', 'first clause of choice B make'],
  ],
  ai_rw015: [
    ['explanation_html', 'C reads acceptably aloud', 'Choice D reads acceptably aloud'],
  ],
  ai_rw030: [
    ['explanation_html', 'B is true of the numbers and supports a general superiority',
      'Choice C is true of the numbers and supports a general superiority'],
    ['explanation_html', 'C is accurate and about the wrong coating.',
      'Choice D is accurate and about the wrong coating.'],
    ['explanation_html', 'A gives the edge contrast, 8% against 28 to 32',
      'Choice B gives the edge contrast, 8% against 28 to 32'],
  ],
  ai_rw031: [
    ['explanation_html', 'so D strengthens the ornament reading',
      'so choice A strengthens the ornament reading'],
    ['explanation_html', 'A repeats her observation at another site.',
      'Choice B repeats her observation at another site.'],
    ['explanation_html', 'B shows that known counting devices have exactly those two properties',
      'Choice C shows that known counting devices have exactly those two properties'],
  ],
  ai_rw032: [
    ['explanation_html', 'D says grief and accounting in one breath',
      'Choice C says grief and accounting in one breath'],
    ['explanation_html', "not avoiding.</em> B is the critic", "not avoiding.</em> Choice A is the critic"],
    ['explanation_html', 'C remembers the uncle', 'Choice B remembers the uncle'],
  ],
  ai_rw034: [
    ['explanation_html', 'D omits the comma before a nonrestrictive',
      'Choice A omits the comma before a nonrestrictive'],
  ],
  ai_rw036: [
    ['explanation_html', 'D restates what duplication means',
      'Choice C restates what duplication means'],
    ['explanation_html', "C is the vault's one dramatic episode",
      "Choice B is the vault's one dramatic episode"],
    ['explanation_html', 'B tells a newcomer what the vault does not have.',
      'Choice A tells a newcomer what the vault does not have.'],
  ],
  ai_rw037: [
    ['explanation_html', 'C describes rejection and rediscovery',
      'Choice B describes rejection and rediscovery'],
  ],
  ai_rw039: [
    ['explanation_html', 'D leaves the participial phrase attached to a placeholder.',
      'Choice A leaves the participial phrase attached to a placeholder.'],
  ],
  ai_rw048: [
    ['explanation_html', 'C blames servers', 'Choice B blames servers'],
    ['explanation_html', 'D says diners did not know about the law',
      'Choice C says diners did not know about the law'],
  ],
  ai_rw064: [
    ['explanation_html', 'C confirms trade in the twelfth century',
      'Choice B confirms trade in the twelfth century'],
    ['explanation_html', 'D makes cold decades more common',
      'Choice C makes cold decades more common'],
    ['explanation_html', 'A shows contemporaneous local cod carrying the southern signature',
      'Choice D shows contemporaneous local cod carrying the southern signature'],
  ],
  ai_rw065: [
    ['explanation_html', "A reports it accurately and argues for the conclusion's opposite.",
      "Choice D reports it accurately and argues for the conclusion's opposite."],
    ['explanation_html', 'C is true and would support', 'Choice B is true and would support'],
  ],
  ai_rw066: [
    ['explanation_html', 'D says outright that nobody interrupts',
      'Choice A says outright that nobody interrupts'],
    ['explanation_html', 'B explains why she writes to this friend',
      'Choice C explains why she writes to this friend'],
  ],
  ai_rw067: [
    // The stem says the new buildings advertised rents 8 percent below the
    // average, so the pre-existing gap the explanation calls "the same size"
    // has to be 8, not 9.
    ['choice', 'C',
      'Buildings permitted after the reform were concentrated in neighborhoods where rents were already 9 percent below the metropolitan average before the reform.',
      'Buildings permitted after the reform were concentrated in neighborhoods where rents were already 8 percent below the metropolitan average before the reform.'],
    ['explanation_html', 'D says parking is expensive', 'Choice B says parking is expensive'],
    ['explanation_html', 'B notes that some developers built extra parking anyway',
      'Choice D notes that some developers built extra parking anyway'],
    ['explanation_html', 'A supplies a pre-existing difference of the same size',
      'Choice C supplies a pre-existing difference of the same size'],
  ],
  ai_rw071: [
    ['explanation_html', 'D states the outcome and never says why',
      'Choice A states the outcome and never says why'],
    ['explanation_html', 'C names the ash and the modern service life',
      'Choice D names the ash and the modern service life'],
  ],
  ai_rw072: [
    ['explanation_html', "C's 4.5 billion against 100 million",
      "Choice B's 4.5 billion against 100 million"],
    ['explanation_html', 'D turns the limitation into the reason for the mission',
      'Choice C turns the limitation into the reason for the mission'],
  ],
  ai_rw160: [
    ['explanation_html', 'The concession in D undoes it.',
      'The concession in choice C undoes it.'],
  ],
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
        touched = true;
      }
    }
    if (touched) fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const missing = Object.keys(FIXES).filter(id => !seen.has(id));
  if (missing.length) throw new Error('rows not found: ' + missing.join(', '));
  console.log(`${seen.size} rows repaired, ${edits} edits`);
}

run();
