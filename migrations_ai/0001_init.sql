-- The AI-authored bank, in its own D1 database. Same column names as the main
-- bank's `questions` so the Worker's SELECT is the same string twice and the client
-- needs no second row shape. `level` is the rank the focus ladder climbs: 4 and 5
-- here, while official Easy/Medium/Hard are derived as 1/2/3 in the client.
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
  stem_text TEXT DEFAULT '',
  level INTEGER DEFAULT 4
);
