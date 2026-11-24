# Elfura egress relay (Cloudflare Worker)

> This Worker carries **discovery** traffic only — provider API and page requests.
> No media ever passes through it. Streams are served to viewers by Elfura's own
> stateless `/api/proxy` pass-through on your server.

A ~15 minute setup, done entirely in a browser. No CLI, no npm, no card.

## What this fixes

Your Pterodactyl container has one IP address. When a provider website decides that
address is a bot, every source goes quiet at once — that is the `403` / `tls-fail`
storm in the console. A Worker fetches on the container's behalf from Cloudflare's
address instead, so the provider sees Cloudflare, not the container.

## Why this instead of Webshare

| | Webshare-style proxy | Cloudflare Worker |
|---|---|---|
| Cost | per GB / per proxy | free plan: 100,000 requests/day |
| Rate limit | "1,000 requests in 1 second → upgrade" | Cloudflare's own limits, far above this |
| Credentials | per-proxy user:pass to rotate and leak | one token string |
| Setup | upload a list, hope the IPs aren't burnt | paste one URL |
| Failure mode | every request still dials the proxy | one request, one hop, no fan-out |

Discovery is bursty by nature: one page load fans out to 21 sources and several
requests each. That is fine against a Worker's request allowance and fatal against
a metered proxy, which is exactly what happened to your account.

## Setup

1. Go to <https://dash.cloudflare.com> → **Compute (Workers)** → **Create** → **Worker**.
2. Name it something like `elfura-relay`, then **Deploy** the default Hello World.
3. Click **Edit code**, delete everything, paste the contents of [`worker.js`](./worker.js), then **Deploy**.
4. **Settings** → **Variables and Secrets** → **Add**:
   - Name: `TOKEN`
   - Value: a long random string you invent, 40+ characters (bash: `openssl rand -hex 32`)
   - Type: **Secret**
   - Then **Save and deploy**.
5. Copy the URL at the top of the Worker page — it looks like
   `https://elfura-relay.YOUR-SUBDOMAIN.workers.dev`.
6. In Elfura: open `/roxy` → **Egress relay** → paste the URL **and** the token → **Save** → **Test relay**.

The test should answer with Cloudflare's exit address and a millisecond figure. If
it does, source discovery now leaves through the Worker and the container's own IP
is no longer what providers see.

## Which hosts it will fetch

By default the Worker only relays the provider hostnames Elfura's adapters use, plus
the IP-echo endpoints used by the panel's test. Anything else is refused, so a
leaked URL plus token cannot be used as a general-purpose open proxy.

To allow a hostname that isn't in the list, add another secret:

```
ALLOWED_HOSTS = vidbolt.xyz,some-new-provider.example
```

or set `ALLOWED_HOSTS=*` to allow everything (still refusing literal IPs, `localhost`,
and internal names — a relay that can be pointed at `127.0.0.1` is an SSRF hole).

## Verify it works without Elfura

```bash
curl -s https://elfura-relay.YOUR-SUBDOMAIN.workers.dev/ \
  -H "x-elfura-token: YOUR_TOKEN" \
  -H "x-elfura-target: https://api.ipify.org/?format=text"
```

You should get an IP address back that is **not** your container's IP. That single
line proves the relay works before you touch any Elfura setting.

## If it doesn't work

| Symptom | Cause |
|---|---|
| `Worker has no TOKEN secret set` | Step 4 was skipped; add the secret and redeploy |
| `Bad or missing x-elfura-token` | Panel token differs from the Worker secret |
| `Host not allowed by this relay` | Add the host to `ALLOWED_HOSTS` |
| `Worker could not reach <host>: ...` | The provider refuses Cloudflare's address too |
| Cloudflare `1042` / `522` | Worker not deployed, or the URL is misspelled |
| `1102` | Worker name/URL is wrong, or you edited the wrong Worker |

If the provider refuses Cloudflare's address as well, the relay is not the answer for
that provider and the console will say `via relay` with a `403` — the profile retry
then falls back to a direct connection rather than failing the source.

## Cost and limits (free plan, as of writing)

- 100,000 requests/day, reset daily
- CPU time per request is not an issue here: the Worker is waiting on I/O, not computing

One `resolve` of a title is roughly 40–80 relayed requests, so the free tier covers
well over a thousand title resolutions a day. Media playback does **not** go through
the relay: viewers are served by `/api/proxy` on the Elfura server itself.
