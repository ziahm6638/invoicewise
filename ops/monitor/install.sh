#!/usr/bin/env bash
# shellcheck disable=SC2029 # remote commands deliberately embed local values
# Install or update the InvoiceWise monitor for one environment:
#   ops/monitor/install.sh production|staging [root@31.97.116.107]
# Runs on hostinger by default: a different host from production (hp-slice),
# so an hp-slice outage still alerts. Staging runs on hostinger too; its
# daily status mail stops if hostinger goes down.
#
# Reads OPS_TOKEN, SMTP_PASS and OPS_ALERT_TO from Infisical (`infisical
# export --env <env>`, run from the repo root while logged in) and writes them
# to root-only files on the host over SSH stdin: no value is printed or
# passed on a command line. Then enables the timer and runs one pass.
set -euo pipefail

env_name=${1:?usage: install.sh production|staging [host]}
host=${2:-root@31.97.116.107}
here=$(cd "$(dirname "$0")" && pwd)

case "$env_name" in
  production)
    infisical_env=prod
    api_url=https://api.invoicewise.uk
    app_url=https://app.invoicewise.uk
    ;;
  staging)
    infisical_env=staging
    api_url=https://iw-staging-api.zzapp.uk
    app_url=https://iw-staging-app.zzapp.uk
    ;;
  *)
    echo "environment must be production or staging" >&2
    exit 2
    ;;
esac

secrets=$(infisical export --env "$infisical_env" --format json 2>/dev/null)
value() { printf '%s' "$secrets" | jq -r --arg k "$1" '.[] | select(.key == $k) | .value'; }
for key in OPS_TOKEN SMTP_PASS OPS_ALERT_TO; do
  [ -n "$(value "$key")" ] || {
    echo "Infisical $infisical_env has no $key" >&2
    exit 1
  }
done

scp -q "$here/invoicewise-monitor" "$host:/usr/local/sbin/invoicewise-monitor"
scp -q "$here/invoicewise-monitor@.service" "$here/invoicewise-monitor@.timer" \
  "$host:/etc/systemd/system/"

{
  printf 'API_URL=%s\n' "$api_url"
  printf 'APP_URL=%s\n' "$app_url"
  printf 'OPS_TOKEN=%s\n' "$(value OPS_TOKEN)"
  printf 'SMTP_URL=smtps://smtp.purelymail.com:465\n'
  printf 'SMTP_USER=auth@invoicewise.uk\n'
  printf "ALERT_FROM='InvoiceWise Monitor <auth@invoicewise.uk>'\n"
  printf 'ALERT_TO=%s\n' "$(value OPS_ALERT_TO)"
  printf 'REPEAT_SECONDS=21600\n'
  printf 'DIGEST_HOUR=08\n'
} | ssh "$host" "umask 077 && mkdir -p /etc/invoicewise-monitor &&
  cat > /etc/invoicewise-monitor/$env_name.env"

printf 'machine smtp.purelymail.com login auth@invoicewise.uk password %s\n' \
  "$(value SMTP_PASS)" |
  ssh "$host" "umask 077 && cat > /etc/invoicewise-monitor/$env_name.netrc"

ssh "$host" "chmod 0755 /usr/local/sbin/invoicewise-monitor &&
  systemctl daemon-reload &&
  systemctl enable --now invoicewise-monitor@$env_name.timer &&
  systemctl start invoicewise-monitor@$env_name.service;
  systemctl --no-pager status invoicewise-monitor@$env_name.service | tail -5"
