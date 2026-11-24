# Prompt: build the fetch middleman

Copy everything below the line into the builder.

---

Build a single-purpose HTTP service. It is a **dumb fetch pipe**. It has exactly one job: fetch a URL it is told to fetch, and return the raw result. It must not know anything about the caller's business, must not parse or interpret what it fetches, and must not have any opinion about the content.

## Stack

Any Node.js HTTP server (Express, Fastify, or bare `node:http`). One file if possible. No database. No build step. It must run on a small free/cheap instance and start with `npm start`.

## Endpoint: `POST /fetch`

### Request

```http
POST /fetch
content-type: application/json
x-key: <shared secret from env var FETCH_KEY>

{
  "url": "https://example.com/api/thing?id=1",
  "method": "GET",
  "headers": { "accept": "application/json", "referer": "https://example.com/" },
  "body": "optional string, only used when method is POST",
  "timeoutMs": 15000
}
```

- `url` — required, must be `http:` or `https:`
- `method` — optional, default `GET`. Allow only `GET`, `POST`, `HEAD`.
- `headers` — optional object of strings, passed through to the outbound request as given
- `body` — optional string, raw, passed through as given
- `timeoutMs` — optional, default `15000`, clamp to `1000`–`30000`

### Response

Always respond `200` with this JSON shape — **including when the outbound request failed**:

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"raw\":\"response body exactly as received, as a UTF-8 string\"}"
}
```

```json
{
  "status": 0,
  "headers": {},
  "body": "",
  "error": "ECONNRESET"
}
```

- `status` — the outbound HTTP status. `0` means the request never got a response.
- `headers` — the outbound response headers, flattened to a plain object
- `body` — the response body as a **string**, unmodified, whether it is JSON, HTML, or an HLS playlist. Do not parse it. Do not pretty-print it. Do not truncate it below the size cap.
- `error` — only present when `status` is `0`. Use the network error code (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, …).

The caller decides what the body means. This service never does.

## Rules

1. **No parsing.** Do not `JSON.parse` the request body's meaning, do not inspect the response body, do not detect content types, do not transform anything.
2. **No caching.** Every request goes out.
3. **No retries.** If it fails, report the failure. The caller decides whether to retry.
4. **Follow redirects**, up to 5, and return the final status and body.
5. **Size cap**: read at most 10 MB of response body. If the response is larger, stop reading and return what was read with the header `"x-truncated": "1"` added to the returned headers object.
6. **Binary bodies**: if the response `content-type` is not text-like, return the body base64-encoded and add `"x-encoding": "base64"` to the returned headers object. Text-like means it starts with `text/`, or contains `json`, `xml`, `javascript`, or `mpegurl`.
7. **Auth is mandatory.** If `x-key` is missing or does not equal `process.env.FETCH_KEY` (compare in constant time), respond `401` with `{ "error": "unauthorized" }` and do nothing else.
8. **SSRF guard.** Before fetching, resolve the hostname and reject the request with `400` and `{ "error": "blocked" }` if the URL is not `http`/`https`, or if the host resolves to a private, loopback, link-local, or metadata address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, or `0.0.0.0`).
9. **No logging of bodies or headers.** Log one line per request: timestamp, method, host, outbound status, duration in ms. Never log the `x-key`, request body, or response body.
10. **Do not forward the `x-key` header or any `host` header** to the outbound request.

## Other endpoints

- `GET /health` → `200 { "ok": true }`, no auth required, no other data.

Nothing else. No dashboards, no config UI, no statistics, no admin panel.

## Environment

- `FETCH_KEY` — required, the shared secret. Refuse to start if it is unset.
- `PORT` — required by the host; listen on `0.0.0.0`.

## Deployment notes for the builder

- Bind to `0.0.0.0:$PORT`, because the host routes to it.
- No `--production` flags needed beyond `NODE_ENV=production`.
- Generate a long random `FETCH_KEY` (40+ chars) and show it once.
- Do not add a rate limiter, queue, background worker, or database.

## Acceptance test

This must pass once deployed, using your own `FETCH_KEY`:

```bash
curl -sS -X POST "$MIDDLEMAN_URL/fetch" \
  -H "content-type: application/json" \
  -H "x-key: $FETCH_KEY" \
  -d '{"url":"https://api.github.com/zen"}' | head -c 300
```

Expected: JSON containing `"status": 200` and a `body` string with a short quote in it.

Then a failure case:

```bash
curl -sS -X POST "$MIDDLEMAN_URL/fetch" \
  -H "content-type: application/json" \
  -H "x-key: $FETCH_KEY" \
  -d '{"url":"https://this-host-does-not-exist.invalid/"}'
```

Expected: JSON containing `"status": 0` and an `error` field.
