-- pt10_math_m2_q16 printed all four answer choices inside its own stem, separated
-- by " / ", so the question gave itself away above the choice list. The choices
-- are already in choices_json; the stem only needs the question.
UPDATE questions
SET stem_html = '<p>Which equation represents a circle that intersects the y-axis at exactly one point?</p>'
WHERE id = 'pt10_math_m2_q16';
