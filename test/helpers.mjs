import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates an isolated data directory and pins the admin credentials BEFORE the
 * app module is imported. `src/index.js` reads env at module-evaluation time, so
 * this must run before the dynamic import.
 */
export const bootstrapEnv = async ({
  adminUser = "test-admin",
  adminPassword = "test-password-123",
  adminToken = "test-token-abcdef",
} = {}) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "asb-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_USER = adminUser;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.ADMIN_TOKEN = adminToken;
  // Sits between the concurrency test (20 requests, must all succeed) and the
  // flood test (40 requests, must be throttled).
  process.env.RATE_LIMIT_SUBMISSION = process.env.RATE_LIMIT_SUBMISSION || "30";
  return { dataDir, adminUser, adminPassword, adminToken };
};

/** Starts the express app on an ephemeral port and returns a fetch-based client. */
export const startServer = async () => {
  const { app, resetRateLimits } = await import("../src/index.js");

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const request = async (method, urlPath, { body, token, headers = {}, raw } = {}) => {
    const init = { method, headers: { ...headers } };
    const bodyless = method === "GET" || method === "HEAD";

    if (bodyless) {
      // fetch forbids a body on GET/HEAD; drop it rather than throw.
    } else if (raw !== undefined) {
      init.body = raw;
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }

    if (token) init.headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${base}${urlPath}`, init);
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text();

    return { status: response.status, headers: response.headers, body: payload };
  };

  return {
    base,
    request,
    /** Clears every rate-limit bucket so one test's flood does not starve the next. */
    resetLimits: resetRateLimits,
    get: (p, o) => request("GET", p, o),
    post: (p, o) => request("POST", p, o),
    put: (p, o) => request("PUT", p, o),
    del: (p, o) => request("DELETE", p, o),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

export const cleanup = async (dataDir) => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
};

/** 1x1 transparent PNG as a data URI, for image-upload tests. */
export const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Payloads that must never survive the blog HTML sanitizer. */
export const XSS_PAYLOADS = [
  { name: "script tag", html: '<p>hi</p><script>alert(1)</script>' },
  { name: "self-closing script src", html: '<script src="https://evil.test/x.js"></script>' },
  { name: "unclosed script tag", html: '<script src="https://evil.test/x.js">' },
  { name: "img onerror unquoted", html: '<img src=x onerror=alert(1)>' },
  { name: "img onerror quoted", html: '<img src="x" onerror="alert(1)">' },
  { name: "svg onload", html: '<svg onload=alert(1)></svg>' },
  { name: "body onload", html: '<body onload=alert(1)>' },
  { name: "iframe javascript src", html: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: "iframe external", html: '<iframe src="https://evil.test"></iframe>' },
  { name: "anchor javascript href", html: '<a href="javascript:alert(1)">click</a>' },
  { name: "anchor JaVaScRiPt href", html: '<a href="JaVaScRiPt:alert(1)">click</a>' },
  { name: "object data", html: '<object data="https://evil.test/x.swf"></object>' },
  { name: "embed src", html: '<embed src="https://evil.test/x">' },
  { name: "form action", html: '<form action="https://evil.test"><input name="p"></form>' },
  { name: "style expression", html: '<style>body{background:url(javascript:alert(1))}</style>' },
  { name: "onfocus autofocus", html: '<input autofocus onfocus=alert(1)>' },
  { name: "meta refresh", html: '<meta http-equiv="refresh" content="0;url=https://evil.test">' },
  { name: "base href hijack", html: '<base href="https://evil.test/">' },
];

/** Substrings that indicate an XSS payload survived sanitisation. */
export const DANGEROUS_MARKERS = [
  /<script/i,
  /<iframe/i,
  /<object/i,
  /<embed/i,
  /<form/i,
  /<style/i,
  /<base/i,
  /<meta/i,
  /\son\w+\s*=/i,
  /javascript:/i,
];
