/**
 * Course API: public reads, admin CRUD, pagination, two images, SEO rendering.
 *
 * Courses moved from a bundled TypeScript file into this store, so these tests
 * also guard the migration itself - every structured field must survive a round
 * trip, or the public pages silently lose their syllabus and FAQs.
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

/* ------------------------------------------------------------------ *
 * Migration integrity
 * ------------------------------------------------------------------ */
describe("catalogue seeded from the committed seed", () => {
  it("serves the full catalogue on first run", async () => {
    const res = await api.get("/api/courses");
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 50, `expected the full catalogue, got ${res.body.length}`);
  });

  it("keeps every structured field the old static file had", async () => {
    const courses = (await api.get("/api/courses")).body;

    for (const field of [
      "syllabus", "tools", "careers", "whoShouldJoin",
      "learningOutcomes", "prerequisites", "projects", "faqs",
    ]) {
      const withField = courses.filter((c) => Array.isArray(c[field]) && c[field].length > 0);
      assert.ok(
        withField.length > 20,
        `only ${withField.length} courses have ${field} - the migration dropped data`,
      );
    }

    for (const c of courses) {
      assert.ok(c.title, `${c.slug} has no title`);
      assert.ok(c.description, `${c.slug} has no description`);
      assert.ok(c.duration, `${c.slug} has no duration`);
      assert.ok(c.mode, `${c.slug} has no mode`);
      assert.match(c.slug, /^[a-z0-9-]+$/);
    }
  });

  it("every course carries SEO fields", async () => {
    for (const c of (await api.get("/api/courses")).body) {
      assert.ok(c.metaTitle, `${c.slug} has no metaTitle`);
      assert.ok(c.metaDescription, `${c.slug} has no metaDescription`);
      assert.ok(c.keywords, `${c.slug} has no keywords`);
      assert.ok(c.metaDescription.length <= 300, `${c.slug} metaDescription too long`);
    }
  });

  it("has no duplicate slugs", async () => {
    const slugs = (await api.get("/api/courses")).body.map((c) => c.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });
});

/* ------------------------------------------------------------------ *
 * Public reads
 * ------------------------------------------------------------------ */
