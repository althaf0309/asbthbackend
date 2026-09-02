#!/usr/bin/env node
/**
 * Rebuilds data/blogs.json after the tracked copy was overwritten on deploy.
 *
 * Sources, in order of reliability:
 *   1. data/uploads/            - filenames are "<slug>-<id>.<ext>", and this
 *                                 directory is gitignored so it survived intact
 *   2. nginx access logs        - every /blog/<slug> ever requested
 *   3. the live sitemap         - if an older one is still cached anywhere
 *
 * For each slug it then fetches the archived page from the Wayback Machine and
 * pulls the metadata back out of the BlogPosting JSON-LD the backend rendered
 * into <head>. That reliably restores title, description, keywords, dates,
 * category and image.
 *
 * The article BODY was rendered client-side from /api/blogs/<slug>, so archived
 * HTML usually does not contain it. Recovered posts are therefore written with
 * `published: false` and a placeholder body, so nothing half-restored goes live
 * without you reviewing it.
 *
 *   node scripts/recover-blogs.mjs --discover      # list slugs only
 *   node scripts/recover-blogs.mjs --fetch         # fetch + write recovered.json
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://www.asbtraininghub.com";
const mode = process.argv.includes("--fetch") ? "fetch" : "discover";

/* ---------------------------------------------------------------- *
 * 1. Discover slugs
 * ---------------------------------------------------------------- */

const slugs = new Set();

// From uploaded images: "<slug>-<timestamp36>-<rand>.<ext>"
const uploadDir = path.join(rootDir, "data", "uploads");
if (existsSync(uploadDir)) {
  for (const file of await readdir(uploadDir)) {
    const base = file.replace(/\.[a-z0-9]+$/i, "");
    // createId() is "<base36>-<8 chars>"; strip that suffix to get the slug.
    const slug = base.replace(/-[a-z0-9]+-[a-z0-9]{8}$/i, "");
    if (slug && slug !== base) slugs.add(slug);
  }
}
const fromUploads = slugs.size;

// From nginx access logs, including rotated and gzipped ones.
try {
  const out = execFileSync(
    "bash",
    [
      "-c",
      "sudo zgrep -ho 'GET /blog/[a-z0-9-]\\+' /var/log/nginx/access.log* 2>/dev/null || true",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  for (const line of out.split("\n")) {
    const slug = line.replace("GET /blog/", "").trim();
    if (slug && /^[a-z0-9-]+$/.test(slug)) slugs.add(slug);
  }
} catch {
  console.warn("could not read nginx logs (try running with sudo)");
}

// Drop the six seed posts - those were never lost.
const seeds = new Set([
  "why-sap-career-2024",
  "python-vs-java",
  "ai-jobs-kerala",
  "internship-tips",
  "erp-implementation",
  "generative-ai-future",
]);
for (const s of seeds) slugs.delete(s);

const list = [...slugs].sort();
console.log(`discovered ${list.length} slugs (${fromUploads} from image filenames)`);

if (mode === "discover") {
  console.log(list.join("\n"));
  await writeFile(path.join(rootDir, "recovered-slugs.txt"), list.join("\n") + "\n");
  console.log(`\nwritten to ${path.join(rootDir, "recovered-slugs.txt")}`);
  process.exit(0);
}

/* ---------------------------------------------------------------- *
 * 2. Fetch each from the Wayback Machine
 * ---------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonLdFrom = (html) => {
  for (const m of html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    try {
      const data = JSON.parse(m[1]);
      if (data["@type"] === "BlogPosting" || data["@type"] === "Article") return data;
    } catch {
      /* ignore malformed block */
    }
  }
  return null;
};

const metaFrom = (html, name) => {
  const m =
    html.match(new RegExp(`<meta\\s+name=["']${name}["'][^>]*content=["']([^"']*)`, "i")) ||
    html.match(new RegExp(`<meta\\s+property=["']${name}["'][^>]*content=["']([^"']*)`, "i"));
  return m ? m[1] : "";
};

const decode = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const recovered = [];
const failed = [];

for (const [i, slug] of list.entries()) {
  const target = `${SITE}/blog/${slug}`;
  process.stdout.write(`[${i + 1}/${list.length}] ${slug} ... `);

  try {
    const avail = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`,
      { signal: AbortSignal.timeout(20000) },
    ).then((r) => r.json());

    const snap = avail?.archived_snapshots?.closest;
    if (!snap?.available) {
      console.log("no snapshot");
      failed.push(slug);
      await sleep(400);
      continue;
    }

    // "id_" asks for the original bytes without the Wayback toolbar.
    const rawUrl = snap.url.replace(/\/(\d{14})\//, "/$1id_/");
    const html = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) }).then((r) =>
      r.text(),
    );

    const ld = jsonLdFrom(html) || {};
    const title = decode(ld.headline || metaFrom(html, "og:title") || slug);
    const description = decode(ld.description || metaFrom(html, "description"));

    recovered.push({
      slug,
      title,
      excerpt: description,
      category: decode(ld.articleSection || "Blog"),
      author: decode(ld.author?.name || "ASB Team"),
      readTime: "5 min",
      metaTitle: decode(metaFrom(html, "og:title") || title),
      metaDescription: description,
      keywords: decode(ld.keywords || metaFrom(html, "keywords")),
      imageUrl: String(ld.image || metaFrom(html, "og:image") || "").replace(SITE, ""),
      imageAlt: title,
      // The body was client-rendered, so it is not in the archived HTML.
      content: `<p><strong>Body not recovered.</strong> Metadata was restored from an archived copy of ${target}. Paste the original article text here before publishing.</p>`,
      createdAt: ld.datePublished || new Date().toISOString(),
      updatedAt: ld.dateModified || ld.datePublished || new Date().toISOString(),
      published: false,
      recovered: true,
      archivedFrom: snap.url,
    });
    console.log("ok");
  } catch (error) {
    console.log(`failed (${error.message})`);
    failed.push(slug);
  }

  await sleep(600); // be polite to archive.org
}

const outPath = path.join(rootDir, "data", "recovered-blogs.json");
await writeFile(outPath, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");

console.log(`\nrecovered ${recovered.length} posts -> ${outPath}`);
if (failed.length) {
  console.log(`no archive for ${failed.length}: ${failed.join(", ")}`);
}
console.log(
  [
    "",
    "NOT merged into data/blogs.json automatically. Review it, then:",
    "  cp data/blogs.json data/blogs.json.bak",
    "  node -e \"const a=require('./data/blogs.json'),b=require('./data/recovered-blogs.json');" +
      "const s=new Set(a.map(x=>x.slug));" +
      "require('fs').writeFileSync('./data/blogs.json',JSON.stringify([...a,...b.filter(x=>!s.has(x.slug))],null,2))\"",
    "  sudo systemctl restart asb-backend",
    "",
    "Every recovered post is published:false, so nothing appears publicly until",
    "you add the body text and publish it from /admin/blog.",
  ].join("\n"),
);
