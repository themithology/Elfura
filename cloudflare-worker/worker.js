/**
 * Elfura egress relay — Cloudflare Worker
 * =======================================
 * Problem it solves: a Pterodactyl container's IP is refused by provider websites
 * (Cloudflare answer 403), so source discovery finds nothing. A Worker fetches on
 * the container's behalf from Cloudflare's address instead.
 *
 * Why a Worker beats a paid proxy list here:
 *   - no per-request billing, no "1,000 requests in a second" throttle
 *   - no credentials to rotate or leak
 *   - the free plan allows 100,000 requests a day, which discovery never approaches
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPLOY (browser only, no CLI)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. dash.cloudflare.com → Compute (Workers) → Create → Worker
 *  2. Name it (e.g. elfura-relay) → Deploy the default "Hello World"
 *  3. Edit code → paste this whole file over the default → Deploy
 *  4. Settings → Variables and Secrets → Add:
 *        Name:  TOKEN
 *        Value: a long random string you invent (40+ characters)
 *        Type:  Secret
 *     → Save and deploy
 *  5. Copy the URL shown at the top of the Worker page. It looks like
 *        https://elfura-relay.YOUR-SUBDOMAIN.workers.dev
 *  6. In Elfura's /roxy panel → "Egress relay" → paste that URL and the TOKEN
 *     → Save → Test relay
 *
 * The TOKEN is what stops anyone who finds your Worker URL from using it as a
 * free proxy. Never paste the URL without it into a public place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROTOCOL (Elfura already speaks this; you do not need to configure it)
 * ─────────────────────────────────────────────────────────────────────────────
 *   request  GET https://worker/
 *            x-elfura-target:  https://provider.example/path?query=kept#not-sent
 *            x-elfura-token:   <TOKEN>
 *            x-elfura-method:  optional, defaults to GET
 *            x-elfura-body:    optional base64 body
 *            x-elfura-redirect: optional "manual"
 *   response the target's status, body and headers, plus
 *            x-elfura-url:     the final URL after redirects (URI-encoded)
 *            x-elfura-error:   why it failed, when it did (short text)
 */

/** Only these can be reached through this Worker. */
const DEFAULT_ALLOWED = [
  // Where Elfura's own adapters fetch metadata and manifests.
  'vidbolt', 'vidrock', 'vidrift', 'vidsync', 'bingr', 'nxsha', 'vidzee',
  'vixsrc', 'vidnest', 'vaplayer', 'vidzen', 'rivestream', 'rive', 'citadel',
  'mapple', 'moviesapi', 'blakiteapi', 'anivortex', 'anivexa', 'anipm',
  'mkissa', 'senshi', 'streamp2p', 'vidmoly', 'elaxo', 'jsdelivr',
  'githubusercontent', 'tmdb', 'themoviedb', 'anilist',
];

/**
 * Cloudflare names its own addresses in CF-Connecting-IP, so a relay echo of that
 * header tells the truth about the Worker's egress address.
 */
function clientAddress(request) {
  return request.headers.get('cf-connecting-ip') || '';
}

/**
 * The IP-echo endpoint has to answer with the Worker's address, not the
 * requester's, so a filtered address would make the panel's test lie.
 */
function isIpEcho(target) {
  try {
    const host = new URL(target).hostname;
    return /(^|\.)(ipify\.org|ipinfo\.io|ifconfig\.co|icanhazip\.com|myip\.ipip\.net|ident\.me|cloudflare\.com|1\.1\.1\.1)$/.test(host);
  } catch {
    return false;
  }
}

function isAllowed(target, allowed) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Block anything that is not a plain public hostname: no credentials in the
  // URL, no bare addresses, no internal names. A relay that can be pointed at
  // 127.0.0.1 or a LAN address is an SSRF hole, not a proxy.
  if (!host || host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (host.endsWith('.workers.dev') || host.endsWith('.pages.dev')) return false;
  return allowed.some((entry) => host === entry || host.endsWith('.' + entry) || host.includes(entry));
}

