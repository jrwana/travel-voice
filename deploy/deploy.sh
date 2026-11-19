#!/usr/bin/env bash
# First deploy (and manual redeploys) of the voice agent onto the shared server.
# Pulls main, builds and starts the container, registers its unlisted route with Caddy, and
# installs the timer that auto-deploys later commits once CI passes (autodeploy.sh).
# Usage: deploy/deploy.sh            (reads deploy/deploy.env)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$here/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$here/deploy.env"
fi
: "${DEPLOY_HOST:?set DEPLOY_HOST (see deploy/deploy.env.example)}"
: "${APP_HOST:?set APP_HOST}"

# The unlisted path: generated once, then reused so a shared link keeps working.
if [[ -z "${VOICE_PATH:-}" ]]; then
  VOICE_PATH="$(openssl rand -hex 12)"
  if [[ -f "$here/deploy.env" ]]; then
    sed -i.bak "s/^VOICE_PATH=.*/VOICE_PATH=$VOICE_PATH/" "$here/deploy.env" && rm -f "$here/deploy.env.bak"
  fi
  echo "Generated VOICE_PATH (saved to deploy/deploy.env)."
fi
[[ "$VOICE_PATH" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "VOICE_PATH must be URL-safe" >&2; exit 1; }

repo_url="$(git -C "$here/.." remote get-url origin)"

ssh -o StrictHostKeyChecking=accept-new "ubuntu@$DEPLOY_HOST" bash -s <<REMOTE
set -euo pipefail
sudo install -d -o ubuntu -g ubuntu /srv/voice
[[ -d /srv/voice/.git ]] || git clone -q '$repo_url' /srv/voice
cd /srv/voice
git fetch -q origin main
git reset -q --hard origin/main
# Server-only settings (OPENAI_API_KEY). Created empty once; never overwritten.
( umask 077; touch deploy/.env )
docker compose -f deploy/compose.yml up -d --build --remove-orphans
docker image prune -f >/dev/null
# Route /VOICE_PATH/ to the container. handle_path strips the prefix; the app uses relative URLs.
sudo install -d -o ubuntu -g ubuntu /srv/caddy-sites
cat > /srv/caddy-sites/voice.caddy <<CADDY
redir /$VOICE_PATH /$VOICE_PATH/ 308
handle_path /$VOICE_PATH/* {
	reverse_proxy voice:3001
}
CADDY
docker exec \$(docker ps -q --filter label=com.docker.compose.project=market-calibration --filter label=com.docker.compose.service=caddy) caddy reload --config /etc/caddy/Caddyfile
sudo install -m 644 deploy/systemd/voice-deploy.service deploy/systemd/voice-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now voice-deploy.timer >/dev/null
REMOTE

echo "Live at: https://$APP_HOST/$VOICE_PATH/"
