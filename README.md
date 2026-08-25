# SAT Question Bank

A complete SAT practice application built with the exact College Board Educator Question Bank format, plus your personal Bluebook practice test mistakes.

**Source:** Questions extracted from official College Board PDFs + 17 Bluebook PT5 mistakes from Notion export.

## Features

- **3787 Official Questions** from College Board Educator Question Bank (1925 Math, 1845 Reading & Writing)
- **17 Bluebook Mistakes** from Practice Test 5 with full rationale and mistake tags
- **Speedrun Mode** — countdown timer per question (120s for R&W, 70s for Math), earn 3 stars per question based on speed
- **Per-Question Timer Reset** — clock resets and counts up (or down in speedrun) for every question
- **Dashboard** — overall accuracy, section breakdowns, history table with times and stars
- **Bluebook-style UI** — split pane for passages, choice elimination buttons, dark/light mode support
- **Browse** — sortable/filterable Grid.js table over all questions

## Quick Start

```bash
cd sat-question-bank
npm install          # only needed first time
./start_server.bat   # or: node server.js
# Open http://localhost:3001
```

## Project Structure

```
sat-question-bank/
├── public/
│   └── index.html       # Single-page app (drill, browse, dashboard)
├── src/
│   └── index.js         # Cloudflare Workers entry (optional, for deployment)
├── server.js            # Local Node server (port 3001, serves questions.json)
├── questions.json       # 3787 questions (3770 CollegeBoard + 17 Bluebook mistakes)
├── progress.json        # Local progress storage (auto-created)
├── package.json
├── start_server.bat     # Windows launcher
└── wrangler.toml        # Cloudflare deployment config (optional)
```

## Data Schema (questions.json)

Each question contains:
- `id` — unique identifier
- `label` — `"new_2026"` (CollegeBoard) or `"mistake"` (Bluebook)
- `section` — `"Math"` or `"Reading & Writing"`
- `domain` — e.g., `"Algebra"`, `"Information and Ideas"`
- `skill` — specific skill within domain
- `difficulty` — `"Easy"`, `"Medium"`, `"Hard"`
- `stem_html` — full question/passage HTML
- `choices_json` — answer choices
- `correct_answer` — correct letter(s)
- `rationale_html` — explanation HTML
- `source` — `"CollegeBoard"` or `"Bluebook"`
- `your_answer`, `why_missed`, `rule` — mistake metadata (Bluebook only)

## Speedrun Star System

| Time | Stars |
|------|-------|
| Under 50% of limit | 3 stars |
| Under 100% of limit | 2 stars |
| Over limit (time up) | 0 stars (auto-submit) |

## License

Questions © College Board. This app is for personal study use only.
