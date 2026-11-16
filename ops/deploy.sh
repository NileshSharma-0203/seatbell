#!/bin/sh
# Usage: ops/deploy.sh <image>. Runs on the server. If the new version fails its health checks, the previous one comes back.
# Migrations run first and aren't reversed, so each migration must keep working with the previous release.
set -eu
cd /opt/seatbell
new="$1"
old="$(sed -n 's/^IMAGE=//p' .env | tail -1)"
services="db web worker caddy backup prometheus grafana"

export IMAGE="$new"
docker compose pull --quiet web
docker compose --profile tools run --rm migrate

if docker compose --profile monitoring up -d --wait --wait-timeout 90 $services; then
  sed -i '/^IMAGE=/d' .env
  echo "IMAGE=$new" >> .env
  [ -n "$old" ] && echo "$old" > .previous-image
  echo "deployed $new"
elif [ -n "$old" ]; then
  echo "health checks failed, rolling back to $old" >&2
  export IMAGE="$old"
  docker compose --profile monitoring up -d --wait --wait-timeout 90 $services
  exit 1
else
  echo "health checks failed and there is no previous version" >&2
  exit 1
fi
