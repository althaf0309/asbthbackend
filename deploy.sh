#!/usr/bin/env bash
#
# Deploy ASB Training Hub.
#
#   sudo -u ubuntu bash /var/www/asbtraininghub/deploy.sh
#
# Safe to re-run. Stops at the first real failure instead of carrying on with
# stale code, which is what the old copy-paste sequence did.

set -euo pipefail

ROOT="${ASB_ROOT:-/var/www/asbtraininghub}"
FRONTEND="$ROOT/frontend"
BACKEND="$ROOT/backend"
PM2_APP="${PM2_APP:-asb-backend}"

bold() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$1"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$1"; }
die()  { printf '\n\033[31mFAILED:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight: the backend will not start without real credentials.
# ---------------------------------------------------------------------------
bold "Preflight"

[ -d "$BACKEND" ] || die "no backend at $BACKEND (set ASB_ROOT)"
[ -d "$FRONTEND" ] || die "no frontend at $FRONTEND (set ASB_ROOT)"

if [ ! -f "$BACKEND/.env" ]; then
  die "$BACKEND/.env is missing.
     cp $BACKEND/.env.example $BACKEND/.env
     nano $BACKEND/.env          # set ADMIN_USER and a 12+ char ADMIN_PASSWORD
     chmod 600 $BACKEND/.env"
fi

# A line starting with # is a comment, so `# ADMIN_USER=x` sets nothing and the
# app dies on the credential check. Require real, uncommented assignments.
for key in ADMIN_USER ADMIN_PASSWORD; do
  grep -qE "^[[:space:]]*$key=[^[:space:]]" "$BACKEND/.env" || die     "$BACKEND/.env has no active $key line.
     A leading # makes it a comment. The file needs, with no # in front:
       ADMIN_USER=<username>
       ADMIN_PASSWORD=<12+ characters>"
done

if grep -qiE '^[[:space:]]*(ADMIN_USER|ADMIN_PASSWORD)=(change-me|changeme|admin|admin123|password)' "$BACKEND/.env"; then
  die "$BACKEND/.env still holds placeholder credentials from .env.example.
     Those values are public in the repository. Edit the file and set real ones."
fi
ok ".env present with active, non-placeholder credentials"

# ---------------------------------------------------------------------------
# Backend first: it renders blog pages from the frontend's built index.html.
# ---------------------------------------------------------------------------
bold "Backend"
cd "$BACKEND"

# Clear accumulated logs so anything printed below is from this deploy only.
pm2 flush "$PM2_APP" >/dev/null 2>&1 || true

git fetch origin main --quiet
# The server is a deploy target, not a workspace - discard local drift rather
# than letting a stray file abort the pull and leave stale code running.
git reset --hard origin/main --quiet
ok "at $(git rev-parse --short HEAD)"

npm ci --omit=dev --silent
ok "dependencies installed"

# pm2 was configured to run `npm start`, which puts an npm wrapper between pm2
# and node. On restart pm2 signals npm, npm does not always forward it, and the
# orphaned node keeps port 5000 - so the replacement dies with EADDRINUSE and
# pm2 loops. Run node directly, with an explicit cwd, so there is nothing in
# between.
PORT_LOCAL="${BACKEND_PORT:-5000}"

if pm2 describe "$PM2_APP" 2>/dev/null | grep -qE 'script path.*npm|exec interpreter.*none'; then
  warn "pm2 runs this app through npm; re-registering it to run node directly"
  pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
  pm2 start src/index.js --name "$PM2_APP" --cwd "$BACKEND" >/dev/null
  pm2 save >/dev/null 2>&1 || true
  ok "pm2 re-registered on src/index.js"
else
  pm2 restart "$PM2_APP" --update-env >/dev/null
  ok "pm2 restart issued"
fi

# Anything still holding the port after that is an orphan from a previous run.
sleep 1
ORPHANS="$(pgrep -f 'node .*asbtraininghub/backend/src/index.js' | tr '
' ' ' || true)"
if [ -n "${ORPHANS// /}" ] && ! curl -fsS "http://127.0.0.1:$PORT_LOCAL/api/health" >/dev/null 2>&1; then
  warn "port $PORT_LOCAL busy but not answering - killing orphans: $ORPHANS"
  # shellcheck disable=SC2086
  kill $ORPHANS 2>/dev/null || true
  sleep 1
  pm2 restart "$PM2_APP" --update-env >/dev/null
fi

# pm2 reports "online" between crashes, so poll the health endpoint instead.
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT_LOCAL/api/health" >/dev/null 2>&1; then
    ok "health check passed"
    break
  fi
  [ "$i" = 15 ] && {
    warn "still down after 15s - diagnostics follow"
    echo "--- .env keys (values hidden) ---"
    sed 's/=.*/=<set>/' "$BACKEND/.env" 2>/dev/null || echo "  cannot read .env"
    ls -la "$BACKEND/.env" 2>/dev/null || true
    echo "--- what pm2 is executing ---"
    pm2 describe "$PM2_APP" 2>/dev/null | grep -iE 'script path|exec cwd|interpreter|status|restarts' || true
    echo "--- port $PORT_LOCAL ---"
    (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep ":$PORT_LOCAL" || echo "  nothing listening"
    echo "--- fresh log ---"
    pm2 logs "$PM2_APP" --lines 25 --nostream || true
    die "backend did not come up - see diagnostics above"
  }
  sleep 1
done

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
bold "Frontend"
cd "$FRONTEND"

git fetch origin main --quiet
# public/sitemap.xml used to be committed AND regenerated by every build, so it
# always aborted the pull. It is gitignored now; this clears any copy left from
# before that change.
git reset --hard origin/main --quiet
git clean -fdq -e node_modules -e dist
ok "at $(git rev-parse --short HEAD)"

npm ci --silent
ok "dependencies installed"

npm run build
ok "build complete"

# Catch a build that silently ran against stale code.
if ls dist/assets/*.jpg >/dev/null 2>&1; then
  warn "build emitted .jpg assets - expected .webp. Is this really the latest commit?"
fi
if [ ! -d dist/fonts ] && [ ! -f public/fonts/inter-latin-variable.woff2 ]; then
  warn "self-hosted fonts missing from the build"
fi

# ---------------------------------------------------------------------------
# nginx: only reload if the config actually validates.
# ---------------------------------------------------------------------------
bold "nginx"
if sudo nginx -t >/dev/null 2>&1; then
  sudo systemctl reload nginx
  ok "config valid, reloaded"
else
  sudo nginx -t || true
  warn "config did NOT validate - nginx left running the previous config"
fi

# ---------------------------------------------------------------------------
bold "Verify"
HOST="${SITE_HOST:-https://www.asbtraininghub.com}"

printf '   health   : %s\n' "$(curl -fsS "$HOST/api/health" || echo 'UNREACHABLE')"
printf '   sitemap  : %s\n' "$(curl -fsSI "$HOST/sitemap.xml" | grep -i '^content-type' | tr -d '\r' || echo 'UNREACHABLE')"
printf '   gzip     : %s\n' "$(curl -fsS -H 'Accept-Encoding: gzip' -o /dev/null -D - "$HOST/" | grep -i '^content-encoding' | tr -d '\r' || echo 'not enabled')"
printf '   defaults : %s\n' "$(curl -fsS -X POST "$HOST/api/admin/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' || echo 'UNREACHABLE')"

printf '\n\033[32mDone.\033[0m\n'
