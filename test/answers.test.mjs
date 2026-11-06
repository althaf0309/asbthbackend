/**
 * Quick facts and quotable answers: every keyword page must get answers that
 * stand alone when quoted, and must never claim what the course record lacks.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bootstrapEnv, cleanup, startServer } from "./helpers.mjs";
import { courseAnswers, courseFacts, keywordAnswers } from "../src/answers.js";

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const PHONE = "+91 87147 73304";
const words = (text) => text.split(/\s+/).length;

let env;
let api;
let courses;
let logisticsPages;
let aiPages;
const courseFor = (slug) => courses.find((c) => c.slug === slug);
const logisticsCourse = (page) => courseFor(page.family === "warehouse" ? "warehouse-management" : "logistics-supply-chain");

before(async () => {
  env = await bootstrapEnv();
  api = await startServer();
  courses = await json("courses.seed.json");
  logisticsPages = await json("seo-logistics-pages.json");
  aiPages = await json("seo-ai-pages.json");
});

after(async () => {
  await api?.close();
  await cleanup(env?.dataDir);
});

beforeEach(() => api?.resetLimits());

const assertQuotable = (answer, context) => {
  assert.match(answer.a, /ASB Training Hub/, `${context}: no institute name`);
  assert.ok(answer.a.includes(PHONE), `${context}: no phone number`);
  const count = words(answer.a);
  assert.ok(count >= 30 && count <= 75, `${context}: ${count} words`);
  assert.doesNotMatch(answer.a, /undefined|null|\[object/, context);
};

describe("quotable answers", () => {
  it("stand alone on every logistics and warehouse keyword page", () => {
    for (const page of logisticsPages) {
      const answers = keywordAnswers(page, logisticsCourse(page), page.location);
      assert.equal(answers.length, 6, page.slug);
      assert.equal(new Set(answers.map((a) => a.q)).size, 6, `${page.slug}: repeated question`);
      answers.forEach((answer) => assertQuotable(answer, page.slug));
    }
  });

  it("stand alone on every published course and AI keyword page", () => {
    for (const course of courses) courseAnswers(course).forEach((answer) => assertQuotable(answer, course.slug));
    for (const page of aiPages) {
      keywordAnswers(page, courseFor(`${page.family}-ai`), "").forEach((answer) => assertQuotable(answer, page.slug));
    }
  });

  it("lead with what was searched", () => {
    const course = courseFor("logistics-supply-chain");
    const first = (slug) => keywordAnswers(logisticsPages.find((p) => p.slug === slug), course, "")[0].q;
    assert.match(first("logistics-course-fees-in-kozhikode"), /fee/i);
    assert.match(first("logistics-course-after-12th-in-trivandrum"), /Plus Two/);
    assert.match(first("what-is-the-salary-after-a-logistics-course"), /jobs/i);
  });

  it("never invent fees, salaries, local branches or Plus Two eligibility", () => {
    for (const page of logisticsPages) {
      for (const { a } of keywordAnswers(page, logisticsCourse(page), page.location)) {
        assert.doesNotMatch(a, /(Rs\.?|₹|INR)\s*\d|\blakh\b|\bLPA\b/i, page.slug);
        assert.doesNotMatch(a, /\bbranch\b|\bour (centre|center) in\b/i, page.slug);
        assert.doesNotMatch(a, /(can|may) join .* after (Plus Two|12th)|Plus Two students can/i, page.slug);
      }
    }
  });

  it("describe remote districts as live online and Trivandrum as classroom", () => {
    const course = courseFor("warehouse-management");
    const mode = (place) => courseFacts(course, place).find((f) => f.label === "Mode").value;
    assert.equal(mode("Kochi"), "Live online from Kochi");
    assert.equal(mode("Kazhakootam"), course.mode);
    assert.equal(mode("Kerala"), course.mode);
    const kochi = keywordAnswers({ title: "x", intent: "course" }, course, "Kochi")[0].a;
    assert.match(kochi, /learners in Kochi join through live-online batches/);
  });
});

describe("answers on the site", () => {
  it("appear in the server HTML with FAQ and speakable schema", async () => {
    for (const path of [
      "/course/warehouse-management",
      "/course-training/Diploma-in-warehouse-Management/warehouse-course-in-kochi",
      "/course-training/agentic/ai/agentic-ai-course-kerala",
    ]) {
      const html = String((await api.get(path)).body);
      assert.match(html, /id="quick-facts"/, path);
      assert.match(html, /class="citable-answer"/, path);
      assert.equal((html.match(/"@type":"FAQPage"/g) || []).length, 1, path);
      assert.match(html, /"SpeakableSpecification"/, path);
    }
  });

  it("are served to the React pages, and 404 for unknown pages", async () => {
    const res = await api.get("/api/answers/keyword/warehouse/warehouse-course-in-kochi");
    assert.equal(res.status, 200);
    assert.equal(res.body.answers.length, 6);
    assert.ok(res.body.facts.length >= 6);
    assert.equal((await api.get("/api/answers/course/warehouse-management")).status, 200);
    assert.equal((await api.get("/api/answers/ai/agentic/agentic-ai-course-kerala")).status, 200);
    assert.equal((await api.get("/api/answers/keyword/warehouse/no-such-page")).status, 404);
    assert.equal((await api.get("/api/answers/course/no-such-course")).status, 404);
  });

  it("publish an RSS feed and state coverage in llms.txt", async () => {
    const feed = await api.get("/feed.xml");
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get("content-type"), /rss\+xml/);
    assert.match(String(feed.body), /<item>[\s\S]*\/blog\/[\s\S]*<\/item>/);
    const llms = String((await api.get("/llms.txt")).body);
    assert.match(llms, /## Coverage/);
    assert.match(llms, /Placement is not guaranteed/);
  });

  it("shorten long keyword titles to fit the search result", async () => {
    const page = logisticsPages.find((p) => `${p.title} | ASB Training Hub`.length > 60 && p.slug !== "diploma-in-logistics-and-supply-chain-management" && p.slug !== "diploma-in-warehouse-management");
    const res = await api.get(`/course-training/${page.family === "warehouse" ? "Diploma-in-warehouse-Management" : "Diploma-in-Logistics-and-Supply-Chain-Management"}/${page.slug}`);
    assert.match(String(res.body), /<title>[^<]* \| ASB<\/title>/);
  });
});
