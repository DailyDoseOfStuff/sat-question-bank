CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  section TEXT,
  domain TEXT,
  difficulty TEXT,
  skill TEXT,
  stem_html TEXT,
  choices_json TEXT,
  correct_answer TEXT,
  explanation_html TEXT,
  source TEXT,
  source_page INTEGER,
  has_figure INTEGER DEFAULT 0,
  stem_text TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  corrects INTEGER DEFAULT 0,
  marker TEXT DEFAULT 'Red',
  last_reviewed TEXT,
  time_taken_ms INTEGER,
  stars INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
-- One row per answer. `progress` keeps only the latest state of a question, so a
-- re-drill overwrote the date it was last seen and any per-day history with it.
-- This is the history: it is append-only and nothing rewrites a past row.
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  time_taken_ms INTEGER DEFAULT 0,
  UNIQUE (user_id, question_id, ts)
);
CREATE INDEX IF NOT EXISTS attempts_user_ts ON attempts (user_id, ts);
