#!/bin/sh
# Nightly compressed dump, keeping 14 days. Copy /backups off the server too: a backup on the same disk isn't one.
set -u
while true; do
  file="/backups/seatbell-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if pg_dump -h db -U seatbell seatbell | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "backup written: $file"
  else
    rm -f "$file.tmp"
    echo "backup FAILED" >&2
  fi
  find /backups -name 'seatbell-*.sql.gz' -mtime +14 -delete
  sleep 86400
done
