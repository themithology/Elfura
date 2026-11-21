# Ubuntu VPS resolver behind a Cloudflare Tunnel

This installs **only the source resolver** on Ubuntu with systemd. The
Pterodactyl server continues to run the streaming/player node. You configure
and run `cloudflared` separately; the installer does not install or modify it.

On the Ubuntu VPS, run this one line from the directory containing your
configured resolver `.env`. An existing `/opt/elfura-resolver/.env` takes
precedence and is never overwritten by an update. If neither exists, the
installer interactively asks for the matching secrets without echoing them.

```sh
sudo bash -o pipefail -c '{ command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }; } && curl -fsSL https://raw.githubusercontent.com/themithology/Elfura/arena/124b7afe-elfura/scripts/install-ubuntu-resolver.sh | bash'
```

The installer uses Node 22+ (installing NodeSource Node 22 if needed), downloads
the prebuilt deployment ZIP, preserves `.env` and `data/`, creates a dedicated
system user, and enables the `elfura-resolver` systemd service. It checks the
local health endpoint. It requires systemd and does not configure the firewall.
It validates that the resolver's secret and token are non-placeholder values of
at least 24 characters; do not use credentials published in this repository.

## Connect the two servers

1. In the **existing Cloudflare Tunnel** for the VPS, add a published hostname,
   for example `resolver.example.com`, with service **HTTP** and URL
   `http://127.0.0.1:3002`. The port is local to the VPS: the public address is
   `https://resolver.example.com` without `:3002`. The installer forces
   `ELFURA_RESOLVER_LISTEN=127.0.0.1` and `ELFURA_RESOLVER_OPEN=0` in the service.
2. On the **Pterodactyl streaming node**, configure and restart:

   ```ini
   ELFURA_RESOLVER_URL=https://resolver.example.com
   ELFURA_RESOLVER_ALLOW_PUBLIC=1
   ELFURA_RESOLVER_ALLOW_LOCAL=0
   ```

   `ELFURA_SECRET` must match on both nodes for encrypted stream tickets.
   `ELFURA_RESOLVER_TOKEN` must also match; when absent on a node it defaults to
   that node's `ELFURA_SECRET`. Do not put secrets in URLs, commands or chat.
3. From the streaming node, verify the tunnel by requesting
   `https://resolver.example.com/resolver/api/health`. The resolver's `/sources`
   and `/playback` endpoints require the `x-elfura-resolver-token` header.
   Check **Source health** in `/roxy` on the streaming node to confirm it uses
   the separate resolver. A reachable health endpoint alone does not prove
   matching tokens or successful playback.

## Optional: balance two or three resolver nodes

Install a resolver and configure a separate tunnel hostname on each node. All
resolvers and the streaming node must have the **same** `ELFURA_SECRET` and
`ELFURA_RESOLVER_TOKEN`, the same enabled source configuration, and compatible
software versions. On the Pterodactyl streaming node set:

```ini
ELFURA_RESOLVER_URL=https://resolver-one.example.com
ELFURA_RESOLVER_BACKUP_URL=https://resolver-two.example.com
# Optional third resolver:
ELFURA_RESOLVER_THIRD_URL=https://resolver-three.example.com
ELFURA_RESOLVER_ALLOW_PUBLIC=1
ELFURA_RESOLVER_ALLOW_LOCAL=0
```

A public HTTP backup (for example `http://203.0.113.9:3002`) is also accepted
when `ELFURA_RESOLVER_ALLOW_PUBLIC=1`. **HTTP is unencrypted:** the resolver
API token, requests and responses can be read or altered in transit. Prefer
HTTPS or a private VPN, and restrict resolver access to the streaming node's
outbound IP where possible. A Pterodactyl-hosted resolver must listen on its
allocated accessible port; a localhost-only listener will not work remotely.

Update **both the streaming server and every resolver**, then restart them.
The streaming node routes to the least busy closed circuit; ties rotate across
nodes. Errors open a circuit for roughly 30 seconds (5 seconds for explicit
capacity responses), with jitter and increasing backoff after failed recovery
trials. Open circuits receive no playback requests until their cooldown expires,
when at most one request per streaming process tests recovery. There are no
background health checks. A fast failure can try another available node. An
empty search or invalid request does not itself trigger failover.

For a slow request, the pool may send at most one extra request to a closed
node with spare capacity. This is limited globally per streaming process to one
concurrent hedge and about one hedge per 20 initial searches, plus one initial
token. When the budget is exhausted, a stalled viewer may time out instead of
multiplying work on already-busy servers. An already-started search continues
on its resolver even if another answers first; cancellation is not propagated
into provider work or the late-source stash.

The streaming node limits outstanding requests per resolver with
`ELFURA_RESOLVER_NODE_MAX_INFLIGHT` (default 8, per streaming process). Each
updated resolver independently limits actual discovery work with
`ELFURA_RESOLVER_MAX_CONCURRENT` (default 8, per resolver process), including
work whose client has disconnected. These are starting values, not verified
capacity: tune using load tests and logs. They do not coordinate across multiple
streaming or resolver processes; the resolver-side limit is essential when
multiple streaming servers share it. Over-capacity requests get 503 and
`Retry-After`; there is no unbounded queue. The authenticated
`/resolver/api/capacity` reports active work and the configured limit. A provider
lane that never settles keeps its slot occupied; investigate stuck tasks and
restart the resolver if necessary rather than automatically admitting more work.
Older resolver versions do not enforce that server-side limit.

Authentication/access failures (401/403), missing routes (404/405), and rate
limits (429) open a circuit; fix the underlying token or access rule. If neither
optional URL is set, single-resolver behavior is unchanged on the media node.
Duplicate URLs are ignored. The streaming node does not scrape locally during
remote failures.

The startup console reports how many distinct resolver URLs were loaded.
Non-empty hosting environment variables take precedence over `.env`; the
console warns by key name if a resolver setting was overridden. After login,
`/roxy` → Source health shows each resolver's authenticated status, playback
attempts, failures and cooldown. Per-source health counters come from one
resolver, not aggregated cluster counters; request counters reset on restart.
Source enable/disable changes are sent to every node; an error means one or
more did not accept the change, so retry after all are online. Source settings
and cached data are independent on each resolver node. The pool probe checks
both public health and authenticated source APIs, but does not verify playback
tickets or shared encryption secrets. Protect all tunnel hostnames as described
below.

**Security:** A Tunnel hostname is publicly reachable unless you separately
restrict it; `.env` itself is not a network access control. The resolver has
unauthenticated health and network-info endpoints, even though sensitive API
calls require the shared token. Restrict the hostname at Cloudflare to the
streaming VPS's actual outbound IP where possible, keep the token strong, and
rotate any credentials previously committed to the repository. Cloudflare
Access requiring interactive login or a service-token header will block the
current resolver client unless compatible authentication is configured.
Tokenless `ELFURA_RESOLVER_OPEN=1` is unsafe behind a local reverse proxy: the
proxy connects from loopback, so the installer explicitly disables it.

```sh
sudo systemctl status elfura-resolver --no-pager
sudo journalctl -u elfura-resolver -n 80 --no-pager
sudo systemctl restart elfura-resolver
```

For an update, run the same installation line. If you want to change an
existing resolver `.env`, edit `/opt/elfura-resolver/.env` and restart the
service; rerunning the installer never replaces it with a different file.
