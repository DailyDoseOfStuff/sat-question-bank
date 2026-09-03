# SAT Question Bank

A Bluebook-style SAT practice app over 3,843 questions extracted from the
official College Board Educator Question Bank PDFs, plus a handful of personal
Bluebook practice-test mistakes. Runs as a single Cloudflare Worker: the
questions live in D1, the UI is one static HTML file.

Live: https://helpmeaceit.page

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
- **Copy for AI** — copies the question, choices, answer, your answer and the
  official explanation as a plain-text prompt to paste into any AI assistant
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
src/index.js        Worker: /api/questions, /api/progress, /api/attempts, assets
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

## Custom domain

`wrangler.toml` claims `helpmeaceit.page` and `www.helpmeaceit.page` as custom
domains. A deploy only succeeds once the domain is a zone on the same Cloudflare
account:

1. Cloudflare dashboard -> Add a site -> `helpmeaceit.page`.
2. Cloudflare gives you two nameservers. Set them at the registrar the domain was
   bought from, replacing whatever is there.
3. Wait for the zone to read **Active** (minutes to a day, depending on the registrar).
4. `wrangler deploy`. Cloudflare creates both DNS records itself; do not add an
   A/CNAME record by hand, a custom-domain route owns it.

Done, as of 2026-09-02. `www` 301s to the apex, because Supabase returns an OAuth
or confirmation link to one allowlisted origin and a session started on one host
and finished on the other is a session dropped. Assets are served before the
Worker runs, so that check would never have seen `/`: `run_worker_first = ["/"]`
in `[assets]` routes just the page through the Worker.

The `*.workers.dev` URL is gone — `workers_dev` is not set in `wrangler.toml`, so
the first deploy with custom domains disabled it. That is deliberate: one origin
is the whole point of the redirect above. Add `workers_dev = true` to bring it back.

Security headers live in **two** places and must agree: `public/_headers` covers
static assets (a request that matches one never reaches the Worker) and the `CSP`
constant in `src/index.js` covers the JSON API and `/auth/callback`.
