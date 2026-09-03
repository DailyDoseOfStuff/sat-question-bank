-- Skill names that were never a skill.
--
-- Two of these are the PDF's own page header pasted into the column: the
-- extractor's metadata banner reader ran past the label and swallowed the
-- whole "Assessment Test Domain Skill Difficulty ..." strip, spurious spaces
-- and all. They rendered as their own entries in the topic list, so 151
-- questions sat under an unpickable heading instead of under their skill.
-- The real skill is the tail of the string in both cases.
UPDATE questions SET skill = 'Text Structure and Purpose'
WHERE skill = 'Assessment T est Domain Skill Difficulty SA T Reading and Writing Cr aft and Structure T ext Structure and Purpose';
UPDATE questions SET skill = 'Cross-Text Connections'
WHERE skill = 'Assessment T est Domain Skill Difficulty SA T Reading and Writing Cr aft and Structure Cross-text Connections';

-- The same narrow-space artifact ("ar tifacts") that the extractor handles in
-- the body text, left in two skill names.
UPDATE questions SET skill = 'Two-variable data: Models and scatterplots'
WHERE skill = 'T wo-variable data: Models and scatterplots';
UPDATE questions SET skill = 'Ratios, rates, proportional relationships, and units'
WHERE skill = 'Ratios, rates, proportional relationships and units';

-- Bluebook rows spell three skills with "&" where the College Board rows spell
-- them out, which split each one into two topics in the list.
UPDATE questions SET skill = 'Form, Structure, and Sense' WHERE skill = 'Form Structure & Sense';
UPDATE questions SET skill = 'Text Structure and Purpose' WHERE skill = 'Text Structure & Purpose';
UPDATE questions SET skill = 'Central Ideas and Details' WHERE skill = 'Central Ideas & Details';
