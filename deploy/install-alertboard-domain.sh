#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

bundle=${1:?Usage: install-alertboard-domain.sh PEM_BUNDLE NGINX_CONFIG}
config=${2:?Usage: install-alertboard-domain.sh PEM_BUNDLE NGINX_CONFIG}
domain=alertboard.string.ink
cert_dir=/etc/nginx/ssl/alertboard.string.ink
available=/etc/nginx/sites-available/alertboard.string.ink.conf
enabled=/etc/nginx/sites-enabled/zz-alertboard.string.ink.conf
gateway_cert=/opt/string-alert-panel/secrets/tls.crt

test "$(id -u)" = 0
test -f "$bundle"
test -f "$config"
for target in "$cert_dir" "$available" "$enabled"; do
    if [[ -e "$target" || -L "$target" ]]; then
        printf 'Refusing to replace existing path: %s\n' "$target" >&2
        exit 1
    fi
done
nginx_config=$(nginx -T 2>/dev/null)
if grep -Eq '^[[:space:]]*server_name[[:space:]][^;]*alertboard\.string\.ink([[:space:];])' <<< "$nginx_config"; then
    printf 'An alertboard virtual host already exists; refusing to duplicate it.\n' >&2
    exit 1
fi
nginx -t
openssl verify -CAfile "$gateway_cert" -verify_hostname 103.204.174.231 "$gateway_cert"

work=$(mktemp -d /root/alertboard-install.XXXXXXXX)
created_cert=0
created_config=0
created_link=0
reloaded=0
committed=0
cleanup() {
    status=$?
    trap - EXIT
    if [[ "$committed" = 0 ]]; then
        [[ "$created_link" = 0 ]] || rm -f -- "$enabled"
        [[ "$created_config" = 0 ]] || rm -f -- "$available"
        if [[ "$created_cert" = 1 ]]; then
            rm -f -- "$cert_dir/origin.crt" "$cert_dir/origin.key" "$cert_dir/cloudflare-origin-ca.pem"
            rmdir -- "$cert_dir" 2>/dev/null || true
        fi
        if [[ "$reloaded" = 1 ]]; then
            nginx -t && systemctl reload nginx
        fi
        printf 'Domain deployment did not complete; new active configuration was rolled back.\n' >&2
    fi
    rm -f -- "$work/origin.crt" "$work/origin.key" "$work/cloudflare-origin-ca.pem" "$work/existing.sha256" "$work/headers"
    rmdir -- "$work" 2>/dev/null || true
    exit "$status"
}
trap cleanup EXIT

openssl x509 -in "$bundle" -out "$work/origin.crt"
openssl pkey -in "$bundle" -passin pass: -out "$work/origin.key"
cert_pub=$(openssl x509 -in "$work/origin.crt" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d ' ' -f 1)
key_pub=$(openssl pkey -in "$work/origin.key" -pubout -outform DER | sha256sum | cut -d ' ' -f 1)
test "$cert_pub" = "$key_pub"
openssl x509 -in "$work/origin.crt" -checkend 86400 -noout
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 30 \
    https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem -o "$work/cloudflare-origin-ca.pem"
openssl verify -CAfile "$work/cloudflare-origin-ca.pem" -verify_hostname "$domain" "$work/origin.crt"

sha256sum /etc/nginx/nginx.conf \
    /etc/nginx/sites-available/testai.string.ink.conf \
    /etc/nginx/sites-available/jp.string.ink.conf \
    /opt/string-alert-panel/nginx.conf > "$work/existing.sha256"

mkdir -p /etc/nginx/ssl
mkdir -m 700 "$cert_dir"
created_cert=1
install -m 644 "$work/origin.crt" "$cert_dir/origin.crt"
install -m 600 "$work/origin.key" "$cert_dir/origin.key"
install -m 644 "$work/cloudflare-origin-ca.pem" "$cert_dir/cloudflare-origin-ca.pem"
install -m 644 "$config" "$available"
created_config=1
ln -s "$available" "$enabled"
created_link=1
nginx -t
systemctl reload nginx
reloaded=1

# Check the new vhost with certificate verification, not curl --insecure.
origin_curl=(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 15
    --cacert "$cert_dir/cloudflare-origin-ca.pem" --resolve "$domain:443:127.0.0.1")
ready=0
for attempt in 1 2 3 4 5; do
    code=$("${origin_curl[@]}" -o /dev/null -D "$work/headers" -w '%{http_code}' "https://$domain/") || code=000
    if [[ "$code" = 401 ]] && grep -qi '^WWW-Authenticate: Basic realm="String Operations"' "$work/headers"; then
        ready=1
        break
    fi
    sleep 1
done
test "$ready" = 1
test "$("${origin_curl[@]}" --fail "https://$domain/healthz")" = ok
for path in /vendor/vue.global.prod.js /monitor-view.js /monitor.css /api/schedule; do
    code=$("${origin_curl[@]}" -o /dev/null -w '%{http_code}' "https://$domain$path")
    test "$code" = 401
    printf 'AUTH_PROTECTED %s %s\n' "$path" "$code"
done
code=$(curl --noproxy '*' --silent --show-error --resolve "$domain:80:127.0.0.1" --max-time 10 \
    -o /dev/null -D "$work/headers" -w '%{http_code}' "http://$domain/")
test "$code" = 308
grep -qi "^Location: https://$domain/" "$work/headers"

for site in testai.string.ink jp.string.ink; do
    code=$(curl --noproxy '*' --silent --show-error --resolve "$site:443:127.0.0.1" --max-time 20 \
        -o /dev/null -w '%{http_code}' "https://$site/")
    test "$code" = 200
    printf 'EXISTING_SITE_OK %s %s\n' "$site" "$code"
done
sha256sum --check "$work/existing.sha256"
committed=1
printf 'ORIGIN_DEPLOYMENT_OK %s\n' "$domain"
printf 'Cloudflare must use Full (strict) for this hostname; public access requires separate verification.\n'
openssl x509 -in "$cert_dir/origin.crt" -noout -dates -ext subjectAltName
stat -c '%a %U:%G %n' "$cert_dir" "$cert_dir/origin.key"
