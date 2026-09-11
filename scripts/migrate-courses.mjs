#!/usr/bin/env node
/**
 * One-time migration: asb-ascend/src/data/courses.ts -> backend/data/courses.json
 *
 * Courses used to be a static TypeScript file baked into the bundle. They are
 * now admin-managed content, so they move into the same JSON store the blog
 * uses. Every field is carried across unchanged - syllabus, tools, careers,
 * who-should-join, learning outcomes, prerequisites, projects, certificate and
 * FAQs - so nothing a visitor sees changes; the pages simply become editable.
 *
 * The source is transpiled with esbuild rather than parsed with regexes, so the
 * result is exactly what the app was rendering.
 *
 *   node scripts/migrate-courses.mjs           # preview
 *   node scripts/migrate-courses.mjs --write   # write data/courses.json
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const frontend = path.resolve(rootDir, "..", "asb-ascend");
const write = process.argv.includes("--write");

const esbuildPath = path.join(frontend, "node_modules", "esbuild", "lib", "main.js");
if (!existsSync(esbuildPath)) {
  console.error(`esbuild not found at ${esbuildPath}. Run npm install in asb-ascend first.`);
  process.exit(1);
}
const esbuild = await import(pathToFileURL(esbuildPath).href);

/** Transpiles a .ts module to ESM JS and imports it via a data: URL. */
const loadTs = async (file, { stripImports = false } = {}) => {
  let source = await readFile(file, "utf8");
  if (stripImports) {
    // courses.ts pulls its category type from a sibling module; the type is
    // erased at runtime, and the re-export would need a resolvable specifier.
    source = source
      .replace(/^export type \{[^}]*\} from '[^']*';$/gm, "")
      .replace(/^import type \{[^}]*\} from '[^']*';$/gm, "")
      .replace(/^export \{ courseCategories \} from '[^']*';$/gm, "");
  }
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
};

const coursesMod = await loadTs(path.join(frontend, "src/data/courses.ts"), { stripImports: true });
const categoriesMod = await loadTs(path.join(frontend, "src/data/courseCategories.ts"));

const courses = coursesMod.courses;
const categories = categoriesMod.courseCategories;

if (!Array.isArray(courses) || !courses.length) {
  console.error("no courses parsed - aborting");
  process.exit(1);
}

const SITE = "https://www.asbtraininghub.com";
const now = new Date().toISOString();

/** Turns the structured fields into an editable HTML body for the rich editor. */
const buildContent = (c) => {
  const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  const parts = [`<p>${c.overview}</p>`];
  if (c.syllabus?.length) parts.push("<h2>Syllabus</h2>", ul(c.syllabus));
  if (c.learningOutcomes?.length) parts.push("<h2>What you will learn</h2>", ul(c.learningOutcomes));
  if (c.tools?.length) parts.push("<h2>Tools you will use</h2>", ul(c.tools));
  if (c.projects?.length) parts.push("<h2>Projects</h2>", ul(c.projects));
  if (c.careers?.length) parts.push("<h2>Career paths</h2>", ul(c.careers));
  if (c.whoShouldJoin?.length) parts.push("<h2>Who should join</h2>", ul(c.whoShouldJoin));
  if (c.prerequisites?.length) parts.push("<h2>Prerequisites</h2>", ul(c.prerequisites));
  if (c.certificate) parts.push("<h2>Certificate</h2>", `<p>${c.certificate}</p>`);
  return parts.join("");
};

const trim = (s, max) => {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
};

const migrated = courses.map((c) => ({
  // identity
  id: c.id,
  slug: c.slug,
  title: c.title,

  // taxonomy
  category: c.category,
  categoryLabel: c.categoryLabel,
  icon: c.icon,

  // summary fields used by cards and lists
  description: c.description,
  overview: c.overview,
  duration: c.duration,
  mode: c.mode,
  internship: Boolean(c.internship),

  // structured detail - carried across verbatim
  syllabus: c.syllabus ?? [],
  tools: c.tools ?? [],
  careers: c.careers ?? [],
  whoShouldJoin: c.whoShouldJoin ?? [],
  learningOutcomes: c.learningOutcomes ?? [],
  prerequisites: c.prerequisites ?? [],
  projects: c.projects ?? [],
  certificate: c.certificate ?? "",
  faqs: c.faqs ?? [],

  // new: editable rich body, seeded from the structured fields above
  content: buildContent(c),

  // new: two images per course, filled in from the admin
  imageUrl: "",
  imageAlt: `${c.title} course at ASB Training Hub`,
  secondaryImageUrl: "",
  secondaryImageAlt: `${c.title} training session at ASB Training Hub`,

  // new: SEO, defaulted from existing copy
  metaTitle: trim(`${c.title} Course in Trivandrum | ASB Training Hub`, 70),
  metaDescription: trim(
    `${c.description} ${c.duration}, ${String(c.mode).toLowerCase()}${
      c.internship ? ", with internship support" : ""
    }.`,
    155,
  ),
  keywords: [
    c.title.toLowerCase(),
    `${c.title.toLowerCase()} course trivandrum`,
    `${c.categoryLabel.toLowerCase()} kerala`,
    "asb training hub",
  ].join(", "),

  published: true,
  createdAt: now,
  updatedAt: now,
}));

// ---- validation: nothing may be silently dropped -------------------------
const problems = [];
const seen = new Set();
for (const c of migrated) {
  if (!c.slug || !/^[a-z0-9-]+$/.test(c.slug)) problems.push(`bad slug: ${c.slug}`);
  if (seen.has(c.slug)) problems.push(`duplicate slug: ${c.slug}`);
  seen.add(c.slug);
  for (const field of ["title", "category", "description", "overview", "duration", "mode"]) {
    if (!c[field]) problems.push(`${c.slug}: missing ${field}`);
  }
}

const totals = (key) => migrated.reduce((n, c) => n + (c[key]?.length ?? 0), 0);

console.log(`courses migrated : ${migrated.length}`);
console.log(`categories       : ${categories.map((c) => `${c.id}(${c.count})`).join(" ")}`);
console.log(`syllabus items   : ${totals("syllabus")}`);
console.log(`faqs             : ${totals("faqs")}`);
console.log(`careers          : ${totals("careers")}`);
console.log(`avg body length  : ${Math.round(
  migrated.reduce((n, c) => n + c.content.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length, 0) /
    migrated.length,
)} words`);

if (problems.length) {
  console.error(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}
console.log("validation       : all courses complete");

if (!write) {
  console.log("\n(preview only - pass --write to save)");
  console.log("\nsample:");
  const s = migrated[0];
  console.log(`  ${s.slug}`);
  console.log(`    title      : ${s.title}`);
  console.log(`    metaTitle  : ${s.metaTitle}`);
  console.log(`    metaDesc   : ${s.metaDescription}`);
  console.log(`    syllabus   : ${s.syllabus.length} items`);
  console.log(`    faqs       : ${s.faqs.length}`);
  process.exit(0);
}

await mkdir(dataDir, { recursive: true });
// Written as the committed SEED, not the live store. The backend copies it to
// courses.json on first run, exactly as it does for blogs, so a fresh deploy
// self-populates while admin edits live in the gitignored courses.json.
const target = path.join(dataDir, "courses.seed.json");
if (existsSync(target)) {
  const backup = `${target}.bak-${Date.now()}`;
  await copyFile(target, backup);
  console.log(`existing file backed up to ${backup}`);
}
await writeFile(target, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
console.log(`\nwritten: ${target}`);
