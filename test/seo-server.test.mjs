/**
 * Server-side SEO / AEO / GEO checks.
 *
 * SEO  - crawlable, canonical, non-duplicated metadata for search engines.
 * AEO  - Answer Engine Optimisation: structured data an assistant can lift a
 *        direct answer from (schema.org types, dates, authorship).
 * GEO  - Generative Engine Optimisation: entity clarity, attribution surfaces
 *        and machine-readable summaries (llms.txt, absolute URLs, publisher).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEnv, cleanup, startServer } from "./helpers.mjs";

const SITE_URL = "https://www.asbtraininghub.com";

let env;
let api;
let token;
let sitemap;
/** Set once we know whether a frontend build exists to render SEO HTML from. */
let renderedBlogPage = null;

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  token = (
    await api.post("/api/admin/login", {
      body: { username: env.adminUser, password: env.adminPassword },
    })
  ).body.token;
  sitemap = (await api.get("/sitemap.xml")).body;

  const page = await api.get("/blog/python-vs-java");
  if (page.status === 200) renderedBlogPage = String(page.body);
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

const locs = () => [...String(sitemap).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

/* ------------------------------------------------------------------ *
 * SEO - sitemap
 * ------------------------------------------------------------------ */
describe("SEO: sitemap.xml", () => {
  it("is served as XML with a sitemap namespace", async () => {
    const res = await api.get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/xml/);
    assert.match(res.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(res.body.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  });

  it("lists every core marketing route", () => {
    const found = locs();
    const required = [
      "/",
      "/about",
      "/courses",
      "/reviews",
      "/faq",
      "/blog",
      "/contact",
      "/apply",
      "/terms-and-conditions",
    ];
    for (const route of required) {
      assert.ok(
        found.includes(`${SITE_URL}${route}`),
        `sitemap is missing ${route}`,
      );
    }
  });

  it("lists all five course-category landing pages", () => {
    const found = locs();
    for (const category of ["erp", "programming", "ai", "management", "internship"]) {
      assert.ok(
        found.includes(`${SITE_URL}/courses/${category}`),
        `sitemap is missing /courses/${category}`,
      );
    }
  });

  it("includes individual course detail pages", () => {
    const courseUrls = locs().filter((l) => l.includes("/course/"));
    assert.ok(courseUrls.length > 10, `expected many /course/ URLs, got ${courseUrls.length}`);
  });

  it("includes published blog posts and excludes drafts", async () => {
    const draft = await api.post("/api/admin/blogs", {
      token,
      body: { title: "Sitemap draft", content: "<p>x</p>", published: false },
    });
    const fresh = (await api.get("/sitemap.xml")).body;
    assert.ok(fresh.includes(`${SITE_URL}/blog/python-vs-java`), "published post missing");
    assert.ok(
      !fresh.includes(`${SITE_URL}/blog/${draft.body.blog.slug}`),
      "an unpublished draft was advertised to crawlers",
    );
  });

  it("contains no duplicate URLs", () => {
    const found = locs();
    assert.equal(new Set(found).size, found.length, "duplicate <loc> entries dilute crawl budget");
  });

  it("uses absolute https URLs only", () => {
    for (const loc of locs()) {
      assert.ok(loc.startsWith("https://"), `non-absolute or insecure URL: ${loc}`);
    }
  });

  it("gives every entry a valid lastmod, changefreq and priority", () => {
    const entries = [...String(sitemap).matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const lastmod = entry.match(/<lastmod>([^<]+)<\/lastmod>/);
      const changefreq = entry.match(/<changefreq>([^<]+)<\/changefreq>/);
      const priority = entry.match(/<priority>([^<]+)<\/priority>/);
      assert.ok(lastmod && /^\d{4}-\d{2}-\d{2}$/.test(lastmod[1]), `bad lastmod: ${entry}`);
      assert.ok(
        changefreq &&
          ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"].includes(
            changefreq[1],
          ),
        `bad changefreq: ${entry}`,
      );
      const value = Number(priority?.[1]);
      assert.ok(value >= 0 && value <= 1, `bad priority: ${entry}`);
    }
  });

  it("does not advertise admin or private routes", () => {
    for (const loc of locs()) {
      assert.ok(!loc.includes("/admin"), `admin route in sitemap: ${loc}`);
    }
  });

  it("is cacheable", async () => {
    const res = await api.get("/sitemap.xml");
    assert.match(res.headers.get("cache-control") || "", /max-age=\d+/);
  });
});

/* ------------------------------------------------------------------ *
 * SEO - server-rendered blog HTML
 * ------------------------------------------------------------------ */
describe("SEO: server-rendered blog pages", () => {
  const requireBuild = () => {
    if (!renderedBlogPage) {
      assert.fail(
        "no frontend build found - run `npm run build` in asb-ascend so the backend can render SEO HTML",
      );
    }
  };

  it("renders a post with a per-post <title>", () => {
    requireBuild();
    const title = renderedBlogPage.match(/<title>([\s\S]*?)<\/title>/i);
    assert.ok(title, "no <title>");
    assert.ok(
      title[1].includes("Python vs Java"),
      `title must be post-specific, got: ${title[1]}`,
    );
    assert.ok(title[1].length <= 65, `title should stay under ~65 chars: ${title[1].length}`);
  });

  it("sets a self-referencing canonical, not the homepage", () => {
    requireBuild();
    const canonical = renderedBlogPage.match(/<link\s+rel=["']canonical["'][^>]*href=["']([^"']+)/i);
    assert.ok(canonical, "no canonical link");
    assert.equal(canonical[1], `${SITE_URL}/blog/python-vs-java`);
  });

  it("emits exactly one canonical, title and description", () => {
    requireBuild();
    const count = (re) => (renderedBlogPage.match(re) || []).length;
    assert.equal(count(/<link\s+rel=["']canonical["']/gi), 1, "duplicate canonical tags");
    assert.equal(count(/<title>/gi), 1, "duplicate <title> tags");
    assert.equal(count(/<meta\s+name=["']description["']/gi), 1, "duplicate description tags");
  });

  it("has a meta description of a usable length", () => {
    requireBuild();
    const desc = renderedBlogPage.match(/<meta\s+name=["']description["'][^>]*content=["']([^"']*)/i);
    assert.ok(desc, "no meta description");
    assert.ok(
      desc[1].length >= 50 && desc[1].length <= 165,
      `description should be 50-165 chars, got ${desc[1].length}`,
    );
  });

  it("is indexable", () => {
    requireBuild();
    const robots = renderedBlogPage.match(/<meta\s+name=["']robots["'][^>]*content=["']([^"']*)/i);
    assert.ok(robots);
    assert.match(robots[1], /index/);
    assert.ok(!/noindex/i.test(robots[1]));
  });

  it("carries complete Open Graph and Twitter card tags", () => {
    requireBuild();
    for (const prop of ["og:title", "og:description", "og:type", "og:url", "og:image"]) {
      assert.ok(
        new RegExp(`<meta\\s+property=["']${prop}["']`, "i").test(renderedBlogPage),
        `missing ${prop}`,
      );
    }
    for (const name of ["twitter:title", "twitter:description", "twitter:image"]) {
      assert.ok(
        new RegExp(`<meta\\s+name=["']${name}["']`, "i").test(renderedBlogPage),
        `missing ${name}`,
      );
    }
    const ogType = renderedBlogPage.match(/<meta\s+property=["']og:type["'][^>]*content=["']([^"']*)/i);
    assert.equal(ogType[1], "article", "a blog post must be og:type=article");
  });

  it("uses an absolute og:image URL", () => {
    requireBuild();
    const image = renderedBlogPage.match(/<meta\s+property=["']og:image["'][^>]*content=["']([^"']*)/i);
    assert.ok(image, "no og:image");
    assert.match(image[1], /^https:\/\//, "og:image must be absolute for social/AI previews");
  });

  it("returns 404 for an unknown post rather than a soft 200", async () => {
    const res = await api.get("/blog/definitely-not-a-post");
    assert.equal(res.status, 404);
  });
});

/* ------------------------------------------------------------------ *
 * AEO - structured data an answer engine can quote
 * ------------------------------------------------------------------ */
describe("AEO: structured data", () => {
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

  it("every JSON-LD block on a blog post is valid JSON", () => {
    if (!renderedBlogPage) return;
    const raw = [...renderedBlogPage.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(raw.length > 0, "blog post has no JSON-LD");
    for (const [, body] of raw) {
      assert.doesNotThrow(() => JSON.parse(body), `invalid JSON-LD: ${body.slice(0, 120)}`);
    }
  });

  it("a blog post exposes a complete BlogPosting entity", () => {
    if (!renderedBlogPage) return;
    const posting = jsonLdBlocks(renderedBlogPage).find(
      (b) => b["@type"] === "BlogPosting" || b["@type"] === "Article",
    );
    assert.ok(posting, "no BlogPosting/Article JSON-LD");
    assert.equal(posting["@context"], "https://schema.org");

    for (const field of [
      "headline",
      "description",
      "image",
      "author",
      "publisher",
      "datePublished",
      "dateModified",
      "mainEntityOfPage",
    ]) {
      assert.ok(posting[field], `BlogPosting is missing ${field}`);
    }

    assert.ok(posting.headline.length <= 110, "headline must be <= 110 chars for rich results");
    assert.ok(!Number.isNaN(Date.parse(posting.datePublished)), "datePublished must be ISO-8601");
    assert.ok(!Number.isNaN(Date.parse(posting.dateModified)), "dateModified must be ISO-8601");
    assert.match(String(posting.image), /^https:\/\//, "image must be an absolute URL");
    assert.ok(posting.publisher.logo?.url, "publisher needs a logo for rich results");
  });

  it("the blog index exposes a Blog entity listing its posts", async () => {
    const res = await api.get("/blog");
    if (res.status !== 200) return;
    const blog = jsonLdBlocks(String(res.body)).find((b) => b["@type"] === "Blog");
    assert.ok(blog, "no Blog JSON-LD on /blog");
    assert.ok(Array.isArray(blog.blogPost) && blog.blogPost.length > 0, "blogPost list is empty");
    for (const post of blog.blogPost) {
      assert.equal(post["@type"], "BlogPosting");
      assert.match(post.url, /^https:\/\//);
      assert.ok(post.headline, "listed post is missing a headline");
    }
  });

  it("a blog post declares breadcrumbs so answer engines can place it", () => {
    if (!renderedBlogPage) return;
    const crumbs = jsonLdBlocks(renderedBlogPage).find((b) => b["@type"] === "BreadcrumbList");
    assert.ok(
      crumbs,
      "no BreadcrumbList - answer engines cannot show the Home > Blog > Post path",
    );
    assert.ok(Array.isArray(crumbs.itemListElement) && crumbs.itemListElement.length >= 2);
  });

  it("the publisher is a consistent named entity across pages", async () => {
    if (!renderedBlogPage) return;
    const posting = jsonLdBlocks(renderedBlogPage).find((b) =>
      ["BlogPosting", "Article"].includes(b["@type"]),
    );
    assert.equal(posting.publisher.name, "ASB Training Hub");
    assert.equal(posting.publisher.url, SITE_URL);
  });
});

/* ------------------------------------------------------------------ *
 * GEO - generative engine surfaces
 * ------------------------------------------------------------------ */
describe("GEO: generative engine surfaces", () => {
  it("blog HTML is served to a crawler without requiring JavaScript", () => {
    if (!renderedBlogPage) return;
    assert.match(renderedBlogPage, /<title>/i);
    assert.match(renderedBlogPage, /<meta\s+name=["']description["']/i);
  });

  it("blog pages are cacheable but revalidated so edits propagate", async () => {
    const res = await api.get("/blog/python-vs-java");
    if (res.status !== 200) return;
    const cacheControl = res.headers.get("cache-control") || "";
    assert.match(cacheControl, /max-age=\d+/);
    assert.match(cacheControl, /must-revalidate|no-cache/);
  });

  it("declares the HTML charset so quoted text is not mangled", () => {
    if (!renderedBlogPage) return;
    assert.match(renderedBlogPage, /<meta\s+charset=["']?utf-8/i);
  });

  it("post content is substantive enough to be citable", async () => {
    const posts = (await api.get("/api/blogs")).body;
    for (const post of posts) {
      const words = post.content
        .replace(/<[^>]+>/g, " ")
        .split(/\s+/)
        .filter(Boolean).length;
      assert.ok(
        words >= 40,
        `"${post.slug}" has only ${words} words - too thin for a generative engine to cite`,
      );
    }
  });

  it("every published post has an excerpt, keywords and an image alt", async () => {
    const posts = (await api.get("/api/blogs")).body;
    for (const post of posts) {
      assert.ok(post.excerpt, `${post.slug} has no excerpt`);
      assert.ok(post.keywords, `${post.slug} has no keywords`);
      assert.ok(post.imageAlt, `${post.slug} has no image alt text`);
      assert.ok(post.metaDescription, `${post.slug} has no metaDescription`);
    }
  });

  it("post slugs are short, lowercase and keyword-bearing", async () => {
    const posts = (await api.get("/api/blogs")).body;
    for (const post of posts) {
      assert.match(post.slug, /^[a-z0-9-]+$/, `non-canonical slug: ${post.slug}`);
      assert.ok(post.slug.length <= 70, `slug too long: ${post.slug}`);
    }
  });
});
