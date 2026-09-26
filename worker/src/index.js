// Mints short-lived Cloudflare TURN credentials for the game's WebRTC link.
// Only the game's own pages may ask, so strangers can't relay on our bill.
const SITE = 'https://ageofepochs.com';
const allowed = origin =>
  origin === SITE || origin === 'https://www.ageofepochs.com' ||
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed(origin) ? origin : SITE,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
      'Cache-Control': 'no-store', // each caller gets its own credentials
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed(origin)) return new Response('forbidden', { status: 403, headers: cors });
    if (!env.TURN_KEY_SECRET) return Response.json({ error: 'TURN_KEY_SECRET is not configured' }, { status: 500, headers: cors });

    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.TURN_KEY_SECRET}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }), // 24 h: outlives any match
        });
      if (!res.ok) return Response.json({ error: 'Failed to generate ICE servers', detail: await res.text() }, { status: res.status, headers: cors });
      return Response.json(await res.json(), { headers: cors });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: cors });
    }
  },
};
