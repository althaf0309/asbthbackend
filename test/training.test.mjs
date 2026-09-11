/**
 * Training programmes: a second catalogue served by the same factory as
 * courses. These tests cover what genuinely differs - its own store, category
 * set, URL space and SEO routes - plus a check that the two stay isolated.
 */
import { after, before, beforeEach, describe, it } from "node:test";
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

beforeEach(() => api?.resetLimits());

describe("training catalogue", () => {
  it("seeds from its committed seed", async () => {
    const res = await api.get("/api/training");
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 3, `expected the seeded programmes, got ${res.body.length}`);

    for (const t of res.body) {
      assert.ok(t.title && t.description && t.duration && t.mode, `${t.slug} is incomplete`);
      assert.ok(t.metaTitle && t.metaDescription, `${t.slug} has no SEO fields`);
    }
  });

  it("uses its own category set, not the course one", async () => {
    const cats = (await api.get("/api/training-categories")).body;
    assert.deepEqual(
      cats.map((c) => c.id).sort(),
      ["bootcamp", "certification", "corporate", "online", "workshop"],
    );
  });

  it("filters by a training category", async () => {
    const res = await api.get("/api/training?category=workshop");
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((t) => t.category === "workshop"));
  });

  it("summary mode drops the heavy fields", async () => {
    const [summary] = (await api.get("/api/training?summary=1")).body;
    assert.equal(summary.syllabus, undefined);
    assert.equal(summary.content, undefined);
    assert.ok(summary.title && summary.duration);
  });

  it("404s an unknown programme", async () => {
    assert.equal((await api.get("/api/training/nope")).status, 404);
  });
});

describe("training is isolated from courses", () => {
  it("a course slug is not reachable as a training programme", async () => {
    const [course] = (await api.get("/api/courses?summary=1")).body;
    assert.equal((await api.get(`/api/training/${course.slug}`)).status, 404);
  });

  it("creating a programme does not change the course catalogue", async () => {
    const before = (await api.get("/api/courses?summary=1")).body.length;

    const created = await api.post("/api/admin/training", {
      token,
      body: { title: "Isolation Probe", description: "Checks the stores are separate." },
    });
    assert.equal(created.status, 201);

    const after = (await api.get("/api/courses?summary=1")).body.length;
    assert.equal(after, before, "creating training changed the course count");

    await api.del(`/api/admin/training/${created.body.item.slug}`, { token });
  });
});

