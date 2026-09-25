#!/usr/bin/env bash
# Install or update the daily InvoiceWise container-log prune on a Kamal host:
#   ops/log-retention/install.sh root@100.90.24.83    # production (hp-slice)
#   ops/log-retention/install.sh root@31.97.116.107   # staging (hostinger)
# Copies the script and systemd units, enables the timer and runs one prune so
# a broken install shows up immediately.
set -euo pipefail

host=${1:-root@100.90.24.83}
here=$(cd "$(dirname "$0")" && pwd)

scp -q "$here/invoicewise-logs-prune" "$host:/usr/local/sbin/invoicewise-logs-prune"
scp -q "$here/invoicewise-logs-prune.service" "$here/invoicewise-logs-prune.timer" \
  "$host:/etc/systemd/system/"
ssh "$host" 'chmod 0755 /usr/local/sbin/invoicewise-logs-prune &&
  systemctl daemon-reload &&
  systemctl enable --now invoicewise-logs-prune.timer &&
  systemctl start invoicewise-logs-prune.service &&
  journalctl -u invoicewise-logs-prune.service -n 5 --no-pager'
