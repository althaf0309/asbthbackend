import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  bootstrapEnv,
  cleanup,
  startServer,
  DANGEROUS_MARKERS,
  PNG_DATA_URI,
  XSS_PAYLOADS,
} from "./helpers.mjs";

let env;
let api;
let token;

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  const login = await api.post("/api/admin/login", {
    body: { username: env.adminUser, password: env.adminPassword },
  });
  token = login.body.token;
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

// The limiters are real now, so a suite that deliberately floods an endpoint
// would otherwise starve every test after it.
beforeEach(() => api?.resetLimits());

/* ------------------------------------------------------------------ *
 * A. Authentication
 * ------------------------------------------------------------------ */
describe("A. authentication", () => {
  it("A1 rejects login with a wrong password", async () => {
    const res = await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: "wrong" },
    });
    assert.equal(res.status, 401);
    assert.ok(!res.body.token, "no token must be issued on failed login");
  });

  it("A2 rejects login with a wrong username", async () => {
    const res = await api.post("/api/admin/login", {
      body: { username: "nobody", password: env.adminPassword },
    });
    assert.equal(res.status, 401);
  });

  it("A3 does not accept the shipped default credentials", async () => {
    const res = await api.post("/api/admin/login", {
      body: { username: "admin", password: "admin123" },
    });
    assert.equal(
      res.status,
      401,
      "the hardcoded admin/admin123 fallback must never authenticate",
    );
  });

  it("A4 does not authenticate on an empty body", async () => {
    const res = await api.post("/api/admin/login", { body: {} });
    assert.equal(res.status, 401);
  });

  it("A5 is not bypassable by type juggling in the credential fields", async () => {
    const payloads = [
      { username: { $ne: null }, password: { $ne: null } },
      { username: [env.adminUser], password: [env.adminPassword] },
      { username: true, password: true },
    ];
    for (const body of payloads) {
      const res = await api.post("/api/admin/login", { body });
      assert.equal(res.status, 401, `payload must not authenticate: ${JSON.stringify(body)}`);
    }
  });

  it("A6 issues a session-scoped token, not a fixed shared secret", async () => {
    const a = await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: env.adminPassword },
    });
    const b = await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: env.adminPassword },
    });
    assert.notEqual(
      a.body.token,
      b.body.token,
      "two logins must not return an identical, never-expiring token",
    );
  });

  it("A7 rate-limits repeated failed logins (brute-force protection)", async () => {
    const statuses = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await api.post("/api/admin/login", {
        body: { username: env.adminUser, password: `guess-${i}` },
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      "25 consecutive failed logins must eventually be throttled with HTTP 429",
    );
  });
});

/* ------------------------------------------------------------------ *
 * B. Authorisation
 * ------------------------------------------------------------------ */
