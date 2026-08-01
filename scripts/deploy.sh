#!/usr/bin/env bash
# Deploy Yggdrasil to the Pterodactyl-managed container on new-lithium.
#
# This is a DIST-ONLY deploy: the host has no .git and no src/, only dist/ + node_modules +
# package.json. Build here, ship dist/, install deps inside the container, restart.
#
#   ./scripts/deploy.sh            # build, ship, restart, verify
#   SKIP_BUILD=1 ./scripts/deploy.sh
set -euo pipefail

HOST="${HOST:-new-lithium}"
UUID="${UUID:-5f483015-a510-4aea-9474-2262cf6bbcb9}"   # yggdrasil ptero container
VOL="/var/lib/pterodactyl/volumes/$UUID"
CUID="${CUID:-999:995}"                                 # container runs as this uid:gid
YGG_URL="${YGG_URL:-https://api.valhallamc.dev}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%Y%m%dT%H%M%S)"

step(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "0. local gate"
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "tree is dirty — commit first"; exit 1; }
echo "  HEAD $(git -C "$SRC" rev-parse --short HEAD) on $(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
if [ -z "${SKIP_BUILD:-}" ]; then
  npm --prefix "$SRC" run typecheck
  npm --prefix "$SRC" test
  rm -rf "$SRC/dist" && npm --prefix "$SRC" run build
fi
[ -f "$SRC/dist/main.js" ] || { echo "no dist/main.js — build failed"; exit 1; }

step "1. backup the live build (rollback point)"
ssh "$HOST" "cd '$VOL' && tar czf 'rollback-$TS.tar.gz' dist package.json package-lock.json && ls -lh 'rollback-$TS.tar.gz'"

step "2. ship dist + manifests"
rsync -az --delete "$SRC/dist/" "$HOST:$VOL/dist/"
rsync -az "$SRC/package.json" "$SRC/package-lock.json" "$HOST:$VOL/"

step "3. deps (only when the lockfile moved)"
# Park node_modules by rename first: instant, and a failed install is one mv to undo. The running
# process keeps its open inodes, so it survives until the restart.
ssh "$HOST" "set -e; cd '$VOL'
  if [ -n \"\$(diff <(tar xzOf 'rollback-$TS.tar.gz' package-lock.json) package-lock.json || true)\" ]; then
    mv node_modules 'node_modules-bak-$TS'
    if docker exec -u $CUID -w /home/container '$UUID' npm ci --omit=dev --no-audit --no-fund; then
      echo '  npm ci OK'
    else
      echo '  npm ci FAILED — restoring'; rm -rf node_modules; mv 'node_modules-bak-$TS' node_modules; exit 1
    fi
  else
    echo '  lockfile unchanged — skipping npm ci'
  fi"

step "4. env check — the link REFUSES to boot without PLUGIN_WEBSOCKET=true"
ssh "$HOST" "grep -E '^(PLUGIN_WEBSOCKET|PLUGIN_BIFORESTING_LINK)=' '$VOL/.env' || true"
read -rp "  restart now? [y/N] " a; [ "$a" = y ] || { echo "aborted before restart"; exit 1; }

step "5. restart"
ssh "$HOST" "docker restart '$UUID' > /dev/null && echo restarted"

step "6. verify"
sleep 10
K=$(head -c16 /dev/urandom | base64)
for i in 1 2 3 4 5 6; do
  # MUST be a real HTTP/1.1 upgrade: a plain GET 404s even when healthy (noServer + manual
  # 'upgrade' handler), and curl defaults to HTTP/2 where Upgrade is meaningless.
  line=$(curl -s -i -N --http1.1 --max-time 10 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
          -H "Sec-WebSocket-Key: $K" -H 'Sec-WebSocket-Version: 13' "$YGG_URL/biforesting/" 2>/dev/null | head -1)
  echo "  attempt $i: ${line:-no response}"
  case "$line" in *101*) echo "  OK — link listener live"; exit 0 ;; esac
  sleep 5
done
echo "  NOT MOUNTED — check PLUGIN_WEBSOCKET and that the proxy forwards /biforesting/ upgrades"
echo "  rollback: ssh $HOST \"cd '$VOL' && tar xzf 'rollback-$TS.tar.gz' && docker restart '$UUID'\""
exit 1
