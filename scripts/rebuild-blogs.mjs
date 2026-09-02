#!/usr/bin/env node
/**
 * Rebuilds the blog posts lost when a deploy overwrote data/blogs.json.
 *
 * The original bodies are unrecoverable (no archive.org captures of the React
 * site, and the posts existed only in the admin panel). What IS recoverable is
 * the URL set - from surviving upload filenames and nginx access logs - and
 * those URLs are indexed. Every day they 404, Google drops more of them.
 *
 * This regenerates a real article per slug from its pattern, using facts that
 * are true about the institute. It is a starting point, not a replacement for
 * the originals: review and improve them in /admin/blog.
 *
 *   node scripts/rebuild-blogs.mjs                 # preview, writes nothing
 *   node scripts/rebuild-blogs.mjs --write         # write data/rebuilt-blogs.json
 *   node scripts/rebuild-blogs.mjs --write --merge # also merge into blogs.json
 */
import { readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const write = process.argv.includes("--write");
const merge = process.argv.includes("--merge");

/* ------------------------------------------------------------------ *
 * Facts about the institute - used so generated copy is accurate
 * ------------------------------------------------------------------ */
const ASB = {
  name: "ASB Training Hub",
  phone: "+91 87147 73304",
  whatsapp: "https://wa.me/918714773304",
  email: "info@asbtraininghub.com",
  address:
    "105-2, The Atomic, Near Technopark Phase 1, Kazhakootam, Trivandrum, Kerala 695581",
  hours: "Monday to Saturday, 9:00 AM to 6:00 PM",
  batch: "15-20 students",
};

const TOPICS = {
  "agentic-ai": {
    label: "Agentic AI",
    category: "AI",
    duration: "3-6 months",
    blurb:
      "Agentic AI is the practice of building systems that plan, call tools and act toward a goal rather than answering a single prompt.",
    skills: ["Python", "LLM APIs", "tool calling and function schemas", "retrieval-augmented generation", "agent orchestration frameworks", "evaluation and guardrails"],
    roles: ["AI Agent Developer", "AI Application Engineer", "Automation Engineer", "Machine Learning Engineer"],
    projects: ["a research agent that gathers and summarises sources", "a customer-support agent grounded in a real knowledge base", "a workflow agent that classifies and routes incoming requests"],
  },
  "generative-ai": {
    label: "Generative AI",
    category: "AI",
    duration: "3-6 months",
    blurb:
      "Generative AI covers the models and application patterns behind text, image and code generation, and how to wire them into real products.",
    skills: ["prompt design", "retrieval-augmented generation", "fine-tuning basics", "vector databases", "API integration", "output evaluation"],
    roles: ["Generative AI Developer", "AI Product Engineer", "Prompt Engineer", "AI Solutions Consultant"],
    projects: ["a document question-answering tool", "a content assistant with brand constraints", "an image-generation pipeline with review steps"],
  },
  "prompt-engineering": {
    label: "Prompt Engineering",
    category: "AI",
    duration: "2-3 months",
    blurb:
      "Prompt engineering is the discipline of getting reliable, repeatable output from language models and knowing when a prompt is the wrong tool.",
    skills: ["structured prompting", "few-shot design", "chain-of-thought patterns", "output schemas", "systematic evaluation", "failure analysis"],
    roles: ["Prompt Engineer", "AI Content Specialist", "AI Support Engineer"],
    projects: ["a prompt library with measured accuracy", "an evaluation harness comparing prompt variants"],
  },
  "data-science": {
    label: "Data Science",
    category: "AI",
    duration: "4-6 months",
    blurb:
      "Data science combines statistics, programming and communication to turn raw data into decisions a business will actually act on.",
    skills: ["Python and pandas", "SQL", "statistics and hypothesis testing", "visualisation", "machine learning fundamentals", "model evaluation"],
    roles: ["Data Analyst", "Data Scientist", "Business Intelligence Analyst", "Machine Learning Engineer"],
    projects: ["an end-to-end analysis with a written recommendation", "a predictive model with documented error analysis", "an interactive dashboard"],
  },
  ai: {
    label: "Artificial Intelligence",
    category: "AI",
    duration: "3-6 months",
    blurb:
      "Artificial intelligence training covers the fundamentals of machine learning through to deploying models inside working applications.",
    skills: ["Python", "machine learning algorithms", "deep learning basics", "model deployment", "data preparation", "evaluation"],
    roles: ["AI Engineer", "Machine Learning Engineer", "Data Scientist", "AI Application Developer"],
    projects: ["a deployed classification service", "a computer-vision prototype", "a natural-language processing pipeline"],
  },
  logistics: {
    label: "Logistics and Supply Chain",
    category: "Management",
    duration: "3-6 months",
    blurb:
      "Logistics and supply chain training covers how goods move, how inventory is planned and costed, and the documentation that keeps trade moving.",
    skills: ["supply chain planning", "warehouse operations", "inventory control", "export and import documentation", "freight and shipping", "ERP logistics modules"],
    roles: ["Logistics Executive", "Supply Chain Analyst", "Warehouse Supervisor", "Import/Export Documentation Officer"],
    projects: ["a warehouse layout and process design", "a shipment costing exercise", "an inventory optimisation study"],
  },
  "warehouse-management": {
    label: "Warehouse Management",
    category: "Management",
    duration: "3 months",
    blurb:
      "Warehouse management training covers receiving, put-away, picking, stock accuracy and the systems that track all of it.",
    skills: ["inbound and outbound processes", "stock accuracy and cycle counting", "WMS basics", "safety and compliance", "layout planning"],
    roles: ["Warehouse Supervisor", "Inventory Controller", "Stores Officer", "WMS Executive"],
    projects: ["a cycle-count programme design", "a picking-route optimisation exercise"],
  },
  sap: {
    label: "SAP / ERP",
    category: "ERP",
    duration: "3-6 months",
    blurb:
      "SAP and ERP training connects business processes to system configuration, which is what consultants are actually hired to do.",
    skills: ["business process mapping", "module configuration", "master data", "integration between modules", "testing and user training", "go-live support"],
    roles: ["SAP Functional Consultant", "ERP Analyst", "Business Process Consultant", "ERP Support Executive"],
    projects: ["a full procure-to-pay configuration", "an order-to-cash cycle build", "a module integration audit"],
  },
};

const CITIES = {
  trivandrum: { name: "Trivandrum", note: "home to Technopark, Kerala's largest IT park" },
  thiruvananthapuram: { name: "Thiruvananthapuram", note: "home to Technopark" },
  kochi: { name: "Kochi", note: "Kerala's commercial capital and home to Infopark" },
  ernakulam: { name: "Ernakulam", note: "the business heart of Kochi" },
  kozhikode: { name: "Kozhikode", note: "a growing IT and trade centre in north Kerala" },
  calicut: { name: "Calicut", note: "a long-established trading city in north Kerala" },
  thrissur: { name: "Thrissur", note: "a central Kerala hub with strong college enrolment" },
  kollam: { name: "Kollam", note: "a coastal district with growing logistics activity" },
  kottayam: { name: "Kottayam", note: "a major education centre in central Kerala" },
  kannur: { name: "Kannur", note: "north Kerala's expanding commercial district" },
  alappuzha: { name: "Alappuzha", note: "a coastal district with established trade links" },
  malappuram: { name: "Malappuram", note: "one of Kerala's most populous districts" },
  palakkad: { name: "Palakkad", note: "Kerala's industrial gateway to Tamil Nadu" },
  kerala: { name: "Kerala", note: "with learners joining from every district" },
};

/* ------------------------------------------------------------------ *
 * Slug parsing
 * ------------------------------------------------------------------ */

// Probe attempts and junk, not real posts.
const JUNK = new Set([
  "wp-config", "wp-includes", "wp-json", "wp-login", "wp-admin",
  "vendor", "null", "undefined", "index", "admin",
]);

const TOPIC_KEYS = Object.keys(TOPICS).sort((a, b) => b.length - a.length);
const CITY_KEYS = Object.keys(CITIES).sort((a, b) => b.length - a.length);

const titleCase = (s) =>
  s.split("-").map((w) => {
    if (["ai", "sap", "erp"].includes(w)) return w.toUpperCase();
    if (["in", "for", "with", "the", "a", "an", "of", "and", "to", "vs"].includes(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ").replace(/^./, (c) => c.toUpperCase());

const parse = (slug) => {
  const topicKey = TOPIC_KEYS.find((k) => slug.includes(k)) ?? null;
  const cityKey = CITY_KEYS.find((k) => slug.includes(k)) ?? null;

  let kind = "topic";
  if (/^(what|how|why|who|which|where|when|is|are|can|does|do)-/.test(slug)) kind = "question";
  else if (/-vs-/.test(slug)) kind = "comparison";
  else if (/^(best|top|affordable|advanced|professional|job-oriented|online|offline)/.test(slug)) kind = "best";
  else if (cityKey) kind = "city";

  return { topicKey, cityKey, kind };
};

/* ------------------------------------------------------------------ *
 * Content generation
 * ------------------------------------------------------------------ */

const p = (t) => `<p>${t}</p>`;
const h2 = (t) => `<h2>${t}</h2>`;
const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

const contactBlock = () =>
  h2("Visit or talk to us") +
  p(
    `${ASB.name} is at ${ASB.address}. We are open ${ASB.hours}. ` +
      `Call <strong>${ASB.phone}</strong>, email ${ASB.email}, or ` +
      `<a href="${ASB.whatsapp}">message us on WhatsApp</a> to ask about batch dates, fees or a free demo session.`,
  );

const howWeTeach = (topic) =>
  h2("How the course is structured") +
  p(
    `Sessions run both online and offline, with weekend and evening batches for people already working. ` +
      `Batches are kept to ${ASB.batch} so trainers can give individual attention. The programme runs ${topic.duration} ` +
      `depending on the track and pace you choose.`,
  ) +
  p("Across the course you build:") +
  ul(topic.projects.map((x) => x.charAt(0).toUpperCase() + x.slice(1))) +
  p(
    "Every learner finishes with a portfolio they can show an interviewer, plus a completion certificate. " +
      "Internship placements and placement support - resume review, mock interviews and referrals - are part of the programme.",
  );

const whatYouLearn = (topic) =>
  h2("What you will learn") + p(`The syllabus is built around what employers ask for:`) + ul(topic.skills);

const careers = (topic) =>
  h2("Where it leads") +
  p(`Graduates from this track typically move into roles such as:`) +
  ul(topic.roles) +
  p(
    "Hiring managers consistently ask for two things beyond the certificate: working code or configuration you can explain, " +
      "and a clear account of a problem you solved. The project work is designed around exactly that.",
  );

const buildContent = ({ slug, topicKey, cityKey, kind }) => {
  const topic = TOPICS[topicKey] ?? TOPICS.ai;
  const city = cityKey ? CITIES[cityKey] : null;
  const where = city ? city.name : "Kerala";

  if (kind === "question") {
    const q = titleCase(slug).replace(/\s+$/, "");
    return (
      p(
        `This is one of the questions we are asked most often about ${topic.label} training, ` +
          `so here is a straight answer.`,
      ) +
      h2("The short answer") +
      p(topic.blurb) +
      whatYouLearn(topic) +
      howWeTeach(topic) +
      careers(topic) +
      contactBlock()
    );
  }

  if (kind === "comparison") {
    const [a, b] = slug.split("-vs-").map((s) => titleCase(s));
    return (
      p(`${a} and ${b} get used interchangeably, but they solve different problems. Here is the practical difference.`) +
      h2(`Where ${a} and ${b} differ`) +
      p(
        `Generative models produce output from a prompt. Agentic systems wrap a model in a loop that can plan, ` +
          `call tools, check its own results and try again. One writes; the other gets something done.`,
      ) +
      h2("Which one should you learn?") +
      p(
        "Start with the generative fundamentals - prompting, retrieval, evaluation - because agentic systems are built on top of them. " +
          "Move into agents once you can reliably get good output from a single call.",
      ) +
      whatYouLearn(topic) +
      howWeTeach(topic) +
      contactBlock()
    );
  }

  const opening = city
    ? p(
        `${topic.blurb} If you are looking for ${topic.label} training in ${city.name} - ` +
          `${city.note} - this page covers what the course includes, who it suits and what comes after it.`,
      )
    : p(topic.blurb);

  return (
    opening +
    whatYouLearn(topic) +
    howWeTeach(topic) +
    careers(topic) +
    (city
      ? h2(`Why learners from ${city.name} choose ${ASB.name}`) +
        p(
          `Our campus is in Trivandrum, and learners from ${city.name} join either the online live batches or travel for ` +
            `weekend offline sessions. The online batches are taught live, not pre-recorded, so you get the same trainer ` +
            `interaction either way.`,
        )
      : "") +
    contactBlock()
  );
};

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

const slugFile = path.join(rootDir, "recovered-slugs.txt");
if (!existsSync(slugFile)) {
  console.error(`Missing ${slugFile}. Run scripts/recover-blogs.mjs --discover first.`);
  process.exit(1);
}

const slugs = (await readFile(slugFile, "utf8"))
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !JUNK.has(s) && s.length > 4 && /^[a-z0-9-]+$/.test(s));

// Match surviving uploads back to their slug.
const imagesBySlug = new Map();
const uploadDir = path.join(dataDir, "uploads");
if (existsSync(uploadDir)) {
  for (const file of await readdir(uploadDir)) {
    const base = file.replace(/\.[a-z0-9]+$/i, "");
    const slug = base.replace(/-[a-z0-9]+-[a-z0-9]{8}$/i, "");
    if (slug && slug !== base && !imagesBySlug.has(slug)) {
      imagesBySlug.set(slug, `/uploads/${file}`);
    }
  }
}

const existing = JSON.parse(await readFile(path.join(dataDir, "blogs.json"), "utf8"));
const existingSlugs = new Set(existing.map((b) => b.slug));

const now = new Date().toISOString();
const rebuilt = [];

for (const slug of slugs) {
  if (existingSlugs.has(slug)) continue;
  const meta = parse(slug);
  const topic = TOPICS[meta.topicKey] ?? TOPICS.ai;
  const title = titleCase(slug);
  const content = buildContent({ slug, ...meta });
  const words = content.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

  const cityName = meta.cityKey ? CITIES[meta.cityKey].name : "Kerala";
  const excerpt =
    `${topic.label} training at ${ASB.name}, ${cityName} - practical syllabus, live online and offline batches, ` +
    `real project work, internship and placement support.`;

  rebuilt.push({
    slug,
    title,
    excerpt,
    category: topic.category,
    author: "ASB Team",
    readTime: `${Math.max(3, Math.round(words / 200))} min`,
    metaTitle: `${title} | ${ASB.name}`,
    metaDescription: excerpt.slice(0, 155),
    keywords: [
      title.toLowerCase(),
      `${topic.label.toLowerCase()} course ${cityName.toLowerCase()}`,
      `${topic.label.toLowerCase()} training kerala`,
      "asb training hub",
      "placement support",
    ].join(", "),
    imageUrl: imagesBySlug.get(slug) ?? "",
    imageAlt: title,
    content,
    createdAt: now,
    updatedAt: now,
    published: true,
    rebuilt: true,
  });
}

const withImages = rebuilt.filter((b) => b.imageUrl).length;
const avgWords = Math.round(
  rebuilt.reduce((n, b) => n + b.content.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length, 0) /
    Math.max(rebuilt.length, 1),
);

console.log(`slugs read      : ${slugs.length}`);
console.log(`rebuilt         : ${rebuilt.length} (skipped ${slugs.length - rebuilt.length} already present)`);
console.log(`with original image: ${withImages}`);
console.log(`average length  : ${avgWords} words`);
console.log("\nby category:");
for (const [cat, n] of Object.entries(
  rebuilt.reduce((acc, b) => ((acc[b.category] = (acc[b.category] ?? 0) + 1), acc), {}),
)) console.log(`  ${cat.padEnd(12)} ${n}`);
console.log("\nsample:");
for (const b of rebuilt.slice(0, 5)) console.log(`  ${b.slug}\n    -> ${b.title}`);

if (!write) {
  console.log("\n(preview only - pass --write to save)");
  process.exit(0);
}

await writeFile(path.join(dataDir, "rebuilt-blogs.json"), JSON.stringify(rebuilt, null, 2) + "\n");
console.log(`\nwritten: ${path.join(dataDir, "rebuilt-blogs.json")}`);

if (merge) {
  const backup = path.join(dataDir, `blogs.json.bak-${Date.now()}`);
  await copyFile(path.join(dataDir, "blogs.json"), backup);
  await writeFile(
    path.join(dataDir, "blogs.json"),
    JSON.stringify([...rebuilt, ...existing], null, 2) + "\n",
  );
  console.log(`merged into blogs.json (${rebuilt.length + existing.length} posts). Backup: ${backup}`);
  console.log("Restart the backend:  sudo systemctl restart asb-backend");
}
