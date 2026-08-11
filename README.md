# SAT question bank

Combines the two Cowork artifacts ("Sat Bank D1" drill/trainer + "Sat Mistake
Bank" browsable table) into one local webapp. Pulls live from the same
Cloudflare D1 database (`sat_question_bank`), so new questions you add later
show up on refresh — no re-export needed.

## Why a server

A plain HTML file opened by double-click has no way to reach D1 without
exposing a Cloudflare API token in plain text. `server.js` holds the token
server-side (in `.env`, not in the browser) and proxies three endpoints:
`GET /api/questions`, `GET /api/progress`, `POST /api/progress`.

## Setup

1. Get a Cloudflare API token scoped to D1 (Cloudflare dashboard → My
   Profile → API Tokens → Create Token → permission `Account.D1: Edit`,
   scoped to the account that owns `sat_question_bank`). Note your
   **Account ID** too (dashboard sidebar, or Workers & Pages → Overview).
2. Open `.env` in this folder and fill in:
   ```
   CF_ACCOUNT_ID=...
   CF_API_TOKEN=...
   ```
   (`CF_DATABASE_ID` is already set to the right database.)
3. `node server.js` (or `npm start`) — needs Node 18+.
4. Open http://localhost:8787 in a browser.

## Notes

- Progress (attempts/correct/marker) writes back to the D1 `progress` table
  on every check, same as the original Sat Bank D1 artifact.
- Click "Refresh" on the home screen to pull newly-added questions without
  restarting the server.
- `data.js`, `questions.json`, `progress.json` are a one-time static export
  from an earlier draft of this app and aren't used by `server.js` — safe to
  delete.
