/**
 * JARVIS mailbox — Cloudflare Worker
 * Bridges the static PWA (jarvis.html) and iOS Shortcuts.
 *
 *   POST /<SECRET>/plan      Jarvis writes a plan
 *   GET  /<SECRET>/plan      Shortcut reads the plan
 *   POST /<SECRET>/results   Shortcut writes execution results
 *   GET  /<SECRET>/results   Jarvis reads results and merges them into memory
 *
 * Setup (free tier, ~5 minutes):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file
 *   2. Storage → KV → create namespace "JARVIS" → bind it to this Worker as JARVIS
 *   3. Settings → Variables → add SECRET = <a long random string you generate>
 *   4. Deploy. Your base URL is https://<worker>.<subdomain>.workers.dev
 *
 * Privacy: the SECRET path segment is the only credential. Keep it out of public repos.
 * Payload caps: 20 KB per write. Plan TTL 1 hour, results TTL 30 days.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' }
  });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const secret = parts[0];
    const kind = parts[1];

    // constant-time-ish comparison, and identical response for wrong secret or wrong path
    const expected = env.SECRET || '';
    if (!expected || secret !== expected) return json({ error: 'not found' }, 404);
    if (kind !== 'plan' && kind !== 'results') return json({ error: 'not found' }, 404);

    const ttl = kind === 'plan' ? 3600 : 60 * 60 * 24 * 30;

    if (req.method === 'GET') {
      const stored = await env.JARVIS.get(kind);
      if (stored) {
        return new Response(stored, {
          headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'x-empty': '0' }
        });
      }
      // empty, well-formed defaults so Shortcuts never has to null-check
      const empty = kind === 'plan'
        ? { v: 1, id: null, actions: [] }
        : { v: 1, results: [] };
      return new Response(JSON.stringify(empty), {
        headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'x-empty': '1' }
      });
    }

    if (req.method === 'POST') {
      const body = await req.text();
      if (body.length > 20000) return json({ error: 'payload too large' }, 413);

      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json({ error: 'invalid json' }, 400); }

      // shallow shape validation — refuse anything that isn't a plan or a results batch
      if (kind === 'plan') {
        if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.actions)) {
          return json({ error: 'plan must be {v:1, actions:[...]}' }, 400);
        }
      } else {
        const list = Array.isArray(parsed) ? parsed : parsed && parsed.results;
        if (!Array.isArray(list)) return json({ error: 'results must be {v:1, results:[...]}' }, 400);
      }

      await env.JARVIS.put(kind, body, { expirationTtl: ttl });
      return json({ ok: true, stored: kind, bytes: body.length });
    }

    return json({ error: 'method not allowed' }, 405);
  }
};
