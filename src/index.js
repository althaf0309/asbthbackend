import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import rateLimit, { MemoryStore } from "express-rate-limit";
import cookieParser from "cookie-parser";
import sanitizeHtmlLib from "sanitize-html";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Resolve .env against the backend directory, not process.cwd(). Under pm2 the
// working directory is whatever the process was started from, so a cwd-relative
// lookup silently finds nothing and the app dies on the credential check below.
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const submissionsFile = path.join(dataDir, "submissions.json");
const analyticsFile = path.join(dataDir, "analytics.json");
const blogsFile = path.join(dataDir, "blogs.json");
const coursesFile = path.join(dataDir, "courses.json");
// Committed seed. courses.json (the live, editable store) is gitignored and
// created from this on first run, mirroring how blogs are seeded.
//
// Resolved against the source tree, not DATA_DIR: the seed ships with the code,
// whereas DATA_DIR is the writable location and may be a fresh temp directory
// (as it is under test).
const coursesSeedFile = path.join(rootDir, "data", "courses.seed.json");
const trainingFile = path.join(dataDir, "training.json");
const trainingSeedFile = path.join(rootDir, "data", "training.seed.json");

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Credentials come from the environment only. There is deliberately no fallback:
// a shipped default is a published default.
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  throw new Error(
    [
      "ADMIN_USER and ADMIN_PASSWORD must be set - refusing to start with default credentials.",
      "Create backend/.env from .env.example (it is loaded automatically), or export them",
      "in the process environment. See DEPLOY.md.",
    ].join("\n"),
  );
}
if (ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
}

// .env.example is committed, so its placeholders are public. An interrupted
// edit that leaves them in place must not boot.
const PLACEHOLDERS = new Set([
  "change-me",
  "change-me-at-least-12-chars",
  "admin",
  "admin123",
  "password",
  "changeme",
]);

if (PLACEHOLDERS.has(ADMIN_USER.toLowerCase()) || PLACEHOLDERS.has(ADMIN_PASSWORD.toLowerCase())) {
  throw new Error(
    [
      "ADMIN_USER / ADMIN_PASSWORD still hold the placeholder values from .env.example.",
      "These are public in the repository. Edit backend/.env and set real credentials.",
    ].join("\n"),
  );
}

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const SESSION_COOKIE = "asb_admin_session";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Behind nginx; without this every submission records the loopback address and
// the rate limiters would bucket the whole internet into one key.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // GTM/GA are loaded by index.html and inject inline config.
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://www.googletagmanager.com",
          "https://challenges.cloudflare.com",
        ],
        // Fonts are self-hosted now, so no third-party font origins are needed.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://www.google-analytics.com",
          "https://api.web3forms.com",
          "https://challenges.cloudflare.com",
        ],
        frameSrc: [
          "https://www.googletagmanager.com",
          "https://www.google.com",
          "https://challenges.cloudflare.com",
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  }),
);

app.use(cookieParser());

// Authenticated responses contain private submissions and unpublished content.
// Explicitly prevent browsers, reverse proxies and shared caches from retaining them.
app.use("/api/admin", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
});

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

const limiterOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
};

// Limits are env-tunable so a test run or a load test can raise them without
// editing code. The defaults are the production values.
const limitFrom = (name, fallback) => Number(process.env[name] || fallback);

// Stores are held explicitly so every bucket can be cleared in one call.
const limiterStores = [];

const makeLimiter = (options) => {
  const store = new MemoryStore();
  limiterStores.push(store);
  return rateLimit({ ...limiterOptions, ...options, store });
};

const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: limitFrom("RATE_LIMIT_LOGIN", 10),
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

const submissionLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  limit: limitFrom("RATE_LIMIT_SUBMISSION", 15),
  message: { error: "Too many submissions from this network. Please try again later." },
});

const apiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: limitFrom("RATE_LIMIT_API", 120),
});

app.use("/api/", apiLimiter);

/** Clears every limiter bucket. Used by tests; harmless in production. */
const resetRateLimits = () => {
  for (const store of limiterStores) store.resetAll?.();
};

/* ------------------------------------------------------------------ *
 * Body parsing
 *
 * A small default for everything; the large parser is mounted only on the two
 * authenticated routes that carry a base64 image.
 * ------------------------------------------------------------------ */

const smallJson = express.json({ limit: "100kb" });
const uploadJson = express.json({ limit: "15mb" });

app.use((req, res, next) => {
  const isContentWrite =
    (req.path.startsWith("/api/admin/blogs") ||
      req.path.startsWith("/api/admin/courses") ||
      req.path.startsWith("/api/admin/training")) &&
    (req.method === "POST" || req.method === "PUT");
  // Check the cookie/header before spending memory parsing a 15 MB body. The
  // route performs the same authorization check again after parsing.
  if (isContentWrite) {
    return requireAdmin(req, res, () => uploadJson(req, res, next));
  }
  return smallJson(req, res, next);
});

// body-parser throws for malformed JSON and oversized payloads; both are client
// errors, not 500s.
app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Malformed JSON in request body." });
  }
  return next(error);
});

app.use(
  "/uploads",
  express.static(uploadDir, {
    dotfiles: "deny",
    index: false,
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    },
  }),
);

const emptyStore = {
  inquiries: [],
  applications: [],
  newsletters: [],
};

/** Writes JSON through a sibling temp file so readers never observe half a write. */
const writeJsonAtomic = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

/**
 * Serialises read-modify-write cycles against a JSON file.
 *
 * Every mutation runs inside a queued critical section, so two concurrent
 * submissions can no longer read the same snapshot and have the second write
 * silently discard the first.
 */
const createFileLock = () => {
  let tail = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    // Keep the chain alive even when `work` rejects.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
};

const storeLock = createFileLock();
const blogLock = createFileLock();
const courseLock = createFileLock();
const trainingLock = createFileLock();
const analyticsLock = createFileLock();

const readAnalytics = async () => {
  try { return JSON.parse(await readFile(analyticsFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const recordAnalytics = (event) => analyticsLock(async () => {
  const events = await readAnalytics();
  events.push(event);
  if (events.length > 20000) events.splice(0, events.length - 20000);
  await writeJsonAtomic(analyticsFile, events);
});

const readStore = async () => {
  try {
    const raw = await readFile(submissionsFile, "utf8");
    return { ...emptyStore, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return { ...emptyStore, inquiries: [], applications: [], newsletters: [] };
    throw error;
  }
};

const writeStore = async (store) => {
  await writeJsonAtomic(submissionsFile, store);
};

/** Reads the store, applies `mutate`, and writes it back atomically. */
const updateStore = (mutate) =>
  storeLock(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await writeStore(store);
    return result;
  });

const seedBlogs = [
  {
    slug: "why-sap-career-2024",
    title: "Why a ERP Career Is Still One of the Best Choices in 2024",
    excerpt: "ERP continues to dominate enterprise software with S/4HANA migrations driving massive demand for skilled consultants across India.",
    category: "Career",
    author: "ASB Team",
    readTime: "5 min",
    metaTitle: "Why a ERP Career Is Still One of the Best Choices in 2024 | ASB Training Hub",
    metaDescription: "Explore why ERP and ERP careers remain strong choices for students and working professionals in 2024.",
    keywords: "ERP career, ERP training, ERP courses, ASB Training Hub",
    imageUrl: "/blog/why-sap-career-2024.webp",
    imageAlt: "ERP career training",
    content: "<p>ERP remains one of the strongest career paths for students and working professionals who want enterprise technology roles. Businesses still need skilled consultants for finance, procurement, sales, production, HR, and analytics workflows.</p><p>At ASB Training Hub, our ERP courses focus on practical configuration, business process understanding, and interview preparation.</p>",
    createdAt: "2024-03-15T00:00:00.000Z",
    updatedAt: "2024-03-15T00:00:00.000Z",
    published: true,
  },
  {
    slug: "python-vs-java",
    title: "Python vs Java: Which Should You Learn First?",
    excerpt: "A detailed comparison of Python and Java to help you choose the right programming language for your career goals.",
    category: "Programming",
    author: "ASB Team",
    readTime: "7 min",
    metaTitle: "Python vs Java: Which Should You Learn First? | ASB Training Hub",
    metaDescription: "Compare Python and Java for beginners and choose the right programming language for your career goals.",
    keywords: "Python course, Java course, programming training, coding courses",
    imageUrl: "/blog/python-vs-java.webp",
    imageAlt: "Python and Java programming",
    content: "<p>Python is beginner-friendly and popular in AI, data science, automation, and backend development. Java is widely used in enterprise applications, Android ecosystems, and large-scale backend systems.</p><p>Your first language should match your goal. Choose Python for fast entry into AI and scripting. Choose Java for enterprise software and strongly typed backend work.</p>",
    createdAt: "2024-03-10T00:00:00.000Z",
    updatedAt: "2024-03-10T00:00:00.000Z",
    published: true,
  },
  {
    slug: "ai-jobs-kerala",
    title: "Top AI Job Opportunities in Kerala's Tech Industry",
    excerpt: "Explore the growing AI job market in Kerala's tech hubs including Technopark, Infopark, and startup ecosystem.",
    category: "AI",
    author: "ASB Team",
    readTime: "6 min",
    metaTitle: "Top AI Job Opportunities in Kerala's Tech Industry | ASB Training Hub",
    metaDescription: "Learn about AI job opportunities across Kerala's growing technology ecosystem.",
    keywords: "AI jobs Kerala, AI training Trivandrum, machine learning jobs",
    imageUrl: "/blog/ai-jobs-kerala.webp",
    imageAlt: "AI career opportunities",
    content: "<p>Kerala's technology ecosystem is seeing strong interest in AI, machine learning, automation, and data analytics. Students who can build real projects, explain model choices, and deploy applications have a clear advantage over candidates who only hold a certificate.</p><h2>Where the AI roles are</h2><p>Technopark in Trivandrum and Infopark in Kochi host the largest concentration of AI-adjacent hiring in the state, spanning product companies, IT services firms, and a growing startup layer. Typical entry titles include data analyst, machine learning engineer, AI application developer, and automation engineer. Services companies also recruit for data annotation, model evaluation, and MLOps support roles that are realistic first jobs for a fresher.</p><h2>What employers actually screen for</h2><p>Interview panels in Kerala consistently ask for three things: working Python, a clear explanation of one end-to-end project you built, and evidence that you understand where a model fails. Candidates who can describe how they cleaned their data, why they chose a particular algorithm, and what the error analysis showed are preferred over candidates who can only name frameworks.</p><h2>How to prepare</h2><p>Build two or three projects that solve a problem you can describe in a sentence, deploy at least one so it has a live URL, and keep the code on GitHub with a readable README. Add fundamentals in statistics and SQL, because analytics interviews test both. At ASB Training Hub, our AI and machine learning tracks are structured around exactly this portfolio-first approach, with internship placements that put students on real datasets before they graduate.</p>",
    createdAt: "2024-03-05T00:00:00.000Z",
    updatedAt: "2024-03-05T00:00:00.000Z",
    published: true,
  },
  {
    slug: "internship-tips",
    title: "10 Tips to Make the Most of Your Internship",
    excerpt: "Practical advice on how to maximize your learning, build connections, and convert your internship into a full-time offer.",
    category: "Career",
    author: "ASB Team",
    readTime: "4 min",
    metaTitle: "10 Tips to Make the Most of Your Internship | ASB Training Hub",
    metaDescription: "Practical internship tips for students who want to learn faster and improve placement chances.",
    keywords: "internship tips, career training, student internship",
    imageUrl: "/blog/internship-tips.webp",
    imageAlt: "Internship preparation",
    content: "<p>A good internship is about consistency, not brilliance. The interns who convert into full-time offers are rarely the most technically advanced ones. They are the ones who show up prepared, finish what they start, and make their manager's job easier.</p><h2>In your first week</h2><p>Learn the tools before you need them, read whatever documentation exists, and write down every acronym you hear. Ask your manager what a successful internship looks like to them, and write that answer down too. It becomes the standard you measure yourself against.</p><h2>Through the internship</h2><p>Keep a running log of what you shipped, what broke, and what you learned. Ask for feedback every two weeks rather than waiting for a final review. When you are stuck, timebox it: try for an hour, then ask, and explain what you already tried. Volunteer for the unglamorous tasks nobody has claimed, because that is usually where trust is earned.</p><h2>Building the portfolio</h2><p>Document your contributions as you go, with before-and-after detail and any numbers you are allowed to share. Screenshots, short write-ups, and a clear statement of what you personally did will carry more weight in your next interview than the company name on your resume.</p><h2>Before you leave</h2><p>Ask directly about full-time openings, request a written recommendation while your work is fresh in everyone's memory, and stay in touch with the people you worked closely with. ASB Training Hub internship programs include structured mentoring and review checkpoints built around this progression.</p>",
    createdAt: "2024-02-28T00:00:00.000Z",
    updatedAt: "2024-02-28T00:00:00.000Z",
    published: true,
  },
  {
    slug: "erp-implementation",
    title: "Understanding ERP Implementation: A Beginner's Guide",
    excerpt: "Learn the fundamentals of ERP implementation, key phases, and why ERP is the preferred choice for enterprises.",
    category: "ERP",
    author: "ASB Team",
    readTime: "8 min",
    metaTitle: "Understanding ERP Implementation: A Beginner's Guide | ASB Training Hub",
    metaDescription: "A beginner-friendly guide to ERP implementation phases, roles, and consultant skills.",
    keywords: "ERP implementation, ERP training, ERP implementation",
    imageUrl: "/blog/erp-implementation.webp",
    imageAlt: "ERP implementation guide",
    content: "<p>ERP implementation connects business requirements with system configuration. A consultant must understand process mapping, master data, testing, user training, and go-live support. The technology is rarely the hard part; aligning a business on how it wants to work is.</p><h2>The standard phases</h2><p>Most implementations follow a recognisable sequence: preparation and scoping, business blueprint, realisation and configuration, final preparation and testing, then go-live and hypercare support. Each phase has its own deliverables, and skipping documentation in an early phase reliably causes rework in a later one.</p><h2>Where projects go wrong</h2><p>The two most common failure points are master data and change management. Dirty or incomplete master data will surface during testing and delay go-live. Insufficient user training means a technically correct system that nobody uses correctly, which looks identical to a failed implementation from the business side.</p><h2>What a consultant is expected to do</h2><p>A functional consultant maps existing business processes, configures the system to support them, writes the functional specifications that developers build against, prepares test scripts, runs user acceptance testing, and supports users through the first weeks after go-live. Strong communication matters as much as configuration knowledge.</p><h2>Getting started</h2><p>Learn one module deeply before broadening out, understand the underlying business process rather than just the transaction codes, and get hands-on with a sandbox system. ASB Training Hub ERP courses are built around configuration practice and process understanding, with project work that mirrors a real implementation cycle.</p>",
    createdAt: "2024-02-20T00:00:00.000Z",
    updatedAt: "2024-02-20T00:00:00.000Z",
    published: true,
  },
  {
    slug: "generative-ai-future",
    title: "How Generative AI Is Reshaping Every Industry",
    excerpt: "From healthcare to finance, GenAI is transforming how businesses operate. Learn what skills you need to stay ahead.",
    category: "AI",
    author: "ASB Team",
    readTime: "6 min",
    metaTitle: "How Generative AI Is Reshaping Every Industry | ASB Training Hub",
    metaDescription: "Understand how generative AI is changing business workflows and what skills learners need.",
    keywords: "generative AI, GenAI training, AI courses",
    imageUrl: "/blog/generative-ai-future.webp",
    imageAlt: "Generative AI future",
    content: "<p>Generative AI is changing how teams create content, automate support, analyse documents, and build software. The best learners combine prompt skills with real application development, because prompting alone is not a job.</p><h2>Where it is actually being used</h2><p>In customer support, generative models draft replies that a human reviews before sending. In finance and legal work, they summarise long documents and extract structured fields. In software teams, they accelerate boilerplate, tests, and documentation. In marketing, they produce first drafts at volume. The pattern is consistent: the model produces a draft, a person owns the outcome.</p><h2>The skills that transfer</h2><p>Understanding how to structure a prompt matters, but the durable skills are retrieval-augmented generation, evaluating output quality systematically, handling failure modes like hallucination, and wiring a model into an existing application through its API. Knowing when not to use a generative model is equally valuable.</p><h2>What to build</h2><p>Build something that touches real data: a document question-answering tool over your own files, a support assistant grounded in a real knowledge base, or a workflow that classifies and routes incoming requests. These demonstrate the full loop from data to deployed application.</p><h2>How ASB approaches it</h2><p>Our generative AI and agentic AI tracks focus on application development rather than theory, so students finish with deployed projects, an understanding of evaluation, and the vocabulary to discuss trade-offs in an interview.</p>",
    createdAt: "2024-02-15T00:00:00.000Z",
    updatedAt: "2024-02-15T00:00:00.000Z",
    published: true,
  },
];

const readBlogs = async () => {
  try {
    const raw = await readFile(blogsFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeBlogs(seedBlogs);
      return seedBlogs;
    }
    throw error;
  }
};

const writeBlogs = async (blogs) => {
  await writeJsonAtomic(blogsFile, blogs);
};

const text = (value, max = 500) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
};

const email = (value) => {
  const cleaned = text(value, 254);
  if (!cleaned) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : "";
};

/**
 * Accepts the shapes people actually type - `+91 87147 73304`, `087147-73304`,
 * `(0471) 2345678` - and rejects anything that is not a plausible phone number.
 */
const phone = (value) => {
  const cleaned = text(value, 30);
  if (!cleaned) return "";
  if (!/^\+?[\d\s()-]+$/.test(cleaned)) return "";
  const digits = cleaned.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? cleaned : "";
};

const createId = () => `${Date.now().toString(36)}-${randomBytes(6).toString("base64url")}`;

const slugify = (value) =>
  text(value, 120)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || createId();

/**
 * Allowlist sanitiser for blog body HTML.
 *
 * A denylist cannot be made correct by adding rules - anything not named here
 * is dropped, including every tag that can execute, navigate, or frame.
 */
const BLOG_HTML_POLICY = {
  allowedTags: [
    "p", "br", "hr",
    "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "sup", "sub", "mark",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "span", "div",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    "*": ["class"],
  },
  // Only these URL schemes survive; `javascript:` and `data:` in an href do not.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  // Anything with a body that could execute is removed content-and-all.
  nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href || "";
      const isExternal = /^https?:\/\//i.test(href);
      return {
        tagName: "a",
        attribs: isExternal
          ? { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" }
          : attribs,
      };
    },
    img: (tagName, attribs) => ({
      tagName: "img",
      attribs: { ...attribs, loading: "lazy" },
    }),
  },
};

const sanitizeHtml = (value) => sanitizeHtmlLib(text(value, 20000), BLOG_HTML_POLICY);

const saveImage = async (imageData, slug) => {
  const data = text(imageData, 14000000);
  if (!data) return "";

  const match = data.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid image upload. Use PNG, JPG, WEBP, or GIF.");

  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("Blog image must be smaller than 10 MB.");
  }

  await mkdir(uploadDir, { recursive: true });
  const fileName = `${slug}-${createId()}.${ext}`;
  await writeFile(path.join(uploadDir, fileName), buffer);
  return `/uploads/${fileName}`;
};

/* ------------------------------------------------------------------ *
 * Sessions
 *
 * Each login mints a random token with a server-side expiry. Nothing is a
 * shared secret, and revoking a session is a delete rather than a redeploy.
 * ------------------------------------------------------------------ */

const sessions = new Map();

const pruneSessions = () => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
};

