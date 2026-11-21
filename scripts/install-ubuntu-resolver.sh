#!/usr/bin/env bash
# Install/update ONLY Elfura's resolver on an Ubuntu VPS for a Cloudflare Tunnel.
# A pre-existing /opt/elfura-resolver/.env is never replaced on updates.
set -Eeuo pipefail

DEST=/opt/elfura-resolver
UNIT=/etc/systemd/system/elfura-resolver.service
ZIP_URL='https://raw.githubusercontent.com/themithology/Elfura/arena/124b7afe-elfura/elfura-pterodactyl.zip'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run this installer with sudo.'
command -v apt-get >/dev/null || fail 'This installer requires Ubuntu with apt.'
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || fail 'This installer needs a running systemd system.'

# Prefer an existing install, then .env in the directory from which sudo ran.
# Never source a dotenv file as shell code or use the checked-in demo credentials.
if [[ -f "$DEST/.env" ]]; then
  ENV_SOURCE="$DEST/.env"
elif [[ -f "$PWD/.env" ]]; then
  ENV_SOURCE="$PWD/.env"
else
  [[ -r /dev/tty && -w /dev/tty ]] || fail 'Place the configured .env in the current directory (or /opt/elfura-resolver/.env) and rerun.'
  printf 'No .env found. Enter the SAME values used by the Pterodactyl streaming node.\n' > /dev/tty
  printf 'ELFURA_SECRET (hidden): ' > /dev/tty
  IFS= read -r -s SECRET < /dev/tty; printf '\n' > /dev/tty
  printf 'ELFURA_RESOLVER_TOKEN (hidden; Enter to reuse ELFURA_SECRET): ' > /dev/tty
  IFS= read -r -s TOKEN < /dev/tty; printf '\n' > /dev/tty
  [[ "$SECRET" =~ ^[a-zA-Z0-9_-]{24,}$ ]] || fail 'Use a random ELFURA_SECRET of at least 24 letters, digits, underscores or hyphens.'
  [[ -z "$TOKEN" || "$TOKEN" =~ ^[a-zA-Z0-9_-]{24,}$ ]] || fail 'Use a random ELFURA_RESOLVER_TOKEN of at least 24 letters, digits, underscores or hyphens.'
  umask 077
  printf 'ELFURA_SECRET=%s\n' "$SECRET" > "$TMP/.env"
  [[ -z "$TOKEN" ]] || printf 'ELFURA_RESOLVER_TOKEN=%s\n' "$TOKEN" >> "$TMP/.env"
  unset SECRET TOKEN
  ENV_SOURCE="$TMP/.env"
fi

# Install Node 22 from NodeSource only if a suitable system binary is absent.
export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl unzip
fi
if [[ ! -x /usr/bin/node ]] || ! /usr/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi

# Validate without echoing secrets. The app reads environment values first and
# then .env; systemd's fixed values below cannot silently turn authentication off.
/usr/bin/node - "$ENV_SOURCE" <<'NODE'
const fs = require('node:fs');
const vals = {};
for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  const s = line.trim().replace(/^export\s+/, '');
  if (!s || s.startsWith('#')) continue;
  const p = s.indexOf('='); if (p < 1) continue;
  const key = s.slice(0,p).trim(); let value=s.slice(p+1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
  if (vals[key] === undefined) vals[key]=value;
}
const secret=vals.ELFURA_SECRET || '';
const token=vals.ELFURA_RESOLVER_TOKEN === undefined ? secret : vals.ELFURA_RESOLVER_TOKEN;
const strong = value => value.length >= 24 && !/^(change[-_]?me|replace[-_]?with|example|your[-_])/i.test(value);
if (!strong(secret) || !strong(token)) {
  console.error('Set a strong ELFURA_SECRET and, if present, ELFURA_RESOLVER_TOKEN in .env. Both must match the Pterodactyl node.');
  process.exit(1);
}
NODE

curl -fsSL --retry 3 --connect-timeout 15 "$ZIP_URL" -o "$TMP/elfura.zip"
unzip -tq "$TMP/elfura.zip" >/dev/null || fail 'Downloaded archive failed its integrity check.'
unzip -Z1 "$TMP/elfura.zip" > "$TMP/entries"
if grep -Eq '(^/|(^|/)\.\.(/|$)|(^|/)\.env$|^data/)' "$TMP/entries"; then
  fail 'Archive has an unsafe entry or would overwrite .env/data; installation stopped.'
fi
id elfura-resolver >/dev/null 2>&1 || useradd --system --home-dir "$DEST" --no-create-home --shell /usr/sbin/nologin elfura-resolver
install -d -m 0755 -o root -g root "$DEST"
if [[ "$ENV_SOURCE" != "$DEST/.env" ]]; then install -m 0640 -o root -g elfura-resolver "$ENV_SOURCE" "$DEST/.env"; fi
chown root:elfura-resolver "$DEST/.env"
chmod 0640 "$DEST/.env"

# Existing data and configuration are excluded from the archive. Stop only
# after download/validation; never delete the install directory on an update.
if systemctl is-active --quiet elfura-resolver.service; then systemctl stop elfura-resolver.service; fi
unzip -oq "$TMP/elfura.zip" -d "$DEST"
install -d -m 0750 -o elfura-resolver -g elfura-resolver "$DEST/data"
cat > "$UNIT" <<'UNIT'
[Unit]
Description=Elfura source resolver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=elfura-resolver
Group=elfura-resolver
WorkingDirectory=/opt/elfura-resolver
Environment=NODE_ENV=production
Environment=ELFURA_RESOLVER_MODE=1
Environment=ELFURA_RESOLVER_LISTEN=127.0.0.1
Environment=ELFURA_RESOLVER_PORT=3002
Environment=ELFURA_RESOLVER_OPEN=0
Environment=ELFURA_SUPERVISE=0
ExecStart=/usr/bin/node /opt/elfura-resolver/index.js --resolver
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable --now elfura-resolver.service
ready=0
for _ in {1..20}; do
  if systemctl is-active --quiet elfura-resolver.service && curl -fsS --max-time 2 http://127.0.0.1:3002/resolver/api/health | grep -q '"ok":true'; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail 'Resolver failed to start. Run: sudo journalctl -u elfura-resolver -n 80 --no-pager'
printf '\nResolver is running at http://127.0.0.1:3002 (not exposed on the VPS network).\n'
printf 'Set the Cloudflare Tunnel public hostname service to http://127.0.0.1:3002.\n'
printf 'On the Pterodactyl streaming node: ELFURA_RESOLVER_URL=https://your-resolver-hostname and ELFURA_RESOLVER_ALLOW_PUBLIC=1.\n'
printf 'Both nodes must use the same ELFURA_SECRET and resolver token; restart the streaming node after changing its .env.\n'