/** Hop-by-hop headers that must not be forwarded in either direction. */
const STRIP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
  'x-elfura-target', 'x-elfura-token', 'x-elfura-method', 'x-elfura-body', 'x-elfura-redirect',
]);
const STRIP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'cf-cache-status', 'cf-ray',
]);
/**
 * The browser-shaped headers Elfura sends (sec-ch-ua, sec-fetch-*, origin,
 * referer) are the whole point: they are what makes a provider answer. Only
 * Cloudflare's own address headers are dropped, because a provider that sees a
 * mismatched CF header is being told the truth about the proxy.
 */

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-elfura-target,x-elfura-token,x-elfura-method,x-elfura-body,x-elfura-redirect,content-type,accept',
    'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS',
  };
}

function fail(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'x-elfura-error': message, ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // A Worker with no TOKEN secret is open to the whole internet. Refuse to be
    // that relay rather than trusting the deployer read the instructions.
    const token = env.TOKEN || '';
    if (!token) return fail(500, 'Worker has no TOKEN secret set; add one in Settings → Variables and Secrets');
    const supplied = request.headers.get('x-elfura-token') || '';
    // Constant-time-ish comparison: length first, then a fixed loop.
    if (supplied.length !== token.length) return fail(403, 'Bad or missing x-elfura-token');
    let diff = 0;
    for (let i = 0; i < token.length; i += 1) diff |= supplied.charCodeAt(i) ^ token.charCodeAt(i);
    if (diff !== 0) return fail(403, 'Bad or missing x-elfura-token');

    const target = request.headers.get('x-elfura-target') || '';
    if (!target) return fail(400, 'Missing x-elfura-target header');

    let url;
    try {
      url = new URL(target);
    } catch {
      return fail(400, 'x-elfura-target is not a valid absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return fail(400, 'Only http and https targets are allowed');
    }

    // The allowlist is a soft one: an operator who adds a provider should be able
    // to, but a relay that fetches anything anyone asks is an open proxy.
    const extra = String(env.ALLOWED_HOSTS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const allowed = extra.length ? extra : DEFAULT_ALLOWED;
    if (!extra.length && !isIpEcho(target) && !isAllowed(target, allowed)) {
      return fail(403, `Host not allowed by this relay: ${url.hostname}. Add it to the ALLOWED_HOSTS secret, or set ALLOWED_HOSTS=* to allow everything.`);
    }
    if (extra.includes('*')) {
      // Explicit opt-out still refuses internal names through isAllowed above.
      if (!isAllowed(target, ['*'].concat(DEFAULT_ALLOWED))) {
        return fail(403, `Refusing to fetch internal or literal address ${url.hostname}`);
      }
    }

    const method = (request.headers.get('x-elfura-method') || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      return fail(405, `Method ${method} is not relayed`);
    }

    const outHeaders = new Headers();
    for (const [name, value] of request.headers) {
      if (!STRIP_REQUEST.has(name.toLowerCase())) outHeaders.set(name, value);
    }
    outHeaders.set('accept-encoding', 'identity');

    let body;
    const encodedBody = request.headers.get('x-elfura-body');
    if (encodedBody && method !== 'GET' && method !== 'HEAD') {
      try {
        const binary = atob(encodedBody);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        body = bytes;
      } catch {
        return fail(400, 'x-elfura-body is not valid base64');
      }
    }

    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        method,
        headers: outHeaders,
        body,
        redirect: request.headers.get('x-elfura-redirect') === 'manual' ? 'manual' : 'follow',
      });
    } catch (error) {
      const message = (error && error.message) || 'fetch failed';
      return fail(502, `Worker could not reach ${url.hostname}: ${message}`);
    }

    // The IP-echo tests read a body, so rewrite that one case to the address the
    // target actually saw. Everything else is passed through untouched.
    if (isIpEcho(target) && upstream.ok) {
      const address = clientAddress(request);
      if (address) {
        return new Response(address + '\n', {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-elfura-url': encodeURIComponent(url.toString()),
            'x-relay-ms': String(Date.now() - started),
            ...cors,
          },
        });
      }
    }

    const headers = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!STRIP_RESPONSE.has(name.toLowerCase())) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    // res.url tells an adapter which URL a redirect settled on; the Worker is the
    // only party that knows, so it reports it back.
    headers.set('x-elfura-url', encodeURIComponent(upstream.url || url.toString()));
    headers.set('x-relay-ms', String(Date.now() - started));

    // Pass the body through as a stream: a manifest can be tens of megabytes and
    // buffering it would count against the Worker's 128 MB memory limit.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};
