import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEnv, cleanup, startServer, PNG_DATA_URI } from "./helpers.mjs";

let env;
let api;
let token;

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  token = (
    await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: env.adminPassword },
    })
  ).body.token;
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

describe("health and seed data", () => {
  it("reports healthy", async () => {
    const res = await api.get("/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, service: "asb-backend" });
  });

  it("seeds the six starter posts on first read", async () => {
    const res = await api.get("/api/blogs");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
    assert.ok(res.body.every((b) => b.slug && b.title && b.content));
  });

  it("serves a seeded post by slug and 404s an unknown one", async () => {
    assert.equal((await api.get("/api/blogs/python-vs-java")).status, 200);
    assert.equal((await api.get("/api/blogs/no-such-post")).status, 404);
  });
});

describe("blog CRUD", () => {
  it("creates a post and derives the slug from the title", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Hello ASB World!", content: "<p>first</p>", excerpt: "Intro" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.blog.slug, "hello-asb-world");
    assert.equal(res.body.blog.author, "ASB Team");
    assert.equal(res.body.blog.readTime, "5 min");
    assert.equal(res.body.blog.published, true);
  });

  it("de-duplicates a colliding slug instead of overwriting", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Hello ASB World!", content: "<p>second</p>" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.blog.slug, "hello-asb-world-2");
  });

  it("requires a title and content", async () => {
    assert.equal(
      (await api.post("/api/admin/blogs", { token, body: { content: "<p>x</p>" } })).status,
      400,
    );
    assert.equal(
      (await api.post("/api/admin/blogs", { token, body: { title: "No body" } })).status,
      400,
    );
  });

  it("falls back metaTitle/metaDescription to title/excerpt", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Meta fallback", content: "<p>x</p>", excerpt: "Excerpt text" },
    });
    assert.equal(res.body.blog.metaTitle, "Meta fallback");
    assert.equal(res.body.blog.metaDescription, "Excerpt text");
    assert.equal(res.body.blog.imageAlt, "Meta fallback");
  });

  it("stores an uploaded image and serves it back over /uploads", async () => {
    const res = await api.post("/api/admin/blogs", {
      token,
      body: { title: "With image", content: "<p>x</p>", imageData: PNG_DATA_URI },
    });
    assert.equal(res.status, 201);
    const served = await api.get(res.body.blog.imageUrl);
    assert.equal(served.status, 200);
  });

  it("updates a post and keeps the existing image when none is supplied", async () => {
    const created = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Keeps image", content: "<p>x</p>", imageData: PNG_DATA_URI },
    });
    const original = created.body.blog.imageUrl;

    const updated = await api.put(`/api/admin/blogs/${created.body.blog.slug}`, {
      token,
      body: { title: "Keeps image", content: "<p>edited</p>" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.blog.imageUrl, original);
    assert.equal(updated.body.blog.content, "<p>edited</p>");
    assert.notEqual(updated.body.blog.updatedAt, updated.body.blog.createdAt);
  });

  it("clears the image when removeImage is set", async () => {
    const created = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Drops image", content: "<p>x</p>", imageData: PNG_DATA_URI },
    });
    const updated = await api.put(`/api/admin/blogs/${created.body.blog.slug}`, {
      token,
      body: { title: "Drops image", content: "<p>x</p>", removeImage: true },
    });
    assert.equal(updated.body.blog.imageUrl, "");
  });

  it("404s when updating or deleting an unknown slug", async () => {
    assert.equal(
      (await api.put("/api/admin/blogs/ghost", { token, body: { title: "t", content: "<p>c</p>" } }))
        .status,
      404,
    );
    assert.equal((await api.del("/api/admin/blogs/ghost", { token })).status, 404);
  });

  it("deletes a post and removes it from the public list", async () => {
    const created = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Temporary post", content: "<p>x</p>" },
    });
    const slug = created.body.blog.slug;
    assert.equal((await api.del(`/api/admin/blogs/${slug}`, { token })).status, 200);
    assert.equal((await api.get(`/api/blogs/${slug}`)).status, 404);
  });
});

describe("submissions", () => {
  it("accepts a valid inquiry and records it", async () => {
    const res = await api.post("/api/inquiries", {
      body: {
        name: "Asha Kumar",
        email: "asha@example.com",
        phone: "9876543210",
        course: "erp",
        message: "Interested in SAP MM",
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);

    const list = await api.get("/api/admin/submissions", { token });
    const stored = list.body.find((s) => s.id === res.body.id);
    assert.equal(stored.type, "inquiry");
    assert.equal(stored.status, "new");
    assert.equal(stored.email, "asha@example.com");
  });

  it("treats email as optional for inquiries but required for applications", async () => {
    assert.equal(
      (await api.post("/api/inquiries", { body: { name: "No Email", phone: "9876543210" } }))
        .status,
      201,
    );
    assert.equal(
      (
        await api.post("/api/applications", {
          body: { name: "No Email", phone: "9876543210", course: "ai" },
        })
      ).status,
      400,
    );
  });

  it("accepts a complete application", async () => {
    const res = await api.post("/api/applications", {
      body: {
        name: "Ravi Menon",
        email: "ravi@example.com",
        phone: "9876500000",
        course: "ai",
        qualification: "BTech",
        preferredMode: "Online",
      },
    });
    assert.equal(res.status, 201);
  });

  it("validates the newsletter email", async () => {
    assert.equal((await api.post("/api/newsletters", { body: { email: "nope" } })).status, 400);
    assert.equal(
      (await api.post("/api/newsletters", { body: { email: "ok@example.com" } })).status,
      201,
    );
  });

  it("returns submissions newest-first", async () => {
    const list = await api.get("/api/admin/submissions", { token });
    const times = list.body.map((s) => new Date(s.createdAt).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    assert.deepEqual(times, sorted);
  });

  it("updates a submission status and note", async () => {
    const created = await api.post("/api/inquiries", {
      body: { name: "Status Test", phone: "9000000000" },
    });
    const res = await api.put(`/api/admin/submissions/inquiry/${created.body.id}`, {
      token,
      body: { status: "contacted", note: "Called on Monday" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.submission.status, "contacted");
    assert.equal(res.body.submission.note, "Called on Monday");
  });

  it("404s when updating an unknown submission id", async () => {
    const res = await api.put("/api/admin/submissions/inquiry/no-such-id", {
      token,
      body: { status: "contacted" },
    });
    assert.equal(res.status, 404);
  });

  it("records the real client IP rather than the proxy loopback", async () => {
    const created = await api.post("/api/inquiries", {
      body: { name: "Proxy Test", phone: "9111111111" },
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });
    const list = await api.get("/api/admin/submissions", { token });
    const stored = list.body.find((s) => s.id === created.body.id);
    assert.equal(
      stored.ip,
      "203.0.113.9",
      "app runs behind nginx; `trust proxy` must be enabled or every record shows 127.0.0.1",
    );
  });
});
