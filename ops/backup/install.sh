#!/usr/bin/env bash
# Install or update the nightly InvoiceWise database backup on hp-slice:
#   ops/backup/install.sh [root@100.90.24.83]
# Copies the script and systemd units, enables the timer and runs one backup
# now so a broken install shows up immediately.
set -euo pipefail

host=${1:-root@100.90.24.83}
here=$(cd "$(dirname "$0")" && pwd)

scp -q "$here/invoicewise-backup" "$host:/usr/local/sbin/invoicewise-backup"
scp -q "$here/invoicewise-backup.service" "$here/invoicewise-backup.timer" \
  "$host:/etc/systemd/system/"
ssh "$host" 'chmod 0755 /usr/local/sbin/invoicewise-backup &&
  systemctl daemon-reload &&
  systemctl enable --now invoicewise-backup.timer &&
  systemctl start invoicewise-backup.service &&
  journalctl -u invoicewise-backup.service -n 5 --no-pager'