describe("B. authorisation on admin routes", () => {
  const adminRoutes = [
    ["GET", "/api/admin/blogs"],
    ["GET", "/api/admin/submissions"],
    ["POST", "/api/admin/blogs"],
    ["PUT", "/api/admin/blogs/some-slug"],
    ["DELETE", "/api/admin/blogs/some-slug"],
    ["PUT", "/api/admin/submissions/inquiry/abc"],
  ];

  it("B1 rejects every admin route without a token", async () => {
    for (const [method, route] of adminRoutes) {
      const res = await api.request(method, route, { body: {} });
      assert.equal(res.status, 401, `${method} ${route} must require auth`);
    }
  });

  it("B2 rejects every admin route with a forged token", async () => {
    for (const [method, route] of adminRoutes) {
      const res = await api.request(method, route, { body: {}, token: "forged" });
      assert.equal(res.status, 401, `${method} ${route} must reject a bad token`);
    }
  });

  it("B3 rejects a non-Bearer authorization scheme", async () => {
    const res = await api.get("/api/admin/blogs", {
      headers: { Authorization: `Basic ${token}` },
    });
    assert.equal(res.status, 401);
  });

  it("B4 does not leak unpublished drafts through public routes", async () => {
    const draft = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Secret draft", content: "<p>unpublished</p>", published: false },
    });
    assert.equal(draft.status, 201);
    const slug = draft.body.blog.slug;

    const publicList = await api.get("/api/blogs");
    assert.ok(
      !publicList.body.some((b) => b.slug === slug),
      "drafts must not appear in /api/blogs",
    );
    assert.equal((await api.get(`/api/blogs/${slug}`)).status, 404);
    assert.equal((await api.get(`/blog/${slug}`)).status, 404);
  });

  it("B5 never exposes submitter PII on an unauthenticated route", async () => {
    await api.post("/api/inquiries", {
      body: { name: "Pii Probe", phone: "9999999999", email: "pii@example.com" },
    });

    for (const route of ["/api/blogs", "/api/health", "/sitemap.xml"]) {
      const res = await api.get(route);
      const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      assert.ok(!text.includes("pii@example.com"), `${route} leaked a submitter email`);
      assert.ok(!text.includes("9999999999"), `${route} leaked a submitter phone`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * C. Stored XSS via blog content
 * ------------------------------------------------------------------ */
describe("C. blog HTML sanitisation (stored XSS)", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`C: ${payload.name} is neutralised before storage`, async () => {
      const res = await api.post("/api/admin/blogs", {
        token,
        body: { title: `XSS ${payload.name}`, content: `<p>safe</p>${payload.html}` },
      });
      assert.equal(res.status, 201);

      const stored = res.body.blog.content;
      for (const marker of DANGEROUS_MARKERS) {
        assert.ok(!marker.test(stored), `sanitizer left ${marker} in: ${stored}`);
      }
    });
  }

  it("C: server-rendered blog page never emits an executable payload in <head>", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: {
        title: "Break out </title><script>alert(1)</script>",
        excerpt: '"><script>alert(2)</script>',
        metaDescription: '"><img src=x onerror=alert(3)>',
        keywords: '"><script>alert(4)</script>',
        content: "<p>body</p>",
      },
    });
    assert.equal(res.status, 201);

    const page = await api.get(`/blog/${res.body.blog.slug}`);
    if (page.status !== 200) return; // frontend build absent
    const head = String(page.body).split("</head>")[0];
    // Escaped text such as `&lt;img ... onerror=...&gt;` is inert; only an
    // actual unescaped tag or an attribute break-out is a finding.
    assert.ok(!/<script>alert/i.test(head), "unescaped script injected into <head>");
    assert.ok(!/<img\b/i.test(head), "unescaped <img> injected into <head>");
    const metaLines = head.match(/<meta[^>]*>/gi) || [];
    for (const line of metaLines) {
      assert.ok(
        !/content=["'][^"']*["'][^>]*\son\w+\s*=/i.test(line),
        `attribute break-out in meta tag: ${line}`,
      );
    }
  });

  it("C: JSON-LD block escapes a nested closing script tag", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "JSONLD </script><script>alert(1)</script>", content: "<p>x</p>" },
    });
    const page = await api.get(`/blog/${res.body.blog.slug}`);
    if (page.status !== 200) return;
    const match = String(page.body).match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    if (match) {
      assert.ok(
        !match[1].includes("</script"),
        "JSON-LD payload must not be able to close its own script tag",
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * D. Injection & traversal
 * ------------------------------------------------------------------ */
describe("D. injection and path traversal", () => {
  it("D1 slugs cannot contain path separators or traversal sequences", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { slug: "../../etc/passwd", title: "Traversal", content: "<p>x</p>" },
    });
    assert.equal(res.status, 201);
    const { slug } = res.body.blog;
    assert.match(slug, /^[a-z0-9-]+$/, `slug must be url-safe: ${slug}`);
  });

  it("D2 uploaded images stay inside the uploads directory", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: {
        slug: "../../pwned",
        title: "Upload traversal",
        content: "<p>x</p>",
        imageData: PNG_DATA_URI,
      },
    });
    assert.equal(res.status, 201);
    assert.match(res.body.blog.imageUrl, /^\/uploads\/[a-z0-9._-]+$/i);

    const files = await readdir(path.join(env.dataDir, "uploads"));
    for (const file of files) {
      assert.ok(!file.includes("/") && !file.includes("\\") && !file.includes(".."));
    }
  });

  it("D3 rejects non-image and disguised data URIs", async () => {
    const bad = [
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      "https://evil.test/payload.png",
      "data:image/png;base64,../../../etc/passwd",
    ];
    for (const imageData of bad) {
      const res = await api.post("/api/admin/blogs", {
        token,
        body: { title: `Bad image ${imageData.slice(0, 24)}`, content: "<p>x</p>", imageData },
      });
      assert.notEqual(res.status, 201, `must reject imageData: ${imageData.slice(0, 40)}`);
    }
  });

  it("D4 static /uploads does not serve files outside the uploads directory", async () => {
    const probes = [
      "/uploads/../submissions.json",
      "/uploads/..%2fsubmissions.json",
      "/uploads/%2e%2e/blogs.json",
      "/uploads/....//blogs.json",
    ];
    for (const probe of probes) {
      const res = await api.get(probe);
      const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      assert.ok(
        !text.includes('"inquiries"') && !text.includes('"applications"'),
        `traversal probe leaked the data store: ${probe}`,
      );
    }
  });

  it("D5 rejects an unknown submission type instead of touching the store", async () => {
    const res = await api.put("/api/admin/submissions/__proto__/abc", {
      token,
      body: { status: "hacked" },
    });
    assert.equal(res.status, 400);
  });

  it("D6 is not vulnerable to prototype pollution via a submitted payload", async () => {
    await api.post("/api/inquiries", {
      raw: JSON.stringify({
        name: "Proto",
        phone: "1234567890",
        __proto__: { polluted: "yes" },
        constructor: { prototype: { polluted: "yes" } },
      }),
    });
    assert.equal({}.polluted, undefined, "Object.prototype was polluted");
  });

  it("D7 sitemap XML-escapes untrusted slug values", async () => {
    await api.post("/api/admin/blogs", {
      token,
      body: {
        slug: 'evil"><url><loc>https://spam.test</loc></url><x y="',
        title: "Sitemap injection",
        content: "<p>x</p>",
      },
    });
    const res = await api.get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes("https://spam.test"),
      "attacker injected a URL into the sitemap",
    );
  });
});

