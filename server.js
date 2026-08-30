// Tiny local proxy: serves official College Board SAT questions from local JSON
// No Cloudflare D1 credentials needed — works completely offline.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');

let QUESTIONS = [];
let PROGRESS = {};

function loadQuestions() {
  try {
    const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
    QUESTIONS = JSON.parse(data);
    console.log(`Loaded ${QUESTIONS.length} official College Board questions`);
  } catch (e) {
    console.error('Failed to load questions:', e.message);
    QUESTIONS = [];
  }
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const rows = JSON.parse(data);
      PROGRESS = {};
      rows.forEach(r => PROGRESS[r.question_id] = r);
    }
  } catch (e) {
    console.error('Failed to load progress:', e.message);
    PROGRESS = {};
  }
}

function saveProgress() {
  try {
    const rows = Object.values(PROGRESS);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error('Failed to save progress:', e.message);
  }
}

loadQuestions();
loadProgress();

const PORT = 3001;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/questions' && req.method === 'GET') {
      const rows = QUESTIONS.map(q => ({
        ...q,
        choices: JSON.parse(q.choices_json || '[]'),
        answer: (JSON.parse(q.correct_answer || '[]') || []).join(', ')
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.url === '/api/progress' && req.method === 'GET') {
      const rows = Object.values(PROGRESS);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.url === '/api/progress' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = JSON.parse(body);
      const existing = PROGRESS[p.question_id] || { question_id: p.question_id, attempts: 0, corrects: 0, marker: 'Red', last_reviewed: new Date().toISOString().slice(0,10) };
      existing.attempts = p.attempts;
      existing.corrects = p.corrects;
      existing.marker = p.marker;
      existing.last_reviewed = p.last_reviewed;
      existing.time_taken_ms = p.time_taken_ms;
      existing.stars = p.stars;
      PROGRESS[p.question_id] = existing;
      saveProgress();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    // static files (public/ only)
    const publicDir = path.join(__dirname, 'public');
    let file = path.join(publicDir, req.url === '/' ? '/index.html' : req.url);
    if (!file.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file)) {
      file = path.join(publicDir, 'index.html');
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

server.listen(PORT, () => console.log(`SAT question bank running at http://localhost:${PORT} (${QUESTIONS.length} official College Board questions from PDF)`));