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

## Optional: balance two to four resolver VPSes

Install a resolver and a separate tunnel hostname on each VPS. All resolvers
and the streaming node must use the **same** `ELFURA_SECRET` and
`ELFURA_RESOLVER_TOKEN`, compatible software versions and matching source
configuration. On the Pterodactyl streaming node set:

```ini
ELFURA_RESOLVER_URL=https://resolver-one.example.com
ELFURA_RESOLVER_BACKUP_URL=https://resolver-two.example.com
ELFURA_RESOLVER_THIRD_URL=https://resolver-three.example.com
ELFURA_RESOLVER_FOURTH_URL=https://resolver-four.example.com
ELFURA_RESOLVER_ALLOW_PUBLIC=1
ELFURA_RESOLVER_ALLOW_LOCAL=0
```

The third and fourth URLs are optional. Duplicate URLs are ignored. One configured resolver
retains the original single-resolver behavior. Public URLs require opt-in;
public HTTP exposes tokens and requests in transit, so prefer HTTPS or a
private VPN and restrict access. A resolver must listen on an accessible port.

Restart the streaming node. New searches are distributed round-robin across
available resolvers (equal request counts, not equal workload); latency is not
used to choose a node. A failed playback call marks that node unavailable and
can try another available node within the shared 12-second budget. If the first
call takes most of the budget, that viewer may fail instead of getting a useful
retry. There are no speculative duplicate requests or per-node concurrency
caps. Empty results and invalid requests do not trigger failover.

Unavailable nodes receive no new playback or source-setting requests. Every
10 seconds the media process checks the lightweight health and authenticated
source-status endpoints. Two successful checks reintroduce a failed node;
two failed checks also remove an otherwise idle node. Checks are independent of
viewer traffic; a slow check can lengthen the interval. Requests already in
flight cannot be recalled. If all nodes are unavailable, new searches fail
until one recovers. A restart starts the checks and routing afresh.

These checks verify reachability and API authentication, **not** playback,
shared ticket secrets or search capacity. A resolver can answer health checks
while its searches are overloaded or broken, and may be tried again after
recovery checks; inspect resolver logs and test real playback. `/roxy` → Source
health shows live reachability/authentication and whether playback is paused,
plus per-node request counts. Per-source counters are from one resolver, not
cluster totals. Source enable/disable changes are sent only to available nodes;
if one is offline the operation reports failure, so retry after it recovers.
Settings and caches are independent on each resolver.

For late source updates, deploy the same current package to **every resolver
and the player server**. The player polls the original resolver's short-lived
wave, including later lanes from sources already listed. Empty providers get one
shared retry per active title and source, rather than repeated per-viewer source
scans. Wave data is bounded to 256 titles and 32 MiB per resolver, and expires
after 60 seconds. If a wave has been evicted or its owner is unavailable, the
player can attempt one fresh discovery on an available resolver. These bounds
and retries do not guarantee upstream availability or capacity under every load;
source episode mapping and provider reachability still matter.

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
