# SAT Question Bank

A Bluebook-style SAT practice app over 3,843 questions extracted from the
official College Board Educator Question Bank PDFs, plus a handful of personal
Bluebook practice-test mistakes. Runs as a single Cloudflare Worker: the
questions live in D1, the UI is one static HTML file.

Live: https://sat-question-bank.liuallen1209.workers.dev

## Features

- **Practice sets** filtered by section, domain, difficulty and source
- **Bluebook-style player** — two panes for questions with a passage, figure or
  table; one full-width column for bare questions; choice elimination; flag for
  review; per-question timer; question map
- **Desmos** graphing and scientific calculators, docked left, on Math questions
- **Math as text** — 1,156 questions carry their notation as LaTeX rendered with
  KaTeX rather than as a cropped image, so it selects, scales and reflows. The
  rest keep a crop, displayed at the source's own proportions
- **Dashboard** — accuracy by section, domain and skill
- **Browse** — search every question by domain, skill or id and preview it
- **AI explanations** via a Gemini proxy on the Worker
- **Accounts** through Supabase — Google or email and password. Every answer,
  marker and star is written to D1 under the account, so progress follows you to
  any device. Practice signed out and it is kept locally, then merged into the
  account the first time you sign in

## Running it

```bash
npm install
npm run dev      # wrangler dev on http://localhost:8787
```

`wrangler dev` serves `public/` and reads the local D1 replica under
`.wrangler/`. Deploy with `npm run deploy`.

## Layout

```
public/index.html   the whole app: markup, styles, logic
public/qimg/        figure and notation crops (untracked, ~44M, 5,528 files)
src/index.js        Worker: /api/questions, /api/progress, /api/chat, assets
schema.sql          questions, progress, users
wrangler.toml       Worker name, D1 binding, asset directory
tools/              PDF extractor and its glyph-decoding support
tools/d1_dump.cjs   dumps the local D1 questions table as chunked INSERTs
```

`CLAUDE.md` carries the working notes: how the extractor decodes math from
vector paths, why the raster pages could not be decoded, and the recipe for
rebuilding the remote D1 from the local one.

## Schema

`users` — `id` (the Supabase user id), `email`, `name`, `created_at`. A row is
written the first time an account touches the API.

`progress` — `user_id`, `question_id`, `attempts`, `corrects`, `marker`,
`last_reviewed`, `time_taken_ms`, `stars`, keyed on the first two.

`questions` — `id`, `external_id`, `section`, `domain`, `difficulty`, `skill`,
`stem_html`, `choices_json`, `correct_answer`, `explanation_html`, `source`,
`source_page`, `has_figure`, `stem_text`.

A question with no entries in `choices_json` is a grid-in; the client derives
that rather than storing a type column.

## License

Questions © College Board. This app is for personal study use only.
