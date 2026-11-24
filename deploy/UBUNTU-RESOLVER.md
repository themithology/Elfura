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

   `ELFURA_SECRET` must match on both nodes for the sealed playback envelope.
   `ELFURA_RESOLVER_TOKEN` must also match; when absent on a node it defaults to
   that node's `ELFURA_SECRET`. Do not put secrets in URLs, commands or chat.
3. From the streaming node, verify the tunnel by requesting
   `https://resolver.example.com/resolver/api/health`. The resolver's `/sources`
   and `/playback` endpoints require the `x-elfura-resolver-token` header.
   Check **Source health** in `/roxy` on the streaming node to confirm it uses
   the separate resolver. A reachable health endpoint alone does not prove
   matching tokens or successful playback.

## One resolver

Elfura talks to **one** resolver URL. There is no pool, no round-robin and no
per-node health routing: the streaming node sends every playback request to
`ELFURA_RESOLVER_URL`, and if that resolver is unreachable the viewer gets a 503
instead of a silent second scraper being started on the media process. Keep the
resolver on one box, behind the tunnel, and scale that box if searches get slow.

Deploy the same current package to **the resolver and the player server**. The
player polls the resolver's short-lived wave, including later lanes from sources
already listed. Empty providers get one shared retry per active title and source,
rather than repeated per-viewer source scans. Wave data is bounded to 256 titles
and 32 MiB, and expires after 60 seconds. These bounds and retries do not
guarantee upstream availability or capacity under every load; source episode
mapping and provider reachability still matter.

**Security:** A Tunnel hostname is publicly reachable unless you separately
restrict it; `.env` itself is not a network access control. The resolver has
unauthenticated health and network-info endpoints, even though sensitive API
calls require the shared token. Restrict the hostname at Cloudflare to the
streaming VPS's actual outbound IP where possible, keep the token strong, and
rotate any credentials previously committed to the repository. Cloudflare
Access requiring interactive login or a service-token header will block the
current resolver client unless compatible authentication is configured.
### Source 25 / Greybox connectivity

Source 25 is enabled by default. If a resolver cannot connect to
`greyboxtv.duckdns.org` (for example, it reports a TLS reset), verify connectivity
from that resolver; a healthy resolver endpoint alone does not test the provider.
A separately deployed, token-protected Cloudflare Worker egress relay can be
configured on each resolver with `ELFURA_UPSTREAM_RELAY` and `ELFURA_RELAY_TOKEN`
in its preserved `.env` (see `cloudflare-worker/worker.js` for deployment).
The Worker must contain the current code: older versions do not allow Greybox by
default. Restart each resolver after changing its environment, one at a time.
The relay moves discovery to the Worker, not the media-server playback traffic;
it cannot guarantee that the Worker or media server can reach the provider, or
that a browser supports the returned codec. Never share the relay token.

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