const createSession = (username) => {
  pruneSessions();
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
};

const resolveSession = (token) => {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
};

/** Constant-time string comparison that does not leak length through timing. */
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure cost does not depend on length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: IS_PRODUCTION,
  sameSite: "strict",
  path: "/",
  maxAge: SESSION_TTL_MS,
});

/** Reads the session token from the HttpOnly cookie, falling back to Bearer. */
const readToken = (req) => {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const auth = req.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};

const requireAdmin = (req, res, next) => {
  const session = resolveSession(readToken(req));
  if (!session) {
    return res.status(401).json({ error: "Admin authentication required." });
  }
  req.adminUser = session.username;
  next();
};

const submissionMeta = (req, verification = "screened") => ({
  id: createId(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "new",
  note: "",
  verification,
  ip: req.ip,
  userAgent: req.get("user-agent") || "",
});

/* ------------------------------------------------------------------ *
 * Public-form abuse screening
 *
 * The honeypot and timing checks stop basic form fillers; the conservative
 * pattern score catches the dotted-Gmail/random-token campaign seen in the
 * admin inbox. Turnstile is enforced server-side whenever its secret is set.
 * Rejected bots receive a normal success response so they do not adapt their
 * payload and retry. Nothing rejected is stored or forwarded by email.
 * ------------------------------------------------------------------ */

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const canonicalEmail = (value) => {
  const cleaned = email(value).toLowerCase();
  if (!cleaned) return "";
  const [local, domain] = cleaned.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  }
  return `${local.split("+")[0]}@${domain}`;
};

const hasSuspiciousEmailShape = (value) => {
  const cleaned = email(value).toLowerCase();
  if (!cleaned) return false;
  const [local, domain] = cleaned.split("@");
  const pieces = local.split(".");
  return (
    (domain === "gmail.com" || domain === "googlemail.com") &&
    pieces.length >= 5 &&
    pieces.filter((piece) => piece.length <= 2).length >= 3
  );
};

const looksMachineGenerated = (value) => {
  const cleaned = text(value, 1000);
  if (cleaned.length < 14 || cleaned.length > 80 || /\s/.test(cleaned)) return false;
  const letters = cleaned.replace(/[^a-z]/gi, "");
  const caseTransitions = (cleaned.match(/[a-z][A-Z]|[A-Z][a-z]/g) || []).length;
  return (
    letters.length / cleaned.length > 0.8 &&
    /[a-z]/.test(cleaned) &&
    /[A-Z]/.test(cleaned) &&
    caseTransitions >= 4 &&
    new Set(letters.toLowerCase()).size >= 10 &&
    !/[.!?,]/.test(cleaned)
  );
};

const hasSuspiciousNameShape = (value) => {
  const words = text(value, 120).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const letters = words.join("").replace(/[^a-z]/g, "");
  if (letters.length < 8) return false;
  const vowelRatio = (letters.match(/[aeiou]/g) || []).length / letters.length;
  return vowelRatio < 0.22 || words.some((word) => /[^aeiou\W]{5,}/i.test(word));
};

const verifyTurnstile = async (req) => {
  if (!TURNSTILE_SECRET_KEY) return { ok: true, verification: "screened" };
  const responseToken = text(req.body?.turnstileToken, 3000);
  if (!responseToken) return { ok: false, reason: "missing-turnstile" };

  try {
    const body = new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY,
      response: responseToken,
      remoteip: req.ip,
    });
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json().catch(() => ({}));
    return result.success
      ? { ok: true, verification: "turnstile" }
      : { ok: false, reason: "invalid-turnstile" };
  } catch (error) {
    console.warn("Turnstile verification unavailable:", error.message);
    // Fail closed. A challenge outage should not reopen the spam path.
    return { ok: false, reason: "turnstile-unavailable" };
  }
};

const screenSubmission = async (req, fields) => {
  if (text(req.body?.website, 200)) return { ok: false, reason: "honeypot" };

  let score = 0;
  const startedAt = Number(req.body?.formStartedAt);
  if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < 1500) score += 3;
  if (hasSuspiciousEmailShape(fields.email)) score += 2;
  if (looksMachineGenerated(fields.message)) score += 2;
  if (hasSuspiciousNameShape(fields.name)) score += 1;
  if (score >= 2) return { ok: false, reason: "automated-pattern" };

  return verifyTurnstile(req);
};

const silentlyRejectSubmission = (req, res, reason) => {
  console.warn(`Public form rejected (${reason}) from ${req.ip}`);
  return res.status(201).json({ ok: true });
};

/* ------------------------------------------------------------------ *
 * Inbox notification
 *
 * Web3Forms' free plan rejects server-side requests with HTTP 403. The backend
 * therefore returns a browser delivery instruction only after a submission has
 * passed validation, rate limits, spam screening and Turnstile. Rejected bots
 * never receive the public Web3Forms access key.
 * ------------------------------------------------------------------ */

const WEB3FORMS_KEY = process.env.WEB3FORMS_ACCESS_KEY || "";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

if (!WEB3FORMS_KEY) {
  console.warn(
    "WEB3FORMS_ACCESS_KEY is not set. Forms will be stored in admin, but email notifications are disabled.",
  );
}

if (!TURNSTILE_SECRET_KEY) {
  console.warn(
    "TURNSTILE_SECRET_KEY is not set. Public forms use local spam screening without Cloudflare verification.",
  );
}

const inboxNotification = (formType, submission) => {
  if (!WEB3FORMS_KEY) return undefined;
  const { id, ip, userAgent, status, note, createdAt, updatedAt, ...fields } = submission;
  return {
    endpoint: WEB3FORMS_ENDPOINT,
    payload: {
        access_key: WEB3FORMS_KEY,
        from_name: "ASB Training Hub Website",
        subject: `New ${formType} - ASB Training Hub`,
        form_type: formType,
        reference_id: id,
        ...fields,
    },
  };
};

const getSubmissionList = (store, type) => {
  if (type === "inquiry") return store.inquiries;
  if (type === "application") return store.applications;
  if (type === "newsletter") return store.newsletters;
  return null;
};

const flattenSubmissions = (store) => [
  ...store.inquiries.map((item) => ({ ...item, type: "inquiry" })),
  ...store.applications.map((item) => ({ ...item, type: "application" })),
  ...store.newsletters.map((item) => ({ ...item, type: "newsletter" })),
].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

const storeIfNew = async (type, submission) =>
  updateStore((store) => {
    const target = getSubmissionList(store, type);
    const submittedAt = new Date(submission.createdAt).getTime();
    const identity = canonicalEmail(submission.email) || phone(submission.phone);
    const content = `${submission.course || ""}|${submission.message || ""}`.toLowerCase();
    const duplicate = target.find((item) => {
      const itemIdentity = canonicalEmail(item.email) || phone(item.phone);
      const itemContent = `${item.course || ""}|${item.message || ""}`.toLowerCase();
      const age = submittedAt - new Date(item.createdAt).getTime();
      return identity && itemIdentity === identity && itemContent === content && age < 24 * 60 * 60 * 1000;
    });
    if (duplicate) return { duplicate: true, id: duplicate.id };
    target.unshift(submission);
    return { duplicate: false, id: submission.id };
  });

/* ------------------------------------------------------------------ *
 * Courses
 *
 * Same shape as the static catalogue they replaced, so the public pages
 * render identically - plus an editable HTML body, two images and SEO
 * fields the admin controls.
 * ------------------------------------------------------------------ */

const COURSE_CATEGORIES = ["erp", "programming", "ai", "management", "internship"];

// Training programmes are a second catalogue of the same shape - short courses,
// workshops and corporate sessions - kept separate from the main course list so
// each has its own URLs, admin screen and sitemap entries.
const TRAINING_CATEGORIES = ["corporate", "workshop", "certification", "bootcamp", "online"];

// Declared here; the collections themselves are built once createCollection is
// defined, further down.
let coursesCollection;
let trainingCollection;

const readCourses = async () => coursesCollection.read();
const readTraining = async () => trainingCollection.read();

/** Trims a list field to clean, non-empty strings. */
const list = (value, maxItems = 40, maxLen = 300) => {
  if (!Array.isArray(value)) return [];
  return value.map((v) => text(v, maxLen)).filter(Boolean).slice(0, maxItems);
};

/** Question/answer pairs, both required. */
const faqList = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((f) => ({ q: text(f?.q, 300), a: text(f?.a, 1500) }))
    .filter((f) => f.q && f.a)
    .slice(0, 30);
};

