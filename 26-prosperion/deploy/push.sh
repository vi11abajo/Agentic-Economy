#!/usr/bin/env bash
# Ship a fresh build to the box: compiled code, pages, unit and nginx files. Secrets never travel with it;
# /opt/prosperion/.env is created once on the server and only appended to there.
# Usage (from 26-prosperion/): npm run build && bash deploy/push.sh
set -euo pipefail
HOST=${HOST:-pharos-server}

tar -czf - package.json package-lock.json --exclude='*.test.js' dist web deploy hermes skill | ssh "$HOST" 'set -e
  stage=$(mktemp -d)
  tar -xzf - -C "$stage"
  install -d -o prosperion -g prosperion /opt/prosperion/app /opt/prosperion/data
  rm -rf /opt/prosperion/app/dist
  cp -r "$stage/package.json" "$stage/package-lock.json" "$stage/dist" /opt/prosperion/app/
  chown -R prosperion:prosperion /opt/prosperion/app
  sudo -u prosperion -H bash -lc "cd /opt/prosperion/app && npm ci --omit=dev --no-audit --no-fund --silent"

  # pages: replace everything except the wallet test page that already lives there
  find /opt/prosperion/www -mindepth 1 -maxdepth 1 ! -name wallet-test -exec rm -rf {} +
  cp -r "$stage/web/." /opt/prosperion/www/

  if [ ! -f /opt/prosperion/.env ]; then
    key=$(grep -E "^API_SERVER_KEY=" /opt/prosperion/home/.hermes/.env | cut -d= -f2-)
    umask 027
    printf "HERMES_API_KEY=%s\nAGENT_DAILY_CAP=200\nTELEGRAM_BOT_TOKEN=\nPROSPERION_GATE=\n" "$key" > /opt/prosperion/.env
    chown root:prosperion /opt/prosperion/.env
  fi

  # the agent: its role and the Prosper codex become SOUL.md, Hermes is restarted below to read it
  rm -rf /opt/prosperion/home/prosperion && install -d -o prosperion -g prosperion /opt/prosperion/home/prosperion
  cp -r "$stage/hermes" "$stage/skill" /opt/prosperion/home/prosperion/
  chown -R prosperion:prosperion /opt/prosperion/home/prosperion
  sudo -u prosperion -H bash /opt/prosperion/home/prosperion/hermes/apply.sh | grep -v "^✓"

  cp "$stage/deploy/prosperion.service" /etc/systemd/system/prosperion.service
  site=/etc/nginx/sites-available/prosperion.pharosfdv.xyz
  cp "$site" "$site.prev"
  cp "$stage/deploy/nginx-prosperion.conf" "$site"
  nginx -t || { cp "$site.prev" "$site"; echo "nginx config rejected, previous one restored"; exit 1; }
  systemctl daemon-reload
  systemctl enable --now prosperion.service
  systemctl restart prosperion.service
  sleep 2 && systemctl restart prosperion-hermes   # after the MCP port is back, so it connects at once
  systemctl reload nginx
  rm -rf "$stage"
  echo deployed'
