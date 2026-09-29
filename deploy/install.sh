#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=/opt/string-alert-panel
IP=103.204.174.231
ARCHIVE=${1:?Usage: bash install.sh /root/string-alert-panel-release-TIMESTAMP.tar.gz}

[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ -f "$ARCHIVE" ]] || { echo 'Missing release archive.' >&2; exit 1; }
[[ ! -e "$ROOT/compose.yaml" ]] || {
  echo 'An installation already exists. Refusing to replace its configuration.' >&2
  exit 1
}
command -v openssl >/dev/null
docker compose version >/dev/null
if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)18443$'; then
  echo 'Port 18443 is already in use.' >&2
  exit 1
fi
for container in string-alert-panel string-alert-gateway; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "Container $container already exists." >&2
    exit 1
  fi
done

# All application, gateway, credential and data files stay in this directory.
# No host nginx files, DNS, existing containers or firewall rules are changed.
install -d -m 700 "$ROOT" "$ROOT/secrets"
INCOMING=$(mktemp -d "$ROOT/.incoming.XXXXXXXX")
tar -xzf "$ARCHIVE" --no-same-owner -C "$INCOMING"
install -d -m 755 "$ROOT/app"
cp -a "$INCOMING/src" "$INCOMING/web" "$ROOT/app/"
install -m 644 "$INCOMING/package.json" "$ROOT/app/package.json"
chmod -R u=rwX,go=rX "$ROOT/app"
install -m 600 "$INCOMING/deploy/compose.yaml" "$ROOT/compose.yaml"
install -m 644 "$INCOMING/deploy/nginx.conf" "$ROOT/nginx.conf"
install -o 1000 -g 1000 -m 400 "$INCOMING/.env" "$ROOT/secrets/app.env"
install -d -o 1000 -g 1000 -m 700 "$ROOT/data"
for file in monitor-config.json state.json; do
  if [[ -f "$INCOMING/data/$file" ]]; then
    install -o 1000 -g 1000 -m 600 "$INCOMING/data/$file" "$ROOT/data/$file"
  fi
done

# Create credentials without placing plaintext in command arguments or logs.
PASSWORD=$(openssl rand -base64 24)
HASH=$(printf '%s\n' "$PASSWORD" | openssl passwd -apr1 -stdin)
printf 'ops:%s\n' "$HASH" > "$ROOT/secrets/panel.htpasswd"
printf 'URL: https://%s:18443/\nUsername: ops\nPassword: %s\n' "$IP" "$PASSWORD" > "$ROOT/secrets/panel-access.txt"
chmod 600 "$ROOT/secrets/panel-access.txt"
unset PASSWORD HASH

if [[ -r /etc/letsencrypt/live/jp.string.ink/fullchain.pem && -r /etc/letsencrypt/live/jp.string.ink/privkey.pem ]]; then
  cp -L /etc/letsencrypt/live/jp.string.ink/fullchain.pem "$ROOT/secrets/tls.crt"
  cp -L /etc/letsencrypt/live/jp.string.ink/privkey.pem "$ROOT/secrets/tls.key"
else
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -keyout "$ROOT/secrets/tls.key" -out "$ROOT/secrets/tls.crt" \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,IP:127.0.0.1"
fi
chown 1000:1000 "$ROOT/secrets/panel.htpasswd" "$ROOT/secrets/tls.key" "$ROOT/secrets/tls.crt"
chmod 400 "$ROOT/secrets/panel.htpasswd" "$ROOT/secrets/tls.key" "$ROOT/secrets/tls.crt"

docker compose -f "$ROOT/compose.yaml" config --quiet
docker compose -f "$ROOT/compose.yaml" up -d --wait --wait-timeout 120
printf 'DEPLOYMENT_READY\nURL: https://%s:18443/\nCredentials: %s/secrets/panel-access.txt\n' "$IP" "$ROOT"
openssl x509 -in "$ROOT/secrets/tls.crt" -noout -fingerprint -sha256 -enddate
docker compose -f "$ROOT/compose.yaml" ps