const SITE_URL = "https://www.asbtraininghub.com";
const LOCATION_PAGES = [
  { slug: "trivandrum", name: "Trivandrum", title: "AI Courses in Trivandrum", delivery: "Classroom, hybrid and live online", description: "Join practical Generative AI, Agentic AI, programming, ERP and career courses at ASB Training Hub near Technopark in Trivandrum.", keywords: "Generative AI Course in Trivandrum, AI Course in Trivandrum, Agentic AI Course in Trivandrum, Best AI Institute in Trivandrum" },
  { slug: "kazhakootam-technopark", name: "Kazhakootam & Technopark", title: "AI Courses near Technopark, Kazhakootam", delivery: "Classroom near Technopark, hybrid and live online", description: "Explore AI, Agentic AI, Generative AI, programming and ERP training near Technopark Phase 1 in Kazhakootam, Trivandrum.", keywords: "AI Course in Kazhakootam, AI Training near Technopark, Generative AI Course near Technopark, Agentic AI Training Kazhakootam" },
  { slug: "kochi-ernakulam", name: "Kochi & Ernakulam", title: "AI Courses in Kochi and Ernakulam", delivery: "Live online", description: "Live online Generative AI and Agentic AI training for learners in Kochi and Ernakulam, with practical projects and career support.", keywords: "Generative AI Course in Kochi, AI Course in Kochi, AI Classes in Kochi, Agentic AI Course in Kochi, AI Course in Ernakulam" },
  { slug: "kozhikode-calicut", name: "Kozhikode & Calicut", title: "AI Courses in Kozhikode and Calicut", delivery: "Live online", description: "Join live online Generative AI, Agentic AI and job-oriented AI courses from Kozhikode and Calicut.", keywords: "Generative AI Course in Kozhikode, AI Course in Calicut, Agentic AI Course in Kozhikode" },
  { slug: "thrissur", name: "Thrissur", title: "AI Courses in Thrissur", delivery: "Live online", description: "Practical live online Generative AI and Agentic AI courses for students and professionals in Thrissur.", keywords: "AI Course in Thrissur, Agentic AI Course in Thrissur, Generative AI Training Thrissur" },
  { slug: "kollam", name: "Kollam", title: "AI Courses in Kollam", delivery: "Live online", description: "Learn Generative AI, Agentic AI and AI automation through live online courses for learners in Kollam.", keywords: "AI Course in Kollam, Agentic AI Course in Kollam, Generative AI Training Kollam" },
  { slug: "kottayam", name: "Kottayam", title: "AI Courses in Kottayam", delivery: "Live online", description: "Instructor-led online AI, Generative AI and Agentic AI training for students and working professionals in Kottayam.", keywords: "AI Course in Kottayam, Agentic AI Course in Kottayam, Generative AI Training Kottayam" },
  { slug: "kannur", name: "Kannur", title: "AI Courses in Kannur", delivery: "Live online", description: "Join practical live online Generative AI, Agentic AI and AI automation training from Kannur.", keywords: "AI Course in Kannur, Agentic AI Course in Kannur, Generative AI Training Kannur" },
  { slug: "alappuzha", name: "Alappuzha", title: "Agentic AI Courses in Alappuzha", delivery: "Live online", description: "Live online Agentic AI and Generative AI programmes with practical projects for learners in Alappuzha.", keywords: "Agentic AI Course in Alappuzha, AI Course in Alappuzha, Generative AI Training Alappuzha" },
  { slug: "palakkad", name: "Palakkad", title: "Agentic AI Courses in Palakkad", delivery: "Live online", description: "Study Agentic AI, Generative AI and AI automation through instructor-led online training from Palakkad.", keywords: "Agentic AI Course in Palakkad, AI Course in Palakkad, Generative AI Training Palakkad" },
  { slug: "malappuram", name: "Malappuram", title: "Agentic AI Courses in Malappuram", delivery: "Live online", description: "Career-focused online Agentic AI and Generative AI courses for students and professionals in Malappuram.", keywords: "Agentic AI Course in Malappuram, AI Course in Malappuram, Generative AI Training Malappuram" },
];
const LOCATION_TOPICS = [
  { slug: "generative-ai-course", name: "Generative AI Course", shortName: "Generative AI", category: "ai", summary: "Learn prompt engineering, large language models, RAG, AI application development and responsible use through guided practical projects.", outcomes: ["Prompt engineering for real tasks", "LLM and RAG application fundamentals", "Generative AI workflow projects", "Portfolio and career preparation"] },
  { slug: "agentic-ai-course", name: "Agentic AI Course", shortName: "Agentic AI", category: "ai", summary: "Build AI agents, tool-using workflows and multi-agent systems with practical automation projects and instructor guidance.", outcomes: ["AI agent architecture and planning", "Tool use and workflow automation", "Multi-agent application projects", "Deployment and career preparation"] },
  { slug: "ai-course", name: "Artificial Intelligence Course", shortName: "AI", category: "ai", summary: "Develop practical foundations in artificial intelligence, Python, machine learning, automation and applied AI projects.", outcomes: ["Python and AI foundations", "Machine learning concepts", "Applied AI and automation projects", "Certification and career guidance"] },
  { slug: "erp-sap-courses", name: "ERP Courses", shortName: "ERP", category: "erp", summary: "Build practical ERP skills across finance, materials, sales, production, HR, quality and technical modules through process-based training.", outcomes: ["Business process and ERP foundations", "Module-focused practical exercises", "Configuration and implementation concepts", "ERP career preparation"] },
  { slug: "programming-courses", name: "Programming Courses", shortName: "Programming", category: "programming", summary: "Learn programming through guided coding practice, application development and portfolio projects across popular languages and full-stack paths.", outcomes: ["Programming and problem-solving foundations", "Frontend and backend development", "Database and application projects", "Developer career preparation"] },
  { slug: "management-courses", name: "Management Courses", shortName: "Management", category: "management", summary: "Develop industry-focused skills in logistics, supply chain, warehouse, HR, finance, hospitality and IT management.", outcomes: ["Industry process fundamentals", "Operational and management tools", "Case studies and practical assignments", "Professional career preparation"] },
  { slug: "internship-programs", name: "Internship Programs", shortName: "Internship", category: "internship", summary: "Combine structured technical training with practical assignments, project experience and internship-oriented career preparation.", outcomes: ["Job-oriented technical training", "Guided practical projects", "Portfolio and interview preparation", "Internship and career support"] },
];
const locationDistrictPath = (location) => `/locations/kerala/${location.slug}`;
const locationTopicPath = (location, topic) => `${locationDistrictPath(location)}/${topic.slug}`;
const localizedCoursePath = (location, course) => `${locationDistrictPath(location)}/course/${course.slug}`;
const AI_LANDING_PAGES = [
  ["generative-ai-course-kerala","Generative AI Course in Kerala"],["agentic-ai-course-kerala","Agentic AI Course in Kerala"],["prompt-engineering-course-kerala","Prompt Engineering Course in Kerala"],["chatgpt-course-kerala","ChatGPT Course in Kerala"],["llm-course-kerala","LLM Course in Kerala"],["rag-course-kerala","RAG Course in Kerala"],["mcp-course-kerala","MCP Course in Kerala"],["ai-agent-development-course-kerala","AI Agent Development Course in Kerala"],["ai-automation-course-kerala","AI Automation Course in Kerala"],["ai-course-for-beginners-kerala","AI Course for Beginners in Kerala"],["ai-course-working-professionals-kerala","AI Course for Working Professionals in Kerala"],["online-ai-course-kerala","Online AI Course in Kerala"],["offline-ai-course-trivandrum","Offline AI Course in Trivandrum"],["ai-course-placement-support-kerala","AI Course with Placement Support in Kerala"],["ai-career-guide-kerala","AI Career Guide for Kerala"],["ai-tools-training-kerala","AI Tools Training in Kerala"],
].map(([slug,title])=>({slug,title,description:`Explore ${title.toLowerCase()} with practical lessons, guided projects, instructor support and career-focused learning at ASB Training Hub.`}));
const AI_GUIDES = JSON.parse(await readFile(path.join(rootDir, "data", "ai-guides.json"), "utf8"));
const KEYWORD_COURSES = AI_GUIDES.filter((guide) => guide.kind === "keyword");

const staticSitemapRoutes = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/about", priority: "0.8", changefreq: "monthly" },
  { loc: "/courses", priority: "0.95", changefreq: "weekly" },
  { loc: "/locations/kerala", priority: "0.9", changefreq: "monthly" },
  { loc: "/ai-courses", priority: "0.9", changefreq: "monthly" },
  ...AI_LANDING_PAGES.map((page)=>({loc:`/ai-courses/${page.slug}`,priority:"0.8",changefreq:"monthly"})),
  { loc: "/ai-guides", priority: "0.8", changefreq: "monthly" },
  ...AI_GUIDES.map((guide)=>({loc:`/ai-guides/${guide.slug}`,priority:"0.65",changefreq:"monthly"})),
  { loc: "/keyword-courses", priority: "0.85", changefreq: "monthly" },
  ...KEYWORD_COURSES.map((course)=>({loc:`/keyword-courses/${course.slug}`,priority:"0.7",changefreq:"monthly"})),
  { loc: "/reviews", priority: "0.7", changefreq: "monthly" },
  { loc: "/faq", priority: "0.8", changefreq: "monthly" },
  { loc: "/blog", priority: "0.8", changefreq: "weekly" },
  { loc: "/contact", priority: "0.85", changefreq: "monthly" },
  { loc: "/apply", priority: "0.9", changefreq: "monthly" },
  { loc: "/terms-and-conditions", priority: "0.5", changefreq: "yearly" },
  ...["erp", "programming", "ai", "management", "internship"].map((c) => ({
    loc: `/courses/${c}`, priority: "0.9", changefreq: "weekly",
  })),
  { loc: "/training", priority: "0.9", changefreq: "weekly" },
  ...LOCATION_PAGES.flatMap((location) => [
    { loc: locationDistrictPath(location), priority: "0.85", changefreq: "monthly" },
    ...LOCATION_TOPICS.map((topic) => ({ loc: locationTopicPath(location, topic), priority: "0.8", changefreq: "monthly" })),
  ]),
];

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const stripHtml = (value) =>
  String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncateText = (value, max = 160) => {
  const cleaned = stripHtml(value);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).replace(/\s+\S*$/, "")}â€¦`;
};

const absoluteAssetUrl = (value) => {
  if (!value) return `${SITE_URL}/site-logo.png`;
  if (/^https?:\/\//i.test(value)) return value;
  return `${SITE_URL}${value.startsWith("/") ? value : `/${value}`}`;
};

/** BreadcrumbList so answer engines can place a page inside the site. */
const breadcrumbList = (trail) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: trail.map((crumb, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: crumb.name,
    item: `${SITE_URL}${crumb.path}`,
  })),
});

const readFrontendIndex = async () => {
  const candidates = [
    path.resolve(rootDir, "../frontend/dist/index.html"),
    path.resolve(rootDir, "../asb-ascend/dist/index.html"),
    path.resolve(rootDir, "../../frontend/dist/index.html"),
    path.resolve(rootDir, "../../asb-ascend/dist/index.html"),
  ];

  for (const filePath of candidates) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Unable to read frontend index from ${filePath}:`, error.message);
      }
    }
  }

  throw new Error("Frontend index.html not found. Run the frontend build before enabling SEO fallback routes.");
};

const upsertHeadTag = (html, pattern, replacement) => {
  if (pattern.test(html)) return html.replace(pattern, replacement);
  return html.replace("</head>", `    ${replacement}\n  </head>`);
};

