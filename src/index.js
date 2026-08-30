// SAT Question Bank — Cloudflare Worker
// Serves static assets + /api/questions + /api/progress + /api/chat (Gemini proxy).
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;

    if (p === '/api/questions' && req.method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM questions').all();
      return json(r.results || []);
    }

    if (p === '/api/progress' && req.method === 'GET') {
      const uid = req.headers.get('X-User-Id');
      const r = await env.DB.prepare('SELECT * FROM progress WHERE user_id = ?').bind(uid || '').all();
      return json(r.results || []);
    }

    if (p === '/api/progress' && req.method === 'POST') {
      const b = await req.json();
      const uid = req.headers.get('X-User-Id') || b.user_id || '';
      if (!uid) return json({ error: 'missing user' }, 401);
      await env.DB.prepare(
        `INSERT INTO progress VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
           last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
           stars=MAX(progress.stars, excluded.stars)`
      ).bind(uid, b.question_id, b.attempts || 0, b.corrects || 0, b.marker || 'Red',
             b.last_reviewed, b.time_taken_ms || 0, b.stars || 0).run();
      return json({ ok: true });
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

    if (p === '/auth/callback') {
      return new Response(`<html><head><script>
        const h = new URLSearchParams(location.hash.slice(1));
        const a = h.get('access_token'), r = h.get('refresh_token');
        if (a) localStorage.setItem('sb_token', JSON.stringify({access_token:a,refresh_token:r}));
        location.href='/';
      </script></head><body></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    return env.ASSETS.fetch(req);
  }
};
