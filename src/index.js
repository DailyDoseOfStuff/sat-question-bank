// SAT Question Bank — Cloudflare Worker
// Serves static assets + /api/questions + /api/progress + /api/attempts.

// Everything the page loads is either same-origin or one of the two CDNs in
// index.html's <head>. The question HTML comes out of the database and goes
// straight into innerHTML, so if a stray <script> ever rides along with it,
// connect-src is what stops it from posting a session token anywhere. The inline
// allowances are the app's own <script> block and its style="" attributes.
const CSP = [
  "default-src 'self'",
  // static.cloudflareinsights.com is the Web Analytics beacon, which Cloudflare
  // injects into the HTML itself, so it cannot be dropped from the page — leave it
  // out and the only effect is a console error and no analytics. Its own POST goes
  // to /cdn-cgi/rum on this origin, which 'self' already covers.
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "connect-src 'self' https://lbwxzcdmhyhgtscthnaq.supabase.co",
  // The SAT-locked Desmos calculators are iframed in. frame-src falls back to
  // default-src, so 'self' alone silently blanks the calculator panel.
  "frame-src https://www.desmos.com",
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
  // Only honoured over HTTPS, so wrangler dev on http://localhost ignores it.
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
// Cheap pre-filter, not a verification: is this even shaped like a live JWT? The
// signature still has to be checked by Supabase, but without this any stranger can
// put a line of noise in Authorization and make the Worker spend a call on
// Supabase's auth endpoint - which is the account's shared rate limit, so a curl
// loop from one machine is an auth outage for everyone. Garbage now costs the
// attacker a request and this Worker nothing.
function looksLive(t) {
  const seg = t.split('.');
  if (seg.length !== 3) return false;
  try {
    const c = JSON.parse(atob(seg[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof c.exp === 'number' && c.exp * 1000 > Date.now();
  } catch (e) { return false; }
}

async function whoami(req, env) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t || !looksLive(t)) return null;
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
// Per-request row caps are not a storage bound on their own: nothing stops an
// account from posting the same 500 rows again a thousand times. `progress` is
// bounded by its own primary key once question_id has to name a real question,
// but `attempts` is append-only and keyed on a client-supplied timestamp, so it
// needs a ceiling of its own. 100k is ~55 years at 5 questions a day.
const MAX_ATTEMPTS = 100000;
// The settings blob was truncated to 8000 chars, which cuts JSON mid-string and
// stores something that will never parse again - the read side then silently
// hands back {} and the account's preferences are gone. Refuse it instead.
const MAX_SETTINGS = 8000;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // One canonical host. Supabase only redirects an OAuth or confirmation link
    // back to an origin on its allowlist, so a session started on www and
    // finished on the apex (or the reverse) is a session dropped on the floor.
    if (url.hostname === 'www.helpmeaceit.page') {
      url.hostname = 'helpmeaceit.page';
      return new Response(null, { status: 301, headers: harden(new Headers({ Location: url.toString() })) });
    }

    if (p === '/api/questions' && req.method === 'GET') {
      // Not SELECT *: stem_text is a legacy OCR column nothing renders, and it
      // is 15% of a payload the client downloads whole.
      const r = await env.DB.prepare(
        'SELECT id, external_id, section, domain, difficulty, skill, stem_html,' +
        ' choices_json, correct_answer, explanation_html, source, source_page,' +
        ' has_figure FROM questions').all();
      // 8.3MB, identical for everyone, and it needs no session. Uncached that is a
      // full table scan and 8.3MB of egress for every request anyone cares to make,
      // which is a cost attack that costs the attacker a curl loop. Let Cloudflare
      // answer from its own edge cache instead; the bank changes on a deploy, not
      // on a request.
      const res = json(r.results || []);
      res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
      return res;
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
      // Only a question that exists. Without this the primary key bounds nothing:
      // question_id is whatever the client typed, so an account can write rows for
      // 500 invented ids per request, for ever.
      const stmt = env.DB.prepare(
        `INSERT INTO progress
           SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           attempts=excluded.attempts, corrects=excluded.corrects, marker=excluded.marker,
           last_reviewed=excluded.last_reviewed, time_taken_ms=excluded.time_taken_ms,
           stars=MAX(progress.stars, excluded.stars)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), r.attempts | 0, r.corrects | 0,
        str(r.marker, 16) || 'Red', str(r.last_reviewed, 32) || null,
        r.time_taken_ms | 0, r.stars | 0, str(r.question_id, 64))));
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
      // One count for the batch, not one per row.
      const held = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?')
        .bind(u.id).first();
      if ((held?.n || 0) + rows.length > MAX_ATTEMPTS) return json({ error: 'log full' }, 429);
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO attempts (user_id, question_id, ts, correct, time_taken_ms)
         SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM questions WHERE id = ?)`
      );
      await env.DB.batch(rows.map(r => stmt.bind(
        u.id, str(r.question_id, 64), str(r.ts, 32), r.correct ? 1 : 0, r.time_taken_ms | 0,
        str(r.question_id, 64))));
      return json({ ok: true, saved: rows.length });
    }

    // Preferences, one JSON blob per account, so they follow the user across
    // devices. Resolved from the token like everything else here: a client that
    // names someone else's id gets its own row, not theirs.
    if (p === '/api/settings' && req.method === 'GET') {
      const u = await whoami(req, env);
      if (!u) return json({});
      const r = await env.DB.prepare('SELECT json FROM settings WHERE user_id = ?').bind(u.id).first();
      let out = {};
      try { out = r && r.json ? JSON.parse(r.json) : {}; } catch (e) { out = {}; }
      return json(out);
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const u = await whoami(req, env);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => null);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'bad body' }, 400);
      const blob = JSON.stringify(b);
      if (blob.length > MAX_SETTINGS) return json({ error: 'too large' }, 413);
      await env.DB.prepare(
        `INSERT INTO settings (user_id, json, updated_at) VALUES (?,?,datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`
      ).bind(u.id, blob).run();
      return json({ ok: true });
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
