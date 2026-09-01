// SAT Question Bank — Cloudflare Worker
// Serves static assets + /api/questions + /api/progress + /api/chat (Gemini proxy).

// Everything the page loads is either same-origin or one of the two CDNs in
// index.html's <head>. The question HTML comes out of the database and goes
// straight into innerHTML, so if a stray <script> ever rides along with it,
// connect-src is what stops it from posting a session token anywhere. The inline
// allowances are the app's own <script> block and its style="" attributes.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "connect-src 'self' https://lbwxzcdmhyhgtscthnaq.supabase.co",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ');

const harden = (h) => {
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  return h;
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: harden(new Headers({ 'Content-Type': 'application/json' }))
  });

// ASSETS.fetch hands back an immutable Response, so the headers go on a copy.
const asset = async (env, req) => {
  const r = await env.ASSETS.fetch(req);
  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: harden(new Headers(r.headers))
  });
};

// Resolve the caller from their Supabase access token. The old code trusted an
// X-User-Id header, which let any client read or overwrite any account's progress.
// Asking Supabase to validate the token costs one fetch and no crypto here, and it
// works for both the Google and the email/password sign-ins.
async function whoami(req, env) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${t}`, apikey: env.SUPABASE_ANON_KEY }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

// Every account that signs in gets a row, so progress has an owner to hang off and
// the account survives a Supabase-side name or email change.
async function touchUser(env, u) {
  const name = u.user_metadata?.full_name || u.user_metadata?.name || '';
  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?,?,?)
     ON CONFLICT(id) DO UPDATE SET email=excluded.email,
       name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE users.name END`
  ).bind(u.id, u.email || '', name).run();
}

// A save is one sitting's worth of answers, never thousands. Without a ceiling a
// signed-in account can post an array of any length and have the Worker write all
// of it, which is a cheap way to fill someone else's database.
const MAX_ROWS = 500;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// The instructions belong to the Worker, not to whoever calls it — see /api/chat.
const TUTOR_PROMPT =
  'You are an SAT tutor. Guide the student to understand — never just hand over ' +
  'the answer unless they explicitly ask for it or have already attempted it. ' +
  'Be concise. Only discuss the SAT and the question at hand.';

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;

    if (p === '/api/questions' && req.method === 'GET') {
      // Not SELECT *: stem_text is a legacy OCR column nothing renders, and it
      // is 15% of a payload the client downloads whole.
      const r = await env.DB.prepare(
        'SELECT id, external_id, section, domain, difficulty, skill, stem_html,' +
        ' choices_json, correct_answer, explanation_html, source, source_page,' +
        ' has_figure FROM questions').all();
      return json(r.results || []);
    }

    if (p === '/api/account' && req.method === 'GET') {
      const u = await whoami(req, env);
      if (!u) return json({ error: 'unauthorized' }, 401);
      await touchUser(env, u);
      const r = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first();
      return json(r || {});
    }

    if (p === '/api/progress' && req.method === 'GET') {
      const u = await whoami(req, env);
      if (!u) return json([]);
      await touchUser(env, u);
      const r = await env.DB.prepare('SELECT * FROM progress WHERE user_id = ?').bind(u.id).all();
      return json(r.results || []);
    }

    if (p === '/api/progress' && req.method === 'POST') {
      const u = await whoami(req, env);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => null);
      const rows = (Array.isArray(b) ? b : [b])
        .filter(r => r && typeof r.question_id === 'string' && r.question_id)
        .slice(0, MAX_ROWS);
      if (!rows.length) return json({ ok: true, saved: 0 });
      const stmt = env.DB.prepare(
        `INSERT INTO progress VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
           last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
           stars=MAX(progress.stars, excluded.stars)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), r.attempts | 0, r.corrects | 0,
        str(r.marker, 16) || 'Red', str(r.last_reviewed, 32) || null,
        r.time_taken_ms | 0, r.stars | 0)));
      return json({ ok: true, saved: rows.length });
    }

    // The attempt log. `progress` is overwritten on every answer, so it cannot say
    // how many questions were done on a given day; these rows can. Append-only:
    // a repeat of the same (question, timestamp) is ignored rather than updated.
    if (p === '/api/attempts' && req.method === 'GET') {
      const u = await whoami(req, env);
      if (!u) return json([]);
      const r = await env.DB.prepare(
        'SELECT question_id, ts, correct, time_taken_ms FROM attempts WHERE user_id = ? ORDER BY ts'
      ).bind(u.id).all();
      return json(r.results || []);
    }

    if (p === '/api/attempts' && req.method === 'POST') {
      const u = await whoami(req, env);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => null);
      const rows = (Array.isArray(b) ? b : [b])
        .filter(r => r && typeof r.question_id === 'string' && r.question_id
                       && typeof r.ts === 'string' && r.ts)
        .slice(0, MAX_ROWS);
      if (!rows.length) return json({ ok: true, saved: 0 });
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO attempts (user_id, question_id, ts, correct, time_taken_ms)
         VALUES (?,?,?,?,?)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), str(r.ts, 32), r.correct ? 1 : 0, r.time_taken_ms | 0)));
      return json({ ok: true, saved: rows.length });
    }

    // Every call here spends the owner's Gemini quota, so it is not a public
    // endpoint. It used to be: no sign-in, and the client sent the whole `messages`
    // array — system prompt included — which made it a free, steerable LLM for
    // anyone who found the URL. Now the caller must be signed in, only their own
    // turns are accepted, the instructions are written here, and the rate limiter
    // caps what a single account can spend.
    if (p === '/api/chat' && req.method === 'POST') {
      const u = await whoami(req, env);
      if (!u) return json({ error: 'Sign in to ask the tutor.' }, 401);
      if (env.CHAT_RL && !(await env.CHAT_RL.limit({ key: u.id })).success)
        return json({ error: 'Too many questions in a row — give it a minute.' }, 429);
      if (Number(req.headers.get('Content-Length')) > 64 * 1024)
        return json({ error: 'message too long' }, 413);

      const b = await req.json().catch(() => null);
      const turns = (Array.isArray(b?.messages) ? b.messages : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!turns.length) return json({ error: 'no message' }, 400);

      // The question the student is on is context, not instruction: it arrives as
      // plain text and is pasted into a system line the Worker owns.
      const ctx = str(b?.context, 4000);
      const messages = [{ role: 'system', content: TUTOR_PROMPT }]
        .concat(ctx ? [{ role: 'system', content: 'The student is working on this question.\n' + ctx }] : [])
        .concat(turns);

      try {
        const r = await fetch(`${env.GEMINI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: env.GEMINI_MODEL, messages, temperature: 0.4 })
        });
        const data = await r.json().catch(() => ({}));
        const text = data?.choices?.[0]?.message?.content;
        if (text) return json({ reply: text });
        // An upstream message can name the key, the project or the quota, so it
        // goes to the log rather than back to the browser.
        console.log('chat upstream', r.status, data?.error?.message || '');
        return json({ error: 'The tutor is unavailable right now.' }, 502);
      } catch (e) {
        console.log('chat error', e?.message || String(e));
        return json({ error: 'The tutor is unavailable right now.' }, 502);
      }
    }

    // OAuth and the email-confirmation link both land here with the session in the
    // URL fragment. Serving the app itself lets supabase-js parse and persist it
    // under its own storage key; the previous hand-rolled page stashed the token
    // under "sb_token", which supabase-js never reads, so the session was dropped.
    if (p === '/auth/callback') {
      return asset(env, new Request(new URL('/', req.url), req));
    }

    return asset(env, req);
  }
};
