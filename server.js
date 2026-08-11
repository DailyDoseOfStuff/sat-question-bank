// Tiny local proxy: holds the Cloudflare D1 credentials server-side (.env)
// so the browser never sees them. Serves public/index.html and answers
// /api/questions, /api/progress (GET) and /api/progress (POST, upsert).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const PORT = process.env.PORT || 8787;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const DB_ID = process.env.CF_DATABASE_ID || 'bb6bfa7f-2687-4e52-94e7-eedccd1fa05b';

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

async function d1(sql, params) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params ? { sql, params } : { sql })
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors || j));
  return j.result?.[0]?.results || [];
}

const QUESTIONS_SQL = `SELECT id,label,section,domain,skill,difficulty,qtype,render_mode,stem_html,choices_json,correct_answer,correct_key,rationale_html,external_id,source,content_quality,your_answer,why_missed,rule,notion_id FROM questions`;
const PROGRESS_SQL = `SELECT question_id,attempts,corrects,marker,last_reviewed FROM progress`;
const MIME = { '.html': 'text/html' }; // public/ only ever serves index.html

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/questions' && req.method === 'GET') {
      const rows = await d1(QUESTIONS_SQL);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.url === '/api/progress' && req.method === 'GET') {
      const rows = await d1(PROGRESS_SQL);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.url === '/api/progress' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = JSON.parse(body);
      await d1(
        `INSERT INTO progress(question_id,attempts,corrects,marker,last_reviewed) VALUES(?,?,?,?,?)
         ON CONFLICT(question_id) DO UPDATE SET attempts=excluded.attempts,corrects=excluded.corrects,marker=excluded.marker,last_reviewed=excluded.last_reviewed`,
        [p.question_id, p.attempts, p.corrects, p.marker, p.last_reviewed]
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    // static files (public/ only)
    const publicDir = path.join(__dirname, 'public');
    let file = path.join(publicDir, req.url === '/' ? '/index.html' : req.url);
    if (!file.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

server.listen(PORT, () => console.log(`SAT question bank running at http://localhost:${PORT}`));
