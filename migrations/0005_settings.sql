CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT
);