describe("public course API", () => {
  it("filters by category", async () => {
    const res = await api.get("/api/courses?category=ai");
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((c) => c.category === "ai"));
  });

  it("ignores an unknown category rather than returning nothing", async () => {
    const all = (await api.get("/api/courses")).body.length;
    const res = await api.get("/api/courses?category=not-a-category");
    assert.equal(res.body.length, all);
  });

  it("summary mode omits the heavy fields", async () => {
    const [full] = (await api.get("/api/courses")).body;
    const [summary] = (await api.get("/api/courses?summary=1")).body;

    assert.ok(full.syllabus.length > 0, "precondition: full record has a syllabus");
    assert.equal(summary.syllabus, undefined, "summary should not carry the syllabus");
    assert.equal(summary.content, undefined, "summary should not carry the body");
    for (const field of ["slug", "title", "description", "duration", "mode", "categoryLabel"]) {
      assert.ok(summary[field] !== undefined, `summary is missing ${field}`);
    }
  });

  it("serves a single course by slug and 404s an unknown one", async () => {
    const [first] = (await api.get("/api/courses?summary=1")).body;
    assert.equal((await api.get(`/api/courses/${first.slug}`)).status, 200);
    assert.equal((await api.get("/api/courses/no-such-course")).status, 404);
  });

  it("reports category counts that match the catalogue", async () => {
    const cats = (await api.get("/api/course-categories")).body;
    const courses = (await api.get("/api/courses?summary=1")).body;

    assert.equal(cats.length, 5);
    for (const cat of cats) {
      const actual = courses.filter((c) => c.category === cat.id).length;
      assert.equal(cat.count, actual, `${cat.id} count is wrong`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Admin CRUD
 * ------------------------------------------------------------------ */
describe("admin course API", () => {
  const adminRoutes = [
    ["GET", "/api/admin/courses"],
    ["POST", "/api/admin/courses"],
    ["PUT", "/api/admin/courses/erp-finance-controlling"],
    ["DELETE", "/api/admin/courses/erp-finance-controlling"],
  ];

  it("requires authentication on every admin route", async () => {
    for (const [method, route] of adminRoutes) {
      assert.equal(
        (await api.request(method, route, { body: {} })).status,
        401,
        `${method} ${route} must require auth`,
      );
    }
  });

  it("paginates, and the pages tile the whole catalogue", async () => {
    const first = (await api.get("/api/admin/courses?page=1&perPage=10", { token })).body;
    assert.equal(first.page, 1);
    assert.equal(first.perPage, 10);
    assert.equal(first.items.length, 10);
    assert.ok(first.total >= 50);
    assert.equal(first.pages, Math.ceil(first.total / 10));

    const seen = new Set();
    for (let page = 1; page <= first.pages; page += 1) {
      const res = (await api.get(`/api/admin/courses?page=${page}&perPage=10`, { token })).body;
      for (const c of res.items) seen.add(c.slug);
    }
    assert.equal(seen.size, first.total, "paging skipped or repeated courses");
  });

  it("clamps an out-of-range page instead of returning nothing", async () => {
    const res = (await api.get("/api/admin/courses?page=9999&perPage=10", { token })).body;
    assert.equal(res.page, res.pages);
    assert.ok(res.items.length > 0);
  });

  it("searches by title and slug", async () => {
    const res = (await api.get("/api/admin/courses?search=python", { token })).body;
    assert.ok(res.total > 0);
    assert.ok(
      res.items.every((c) => `${c.title} ${c.slug}`.toLowerCase().includes("python")),
    );
  });

  it("creates a course with two images and returns both URLs", async () => {
    const res = await api.post("/api/admin/courses", {
      token,
      body: {
        title: "Quantum Widgets",
        description: "A test course used to verify creation.",
        category: "ai",
        overview: "Overview of quantum widgets.",
        syllabus: ["Module one", "Module two"],
        faqs: [{ q: "Is this real?", a: "It is a test fixture." }],
        imageData: PNG_DATA_URI,
        secondaryImageData: PNG_DATA_URI,
        metaTitle: "Quantum Widgets | ASB",
        metaDescription: "Test meta description.",
        keywords: "quantum, widgets",
      },
    });

    assert.equal(res.status, 201);
    const course = res.body.course;
    assert.equal(course.slug, "quantum-widgets");
    assert.match(course.imageUrl, /^\/uploads\/quantum-widgets-[\w-]+\.(png|jpg|webp|gif)$/);
    assert.match(course.secondaryImageUrl, /^\/uploads\/quantum-widgets-secondary-[\w-]+\./);
    assert.notEqual(course.imageUrl, course.secondaryImageUrl, "images must be distinct files");
    assert.equal(course.syllabus.length, 2);
    assert.equal(course.faqs.length, 1);

    // Both files are actually served.
    assert.equal((await api.get(course.imageUrl)).status, 200);
    assert.equal((await api.get(course.secondaryImageUrl)).status, 200);
  });

  it("requires a title and description", async () => {
    assert.equal(
      (await api.post("/api/admin/courses", { token, body: { description: "no title" } })).status,
      400,
    );
    assert.equal(
      (await api.post("/api/admin/courses", { token, body: { title: "No description" } })).status,
      400,
    );
  });

  it("de-duplicates a colliding slug", async () => {
    const res = await api.post("/api/admin/courses", {
      token,
      body: { title: "Quantum Widgets", description: "A second course with the same title." },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.course.slug, "quantum-widgets-2");
  });

  it("strips executable markup from the body", async () => {
    const res = await api.post("/api/admin/courses", {
      token,
      body: {
        title: "XSS Course",
        description: "Checks the sanitiser runs on course bodies too.",
        content: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>',
      },
    });
    assert.equal(res.status, 201);
    const { content } = res.body.course;
    assert.ok(!/<script/i.test(content), "script survived");
    assert.ok(!/\son\w+\s*=/i.test(content), "event handler survived");
  });

  it("rejects a non-image upload", async () => {
    const res = await api.post("/api/admin/courses", {
      token,
      body: {
        title: "Bad Upload",
        description: "Should be rejected before anything is written.",
        imageData: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      },
    });
    assert.equal(res.status, 400);
  });

  it("an update that omits fields keeps the stored values", async () => {
    const before = (await api.get("/api/courses/quantum-widgets")).body;

    const res = await api.put("/api/admin/courses/quantum-widgets", {
      token,
      body: { title: "Quantum Widgets II", description: "Updated description only." },
    });
    assert.equal(res.status, 200);

    const after = res.body.course;
    assert.equal(after.title, "Quantum Widgets II");
    assert.deepEqual(after.syllabus, before.syllabus, "syllabus was cleared by a partial update");
    assert.deepEqual(after.faqs, before.faqs, "faqs were cleared by a partial update");
    assert.equal(after.imageUrl, before.imageUrl, "image was cleared by a partial update");
    assert.equal(after.secondaryImageUrl, before.secondaryImageUrl);
    assert.notEqual(after.updatedAt, after.createdAt);
  });

  it("clears an image only when explicitly asked", async () => {
    const res = await api.put("/api/admin/courses/quantum-widgets", {
      token,
      body: {
        title: "Quantum Widgets II",
        description: "Updated description only.",
        removeSecondaryImage: true,
      },
    });
    assert.equal(res.body.course.secondaryImageUrl, "");
    assert.notEqual(res.body.course.imageUrl, "", "the primary image should be untouched");
  });

  it("404s on an unknown slug for update and delete", async () => {
    assert.equal(
      (await api.put("/api/admin/courses/ghost", {
        token,
        body: { title: "t", description: "d" },
      })).status,
      404,
    );
    assert.equal((await api.del("/api/admin/courses/ghost", { token })).status, 404);
  });

  it("deletes a course and removes it from the public list", async () => {
    for (const slug of ["quantum-widgets", "quantum-widgets-2", "xss-course", "bad-upload"]) {
      await api.del(`/api/admin/courses/${slug}`, { token });
    }
    assert.equal((await api.get("/api/courses/quantum-widgets")).status, 404);
  });

  it("hides an unpublished course from the public API but not the admin one", async () => {
    const created = await api.post("/api/admin/courses", {
      token,
      body: { title: "Draft Course", description: "Not for visitors yet.", published: false },
    });
    const { slug } = created.body.course;

    assert.equal((await api.get(`/api/courses/${slug}`)).status, 404);
    assert.ok(!(await api.get("/api/courses")).body.some((c) => c.slug === slug));

    const admin = (await api.get(`/api/admin/courses?search=Draft`, { token })).body;
    assert.ok(admin.items.some((c) => c.slug === slug), "admin should still see the draft");

    await api.del(`/api/admin/courses/${slug}`, { token });
  });
});

/* ------------------------------------------------------------------ *
 * Server-rendered SEO
 * ------------------------------------------------------------------ */
describe("course pages are server-rendered for crawlers", () => {
  const jsonLdBlocks = (html) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => {
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  it("a course page carries its own title, canonical and description", async () => {
    const res = await api.get("/course/erp-finance-controlling");
    if (res.status !== 200) return; // frontend build absent
    const html = String(res.body);

    const canonical = html.match(/<link\s+rel=["']canonical["'][^>]*href=["']([^"']+)/i);
    assert.equal(canonical[1], "https://www.asbtraininghub.com/course/erp-finance-controlling");
    assert.equal((html.match(/<title>/gi) || []).length, 1);
    assert.ok(/<meta\s+name=["']description["']/i.test(html));
    assert.ok(!/noindex/i.test(html.split("</head>")[0]));
  });

  it("publishes Course, BreadcrumbList and FAQPage structured data", async () => {
    const res = await api.get("/course/erp-finance-controlling");
    if (res.status !== 200) return;

    const types = jsonLdBlocks(String(res.body)).map((b) => b["@type"]);
    assert.ok(types.includes("Course"), `no Course entity, got: ${types.join(", ")}`);
    assert.ok(types.includes("BreadcrumbList"), "no BreadcrumbList");
    assert.ok(types.includes("FAQPage"), "course FAQs are not published as schema");

    const course = jsonLdBlocks(String(res.body)).find((b) => b["@type"] === "Course");
    assert.equal(course.provider.name, "ASB Training Hub");
    assert.ok(course.hasCourseInstance?.length, "no hasCourseInstance for rich results");
    assert.ok(course.description.length > 50);
  });

  it("the listing pages are rendered with their own metadata", async () => {
    for (const [route, expected] of [
      ["/courses", "https://www.asbtraininghub.com/courses"],
      ["/courses/ai", "https://www.asbtraininghub.com/courses/ai"],
    ]) {
      const res = await api.get(route);
      if (res.status !== 200) continue;
      const canonical = String(res.body).match(/rel=["']canonical["'][^>]*href=["']([^"']+)/i);
      assert.equal(canonical[1], expected, `${route} has the wrong canonical`);

      const types = jsonLdBlocks(String(res.body)).map((b) => b["@type"]);
      assert.ok(types.includes("ItemList"), `${route} has no ItemList`);
      assert.ok(types.includes("BreadcrumbList"), `${route} has no breadcrumbs`);
    }
  });

  it("an unknown course 404s rather than soft-serving the SPA", async () => {
    assert.equal((await api.get("/course/definitely-not-a-course")).status, 404);
  });

  it("an unknown category falls through instead of rendering an empty page", async () => {
    const res = await api.get("/courses/not-a-category");
    assert.notEqual(res.status, 200);
  });

  it("every published course appears in the sitemap", async () => {
    const courses = (await api.get("/api/courses?summary=1")).body;
    const sitemap = (await api.get("/sitemap.xml")).body;

    for (const c of courses) {
      assert.ok(
        sitemap.includes(`https://www.asbtraininghub.com/course/${c.slug}`),
        `${c.slug} missing from sitemap`,
      );
    }
  });

  it("a newly created course reaches the sitemap without a rebuild", async () => {
    const created = await api.post("/api/admin/courses", {
      token,
      body: { title: "Sitemap Probe Course", description: "Checks dynamic sitemap inclusion." },
    });
    const { slug } = created.body.course;

    const sitemap = (await api.get("/sitemap.xml")).body;
    assert.ok(sitemap.includes(`/course/${slug}`), "dynamic sitemap did not pick up the new course");

    await api.del(`/api/admin/courses/${slug}`, { token });
  });
});
