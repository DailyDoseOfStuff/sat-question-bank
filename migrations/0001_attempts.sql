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
