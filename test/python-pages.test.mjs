/**
 * Python keyword pages under /course-training/python-full-stack: every keyword
 * is its own indexable page with unique snippets, real answers and honest
 * location wording.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bootstrapEnv, cleanup, startServer } from "./helpers.mjs";
import { courseFacts, keywordSeo } from "../src/answers.js";
import { PYTHON_PRIMARY_SLUG, isNearCampus, pythonPagePath, pythonPageSections } from "../src/pythonContent.js";

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const PHONE = "+91 87147 73304";

let env;
let api;
let pages;
let course;

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  pages = await json("seo-python-pages.json");
  course = (await json("courses.seed.json")).find((c) => c.slug === "python-full-stack");
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

beforeEach(() => api?.resetLimits());

describe("python keyword pages", () => {
  it("keep one page per keyword with unique slugs", () => {
    assert.ok(pages.length >= 440, `only ${pages.length} pages`);
    assert.equal(new Set(pages.map((p) => p.slug)).size, pages.length);
    assert.ok(pages.some((p) => p.slug === PYTHON_PRIMARY_SLUG));
  });

  it("give every page a distinct title and description within the result limits", () => {
    const titles = new Map();
    const descriptions = new Map();
    for (const page of pages) {
      const seo = keywordSeo(page, course, page.location);
      // A keyword longer than the limit is used whole, without the brand suffix.
      assert.ok(seo.title.length <= 60 || !seo.title.includes("|"), `${page.slug}: title ${seo.title.length}`);
      assert.ok(seo.description.length <= 155, `${page.slug}: description ${seo.description.length}`);
      assert.ok(!titles.has(seo.title), `${page.slug} repeats the title of ${titles.get(seo.title)}`);
      assert.ok(!descriptions.has(seo.description), `${page.slug} repeats the description of ${descriptions.get(seo.description)}`);
      titles.set(seo.title, page.slug);
      descriptions.set(seo.description, page.slug);
    }
  });

  it("write enough original copy on each page and never quote a fee or salary", () => {
    for (const page of pages) {
      const text = pythonPageSections(page).map((s) => s.text).join(" ");
      assert.ok(text.split(/\s+/).length >= 900, `${page.slug} is thin`);
      assert.doesNotMatch(text, /(₹|rs\.?\s?\d|inr\s?\d|lakh|\d+\s?lpa)/i, page.slug);
      assert.doesNotMatch(text, /guaranteed (placement|job)|100% placement/i, page.slug);
    }
  });

  it("say live online for towns away from the campus, and agree with the quick facts", () => {
    for (const page of pages.filter((p) => p.location && p.location !== "Kerala")) {
      const mode = courseFacts(course, page.location).find((f) => f.label === "Mode").value;
      const lead = pythonPageSections(page)[0].text;
      if (isNearCampus(page.location)) {
        assert.equal(mode, course.mode, page.slug);
        assert.match(lead, /attend the classroom/, page.slug);
      } else {
        assert.match(mode, /^Live online from /, page.slug);
        assert.match(lead, /live-online batches/, page.slug);
        assert.match(lead, /no separate branch/, page.slug);
      }
    }
  });

  it("server-render a keyword page with answers, a hero image and related links", async () => {
    const page = pages.find((p) => p.slug === "python-course-in-kochi") || pages.find((p) => p.slug !== PYTHON_PRIMARY_SLUG);
    const res = await api.get(pythonPagePath(page));
    assert.equal(res.status, 200);
    const html = String(res.body);
    assert.match(html, /id="quick-facts"/);
    assert.ok(html.includes(`/generated/python/${page.slug}.svg`));
    assert.ok(html.includes(`<link rel="canonical" href="https://www.asbtraininghub.com${pythonPagePath(page)}"`));
    assert.ok((html.match(/href="\/course-training\/python-full-stack\//g) || []).length >= 8, "too few related links");
    assert.ok(html.includes(PHONE));
  });

  it("serve the main keyword at the section root and redirect its slug there", async () => {
    const root = await api.get("/course-training/python-full-stack");
    assert.equal(root.status, 200);
    const links = String(root.body).match(/href="\/course-training\/python-full-stack\/[a-z0-9-]+"/g) || [];
    assert.equal(new Set(links).size, pages.length - 1, "main page must link to every keyword page");
    const old = await fetch(`${api.base}/course-training/python-full-stack/${PYTHON_PRIMARY_SLUG}`, { redirect: "manual" });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get("location"), "/course-training/python-full-stack");
  });

  it("serve the same answers and snippet to the React page", async () => {
    const page = pages.find((p) => p.intent === "fees");
    const res = await api.get(`/api/answers/python/${page.slug}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.answers.length, 6);
    assert.match(res.body.answers[0].a, /on request/);
    assert.equal((await api.get("/api/answers/python/not-a-page")).status, 404);
  });

  it("list every python page in the sitemap", async () => {
    const xml = String((await api.get("/sitemap.xml")).body);
    for (const page of pages) assert.ok(xml.includes(`<loc>https://www.asbtraininghub.com${pythonPagePath(page)}</loc>`), page.slug);
  });
});
