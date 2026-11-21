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

## Optional: balance two resolver VPSes

Install a resolver and configure a separate tunnel hostname on each VPS. Both
resolvers and the streaming node must have the **same** `ELFURA_SECRET` and
`ELFURA_RESOLVER_TOKEN`, the same enabled source configuration, and compatible
software versions. On the Pterodactyl streaming node set:

```ini
ELFURA_RESOLVER_URL=https://resolver-one.example.com
ELFURA_RESOLVER_BACKUP_URL=https://resolver-two.example.com
ELFURA_RESOLVER_ALLOW_PUBLIC=1
ELFURA_RESOLVER_ALLOW_LOCAL=0
```

A public HTTP backup (for example `http://203.0.113.9:3002`) is also accepted
when `ELFURA_RESOLVER_ALLOW_PUBLIC=1`. **HTTP is unencrypted:** the resolver
API token, requests and responses can be read or altered in transit. Prefer
HTTPS or a private VPN, and restrict resolver access to the streaming node's
outbound IP where possible. A Pterodactyl-hosted resolver must listen on its
allocated accessible port; a localhost-only listener will not work remotely.

Restart the streaming node. Each playback search alternates between healthy
resolvers (50/50 by request, not bandwidth or exact concurrent load). On a
network, timeout or server failure, the other healthy resolver is tried within
one 12-second overall request budget. A failed node is skipped for 30 seconds,
then tried again; no background health checks are performed. A slow failed
first attempt may leave too little time for the second to finish. An empty
search or invalid playback request does not trigger failover. Authentication or
access failures (401/403), missing routes (404/405), and rate limits (429) do
trigger failover in a two-node pool; fix the underlying token or Cloudflare rule
instead of relying on the other node. Without `ELFURA_RESOLVER_BACKUP_URL`,
single-resolver behavior is unchanged.
The Pterodactyl node does not scrape locally during remote failures.

The Pterodactyl startup console reports whether one or two resolver URLs were
loaded. Non-empty hosting environment variables take precedence over `.env`;
the console warns by key name if a resolver setting was overridden. After login,
`/roxy` → Source health shows each resolver's authenticated status, playback
attempts, failures and cooldown. Its per-source health counters come from one
resolver, not aggregated cluster counters; request counters reset on restart.
Source enable/disable changes are sent to both; an error
means one or both did not accept the change, so retry after both are online.
Source settings and cached data are independent on the two resolver nodes.
The pool probe checks both the public health endpoint and the authenticated
source API, but it does not verify playback tickets or shared encryption secrets.
Protect both tunnel hostnames as described below.

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