const renderSeoHtml = async ({
  title,
  description,
  keywords,
  canonicalPath,
  image = "/site-logo.png",
  type = "website",
  jsonLd,
  visibleHtml = "",
  noindex = false,
}) => {
  const canonical = `${SITE_URL}${canonicalPath}`;
  const imageUrl = absoluteAssetUrl(image);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeKeywords = escapeHtml(keywords || "");
  const safeCanonical = escapeHtml(canonical);
  const safeImage = escapeHtml(imageUrl);

  let html = await readFrontendIndex();

  html = upsertHeadTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`);
  html = upsertHeadTag(html, /<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${safeDescription}">`);
  html = upsertHeadTag(html, /<meta\s+name=["']keywords["'][^>]*>/i, `<meta name="keywords" content="${safeKeywords}">`);
  html = upsertHeadTag(
    html,
    /<meta\s+name=["']robots["'][^>]*>/i,
    `<meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow"}">`,
  );
  html = upsertHeadTag(html, /<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${safeCanonical}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${safeTitle}">`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${safeDescription}">`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:type["'][^>]*>/i, `<meta property="og:type" content="${escapeHtml(type)}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${safeCanonical}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${safeImage}">`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${safeTitle}">`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${safeDescription}">`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${safeImage}">`);

  // Accepts one block or several, so a page can ship an entity plus breadcrumbs.
  for (const block of [].concat(jsonLd || [])) {
    html = html.replace(
      "</head>",
      `    <script type="application/ld+json" data-server-json-ld="true">${JSON.stringify(block).replace(/</g, "\\u003c")}</script>\n  </head>`
    );
  }

  // React replaces this shell when JavaScript loads. Until then, crawlers and
  // visitors still receive the page's real heading, text and crawlable links.
  if (visibleHtml) {
    html = html.replace(
      /<div\s+id=["']root["']\s*>\s*<\/div>/i,
      `<div id="root">${visibleHtml}</div>`,
    );
  }

  return html;
};

const pageShell = ({ heading, intro, body = "", links = [] }) => `
<main data-server-rendered="true" style="max-width:72rem;margin:0 auto;padding:8rem 1.5rem 4rem;font-family:system-ui,sans-serif">
  <h1>${escapeHtml(heading)}</h1>
  ${intro ? `<p>${escapeHtml(intro)}</p>` : ""}
  ${body}
  ${links.length ? `<nav aria-label="Related pages"><ul>${links.map((link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`).join("")}</ul></nav>` : ""}
</main>`;

const catalogueShell = ({ heading, intro, items, prefix }) =>
  pageShell({
    heading,
    intro,
    body: `<section aria-label="${escapeHtml(heading)}"><ul>${items
      .map(
        (item) => `<li><article><h2><a href="${prefix}/${escapeHtml(item.slug)}">${escapeHtml(item.title)}</a></h2><p>${escapeHtml(item.description || item.excerpt || item.overview || "")}</p>${item.duration ? `<p>${escapeHtml(item.duration)} Â· ${escapeHtml(item.mode || "")}</p>` : ""}</article></li>`,
      )
      .join("")}</ul></section>`,
  });

const detailShell = ({ heading, intro, content = "", sections = [], faqs = [] }) =>
  pageShell({
    heading,
    intro,
    body: [
      content,
      ...sections
        .filter((section) => section.items?.length)
        .map(
          (section) => `<section><h2>${escapeHtml(section.title)}</h2><ul>${section.items
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul></section>`,
        ),
      faqs.length
        ? `<section><h2>Frequently asked questions</h2>${faqs
            .map((faq) => `<h3>${escapeHtml(faq.q)}</h3><p>${escapeHtml(faq.a)}</p>`)
            .join("")}</section>`
        : "",
    ].join(""),
  });

/** Catalogue URLs for the sitemap, straight from the live stores. */
const readCourseSitemapRoutes = async () => {
  const entry = (prefix, priority) => (c) => ({
    loc: `${prefix}/${c.slug}`,
    priority,
    changefreq: "monthly",
    lastmod: c.updatedAt ? c.updatedAt.slice(0, 10) : undefined,
  });

  const published = (items) => items.filter((c) => c.published !== false && c.slug);

  const publishedCourses = published(await readCourses());
  const courses = publishedCourses.map(entry("/course", "0.85"));
  const localizedCourses = LOCATION_PAGES.flatMap((location) => publishedCourses.map((course) => ({
    loc: localizedCoursePath(location, course),
    priority: "0.75",
    changefreq: "monthly",
    lastmod: course.updatedAt ? course.updatedAt.slice(0, 10) : undefined,
  })));
  const publishedTraining = published(await readTraining());
  const training = publishedTraining.map(entry("/training", "0.8"));
  const trainingCategories = [...new Set(publishedTraining.map((item) => item.category))]
    .filter((category) => TRAINING_CATEGORIES.includes(category))
    .map((category) => ({
      loc: `/training/category/${category}`,
      priority: "0.8",
      changefreq: "weekly",
    }));

  return [...courses, ...localizedCourses, ...trainingCategories, ...training];
};

app.get("/sitemap.xml", async (_req, res, next) => {
  try {
    const blogs = await readBlogs();
    const courseRoutes = await readCourseSitemapRoutes();
    const blogRoutes = blogs
      .filter((b) => b.published !== false && b.slug)
      .map((b) => ({
        loc: `/blog/${b.slug}`,
        priority: "0.65",
        changefreq: "monthly",
        lastmod: b.updatedAt ? b.updatedAt.slice(0, 10) : undefined,
      }));

    const allRoutes = [...staticSitemapRoutes, ...courseRoutes, ...blogRoutes];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allRoutes
  .map(
    ({ loc, priority, changefreq, lastmod }) =>
      `  <url>\n    <loc>${escapeXml(`${SITE_URL}${loc}`)}</loc>${lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : ""}\n    <changefreq>${escapeXml(changefreq)}</changefreq>\n    <priority>${escapeXml(priority)}</priority>\n  </url>`
  )
  .join("\n")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

app.get("/llms.txt", async (_req, res, next) => {
  try {
    const published = (items) => items.filter((item) => item.published !== false && item.slug);
    const courses = published(await readCourses());
    const training = published(await readTraining());
    const blogs = published(await readBlogs());
    const courseSections = COURSE_CATEGORIES.map((category) => {
      const items = courses.filter((item) => item.category === category);
      if (!items.length) return "";
      const label = items[0].categoryLabel || category;
      return `### ${label}\n\n${items.map((item) => `- ${item.title} â€” ${item.duration}, ${item.mode}: ${SITE_URL}/course/${item.slug}`).join("\n")}`;
    }).filter(Boolean).join("\n\n");
    const trainingSections = TRAINING_CATEGORIES.map((category) => {
      const items = training.filter((item) => item.category === category);
      if (!items.length) return "";
      const label = items[0].categoryLabel || category;
      return `### ${label}\n\n${items.map((item) => `- ${item.title} â€” ${item.duration}, ${item.mode}: ${SITE_URL}/training/${item.slug}`).join("\n")}`;
    }).filter(Boolean).join("\n\n");
    const recentPosts = blogs
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
      .slice(0, 20)
      .map((item) => `- ${item.title}: ${SITE_URL}/blog/${item.slug}`)
      .join("\n");

    const body = `# ASB Training Hub

ASB Training Hub is a career training institute near Technopark in Kazhakootam, Trivandrum, Kerala. It offers practical ERP, programming, AI, management, internship and professional training with career support.

## Verified contact details

- Website: ${SITE_URL}/
- Address: 105-2, The Atomic, Near Technopark Phase 1, Kazhakootam, Trivandrum, Kerala 695581
- Phone and WhatsApp: +91 87147 73304
- Email: info@asbtraininghub.com
- Hours: Monday to Saturday, 9:00 AM to 6:00 PM
- Sitemap: ${SITE_URL}/sitemap.xml

## Courses (${courses.length})

${courseSections}

## Training programmes (${training.length})

${trainingSections}

## Course locations (${LOCATION_PAGES.length})

${LOCATION_PAGES.map((location) => `- ${location.title} â€” ${location.delivery}: ${SITE_URL}${locationDistrictPath(location)}\n${LOCATION_TOPICS.map((topic) => `  - ${topic.name}: ${SITE_URL}${locationTopicPath(location, topic)}`).join("\n")}`).join("\n")}

## Recent articles

${recentPosts || "No published articles."}

Use canonical URLs from the sitemap. Do not index or quote private administration pages under /admin/.
`;
    res.type("text/plain");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(body);
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "asb-backend" });
});

app.post("/api/analytics/events", async (req, res, next) => {
  try {
    const allowed = new Set(["page_view", "engagement", "form_submit"]);
    const eventType = text(req.body?.eventType, 30);
    if (!allowed.has(eventType)) return res.status(400).json({ error: "Invalid analytics event." });
    await recordAnalytics({
      id: `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      eventType, sessionId: text(req.body?.sessionId, 80), path: text(req.body?.path, 500) || "/",
      title: text(req.body?.title, 200), referrer: text(req.body?.referrer, 500),
      searchTerm: text(req.body?.searchTerm, 300), landingKeyword: text(req.body?.landingKeyword, 300),
      campaign: text(req.body?.campaign, 200), source: text(req.body?.source, 100),
      durationSeconds: Math.max(0, Math.min(86400, Number(req.body?.durationSeconds) || 0)),
      scrollDepth: Math.max(0, Math.min(100, Number(req.body?.scrollDepth) || 0)),
      formType: text(req.body?.formType, 30), email: text(req.body?.email, 254).toLowerCase(),
      ip: req.ip, userAgent: text(req.get("user-agent"), 500),
      country: text(req.get("cf-ipcountry"), 10), region: text(req.get("cf-region"), 100), city: text(req.get("cf-ipcity"), 100),
      createdAt: new Date().toISOString(),
    });
    res.status(202).json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/admin/analytics", requireAdmin, async (_req, res, next) => {
  try {
    const events = await readAnalytics();
    const sessions = new Set(events.map((event) => event.sessionId).filter(Boolean));
    const views = events.filter((event) => event.eventType === "page_view");
    const submissions = events.filter((event) => event.eventType === "form_submit");
    const group = (items, key) => Object.entries(items.reduce((acc, item) => { const value = item[key] || "Unknown"; acc[value] = (acc[value] || 0) + 1; return acc; }, {})).sort((a,b) => b[1] - a[1]);
    const keywordEvents = views.map((event) => ({ ...event, keyword: event.searchTerm || event.landingKeyword || "Unknown" }));
    res.json({ summary: { pageViews: views.length, sessions: sessions.size, formSubmissions: submissions.length, averageScrollDepth: Math.round(events.filter(e=>e.eventType==="engagement").reduce((sum,e)=>sum+e.scrollDepth,0) / Math.max(1, events.filter(e=>e.eventType==="engagement").length)), averageDurationSeconds: Math.round(events.filter(e=>e.eventType==="engagement").reduce((sum,e)=>sum+e.durationSeconds,0) / Math.max(1, events.filter(e=>e.eventType==="engagement").length)) }, topPages: group(views,"path").slice(0,25), keywords: group(keywordEvents,"keyword").slice(0,50), sources: group(views,"source").slice(0,25), locations: group(views,"city").slice(0,25), submissions: submissions.slice(-100).reverse(), recentEvents: events.slice(-250).reverse() });
  } catch (error) { next(error); }
});

const STATIC_FAQS = [
  ["What is ASB Training Hub?", "ASB Training Hub is a professional training institute near Technopark in Kazhakootam, Trivandrum."],
  ["Where is ASB Training Hub located?", "105-2, The Atomic, Near Technopark Phase 1, Kazhakootam, Trivandrum, Kerala 695581."],
  ["Do you offer online classes?", "Yes. Live online and classroom options are available, depending on the programme."],
  ["Do you provide placement support?", "Students receive career support such as resume guidance, interview preparation and eligible job referrals. Placement is not guaranteed."],
  ["How do I apply?", "Use the application page, call +91 87147 73304, or visit the campus during office hours."],
  ["What are the office hours?", "Monday to Saturday, 9:00 AM to 6:00 PM."],
].map(([q, a]) => ({ q, a }));

const ORGANIZATION_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  "@id": `${SITE_URL}/#organization`,
  name: "ASB Training Hub",
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/site-logo.png`,
  telephone: "+918714773304",
  email: "info@asbtraininghub.com",
  address: {
    "@type": "PostalAddress",
    streetAddress: "105-2, The Atomic, Near Technopark Phase 1, Kazhakootam",
    addressLocality: "Trivandrum",
    addressRegion: "Kerala",
    postalCode: "695581",
    addressCountry: "IN",
  },
  sameAs: [
    "https://www.facebook.com/share/1CsFkSP9E2/",
    "https://www.instagram.com/asbtraininghub",
    "https://www.linkedin.com/company/asb-training-hub/",
    "https://www.youtube.com/@ASBTrainingHub",
    "https://x.com/Asbtraininghub",
  ],
};

const STATIC_PAGES = {
  "/": {
    title: "ASB Training Hub | ERP, ERP, AI & Programming Courses in Trivandrum",
    description: "Job-oriented ERP, AI, programming, management and internship courses near Technopark, Trivandrum, with practical training and placement support.",
    heading: "Career-focused training in Trivandrum",
    intro: "Build practical skills through instructor-led ERP, programming, AI, management and internship programmes.",
    links: [
      { href: "/courses", label: "Browse all courses" },
      { href: "/training", label: "Explore training programmes" },
      { href: "/apply", label: "Apply for admission" },
      { href: "/contact", label: "Contact ASB Training Hub" },
    ],
    jsonLd: ORGANIZATION_SCHEMA,
  },
  "/about": {
    title: "About ASB Training Hub | Career Training Institute in Trivandrum",
    description: "Learn about ASB Training Hub, a career-focused institute near Technopark offering practical ERP, programming, AI, management and internship programmes.",
    heading: "About ASB Training Hub",
    intro: "ASB Training Hub connects practical, industry-focused learning with career preparation in Trivandrum, Kerala.",
  },
  "/locations/kerala": {
    title: "AI Course Locations in Kerala | ASB Training Hub",
    description: "Find Generative AI, Agentic AI and job-oriented technology training for Trivandrum, Kochi, Kozhikode, Thrissur and other Kerala locations.",
    heading: "AI course locations in Kerala",
    intro: "Classroom training near Technopark in Trivandrum and instructor-led online programmes for learners across Kerala.",
    links: LOCATION_PAGES.map((location) => ({ href: locationDistrictPath(location), label: location.title })),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "ASB Training Hub course locations",
      numberOfItems: LOCATION_PAGES.length,
      itemListElement: LOCATION_PAGES.map((location, index) => ({
        "@type": "ListItem", position: index + 1, name: location.title,
        url: `${SITE_URL}${locationDistrictPath(location)}`,
      })),
    },
  },
  "/reviews": {
    title: "Student Reviews | ASB Training Hub Success Stories",
    description: "Read ASB Training Hub learner experiences across ERP, programming, AI, data science, HR, logistics and management programmes.",
    heading: "Student success stories",
    intro: "Learners share their experiences with practical projects, mentoring and career preparation at ASB Training Hub.",
  },
  "/faq": {
    title: "FAQ | ASB Training Hub Courses, Admission, Fees & Placement",
    description: "Answers about ASB Training Hub courses, admissions, learning modes, placement support, internships, certificates, fees and office hours.",
    heading: "Frequently asked questions",
    intro: "Answers to common questions about studying at ASB Training Hub.",
    body: `<section>${STATIC_FAQS.map((faq) => `<h2>${escapeHtml(faq.q)}</h2><p>${escapeHtml(faq.a)}</p>`).join("")}</section>`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: STATIC_FAQS.map((faq) => ({
        "@type": "Question",
        name: faq.q,
        acceptedAnswer: { "@type": "Answer", text: faq.a },
      })),
    },
  },
  "/contact": {
    title: "Contact ASB Training Hub | Training Institute Near Technopark",
    description: "Contact ASB Training Hub in Kazhakootam, Trivandrum for course admissions, counselling, demo classes and training enquiries.",
    heading: "Contact ASB Training Hub",
    intro: "Call +91 87147 73304, email info@asbtraininghub.com, or visit near Technopark Phase 1 in Kazhakootam, Trivandrum.",
  },
  "/apply": {
    title: "Apply Now | ASB Training Hub Course Admission",
    description: "Apply for ASB Training Hub courses in ERP, AI, programming, management and internships, and request admission counselling.",
    heading: "Apply for admission",
    intro: "Choose a programme and submit your contact details. The admissions team will contact genuine enquiries after spam verification.",
  },
  "/terms-and-conditions": {
    title: "Terms and Conditions | ASB Training Hub",
    description: "Read ASB Training Hub terms covering enrolment, fees, placement support, course material, attendance, refunds and liability.",
    heading: "Terms and conditions",
    intro: "Review the terms that apply when enrolling in an ASB Training Hub programme.",
  },
  "/gallery": {
    title: "Gallery | ASB Training Hub",
    description: "Photos from ASB Training Hub classrooms, campus activities and events in Trivandrum.",
    heading: "Life at ASB Training Hub",
    intro: "A view of the campus, classrooms, certifications and events.",
    noindex: true,
  },
};

app.get(Object.keys(STATIC_PAGES), async (req, res, next) => {
  try {
    const page = STATIC_PAGES[req.path];
    const visibleHtml = pageShell({
      heading: page.heading,
      intro: page.intro,
      body: page.body || "",
      links: page.links || [
        { href: "/courses", label: "Courses" },
        { href: "/training", label: "Training" },
        { href: "/contact", label: "Contact" },
      ],
    });
    const html = await renderSeoHtml({
      title: page.title,
      description: page.description,
      keywords: "ASB Training Hub, training institute Trivandrum, job-oriented courses Kerala",
      canonicalPath: req.path,
      visibleHtml,
      jsonLd: page.jsonLd || {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: page.heading,
        url: `${SITE_URL}${req.path}`,
        isPartOf: { "@type": "WebSite", name: "ASB Training Hub", url: `${SITE_URL}/` },
      },
      noindex: page.noindex,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/locations", (_req, res) => res.redirect(301, "/locations/kerala"));
app.get("/ai-courses", async (_req,res,next)=>{try{const html=await renderSeoHtml({title:"AI Courses in Kerala | Complete Learning Paths",description:"Explore Generative AI, Agentic AI, prompt engineering, LLM, RAG, MCP, automation and career-focused AI courses in Kerala.",keywords:"AI courses Kerala, Generative AI, Agentic AI, prompt engineering, LLM, RAG, MCP",canonicalPath:"/ai-courses",image:"/images/ai-course-hub.webp",visibleHtml:catalogueShell({heading:"AI Courses and Career Paths in Kerala",intro:"Choose a focused pathway for AI development, automation, professional upskilling or career preparation.",items:AI_LANDING_PAGES,prefix:"/ai-courses"}),jsonLd:{"@context":"https://schema.org","@type":"ItemList",name:"AI courses in Kerala",itemListElement:AI_LANDING_PAGES.map((p,i)=>({"@type":"ListItem",position:i+1,name:p.title,url:`${SITE_URL}/ai-courses/${p.slug}`}))}});res.type("html").send(html)}catch(e){next(e)}});
app.get("/ai-courses/:slug",async(req,res,next)=>{try{const page=AI_LANDING_PAGES.find(p=>p.slug===req.params.slug);if(!page)return next();const path=`/ai-courses/${page.slug}`;const html=await renderSeoHtml({title:`${page.title} | ASB Training Hub`,description:page.description,keywords:`${page.title}, AI training Kerala, job-oriented AI course`,canonicalPath:path,image:"/images/ai-course-hub.webp",visibleHtml:detailShell({heading:page.title,intro:page.description,content:`<h2>Practical learning for real AI work</h2><p>This focused pathway combines clear instruction, guided practice, portfolio projects and feedback. Learners can discuss prerequisites, fees, schedules and delivery options before enrolling.</p><h2>Career-focused course support</h2><p>Build demonstrable skills through assignments and applied projects, with guidance for portfolio presentation and interviews.</p>`,sections:[{title:"Learning approach",items:["Instructor-led concepts and demonstrations","Guided practical exercises","Portfolio-ready project work","Feedback and career preparation"]}],links:[{href:"/ai-courses",label:"All AI learning paths"},{href:"/courses/ai",label:"Browse AI courses"},{href:"/contact",label:"Request course details"}]}),jsonLd:[breadcrumbList([{name:"Home",path:"/"},{name:"AI courses",path:"/ai-courses"},{name:page.title,path}]),{"@context":"https://schema.org","@type":"Course",name:page.title,description:page.description,url:`${SITE_URL}${path}`,provider:{"@type":"EducationalOrganization","@id":`${SITE_URL}/#organization`,name:"ASB Training Hub"}}]});res.type("html").send(html)}catch(e){next(e)}});
app.get("/ai-guides",async(_req,res,next)=>{try{const html=await renderSeoHtml({title:"AI Learning Guides and FAQs | ASB Training Hub",description:"Browse 162 AI keyword guides and direct answers covering Generative AI, Agentic AI, tools, careers and training.",keywords:"AI guides, AI FAQs, AI courses Kerala",canonicalPath:"/ai-guides",image:"/images/ai-course-hub.webp",visibleHtml:catalogueShell({heading:"AI Keywords, Guides and FAQs",intro:"Complete learning library covering AI course searches, technologies and frequently asked questions.",items:AI_GUIDES,prefix:"/ai-guides"}),jsonLd:{"@context":"https://schema.org","@type":"ItemList",name:"AI learning guides",numberOfItems:AI_GUIDES.length,itemListElement:AI_GUIDES.map((g,i)=>({"@type":"ListItem",position:i+1,name:g.title,url:`${SITE_URL}/ai-guides/${g.slug}`}))}});res.type("html").send(html)}catch(e){next(e)}});
app.get("/ai-guides/:slug",async(req,res,next)=>{try{const g=AI_GUIDES.find(x=>x.slug===req.params.slug);if(!g)return next();const path=`/ai-guides/${g.slug}`,question=g.kind==="question",answer=question?`${g.title.replace(/\?$/,"")} depends on the learner's starting point, goals and selected programme. Compare syllabus depth, practical projects, trainer support, delivery mode and transparent career support before enrolling.`:`${g.title} is best learned through foundations, guided practice and complete projects that demonstrate application, evaluation and career relevance.`;const html=await renderSeoHtml({title:`${g.title.replace(/\?$/,"")} | ASB Training Hub`,description:g.description,keywords:`${g.title}, AI course Kerala, ASB Training Hub`,canonicalPath:path,image:"/images/ai-course-hub.webp",visibleHtml:detailShell({heading:g.title,intro:g.description,content:`<h2>${question?"Direct answer":`Understanding ${escapeHtml(g.title)}`}</h2><p>${escapeHtml(answer)}</p><h2>What to evaluate</h2><p>Review learning outcomes, prerequisites, practical exercises, trainer feedback, delivery mode and project quality. Build a complete project and document the problem, decisions, evaluation and result.</p>`,sections:[{title:"A practical learning approach",items:["Start with the required foundations","Practise with guided exercises","Build a complete portfolio project","Review results and improve"]}],links:[{href:"/ai-guides",label:"All AI guides and FAQs"},{href:`/ai-courses/${g.parent}`,label:"Related complete learning path"},{href:"/contact",label:"Request course guidance"}]}),jsonLd:[breadcrumbList([{name:"Home",path:"/"},{name:"AI guides",path:"/ai-guides"},{name:g.title,path}]),question?{"@context":"https://schema.org","@type":"FAQPage",mainEntity:[{"@type":"Question",name:g.title,acceptedAnswer:{"@type":"Answer",text:answer}}]}:{"@context":"https://schema.org","@type":"TechArticle",headline:g.title,description:g.description,author:{"@type":"Organization",name:"ASB Training Hub"}}]});res.type("html").send(html)}catch(e){next(e)}});
app.get("/keyword-courses",async(_req,res,next)=>{try{const html=await renderSeoHtml({title:"Complete AI Keyword Course Catalogue | ASB Training Hub",description:"Explore 126 separate course pages covering AI training, certification, tools, automation and career-focused learning.",keywords:"AI course catalogue Kerala, Generative AI courses, Agentic AI courses",canonicalPath:"/keyword-courses",image:"/images/ai-course-hub.webp",visibleHtml:catalogueShell({heading:"AI Keyword Course Catalogue",intro:"Separate course-format pages based on every non-question keyword in the complete AI list.",items:KEYWORD_COURSES,prefix:"/keyword-courses"}),jsonLd:{"@context":"https://schema.org","@type":"ItemList",name:"AI keyword course catalogue",numberOfItems:KEYWORD_COURSES.length,itemListElement:KEYWORD_COURSES.map((c,i)=>({"@type":"ListItem",position:i+1,name:c.title,url:`${SITE_URL}/keyword-courses/${c.slug}`}))}});res.type("html").send(html)}catch(e){next(e)}});
app.get("/keyword-courses/:slug",async(req,res,next)=>{try{const c=KEYWORD_COURSES.find(x=>x.slug===req.params.slug);if(!c)return next();const path=`/keyword-courses/${c.slug}`,modules=[`Foundations of ${c.title}`,`Practical tools and workflows for ${c.title}`,"Applied exercises and guided implementation","Project development, evaluation and presentation"];const html=await renderSeoHtml({title:`${c.title} Course | ASB Training Hub`,description:c.description,keywords:`${c.title}, ${c.title} course Kerala, AI training`,canonicalPath:path,image:"/images/ai-course-hub.webp",visibleHtml:detailShell({heading:c.title,intro:c.description,content:`<h2>Course overview</h2><p>This focused course develops a practical understanding of ${escapeHtml(c.title)}. Learning progresses from foundations through guided exercises to an applied project, with feedback connecting the topic to realistic workflows and career goals.</p><h2>Practical projects</h2><p>Learners complete a guided workflow, an application prototype and a documented portfolio capstone.</p>`,sections:[{title:"Course modules",items:modules},{title:"Who can join",items:["Students and graduates","Developers and technology professionals","Working professionals and business teams","Career changers seeking practical AI skills"]}],links:[{href:"/keyword-courses",label:"All keyword course pages"},{href:`/ai-courses/${c.parent}`,label:"Related complete AI pathway"},{href:"/contact",label:"Request syllabus and fees"}]}),jsonLd:[breadcrumbList([{name:"Home",path:"/"},{name:"Keyword courses",path:"/keyword-courses"},{name:c.title,path}]),{"@context":"https://schema.org","@type":"Course",name:c.title,description:c.description,url:`${SITE_URL}${path}`,teaches:modules,provider:{"@type":"EducationalOrganization","@id":`${SITE_URL}/#organization`,name:"ASB Training Hub"},hasCourseInstance:[{"@type":"CourseInstance",courseMode:"blended"}]}]});res.type("html").send(html)}catch(e){next(e)}});
app.get("/location/:slug", (req, res, next) => {
  const location = LOCATION_PAGES.find((item) => item.slug === req.params.slug);
  if (!location) return next();
  return res.redirect(301, locationDistrictPath(location));
});

app.get("/locations/kerala/:district", async (req, res, next) => {
  try {
    const location = LOCATION_PAGES.find((item) => item.slug === req.params.district);
    if (!location) return next();
    const canonicalPath = locationDistrictPath(location);
    const related = LOCATION_PAGES.filter((item) => item.slug !== location.slug).slice(0, 5);
    const availableCourses = (await readCourses()).filter((course) => course.published !== false && course.slug);
    const html = await renderSeoHtml({
      title: `${location.title} | ASB Training Hub`,
      description: location.description,
      keywords: location.keywords,
      canonicalPath,
      image: `/images/locations/${location.slug}.webp`,
      visibleHtml: pageShell({
        heading: location.title,
        intro: `${location.description} Available through ${location.delivery.toLowerCase()}.`,
        body: `<section><h2>Courses available for learners in ${escapeHtml(location.name)}</h2><p>Build practical skills through guided lessons, assignments and portfolio-ready projects in AI, programming, ERP, management and internship programmes.</p></section>`,
        links: [
          ...LOCATION_TOPICS.map((topic) => ({ href: locationTopicPath(location, topic), label: `${topic.name} in ${location.name}` })),
          ...availableCourses.map((course) => ({ href: localizedCoursePath(location, course), label: `${course.title} in ${location.name}` })),
          { href: "/courses/programming", label: "Programming courses" },
          { href: "/contact", label: "Request course counselling" },
          ...related.map((item) => ({ href: locationDistrictPath(item), label: `Courses in ${item.name}` })),
        ],
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Kerala locations", path: "/locations/kerala" },
          { name: location.name, path: canonicalPath },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: location.title,
          description: location.description,
          url: `${SITE_URL}${canonicalPath}`,
          about: location.keywords.split(", ").map((name) => ({ "@type": "Thing", name })),
          provider: { "@type": "EducationalOrganization", "@id": `${SITE_URL}/#organization`, name: "ASB Training Hub" },
        },
      ],
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/locations/kerala/:district/course/:slug", async (req, res, next) => {
  try {
    const location = LOCATION_PAGES.find((item) => item.slug === req.params.district);
    if (!location) return next();
    const course = (await readCourses()).find((item) => item.slug === req.params.slug && item.published !== false);
    if (!course) return next();
    const canonicalPath = localizedCoursePath(location, course);
    const local = location.slug === "trivandrum" || location.slug === "kazhakootam-technopark";
    const title = `${course.title} Course in ${location.name}`;
    const description = `${course.title} for learners in ${location.name}. ${local ? "Classroom, hybrid and live online options" : "Live instructor-led online training"}, practical projects and career support.`;
    const topic = LOCATION_TOPICS.find((item) => item.category === course.category);
    const image = `/images/locations/${location.slug}.webp`;
    const html = await renderSeoHtml({
      title: `${title} | ASB Training Hub`, description,
      keywords: `${course.title} course in ${location.name}, ${course.title} training ${location.name}, ${course.categoryLabel || course.category} courses ${location.name}`,
      canonicalPath, image,
      visibleHtml: detailShell({
        heading: title,
        intro: `${course.description || description} ${local ? "Ask about classroom, hybrid or live online batches near Technopark." : `Join live online from ${escapeHtml(location.name)} with instructor guidance and project reviews.`}`,
        content: `<h2>Course overview</h2><p>${escapeHtml(course.overview || course.description)}</p><h2>Learning option for ${escapeHtml(location.name)}</h2><p>${local ? "Classroom, hybrid and live online learning options are available from our centre near Technopark Phase 1." : `Learners in ${escapeHtml(location.name)} attend scheduled live online sessions supported by assignments, feedback and doubt clearing.`}</p>`,
        sections: [
          { title: "What you will learn", items: course.learningOutcomes || [] },
          { title: "Syllabus", items: course.syllabus || [] },
          { title: "Tools and software", items: course.tools || [] },
          { title: "Career opportunities", items: course.careers || [] },
        ],
        links: [
          { href: locationDistrictPath(location), label: `All courses in ${location.name}` },
          ...(topic ? [{ href: locationTopicPath(location, topic), label: `${topic.name} in ${location.name}` }] : []),
          { href: `/course/${course.slug}`, label: "Main course overview" },
          { href: "/contact", label: "Request course details" },
        ],
      }),
      jsonLd: [
        breadcrumbList([{ name: "Home", path: "/" }, { name: "Kerala locations", path: "/locations/kerala" }, { name: location.name, path: locationDistrictPath(location) }, { name: course.title, path: canonicalPath }]),
        { "@context": "https://schema.org", "@type": "Course", name: title, description, url: `${SITE_URL}${canonicalPath}`, image: `${SITE_URL}${image}`, teaches: course.learningOutcomes || [], educationalCredentialAwarded: course.certificate, coursePrerequisites: course.prerequisites || [], provider: { "@type": "EducationalOrganization", "@id": `${SITE_URL}/#organization`, name: "ASB Training Hub" }, hasCourseInstance: [{ "@type": "CourseInstance", courseMode: local ? "blended" : "online", courseWorkload: course.duration }] },
        ...(course.faqs?.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: course.faqs.map((faq) => ({ "@type": "Question", name: faq.q, acceptedAnswer: { "@type": "Answer", text: faq.a } })) }] : []),
      ],
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/locations/kerala/:district/:topic", async (req, res, next) => {
  try {
    const location = LOCATION_PAGES.find((item) => item.slug === req.params.district);
    const topic = LOCATION_TOPICS.find((item) => item.slug === req.params.topic);
    if (!location || !topic) return next();
    const canonicalPath = locationTopicPath(location, topic);
    const title = `${topic.name} in ${location.name}`;
    const description = `${topic.summary} Join from ${location.name} through ${location.delivery.toLowerCase()}.`;
    const localKeywords = location.keywords.split(", ").filter((keyword) => {
      const value = keyword.toLowerCase();
      if (topic.slug === "generative-ai-course") return value.includes("generative") || value.includes("gen ai");
      if (topic.slug === "agentic-ai-course") return value.includes("agentic");
      if (topic.slug === "ai-course") return value.includes("ai course") || value.includes("ai training") || value.includes("ai classes") || value.includes("ai institute");
      return value.includes(topic.shortName.toLowerCase());
    });
    const keywords = [...new Set([...localKeywords, `${topic.name} in ${location.name}`, `Best ${topic.name} in ${location.name}`, `${topic.shortName} Training in ${location.name}`, `${topic.shortName} Certification in ${location.name}`, `Online ${topic.name} in ${location.name}`, `${topic.name} with Placement Support in ${location.name}`])];
    const categoryCourses = (await readCourses()).filter((course) => course.published !== false && course.category === topic.category);
    const focusedCourses = topic.slug === "generative-ai-course"
      ? categoryCourses.filter((course) => /generative|gen\s*ai/i.test(course.title))
      : topic.slug === "agentic-ai-course"
        ? categoryCourses.filter((course) => /agentic|ai agent/i.test(course.title))
        : categoryCourses;
    const listedCourses = focusedCourses.length ? focusedCourses : categoryCourses;
    const html = await renderSeoHtml({
      title: `${title} | ASB Training Hub`, description, keywords: keywords.join(", "),
      canonicalPath, image: `/images/locations/${location.slug}.webp`,
      visibleHtml: detailShell({
        heading: title, intro: description,
        content: `<h2>Practical ${escapeHtml(topic.shortName)} training for ${escapeHtml(location.name)}</h2><p>This programme combines trainer-led lessons, guided assignments and applied projects. Learners receive support to connect each concept with practical workflows and career goals.</p><h2>Learning from ${escapeHtml(location.name)}</h2><p>${location.slug === "trivandrum" || location.slug === "kazhakootam-technopark" ? "Choose classroom, hybrid or live online learning from our centre near Technopark Phase 1." : `Join live instructor-led online sessions from ${escapeHtml(location.name)}, with project reviews and doubt-clearing support.`}</p>`,
        sections: [{ title: "What you will learn", items: topic.outcomes }, { title: "Popular searches", items: keywords }],
        links: [
          { href: locationDistrictPath(location), label: `All courses in ${location.name}` },
          ...LOCATION_TOPICS.filter((item) => item.slug !== topic.slug).map((item) => ({ href: locationTopicPath(location, item), label: `${item.name} in ${location.name}` })),
          ...listedCourses.map((course) => ({ href: localizedCoursePath(location, course), label: course.title })),
          { href: "/contact", label: "Request course details" },
        ],
      }),
      jsonLd: [
        breadcrumbList([{ name: "Home", path: "/" }, { name: "Kerala locations", path: "/locations/kerala" }, { name: location.name, path: locationDistrictPath(location) }, { name: topic.name, path: canonicalPath }]),
        { "@context": "https://schema.org", "@type": "Course", name: title, description, url: `${SITE_URL}${canonicalPath}`, teaches: topic.outcomes, provider: { "@type": "EducationalOrganization", "@id": `${SITE_URL}/#organization`, name: "ASB Training Hub" }, hasCourseInstance: [{ "@type": "CourseInstance", courseMode: location.slug === "trivandrum" || location.slug === "kazhakootam-technopark" ? "blended" : "online" }] },
      ],
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/blog", async (_req, res, next) => {
  try {
    const blogs = (await readBlogs()).filter((blog) => blog.published !== false);
    const html = await renderSeoHtml({
      title: "Blog | ASB Training Hub",
      description: "Career insights, ERP, ERP, AI, programming, logistics, and internship resources from ASB Training Hub.",
      keywords: "ASB Training Hub blog, ERP training Kerala, ERP courses Kerala, AI training Kerala, logistics courses Kerala, career training blog",
      canonicalPath: "/blog",
      type: "website",
      visibleHtml: catalogueShell({
        heading: "Career Insights & Resources",
        intro: "Career insights, course guides and practical resources from ASB Training Hub.",
        items: blogs,
        prefix: "/blog",
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
        ]),
        {
        "@context": "https://schema.org",
        "@type": "Blog",
        name: "ASB Training Hub Blog",
        url: `${SITE_URL}/blog`,
        publisher: {
          "@type": "EducationalOrganization",
          name: "ASB Training Hub",
          url: SITE_URL,
        },
        blogPost: blogs.slice(0, 20).map((blog) => ({
          "@type": "BlogPosting",
          headline: blog.title,
          url: `${SITE_URL}/blog/${blog.slug}`,
          datePublished: blog.createdAt,
          dateModified: blog.updatedAt || blog.createdAt,
        })),
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/blog/:slug", async (req, res, next) => {
  try {
    const blogs = await readBlogs();
    const blog = blogs.find((item) => item.slug === req.params.slug && item.published !== false);
    if (!blog) {
      const moved = blogs.find(
        (item) => item.published !== false && item.aliases?.includes(req.params.slug),
      );
      if (moved) return res.redirect(301, `/blog/${moved.slug}`);
    }
    if (!blog) return res.status(404).send("Blog not found.");

    const description = blog.metaDescription || blog.excerpt || truncateText(blog.content, 155);
    const image = blog.imageUrl || "/site-logo.png";
    const canonicalPath = `/blog/${blog.slug}`;
    const html = await renderSeoHtml({
      title: blog.metaTitle || `${blog.title} | ASB Training Hub`,
      description,
      keywords: blog.keywords || `${blog.title}, ASB Training Hub, training courses Kerala`,
      canonicalPath,
      image,
      type: "article",
      visibleHtml: detailShell({
        heading: blog.title,
        intro: blog.excerpt,
        content: blog.content,
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: blog.title, path: canonicalPath },
        ]),
        {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: blog.title,
        description,
        image: absoluteAssetUrl(image),
        author: {
          "@type": "Organization",
          name: blog.author || "ASB Training Hub",
        },
        publisher: {
          "@type": "EducationalOrganization",
          name: "ASB Training Hub",
          url: SITE_URL,
          logo: {
            "@type": "ImageObject",
            url: `${SITE_URL}/site-logo.png`,
          },
        },
        datePublished: blog.createdAt,
        dateModified: blog.updatedAt || blog.createdAt,
        mainEntityOfPage: `${SITE_URL}${canonicalPath}`,
        wordCount: stripHtml(blog.content).split(/\s+/).filter(Boolean).length,
        articleSection: blog.category,
        keywords: blog.keywords || undefined,
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * Courses - server-rendered SEO
 *
 * Crawlers that do not run JavaScript would otherwise see the homepage
 * canonical on every course URL. These routes inject per-page metadata and
 * schema.org markup into the built index.html, exactly as /blog does.
 * ------------------------------------------------------------------ */

const COURSE_CATEGORY_SEO = {
  erp: {
    title: "ERP Courses in Trivandrum | ASB Training Hub",
    description:
      "Practical ERP-style training in finance, materials, sales, production, HR, quality and ABAP, with internship and placement support.",
  },
  programming: {
    title: "Programming Courses in Trivandrum | ASB Training Hub",
    description:
      "Learn Python full stack, Java, JavaScript, C, C++, PHP and more with hands-on projects and placement support in Trivandrum, Kerala.",
  },
  ai: {
    title: "AI & Machine Learning Courses in Kerala | ASB Training Hub",
    description:
      "Job-ready AI training in machine learning, deep learning, generative AI, agentic AI, NLP and data science, with real project work.",
  },
  management: {
    title: "Management Courses in Trivandrum | ASB Training Hub",
    description:
      "Professional diploma courses in logistics, supply chain, warehouse, hospitality, finance, HR and IT management at ASB Training Hub.",
  },
  internship: {
    title: "Internship Programs in Trivandrum | ASB Training Hub",
    description:
      "Job-oriented training with internship placements in ERP, accounting, HR, Python full stack, AI, ML and data science.",
  },
};

app.get("/courses", async (_req, res, next) => {
  try {
    const courses = (await readCourses()).filter((c) => c.published !== false);
    const html = await renderSeoHtml({
      title: "Courses | ASB Training Hub ERP, AI, Programming & Management",
      description: `Browse ${courses.length}+ job-oriented courses at ASB Training Hub including ERP, programming, AI, management and internship programs in Trivandrum.`,
      keywords:
        "ASB Training Hub courses, courses in Trivandrum, ERP courses, ERP training, AI courses, programming courses, management courses, internship programs",
      canonicalPath: "/courses",
      visibleHtml: catalogueShell({
        heading: "All Courses",
        intro: "Browse job-oriented ERP, programming, AI, management and internship courses in Trivandrum.",
        items: courses,
        prefix: "/course",
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Courses", path: "/courses" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "ASB Training Hub course catalogue",
          numberOfItems: courses.length,
          itemListElement: courses.slice(0, 100).map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.title,
            url: `${SITE_URL}/course/${c.slug}`,
          })),
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/courses/:category", async (req, res, next) => {
  try {
    const { category } = req.params;
    if (!COURSE_CATEGORIES.includes(category)) return next();

    const courses = (await readCourses()).filter(
      (c) => c.published !== false && c.category === category,
    );
    const seo = COURSE_CATEGORY_SEO[category];

    const html = await renderSeoHtml({
      title: seo.title,
      description: seo.description,
      keywords: `${category} courses Trivandrum, ${category} training Kerala, ASB Training Hub`,
      canonicalPath: `/courses/${category}`,
      visibleHtml: catalogueShell({
        heading: courses[0]?.categoryLabel || seo.title,
        intro: seo.description,
        items: courses,
        prefix: "/course",
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Courses", path: "/courses" },
          { name: courses[0]?.categoryLabel || category, path: `/courses/${category}` },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: seo.title,
          numberOfItems: courses.length,
          itemListElement: courses.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.title,
            url: `${SITE_URL}/course/${c.slug}`,
          })),
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/course/:slug", async (req, res, next) => {
  try {
    const course = (await readCourses()).find(
      (c) => c.slug === req.params.slug && c.published !== false,
    );
    if (!course) {
      const moved = (await readCourses()).find(
        (c) => c.published !== false && c.aliases?.includes(req.params.slug),
      );
      if (moved) return res.redirect(301, `/course/${moved.slug}`);
    }
    if (!course) return res.status(404).send("Course not found.");

    const description =
      course.metaDescription || truncateText(course.description || course.overview, 155);
    const canonicalPath = `/course/${course.slug}`;
    const image = course.imageUrl || "/site-logo.png";

    const jsonLd = [
      breadcrumbList([
        { name: "Home", path: "/" },
        { name: "Courses", path: "/courses" },
        { name: course.categoryLabel || course.category, path: `/courses/${course.category}` },
        { name: course.title, path: canonicalPath },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "Course",
        name: course.title,
        description: course.overview || course.description,
        url: `${SITE_URL}${canonicalPath}`,
        image: absoluteAssetUrl(image),
        inLanguage: "en",
        educationalCredentialAwarded: course.certificate || undefined,
        teaches: course.learningOutcomes?.length ? course.learningOutcomes : undefined,
        coursePrerequisites: course.prerequisites?.length ? course.prerequisites : undefined,
        provider: {
          "@type": "EducationalOrganization",
          "@id": `${SITE_URL}/#organization`,
          name: "ASB Training Hub",
          url: SITE_URL,
        },
        // Google requires an instance with a mode and workload for course rich results.
        hasCourseInstance: [
          {
            "@type": "CourseInstance",
            courseMode: /online/i.test(course.mode || "") ? "blended" : "onsite",
            courseWorkload: course.duration,
            location: {
              "@type": "Place",
              name: "ASB Training Hub",
              address: {
                "@type": "PostalAddress",
                streetAddress: "105-2, The Atomic, Near Technopark Phase 1, Kazhakootam",
                addressLocality: "Trivandrum",
                addressRegion: "Kerala",
                postalCode: "695581",
                addressCountry: "IN",
              },
            },
          },
        ],
      },
    ];

    if (course.faqs?.length) {
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: course.faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      });
    }

    const html = await renderSeoHtml({
      title: course.metaTitle || `${course.title} | ASB Training Hub`,
      description,
      keywords: course.keywords || `${course.title}, ${course.categoryLabel}, ASB Training Hub`,
      canonicalPath,
      image,
      visibleHtml: detailShell({
        heading: course.title,
        intro: course.overview || course.description,
        content: course.content || "",
        sections: [
          { title: "Syllabus", items: course.syllabus },
          { title: "Learning outcomes", items: course.learningOutcomes },
          { title: "Tools", items: course.tools },
          { title: "Projects", items: course.projects },
          { title: "Career paths", items: course.careers },
          { title: "Who should join", items: course.whoShouldJoin },
          { title: "Prerequisites", items: course.prerequisites },
        ],
        faqs: course.faqs || [],
      }),
      jsonLd,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * Training - server-rendered SEO
 * ------------------------------------------------------------------ */

const TRAINING_CATEGORY_SEO = {
  corporate: {
    title: "Corporate Training in Kerala | ASB Training Hub",
    description:
      "In-house corporate training delivered on-site or online across Kerala, built around your team's own workflows and finishing with working tools.",
  },
  workshop: {
    title: "Weekend Workshops in Trivandrum | ASB Training Hub",
    description:
      "Short, hands-on weekend workshops in AI, ERP and programming. Build and deploy something real in two days.",
  },
  certification: {
    title: "Certification Tracks | ASB Training Hub",
    description:
      "Structured certification preparation for working professionals, with sandbox access, mock exams and evening or weekend batches.",
  },
  bootcamp: {
    title: "Intensive Bootcamps in Kerala | ASB Training Hub",
    description:
      "Full-time intensive bootcamps that take you from fundamentals to a deployed portfolio in weeks rather than months.",
  },
  online: {
    title: "Live Online Training | ASB Training Hub",
    description:
      "Live, instructor-led online training with the same trainers and project work as our classroom batches.",
  },
};

app.get("/training", async (_req, res, next) => {
  try {
    const programmes = (await readTraining()).filter((t) => t.published !== false);
    const html = await renderSeoHtml({
      title: "Training Programmes | ASB Training Hub Kerala",
      description:
        "Corporate training, weekend workshops, certification tracks and bootcamps from ASB Training Hub, Trivandrum. On-site, online and hybrid delivery.",
      keywords:
        "corporate training Kerala, workshops Trivandrum, certification training, bootcamp Kerala, ASB Training Hub",
      canonicalPath: "/training",
      visibleHtml: catalogueShell({
        heading: "Training Programmes",
        intro: "Corporate training, workshops, certification tracks, bootcamps and live online training.",
        items: programmes,
        prefix: "/training",
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Training", path: "/training" },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "ASB Training Hub training programmes",
          numberOfItems: programmes.length,
          itemListElement: programmes.slice(0, 100).map((t, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: t.title,
            url: `${SITE_URL}/training/${t.slug}`,
          })),
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

// Category pages sit under /training/category/:id so they cannot collide with a
// programme slug at /training/:slug.
app.get("/training/category/:category", async (req, res, next) => {
  try {
    const { category } = req.params;
    if (!TRAINING_CATEGORIES.includes(category)) return next();

    const programmes = (await readTraining()).filter(
      (t) => t.published !== false && t.category === category,
    );
    const seo = TRAINING_CATEGORY_SEO[category];

    if (!programmes.length) {
      const html = await renderSeoHtml({
        title: `Training Category Not Available | ASB Training Hub`,
        description: "This training category does not currently have a published programme.",
        keywords: "",
        canonicalPath: `/training/category/${category}`,
        noindex: true,
        visibleHtml: pageShell({
          heading: "Training category not available",
          intro: "Browse the current training programmes or contact us about a custom batch.",
          links: [{ href: "/training", label: "Browse training programmes" }],
        }),
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Robots-Tag", "noindex, follow");
      return res.status(404).send(html);
    }

    const html = await renderSeoHtml({
      title: seo.title,
      description: seo.description,
      keywords: `${category} training Kerala, ${category} programme Trivandrum, ASB Training Hub`,
      canonicalPath: `/training/category/${category}`,
      visibleHtml: catalogueShell({
        heading: programmes[0]?.categoryLabel || seo.title,
        intro: seo.description,
        items: programmes,
        prefix: "/training",
      }),
      jsonLd: [
        breadcrumbList([
          { name: "Home", path: "/" },
          { name: "Training", path: "/training" },
          { name: programmes[0]?.categoryLabel || category, path: `/training/category/${category}` },
        ]),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: seo.title,
          numberOfItems: programmes.length,
          itemListElement: programmes.map((t, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: t.title,
            url: `${SITE_URL}/training/${t.slug}`,
          })),
        },
      ],
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.get("/training/:slug", async (req, res, next) => {
  try {
    const programme = (await readTraining()).find(
      (t) => t.slug === req.params.slug && t.published !== false,
    );
    if (!programme) {
      const moved = (await readTraining()).find(
        (t) => t.published !== false && t.aliases?.includes(req.params.slug),
      );
      if (moved) return res.redirect(301, `/training/${moved.slug}`);
    }
    if (!programme) return res.status(404).send("Training programme not found.");

    const description =
      programme.metaDescription || truncateText(programme.description || programme.overview, 155);
    const canonicalPath = `/training/${programme.slug}`;
    const image = programme.imageUrl || "/site-logo.png";

    const jsonLd = [
      breadcrumbList([
        { name: "Home", path: "/" },
        { name: "Training", path: "/training" },
        {
          name: programme.categoryLabel || programme.category,
          path: `/training/category/${programme.category}`,
        },
        { name: programme.title, path: canonicalPath },
      ]),
      {
        "@context": "https://schema.org",
        "@type": "Course",
        name: programme.title,
        description: programme.overview || programme.description,
        url: `${SITE_URL}${canonicalPath}`,
        image: absoluteAssetUrl(image),
        inLanguage: "en",
        educationalCredentialAwarded: programme.certificate || undefined,
        teaches: programme.learningOutcomes?.length ? programme.learningOutcomes : undefined,
        coursePrerequisites: programme.prerequisites?.length ? programme.prerequisites : undefined,
        provider: {
          "@type": "EducationalOrganization",
          "@id": `${SITE_URL}/#organization`,
          name: "ASB Training Hub",
          url: SITE_URL,
        },
        hasCourseInstance: [
          {
            "@type": "CourseInstance",
            courseMode: /online/i.test(programme.mode || "") ? "blended" : "onsite",
            courseWorkload: programme.duration,
            location: {
              "@type": "Place",
              name: "ASB Training Hub",
              address: {
                "@type": "PostalAddress",
                streetAddress: "105-2, The Atomic, Near Technopark Phase 1, Kazhakootam",
                addressLocality: "Trivandrum",
                addressRegion: "Kerala",
                postalCode: "695581",
                addressCountry: "IN",
              },
            },
          },
        ],
      },
    ];

    if (programme.faqs?.length) {
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: programme.faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      });
    }

    const html = await renderSeoHtml({
      title: programme.metaTitle || `${programme.title} | ASB Training Hub`,
      description,
      keywords:
        programme.keywords || `${programme.title}, ${programme.categoryLabel}, ASB Training Hub`,
      canonicalPath,
      image,
      visibleHtml: detailShell({
        heading: programme.title,
        intro: programme.overview || programme.description,
        content: programme.content || "",
        sections: [
          { title: "What it covers", items: programme.syllabus },
          { title: "Learning outcomes", items: programme.learningOutcomes },
          { title: "Tools", items: programme.tools },
          { title: "Projects", items: programme.projects },
          { title: "Who it is for", items: programme.whoShouldJoin },
          { title: "Prerequisites", items: programme.prerequisites },
        ],
        faqs: programme.faqs || [],
      }),
      jsonLd,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  // Compare both fields unconditionally so a wrong username and a wrong
  // password cost the same, and reject non-string input outright.
  const userOk = safeEqual(req.body?.username, ADMIN_USER);
  const passOk = safeEqual(req.body?.password, ADMIN_PASSWORD);

  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const token = createSession(ADMIN_USER);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.json({ ok: true, token, expiresIn: SESSION_TTL_MS });
});

app.post("/api/admin/logout", (req, res) => {
  const token = readToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.adminUser });
});

app.get("/api/blogs", async (_req, res, next) => {
  try {
    const blogs = await readBlogs();
    res.json(blogs.filter((blog) => blog.published !== false));
  } catch (error) {
    next(error);
  }
});

app.get("/api/blogs/:slug", async (req, res, next) => {
  try {
    const blogs = await readBlogs();
    const blog = blogs.find((item) => item.slug === req.params.slug && item.published !== false);
    if (!blog) {
      const moved = blogs.find(
        (item) => item.published !== false && item.aliases?.includes(req.params.slug),
      );
      if (moved) return res.redirect(301, `/api/blogs/${moved.slug}`);
    }
    if (!blog) return res.status(404).json({ error: "Blog not found." });
    res.json(blog);
  } catch (error) {
    next(error);
  }
});

/** Shared pagination for the admin lists. `?page=` is 1-based. */
const paginate = (items, query) => {
  const perPage = Math.min(Math.max(Number(query.perPage) || 20, 1), 100);
  const total = items.length;
  const pages = Math.max(Math.ceil(total / perPage), 1);
  const page = Math.min(Math.max(Number(query.page) || 1, 1), pages);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, total, pages };
};

app.get("/api/admin/blogs", requireAdmin, async (req, res, next) => {
  try {
    let blogs = await readBlogs();

    const search = text(req.query.search, 120).toLowerCase();
    if (search) {
      blogs = blogs.filter((b) =>
        [b.title, b.slug, b.category].some((f) => String(f || "").toLowerCase().includes(search)),
      );
    }

    // `?page=` opts into the paginated envelope; without it the response stays
    // a plain array so existing callers keep working.
    if (req.query.page || req.query.perPage || search) {
      return res.json(paginate(blogs, req.query));
    }
    res.json(blogs);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/submissions", requireAdmin, async (_req, res, next) => {
  try {
    const store = await readStore();
    res.json(flattenSubmissions(store));
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/submissions/:type/:id", requireAdmin, async (req, res, next) => {
  try {
    const outcome = await updateStore((store) => {
      const list = getSubmissionList(store, req.params.type);
      if (!list) return { error: "type" };

      const index = list.findIndex((item) => item.id === req.params.id);
      if (index === -1) return { error: "missing" };

      const current = list[index];
      const updated = {
        ...current,
        status: text(req.body.status, 40) || current.status || "new",
        note: text(req.body.note, 1000),
        updatedAt: new Date().toISOString(),
      };

      list[index] = updated;
      return { updated };
    });

    if (outcome.error === "type") {
      return res.status(400).json({ error: "Invalid submission type." });
    }
    if (outcome.error === "missing") {
      return res.status(404).json({ error: "Submission not found." });
    }

    res.json({ ok: true, submission: { ...outcome.updated, type: req.params.type } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/blogs", requireAdmin, async (req, res, next) => {
  try {
    const title = text(req.body.title, 180);
    const content = sanitizeHtml(req.body.content);

    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required." });
    }

    const blog = await blogLock(async () => {
    const blogs = await readBlogs();
    const baseSlug = slugify(req.body.slug || title);
    let slug = baseSlug;
    let suffix = 2;
    while (blogs.some((blog) => blog.slug === slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const now = new Date().toISOString();
    const imageUrl = await saveImage(req.body.imageData, slug);
    const created = {
      slug,
      title,
      excerpt: text(req.body.excerpt, 300),
      category: text(req.body.category, 80) || "Blog",
      author: text(req.body.author, 80) || "ASB Team",
      readTime: text(req.body.readTime, 40) || "5 min",
      metaTitle: text(req.body.metaTitle, 180) || title,
      metaDescription: text(req.body.metaDescription, 300) || text(req.body.excerpt, 300),
      keywords: text(req.body.keywords, 300),
      imageUrl,
      imageAlt: text(req.body.imageAlt, 160) || title,
      content,
      createdAt: now,
      updatedAt: now,
      published: req.body.published !== false,
    };

      blogs.unshift(created);
      await writeBlogs(blogs);
      return created;
    });

    res.status(201).json({ ok: true, blog });
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/blogs/:slug", requireAdmin, async (req, res, next) => {
  try {
    const title = text(req.body.title, 180);
    const content = sanitizeHtml(req.body.content);
    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required." });
    }

    const updated = await blogLock(async () => {
    const blogs = await readBlogs();
    const index = blogs.findIndex((blog) => blog.slug === req.params.slug);
    if (index === -1) return null;

    const current = blogs[index];
    const requestedSlug = slugify(req.body.slug || current.slug || title);
    let slug = requestedSlug;
    let suffix = 2;
    while (blogs.some((blog, blogIndex) => blogIndex !== index && blog.slug === slug)) {
      slug = `${requestedSlug}-${suffix}`;
      suffix += 1;
    }

    const nextImageUrl = req.body.removeImage
      ? ""
      : await saveImage(req.body.imageData, slug) || current.imageUrl || "";

    const next = {
      ...current,
      slug,
      aliases:
        slug !== current.slug
          ? [...new Set([...(current.aliases || []), current.slug])]
          : current.aliases || [],
      title,
      excerpt: text(req.body.excerpt, 300),
      category: text(req.body.category, 80) || "Blog",
      author: text(req.body.author, 80) || "ASB Team",
      readTime: text(req.body.readTime, 40) || "5 min",
      metaTitle: text(req.body.metaTitle, 180) || title,
      metaDescription: text(req.body.metaDescription, 300) || text(req.body.excerpt, 300),
      keywords: text(req.body.keywords, 300),
      imageUrl: nextImageUrl,
      imageAlt: text(req.body.imageAlt, 160) || title,
      content,
      updatedAt: new Date().toISOString(),
      published: req.body.published !== false,
    };

      blogs[index] = next;
      await writeBlogs(blogs);
      return next;
    });

    if (!updated) return res.status(404).json({ error: "Blog not found." });
    res.json({ ok: true, blog: updated });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/blogs/:slug", requireAdmin, async (req, res, next) => {
  try {
    const removed = await blogLock(async () => {
      const blogs = await readBlogs();
      const nextBlogs = blogs.filter((blog) => blog.slug !== req.params.slug);
      if (nextBlogs.length === blogs.length) return false;
      await writeBlogs(nextBlogs);
      return true;
    });

    if (!removed) return res.status(404).json({ error: "Blog not found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
/* ------------------------------------------------------------------ *
 * Content collections
 *
 * Courses and training programmes are the same shape - a catalogue entry with
 * structured detail, an editable body, two images and SEO fields - so both are
 * served by one set of route handlers registered twice. Adding another
 * catalogue is a config object, not another 250 lines.
 * ------------------------------------------------------------------ */

/**
 * Builds a read/write pair over a JSON file, seeding from a committed seed on
 * first run. `seedFile` is optional: a collection with no seed starts empty.
 */
const createCollection = ({ file, seedFile, lock }) => {
  const write = async (items) => {
    await writeJsonAtomic(file, items);
  };

  const read = async () => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!seedFile) return [];
      try {
        const seed = JSON.parse(await readFile(seedFile, "utf8"));
        await write(seed);
        return seed;
      } catch (seedError) {
        if (seedError.code !== "ENOENT") throw seedError;
        return [];
      }
    }
  };

  return { read, write, lock };
};

coursesCollection = createCollection({
  file: coursesFile,
  seedFile: coursesSeedFile,
  lock: courseLock,
});

trainingCollection = createCollection({
  file: trainingFile,
  seedFile: trainingSeedFile,
  lock: trainingLock,
});

/**
 * Normalises a catalogue entry from a request body. `base` supplies fallbacks so
 * an edit that omits a field keeps the stored value rather than clearing it.
 */
const entryFromBody = (body, base = {}, { categories, defaultCategory }) => {
  const title = text(body.title, 180);
  const category = categories.includes(body.category)
    ? body.category
    : base.category || defaultCategory;
  const description = text(body.description, 400);

  return {
    title,
    category,
    categoryLabel: text(body.categoryLabel, 80) || base.categoryLabel || "",
    icon: text(body.icon, 60) || base.icon || "GraduationCap",

    description,
    overview: text(body.overview, 2000) || base.overview || "",
    duration: text(body.duration, 60) || base.duration || "3-6 Months",
    mode: text(body.mode, 80) || base.mode || "Online & Offline",
    internship: body.internship !== undefined ? Boolean(body.internship) : Boolean(base.internship),

    syllabus: body.syllabus !== undefined ? list(body.syllabus) : base.syllabus || [],
    tools: body.tools !== undefined ? list(body.tools) : base.tools || [],
    careers: body.careers !== undefined ? list(body.careers) : base.careers || [],
    whoShouldJoin: body.whoShouldJoin !== undefined ? list(body.whoShouldJoin) : base.whoShouldJoin || [],
    learningOutcomes:
      body.learningOutcomes !== undefined ? list(body.learningOutcomes) : base.learningOutcomes || [],
    prerequisites: body.prerequisites !== undefined ? list(body.prerequisites) : base.prerequisites || [],
    projects: body.projects !== undefined ? list(body.projects) : base.projects || [],
    certificate: text(body.certificate, 500) || base.certificate || "",
    faqs: body.faqs !== undefined ? faqList(body.faqs) : base.faqs || [],

    content: body.content !== undefined ? sanitizeHtml(body.content) : base.content || "",

    imageAlt: text(body.imageAlt, 160) || base.imageAlt || title,
    secondaryImageAlt: text(body.secondaryImageAlt, 160) || base.secondaryImageAlt || title,

    metaTitle: text(body.metaTitle, 180) || base.metaTitle || `${title} | ASB Training Hub`,
    metaDescription: text(body.metaDescription, 300) || base.metaDescription || description,
    keywords: text(body.keywords, 300) || base.keywords || "",

    published: body.published !== undefined ? body.published !== false : base.published !== false,
  };
};

/** Card fields only - a listing page has no use for syllabus or FAQ text. */
const toSummary = ({
  id, slug, title, category, categoryLabel, description,
  duration, mode, internship, icon, imageUrl, imageAlt,
}) => ({
  id, slug, title, category, categoryLabel, description,
  duration, mode, internship, icon, imageUrl, imageAlt,
});

/**
 * Registers the public and admin routes for one catalogue.
 *
 * @param apiPath   URL segment, e.g. "courses" -> /api/courses
 * @param collection  created by createCollection()
 * @param categories  allowed category ids
 */
const registerCollectionRoutes = ({
  apiPath,
  collection,
  categories,
  defaultCategory,
  // Named explicitly rather than derived, so an established URL is not silently
  // renamed by a refactor.
  categoriesPath = `${apiPath}-categories`,
}) => {
  const { read, write, lock } = collection;
  const inCategory = (query) => {
    const category = text(query.category, 40);
    return categories.includes(category) ? category : "";
  };

  /* ---- public ---- */

  app.get(`/api/${apiPath}`, async (req, res, next) => {
    try {
      let items = (await read()).filter((c) => c.published !== false);

      const category = inCategory(req.query);
      if (category) items = items.filter((c) => c.category === category);

      if (req.query.summary === "1") return res.json(items.map(toSummary));
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  app.get(`/api/${apiPath}/:slug`, async (req, res, next) => {
    try {
      const items = await read();
      const item = items.find((c) => c.slug === req.params.slug && c.published !== false);
      if (!item) {
        const moved = items.find(
          (c) => c.published !== false && c.aliases?.includes(req.params.slug),
        );
        if (moved) return res.redirect(301, `/api/${apiPath}/${moved.slug}`);
      }
      if (!item) return res.status(404).json({ error: "Not found." });
      res.json(item);
    } catch (error) {
      next(error);
    }
  });

  app.get(`/api/${categoriesPath}`, async (_req, res, next) => {
    try {
      const items = (await read()).filter((c) => c.published !== false);
      res.json(
        categories.map((id) => {
          const inIt = items.filter((c) => c.category === id);
          return { id, label: inIt[0]?.categoryLabel || id, count: inIt.length };
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  /* ---- admin ---- */

  app.get(`/api/admin/${apiPath}`, requireAdmin, async (req, res, next) => {
    try {
      let items = await read();

      const search = text(req.query.search, 120).toLowerCase();
      if (search) {
        items = items.filter((c) =>
          [c.title, c.slug, c.categoryLabel].some((f) =>
            String(f || "").toLowerCase().includes(search),
          ),
        );
      }

      const category = inCategory(req.query);
      if (category) items = items.filter((c) => c.category === category);

      res.json(paginate(items, req.query));
    } catch (error) {
      next(error);
    }
  });

  app.get(`/api/admin/${apiPath}/:slug`, requireAdmin, async (req, res, next) => {
    try {
      const item = (await read()).find((c) => c.slug === req.params.slug);
      if (!item) return res.status(404).json({ error: "Not found." });
      res.json(item);
    } catch (error) {
      next(error);
    }
  });

  app.post(`/api/admin/${apiPath}`, requireAdmin, async (req, res, next) => {
    try {
      const title = text(req.body.title, 180);
      const description = text(req.body.description, 400);
      if (!title || !description) {
        return res.status(400).json({ error: "Title and description are required." });
      }

      const created = await lock(async () => {
        const items = await read();

        const baseSlug = slugify(req.body.slug || title);
        let slug = baseSlug;
        let suffix = 2;
        while (items.some((c) => c.slug === slug)) {
          slug = `${baseSlug}-${suffix}`;
          suffix += 1;
        }

        const now = new Date().toISOString();
        const item = {
          id: text(req.body.id, 80) || slug,
          slug,
          ...entryFromBody(req.body, {}, { categories, defaultCategory }),
          imageUrl: await saveImage(req.body.imageData, slug),
          secondaryImageUrl: await saveImage(req.body.secondaryImageData, `${slug}-secondary`),
          createdAt: now,
          updatedAt: now,
        };

        items.unshift(item);
        await write(items);
        return item;
      });

      res.status(201).json({ ok: true, item: created, course: created, training: created });
    } catch (error) {
      if (/image/i.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.put(`/api/admin/${apiPath}/:slug`, requireAdmin, async (req, res, next) => {
    try {
      const title = text(req.body.title, 180);
      const description = text(req.body.description, 400);
      if (!title || !description) {
        return res.status(400).json({ error: "Title and description are required." });
      }

      const updated = await lock(async () => {
        const items = await read();
        const index = items.findIndex((c) => c.slug === req.params.slug);
        if (index === -1) return null;

        const current = items[index];

        const requestedSlug = slugify(req.body.slug || current.slug || title);
        let slug = requestedSlug;
        let suffix = 2;
        while (items.some((c, i) => i !== index && c.slug === slug)) {
          slug = `${requestedSlug}-${suffix}`;
          suffix += 1;
        }

        const next = {
          ...current,
          slug,
          aliases:
            slug !== current.slug
              ? [...new Set([...(current.aliases || []), current.slug])]
              : current.aliases || [],
          ...entryFromBody(req.body, current, { categories, defaultCategory }),
          imageUrl: req.body.removeImage
            ? ""
            : (await saveImage(req.body.imageData, slug)) || current.imageUrl || "",
          secondaryImageUrl: req.body.removeSecondaryImage
            ? ""
            : (await saveImage(req.body.secondaryImageData, `${slug}-secondary`)) ||
              current.secondaryImageUrl ||
              "",
          updatedAt: new Date().toISOString(),
        };

        items[index] = next;
        await write(items);
        return next;
      });

      if (!updated) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true, item: updated, course: updated, training: updated });
    } catch (error) {
      if (/image/i.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.delete(`/api/admin/${apiPath}/:slug`, requireAdmin, async (req, res, next) => {
    try {
      const removed = await lock(async () => {
        const items = await read();
        const next = items.filter((c) => c.slug !== req.params.slug);
        if (next.length === items.length) return false;
        await write(next);
        return true;
      });

      if (!removed) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
};

registerCollectionRoutes({
  apiPath: "courses",
  collection: coursesCollection,
  categories: COURSE_CATEGORIES,
  defaultCategory: "erp",
  categoriesPath: "course-categories",
});

registerCollectionRoutes({
  apiPath: "training",
  collection: trainingCollection,
  categories: TRAINING_CATEGORIES,
  defaultCategory: "corporate",
});


app.post("/api/inquiries", submissionLimiter, async (req, res, next) => {
  try {
    const fields = {
      name: text(req.body.name, 120),
      email: email(req.body.email),
      phone: phone(req.body.phone),
      course: text(req.body.course, 120),
      message: text(req.body.message, 1000),
    };

    if (!fields.name) {
      return res.status(400).json({ error: "Name is required." });
    }

    if (!fields.phone) {
      return res.status(400).json({ error: "Please enter a valid phone number." });
    }

    if (req.body.email && !fields.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    const screening = await screenSubmission(req, fields);
    if (!screening.ok) return silentlyRejectSubmission(req, res, screening.reason);

    const inquiry = { ...submissionMeta(req, screening.verification), ...fields };
    const stored = await storeIfNew("inquiry", inquiry);
    if (stored.duplicate) return res.status(201).json({ ok: true, id: stored.id, duplicate: true });
    res.status(201).json({
      ok: true,
      id: inquiry.id,
      notification: inboxNotification("Course Inquiry", inquiry),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/applications", submissionLimiter, async (req, res, next) => {
  try {
    const fields = {
      name: text(req.body.name, 120),
      email: email(req.body.email),
      phone: phone(req.body.phone),
      course: text(req.body.course, 120),
      qualification: text(req.body.qualification, 160),
      experience: text(req.body.experience, 160),
      preferredMode: text(req.body.preferredMode, 80),
      callbackTime: text(req.body.callbackTime, 120),
      message: text(req.body.message, 1000),
    };

    if (!fields.name || !fields.email || !fields.phone || !fields.course) {
      return res.status(400).json({ error: "Name, email, phone, and course are required." });
    }

    const screening = await screenSubmission(req, fields);
    if (!screening.ok) return silentlyRejectSubmission(req, res, screening.reason);

    const application = { ...submissionMeta(req, screening.verification), ...fields };
    const stored = await storeIfNew("application", application);
    if (stored.duplicate) return res.status(201).json({ ok: true, id: stored.id, duplicate: true });
    res.status(201).json({
      ok: true,
      id: application.id,
      notification: inboxNotification("Course Application", application),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/newsletters", submissionLimiter, async (req, res, next) => {
  try {
    const fields = { email: email(req.body.email) };

    if (!fields.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    const screening = await screenSubmission(req, fields);
    if (!screening.ok) return silentlyRejectSubmission(req, res, screening.reason);

    const subscription = { ...submissionMeta(req, screening.verification), ...fields };
    const stored = await storeIfNew("newsletter", subscription);
    if (stored.duplicate) return res.status(201).json({ ok: true, id: stored.id, duplicate: true });
    res.status(201).json({
      ok: true,
      id: subscription.id,
      notification: inboxNotification("Newsletter Subscription", subscription),
    });
  } catch (error) {
    next(error);
  }
});

app.get(/^\/admin\/(blog|courses|training)$/, async (req, res, next) => {
  try {
    const section = req.params[0];
    const html = await renderSeoHtml({
      title: `${section[0].toUpperCase()}${section.slice(1)} Admin | ASB Training Hub`,
      description: "Private ASB Training Hub administration page.",
      keywords: "",
      canonicalPath: req.path,
      noindex: true,
      visibleHtml: pageShell({
        heading: "Administration",
        intro: "Sign in to manage ASB Training Hub content.",
      }),
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.send(html);
  } catch (error) {
    next(error);
  }
});

// Return real status codes for unknown API and browser routes. A 200 SPA shell
// makes removed URLs look indexable and hides broken links from monitoring.
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found." });
  }
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  try {
    const html = await renderSeoHtml({
      title: "Page Not Found | ASB Training Hub",
      description: "The requested ASB Training Hub page could not be found.",
      keywords: "",
      canonicalPath: req.path,
      noindex: true,
      visibleHtml: pageShell({
        heading: "Page not found",
        intro: "The page may have moved or no longer exists.",
        links: [{ href: "/", label: "Return to ASB Training Hub" }],
      }),
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(404).send(html);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

export { app, resetRateLimits };

// Only bind a port when this file is the process entrypoint, so tests can
// import the app and drive it on an ephemeral port.
const isEntrypoint =
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ||
  process.env.pm_id !== undefined;

if (isEntrypoint) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`ASB backend running at http://localhost:${PORT}`);
  });
}
