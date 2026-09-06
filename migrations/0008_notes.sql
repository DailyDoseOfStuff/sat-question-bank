-- Per-question notes: why you missed it, in your own words.
CREATE TABLE IF NOT EXISTS notes (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (user_id, question_id)
);
