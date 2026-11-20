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