describe("training admin API", () => {
  it("requires authentication", async () => {
    const routes = [
      ["GET", "/api/admin/training"],
      ["POST", "/api/admin/training"],
      ["PUT", "/api/admin/training/weekend-agentic-ai-workshop"],
      ["DELETE", "/api/admin/training/weekend-agentic-ai-workshop"],
    ];
    for (const [method, route] of routes) {
      assert.equal(
        (await api.request(method, route, { body: {} })).status,
        401,
        `${method} ${route} must require auth`,
      );
    }
  });

  it("paginates and searches", async () => {
    const page = (await api.get("/api/admin/training?page=1&perPage=2", { token })).body;
    assert.equal(page.perPage, 2);
    assert.ok(page.total >= 3);
    assert.equal(page.items.length, 2);

    const found = (await api.get("/api/admin/training?search=workshop", { token })).body;
    assert.ok(found.total >= 1);
  });

  it("creates a programme with two images and sanitises the body", async () => {
    const res = await api.post("/api/admin/training", {
      token,
      body: {
        title: "Data Literacy Day",
        description: "A one-day session for non-technical teams.",
        category: "corporate",
        duration: "1 day",
        mode: "On-site",
        syllabus: ["Reading a chart honestly", "Spotting a misleading axis"],
        faqs: [{ q: "Is it technical?", a: "No, it is aimed at non-technical teams." }],
        content: "<p>Fine</p><script>alert(1)</script>",
        imageData: PNG_DATA_URI,
        secondaryImageData: PNG_DATA_URI,
      },
    });

    assert.equal(res.status, 201);
    const item = res.body.item;
    assert.equal(item.slug, "data-literacy-day");
    assert.equal(item.category, "corporate");
    assert.ok(item.imageUrl && item.secondaryImageUrl);
    assert.notEqual(item.imageUrl, item.secondaryImageUrl);
    assert.ok(!/<script/i.test(item.content), "script survived the sanitiser");
    assert.equal(item.syllabus.length, 2);
    assert.equal(item.faqs.length, 1);
  });

  it("falls back to the training default for a category from another catalogue", async () => {
    const res = await api.post("/api/admin/training", {
      token,
      body: {
        title: "Odd Category",
        description: "Category belongs to the course catalogue, not this one.",
        category: "erp",
      },
    });
    assert.equal(res.body.item.category, "corporate", "should fall back to the training default");
    await api.del(`/api/admin/training/${res.body.item.slug}`, { token });
  });

  it("a partial update keeps stored fields", async () => {
    const before = (await api.get("/api/training/data-literacy-day")).body;

    const res = await api.put("/api/admin/training/data-literacy-day", {
      token,
      body: { title: "Data Literacy Day II", description: "Updated description only." },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.item.syllabus, before.syllabus);
    assert.deepEqual(res.body.item.faqs, before.faqs);
    assert.equal(res.body.item.imageUrl, before.imageUrl);
  });

  it("deletes and disappears from the public list", async () => {
    assert.equal((await api.del("/api/admin/training/data-literacy-day", { token })).status, 200);
    assert.equal((await api.get("/api/training/data-literacy-day")).status, 404);
  });
});

describe("training pages are server-rendered", () => {
  const jsonLdTypes = (html) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => {
        try {
          return JSON.parse(m[1])["@type"];
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  it("a programme page has its own canonical and structured data", async () => {
    const res = await api.get("/training/weekend-agentic-ai-workshop");
    if (res.status !== 200) return; // frontend build absent
    const html = String(res.body);

    const canonical = html.match(/rel=["']canonical["'][^>]*href=["']([^"']+)/i);
    assert.equal(
      canonical[1],
      "https://www.asbtraininghub.com/training/weekend-agentic-ai-workshop",
    );

    const types = jsonLdTypes(html);
    assert.ok(types.includes("Course"), `no Course entity: ${types.join(", ")}`);
    assert.ok(types.includes("BreadcrumbList"), "no BreadcrumbList");
    assert.ok(types.includes("FAQPage"), "programme FAQs are not published as schema");
  });

  it("the listing and category pages render with their own canonicals", async () => {
    const pages = [
      ["/training", "https://www.asbtraininghub.com/training"],
      ["/training/category/workshop", "https://www.asbtraininghub.com/training/category/workshop"],
    ];

    for (const [route, expected] of pages) {
      const res = await api.get(route);
      if (res.status !== 200) continue;
      const canonical = String(res.body).match(/rel=["']canonical["'][^>]*href=["']([^"']+)/i);
      assert.equal(canonical[1], expected, `${route} has the wrong canonical`);
      assert.ok(jsonLdTypes(String(res.body)).includes("ItemList"), `${route} has no ItemList`);
    }
  });

  it("an unknown programme 404s", async () => {
    assert.equal((await api.get("/training/not-a-programme")).status, 404);
  });

  it("every published programme is in the sitemap", async () => {
    const programmes = (await api.get("/api/training?summary=1")).body;
    const sitemap = (await api.get("/sitemap.xml")).body;

    for (const t of programmes) {
      assert.ok(
        sitemap.includes(`https://www.asbtraininghub.com/training/${t.slug}`),
        `${t.slug} missing from sitemap`,
      );
    }
    assert.ok(sitemap.includes("/training/category/workshop"), "category pages missing");
  });
});
