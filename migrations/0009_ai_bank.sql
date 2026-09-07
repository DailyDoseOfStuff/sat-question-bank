-- Which choice was taken, and how many times the student switched before Check.
-- `picked` is the letter for a multiple-choice question and the typed entry for a
-- grid-in. Pacing needs no column: it is time_taken_ms against a section target.
ALTER TABLE attempts ADD COLUMN picked TEXT;
ALTER TABLE attempts ADD COLUMN changes INTEGER DEFAULT 0;

-- The AI bank's question rows live in a second database and D1 cannot join across
-- one. Without this registry the `WHERE EXISTS (SELECT 1 FROM questions ...)` guard
-- on progress/attempts/notes refuses every AI id and the answer is dropped in
-- silence. One column, written by tools/apply_ai.cjs, so the bound stays exact.
CREATE TABLE IF NOT EXISTS ai_ids (id TEXT PRIMARY KEY);
