# Deploying

Read this once before the first deploy of these changes. Three things changed
that the old `git pull && npm install && pm2 restart` sequence does not handle.

## What changed that affects deployment

1. **The backend refuses to start without admin credentials.** There is no
   `admin`/`admin123` fallback any more. `pm2 restart` will crash-loop until
   `ADMIN_USER` and `ADMIN_PASSWORD` exist.
2. **The nginx config is rewritten** and now expects TLS certificates. It is not
   picked up by `systemctl reload` unless you copy it into place first.
3. **The frontend dropped 34 dependencies.** `npm install` alone can leave the
   old ones behind; use `npm ci` so the tree matches the lockfile.

---

## First deploy (once)

### 1. Backend credentials

```bash
cd /var/www/asbtraininghub/backend
cp .env.example .env
nano .env
```

Set at minimum:

```
ADMIN_USER=<pick a username>
ADMIN_PASSWORD=<at least 12 characters>
NODE_ENV=production
WEB3FORMS_ACCESS_KEY=<your key>
```

`.env` is loaded automatically and is gitignored. Without
`WEB3FORMS_ACCESS_KEY` submissions are still stored and visible in the admin
console, they just are not emailed.

```bash
chmod 600 .env
```

### 2. TLS certificates

The nginx config references
`/etc/letsencrypt/live/asbtraininghub.com/fullchain.pem`. If that does not
exist yet:

```bash
sudo certbot certonly --nginx -d asbtraininghub.com -d www.asbtraininghub.com
```

### 3. nginx config

```bash
sudo cp /var/www/asbtraininghub/deploy-nginx-asbtraininghub.conf \
        /etc/nginx/sites-available/asbtraininghub
sudo ln -sf /etc/nginx/sites-available/asbtraininghub \
            /etc/nginx/sites-enabled/asbtraininghub

sudo nginx -t          # MUST pass before reloading
sudo systemctl reload nginx
```

`nginx -t` validates before you reload. If it fails, nginx keeps serving the old
config, so a bad edit will not take the site down — but the reload silently does
nothing, which is why you check the test output rather than assuming.

The config declares two `limit_req_zone` directives. Those live in the `http{}`
context; since `sites-enabled/*` is included from inside `http{}`, they work
where they are. If nginx complains about a duplicate zone, another site file
already declares one with the same name.

---

## Every deploy

Deploy the backend first: it renders the blog pages from the frontend's built
`index.html`, so the order avoids a window where it reads a half-written build.

```bash
# --- backend ---
cd /var/www/asbtraininghub/backend
git pull origin main
npm ci --omit=dev
pm2 restart asb-backend
pm2 logs asb-backend --lines 20   # confirm it actually came up

# --- frontend ---
cd /var/www/asbtraininghub/frontend
git pull origin main
npm ci
npm run build

# --- nginx (only if the conf changed) ---
sudo nginx -t && sudo systemctl reload nginx
```

`npm ci` deletes `node_modules` and installs exactly the lockfile, which is what
you want after 34 dependencies were removed. `npm install` would leave orphans.

---

## Verify after deploying

```bash
# Backend is up and not crash-looping
curl -s https://www.asbtraininghub.com/api/health
# -> {"ok":true,"service":"asb-backend"}

# Real sitemap, not the SPA fallback
curl -sI https://www.asbtraininghub.com/sitemap.xml | grep -i content-type
# -> application/xml

# Security headers are being sent
curl -sI https://www.asbtraininghub.com/ | grep -iE 'strict-transport|content-security|x-frame|x-content-type'

# Compression and HTTP/2 (the two biggest performance wins)
curl -sI -H 'Accept-Encoding: gzip' --http2 https://www.asbtraininghub.com/assets/ -o /dev/null -w '%{http_version}\n'
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -D - https://www.asbtraininghub.com/ | grep -i content-encoding

# Fonts are self-hosted and cacheable
curl -sI https://www.asbtraininghub.com/fonts/inter-latin-variable.woff2 | head -3

# Admin login rejects the old default credentials
curl -s -X POST https://www.asbtraininghub.com/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# -> {"error":"Invalid username or password."}
```

Then, in a browser:

- Sign in at `/admin/blog` with the new credentials and confirm the blog list
  and submissions load.
- **Check Google Analytics Realtime.** The duplicate `gtag.js` load for
  `G-1MSBPYNK3L` was removed because the GTM container was already loading it.
  If traffic stops appearing for that property, GTM does not hold the tag after
  all — restore the standalone snippet in `index.html`.

---

## Rollback

```bash
cd /var/www/asbtraininghub/backend  && git reset --hard HEAD~1 && pm2 restart asb-backend
cd /var/www/asbtraininghub/frontend && git reset --hard HEAD~1 && npm ci && npm run build
```

The old nginx config is in git history alongside it. Note that rolling the
backend back past the credentials change re-enables the `admin`/`admin123`
fallback, so treat that as an emergency-only step.

---

## Windows note

`git add` failing with `fatal: mmap failed: Invalid argument` is usually a file
named `nul` in the working tree — a shell redirect on Windows creates one, and
Git cannot map a reserved device name. Delete it (`rm ./nul` from Git Bash) and
retry. `.gitignore` now blocks the reserved names.
