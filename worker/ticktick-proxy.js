// Cloudflare Worker: TickTick OAuth + CORS proxy for Rozvrhár.
//
// Secrets / vars (wrangler secret put …):
//   TICKTICK_CLIENT_ID, TICKTICK_CLIENT_SECRET
//   ALLOWED_ORIGINS  – comma separated, e.g. "https://user.github.io,http://localhost:8080"
//
// Routes:
//   GET  /auth?redirect=<app url>   → TickTick consent screen
//   GET  /callback?code&state       → exchanges code, redirects to app with #tt_token=…
//   ANY  /api/<path>                → https://api.ticktick.com/open/v1/<path>

const AUTH_URL = 'https://ticktick.com/oauth/authorize';
const TOKEN_URL = 'https://ticktick.com/oauth/token';
const API = 'https://api.ticktick.com/open/v1';

function allowed(env, urlOrOrigin) {
  try {
    const origin = new URL(urlOrOrigin).origin;
    return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  } catch {
    return false;
  }
}

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  return allowed(env, origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const self = `${url.origin}/callback`;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });

    if (url.pathname === '/auth') {
      const redirect = url.searchParams.get('redirect') || '';
      if (!allowed(env, redirect)) return new Response('Redirect not allowed', { status: 400 });
      const q = new URLSearchParams({
        client_id: env.TICKTICK_CLIENT_ID,
        scope: 'tasks:read tasks:write',
        state: btoa(redirect),
        redirect_uri: self,
        response_type: 'code',
      });
      return Response.redirect(`${AUTH_URL}?${q}`, 302);
    }

    if (url.pathname === '/callback') {
      let back = '';
      try { back = atob(url.searchParams.get('state') || ''); } catch { back = ''; }
      if (!allowed(env, back)) return new Response('Bad state', { status: 400 });
      const code = url.searchParams.get('code');
      if (!code) return Response.redirect(`${back}#tt_error=${encodeURIComponent(url.searchParams.get('error') || 'denied')}`, 302);
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${env.TICKTICK_CLIENT_ID}:${env.TICKTICK_CLIENT_SECRET}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', scope: 'tasks:read tasks:write', redirect_uri: self }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.access_token) return Response.redirect(`${back}#tt_error=${encodeURIComponent('token exchange failed')}`, 302);
      return Response.redirect(`${back}#tt_token=${encodeURIComponent(data.access_token)}`, 302);
    }

    if (url.pathname.startsWith('/api/')) {
      const headers = cors(env, req);
      if (!headers['Access-Control-Allow-Origin']) return new Response('Origin not allowed', { status: 403 });
      const target = API + url.pathname.slice(4) + url.search;
      const res = await fetch(target, {
        method: req.method,
        headers: { Authorization: req.headers.get('Authorization') || '', 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(),
      });
      return new Response(res.body, { status: res.status, headers: { ...headers, 'Content-Type': res.headers.get('Content-Type') || 'application/json' } });
    }

    return new Response('Rozvrhár TickTick proxy', { status: 200 });
  },
};