/* ------------------------------------------------------------------ *
 * E. Abuse resistance and limits
 * ------------------------------------------------------------------ */
describe("E. abuse resistance and limits", () => {
  it("E1 rate-limits anonymous form submissions (spam/flood protection)", async () => {
    const statuses = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await api.post("/api/newsletters", {
        body: { email: `flood${i}@example.com` },
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.includes(429),
      "40 rapid anonymous submissions must eventually be throttled",
    );
  });

  it("E2 anonymous endpoints do not accept a multi-megabyte JSON body", async () => {
    const res = await api.post("/api/inquiries", {
      raw: JSON.stringify({ name: "x".repeat(2_000_000), phone: "1234567890" }),
    });
    assert.equal(
      res.status,
      413,
      "unauthenticated endpoints must cap the body well below the 15 MB admin limit",
    );
  });

  it("E3 rejects malformed JSON with 400, not 500", async () => {
    const res = await api.post("/api/inquiries", { raw: "{not json" });
    assert.equal(res.status, 400);
  });

  it("E4 validates required inquiry fields", async () => {
    assert.equal((await api.post("/api/inquiries", { body: {} })).status, 400);
    assert.equal((await api.post("/api/inquiries", { body: { name: "A" } })).status, 400);
    assert.equal(
      (await api.post("/api/inquiries", { body: { name: "A", phone: "1", email: "bad" } }))
        .status,
      400,
    );
  });

  it("E5 validates the phone number format", async () => {
    const res = await api.post("/api/inquiries", {
      body: { name: "Probe", phone: "<script>alert(1)</script>" },
    });
    assert.equal(res.status, 400, "a non-numeric phone value must be rejected");
  });

  it("E6 truncates oversized free-text instead of storing it whole", async () => {
    const res = await api.post("/api/inquiries", {
      body: { name: "Trunc", phone: "9876543210", message: "z".repeat(50_000) },
    });
    assert.equal(res.status, 201);
    const list = await api.get("/api/admin/submissions", { token });
    const stored = list.body.find((s) => s.id === res.body.id);
    assert.ok(stored.message.length <= 1000, "message must be capped at 1000 chars");
  });

  it("E7 does not lose writes under concurrent submissions", async () => {
    const before = (await api.get("/api/admin/submissions", { token })).body.length;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api.post("/api/newsletters", { body: { email: `race${i}@example.com` } }),
      ),
    );
    const after = (await api.get("/api/admin/submissions", { token })).body.length;
    assert.equal(
      after - before,
      20,
      "concurrent read-modify-write on the JSON store dropped submissions",
    );
  });

  it("E8 rejects an image larger than the documented 10 MB limit", async () => {
    const oversized = `data:image/png;base64,${"A".repeat(14_000_000)}`;
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Oversized", content: "<p>x</p>", imageData: oversized },
    });
    assert.notEqual(res.status, 201);
  });
});

/* ------------------------------------------------------------------ *
 * F. Response hardening
 * ------------------------------------------------------------------ */
describe("F. response hardening", () => {
  const securityHeaders = [
    ["x-content-type-options", /nosniff/i],
    ["x-frame-options", /(deny|sameorigin)/i],
    ["referrer-policy", /.+/],
    ["content-security-policy", /.+/],
  ];

  it("F1 sets baseline security headers", async () => {
    const res = await api.get("/api/health");
    for (const [header, pattern] of securityHeaders) {
      const value = res.headers.get(header);
      assert.ok(value && pattern.test(value), `missing or weak header: ${header}`);
    }
  });

  it("F2 does not advertise the server technology", async () => {
    const res = await api.get("/api/health");
    assert.equal(res.headers.get("x-powered-by"), null, "X-Powered-By must be disabled");
  });

  it("F3 does not leak stack traces or internal paths on error", async () => {
    const res = await api.get("/api/blogs/does-not-exist");
    const text = JSON.stringify(res.body);
    assert.ok(!/at\s+\w+\s+\(/.test(text), "response contains a stack frame");
    assert.ok(!/[A-Za-z]:\\|\/home\/|\/var\/www/.test(text), "response leaks a filesystem path");
  });

  it("F4 does not enable permissive CORS on admin endpoints", async () => {
    const res = await api.get("/api/admin/blogs", {
      token,
      headers: { Origin: "https://evil.test" },
    });
    assert.notEqual(
      res.headers.get("access-control-allow-origin"),
      "*",
      "wildcard CORS on an authenticated endpoint",
    );
  });
});
