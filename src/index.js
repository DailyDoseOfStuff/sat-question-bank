const QUESTIONS_SQL = `SELECT id,label,section,domain,skill,difficulty,qtype,render_mode,stem_html,choices_json,correct_answer,correct_key,rationale_html,external_id,source,content_quality,your_answer,why_missed,rule,notion_id FROM questions`;
const PROGRESS_SQL = `SELECT question_id,attempts,corrects,marker,last_reviewed FROM progress`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    
    if (path === '/api/questions' && req.method === 'GET') {
      try {
        const res = await env.DB.prepare(QUESTIONS_SQL).all();
        return new Response(JSON.stringify(res.results || []), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    if (path === '/api/progress' && req.method === 'GET') {
      try {
        const res = await env.DB.prepare(PROGRESS_SQL).all();
        return new Response(JSON.stringify(res.results || []), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    if (path === '/api/progress' && req.method === 'POST') {
      try {
        const body = await req.json();
        await env.DB.prepare(
          `INSERT INTO progress(question_id,attempts,corrects,marker,last_reviewed) VALUES(?,?,?,?,?)
           ON CONFLICT(question_id) DO UPDATE SET attempts=excluded.attempts,corrects=excluded.corrects,marker=excluded.marker,last_reviewed=excluded.last_reviewed`
        ).bind(body.question_id, body.attempts, body.corrects, body.marker, body.last_reviewed).run();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    // Static files: try exact path, fall back to index.html
    try {
      const file = await env.ASSETS.fetch(new Request(new URL(path === '/' ? '/index.html' : path, req.url)));
      return file.status === 404 ? await env.ASSETS.fetch(new Request(new URL('/index.html', req.url))) : file;
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  }
};
