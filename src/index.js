// SAT Question Bank — Cloudflare Worker
// Serves static assets + /api/questions + /api/progress + /api/chat (Gemini proxy).
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
      const b = await req.json();
      const rows = Array.isArray(b) ? b : [b];
      const stmt = env.DB.prepare(
        `INSERT INTO progress VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
           last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
           stars=MAX(progress.stars, excluded.stars)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, r.question_id, r.attempts || 0, r.corrects || 0, r.marker || 'Red',
        r.last_reviewed, r.time_taken_ms || 0, r.stars || 0)));
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
      const b = await req.json();
      const rows = (Array.isArray(b) ? b : [b]).filter(r => r && r.question_id && r.ts);
      if (!rows.length) return json({ ok: true, saved: 0 });
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO attempts (user_id, question_id, ts, correct, time_taken_ms)
         VALUES (?,?,?,?,?)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, r.question_id, r.ts, r.correct ? 1 : 0, r.time_taken_ms || 0)));
      return json({ ok: true, saved: rows.length });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      try {
        const { messages } = await req.json();
        const r = await fetch(`${env.GEMINI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: env.GEMINI_MODEL, messages, temperature: 0.4 })
        });
        const data = await r.json().catch(() => ({}));
        const text = data?.choices?.[0]?.message?.content;
        return json(text ? { reply: text } : { error: data?.error?.message || `upstream ${r.status}` }, r.ok ? 200 : r.status);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500);
      }
    }

    // OAuth and the email-confirmation link both land here with the session in the
    // URL fragment. Serving the app itself lets supabase-js parse and persist it
    // under its own storage key; the previous hand-rolled page stashed the token
    // under "sb_token", which supabase-js never reads, so the session was dropped.
    if (p === '/auth/callback') {
      return env.ASSETS.fetch(new Request(new URL('/', req.url), req));
    }

    return env.ASSETS.fetch(req);
  }
};
