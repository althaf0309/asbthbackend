/**
 * pm2 process definition.
 *
 * Why this file exists: pm2 was started ad-hoc (`pm2 start npm -- start`, then
 * `pm2 start src/index.js`), and in that mode the process environment, working
 * directory and interpreter all depend on whatever shell happened to run the
 * command. That produced a backend which started perfectly in the foreground
 * but died silently under pm2.
 *
 * Everything is pinned here instead:
 *   - cwd            : the backend directory, resolved from this file
 *   - script         : node running src/index.js, with no npm wrapper in between
 *   - interpreter    : the same node that launches pm2
 *   - env            : read from .env HERE and handed to pm2 explicitly, so the
 *                      app does not depend on dotenv resolving anything at
 *                      runtime
 *
 * Usage:
 *   cd /var/www/asbtraininghub/backend
 *   pm2 delete asb-backend
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
const path = require("node:path");
const fs = require("node:fs");

const rootDir = __dirname;
const envPath = path.join(rootDir, ".env");

if (!fs.existsSync(envPath)) {
  throw new Error(
    `Missing ${envPath}. Copy .env.example to .env and set ADMIN_USER / ADMIN_PASSWORD.`,
  );
}

// Minimal .env parser - no dependency on dotenv being installed or on cwd.
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip one layer of matching quotes if present.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (key) env[key] = value;
}

for (const required of ["ADMIN_USER", "ADMIN_PASSWORD"]) {
  if (!env[required]) {
    throw new Error(
      `${envPath} has no active ${required} line. A leading # makes it a comment.`,
    );
  }
}

module.exports = {
  apps: [
    {
      name: "asb-backend",
      script: "src/index.js",
      cwd: rootDir,
      interpreter: process.execPath,
      exec_mode: "fork",
      instances: 1,

      env: { NODE_ENV: "production", ...env },

      // A crash loop should stop and stay stopped rather than spin thousands of
      // times and bury the original error in the log.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      merge_logs: true,
      time: true, // timestamp every line, so stale entries are obvious
      out_file: path.join(rootDir, "logs", "out.log"),
      error_file: path.join(rootDir, "logs", "error.log"),

      kill_timeout: 5000,
    },
  ],
};
