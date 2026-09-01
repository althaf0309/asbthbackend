import express from "express";
import helmet from "helmet";
import rateLimit, { MemoryStore } from "express-rate-limit";
import cookieParser from "cookie-parser";
import sanitizeHtmlLib from "sanitize-html";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const submissionsFile = path.join(dataDir, "submissions.json");
const blogsFile = path.join(dataDir, "blogs.json");

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Credentials come from the environment only. There is deliberately no fallback:
// a shipped default is a published default.
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  throw new Error(
    "ADMIN_USER and ADMIN_PASSWORD must be set. Refusing to start with default credentials.",
  );
}
if (ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
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
        scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com"],
        // Fonts are self-hosted now, so no third-party font origins are needed.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://www.google-analytics.com", "https://api.web3forms.com"],
        frameSrc: ["https://www.googletagmanager.com"],
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
  const isBlogWrite =
    req.path.startsWith("/api/admin/blogs") && (req.method === "POST" || req.method === "PUT");
  return isBlogWrite ? uploadJson(req, res, next) : smallJson(req, res, next);
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
  await mkdir(dataDir, { recursive: true });
  await writeFile(submissionsFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
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
    title: "Why a SAP Career Is Still One of the Best Choices in 2024",
    excerpt: "SAP continues to dominate enterprise software with S/4HANA migrations driving massive demand for skilled consultants across India.",
    category: "Career",
    author: "ASB Team",
    readTime: "5 min",
    metaTitle: "Why a SAP Career Is Still One of the Best Choices in 2024 | ASB Training Hub",
    metaDescription: "Explore why SAP and ERP careers remain strong choices for students and working professionals in 2024.",
    keywords: "SAP career, ERP training, SAP courses, ASB Training Hub",
    imageUrl: "/blog/why-sap-career-2024.webp",
    imageAlt: "SAP career training",
    content: "<p>SAP remains one of the strongest career paths for students and working professionals who want enterprise technology roles. Businesses still need skilled consultants for finance, procurement, sales, production, HR, and analytics workflows.</p><p>At ASB Training Hub, our SAP-oriented ERP courses focus on practical configuration, business process understanding, and interview preparation.</p>",
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
    excerpt: "Learn the fundamentals of ERP implementation, key phases, and why SAP is the preferred choice for enterprises.",
    category: "ERP",
    author: "ASB Team",
    readTime: "8 min",
    metaTitle: "Understanding ERP Implementation: A Beginner's Guide | ASB Training Hub",
    metaDescription: "A beginner-friendly guide to ERP implementation phases, roles, and consultant skills.",
    keywords: "ERP implementation, ERP training, SAP implementation",
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
  await mkdir(dataDir, { recursive: true });
  await writeFile(blogsFile, `${JSON.stringify(blogs, null, 2)}\n`, "utf8");
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

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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

const submissionMeta = (req) => ({
  id: createId(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "new",
  note: "",
  ip: req.ip,
  userAgent: req.get("user-agent") || "",
});

/* ------------------------------------------------------------------ *
 * Inbox notification
 *
 * The browser used to POST straight to Web3Forms with the access key in the
 * bundle, so anyone could flood the inbox and bypass every check above. The
 * call now happens here, keyed from the environment and gated by the same rate
 * limiter as the endpoint itself.
 * ------------------------------------------------------------------ */

const WEB3FORMS_KEY = process.env.WEB3FORMS_ACCESS_KEY || "";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

const forwardToInbox = async (formType, submission) => {
  if (!WEB3FORMS_KEY) return;

  const { id, ip, userAgent, status, note, createdAt, updatedAt, ...fields } = submission;

  try {
    const response = await fetch(WEB3FORMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        from_name: "ASB Training Hub Website",
        subject: `New ${formType} - ASB Training Hub`,
        form_type: formType,
        reference_id: id,
        ...fields,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.warn(`Inbox notification failed for ${id}: HTTP ${response.status}`);
    }
  } catch (error) {
    // The submission is already stored; a notification failure must not turn
    // into a failed form for the visitor.
    console.warn(`Inbox notification failed for ${id}:`, error.message);
  }
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

const SITE_URL = "https://www.asbtraininghub.com";

const staticSitemapRoutes = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/about", priority: "0.8", changefreq: "monthly" },
  { loc: "/courses", priority: "0.95", changefreq: "weekly" },
  { loc: "/reviews", priority: "0.7", changefreq: "monthly" },
  { loc: "/faq", priority: "0.8", changefreq: "monthly" },
  { loc: "/blog", priority: "0.8", changefreq: "weekly" },
  { loc: "/contact", priority: "0.85", changefreq: "monthly" },
  { loc: "/apply", priority: "0.9", changefreq: "monthly" },
  { loc: "/terms-and-conditions", priority: "0.5", changefreq: "yearly" },
  ...["erp", "programming", "ai", "management", "internship"].map((c) => ({
    loc: `/courses/${c}`, priority: "0.9", changefreq: "weekly",
  })),
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
  return `${cleaned.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
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
  html = upsertHeadTag(html, /<meta\s+name=["']robots["'][^>]*>/i, `<meta name="robots" content="index, follow">`);
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
      `    <script type="application/ld+json">${JSON.stringify(block).replace(/</g, "\\u003c")}</script>\n  </head>`
    );
  }

  return html;
};

const readCourseSitemapRoutes = async () => {
  const candidatePaths = [
    path.resolve(rootDir, "../asb-ascend/src/data/courses.ts"),
    path.resolve(rootDir, "../frontend/src/data/courses.ts"),
    path.resolve(rootDir, "../../frontend/src/data/courses.ts"),
  ];

  for (const filePath of candidatePaths) {
    try {
      const source = await readFile(filePath, "utf8");
      const slugs = [...source.matchAll(/slug:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
      return [...new Set(slugs)].map((slug) => ({
        loc: `/course/${slug}`,
        priority: "0.85",
        changefreq: "monthly",
      }));
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Unable to read course routes from ${filePath}:`, error.message);
    }
  }

  return [];
};

app.get("/sitemap.xml", async (_req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const blogs = await readBlogs();
    const courseRoutes = await readCourseSitemapRoutes();
    const blogRoutes = blogs
      .filter((b) => b.published !== false && b.slug)
      .map((b) => ({
        loc: `/blog/${b.slug}`,
        priority: "0.65",
        changefreq: "monthly",
        lastmod: b.updatedAt ? b.updatedAt.slice(0, 10) : today,
      }));

    const allRoutes = [...staticSitemapRoutes, ...courseRoutes, ...blogRoutes];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allRoutes
  .map(
    ({ loc, priority, changefreq, lastmod = today }) =>
      `  <url>\n    <loc>${escapeXml(`${SITE_URL}${loc}`)}</loc>\n    <lastmod>${escapeXml(lastmod)}</lastmod>\n    <changefreq>${escapeXml(changefreq)}</changefreq>\n    <priority>${escapeXml(priority)}</priority>\n  </url>`
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "asb-backend" });
});

app.get("/blog", async (_req, res, next) => {
  try {
    const blogs = (await readBlogs()).filter((blog) => blog.published !== false);
    const html = await renderSeoHtml({
      title: "Blog | ASB Training Hub",
      description: "Career insights, ERP, SAP, AI, programming, logistics, and internship resources from ASB Training Hub.",
      keywords: "ASB Training Hub blog, SAP training Kerala, ERP courses Kerala, AI training Kerala, logistics courses Kerala, career training blog",
      canonicalPath: "/blog",
      type: "website",
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
    if (!blog) return res.status(404).json({ error: "Blog not found." });
    res.json(blog);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/blogs", requireAdmin, async (_req, res, next) => {
  try {
    const blogs = await readBlogs();
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

app.post("/api/inquiries", submissionLimiter, async (req, res, next) => {
  try {
    const inquiry = {
      ...submissionMeta(req),
      name: text(req.body.name, 120),
      email: email(req.body.email),
      phone: phone(req.body.phone),
      course: text(req.body.course, 120),
      message: text(req.body.message, 1000),
    };

    if (!inquiry.name) {
      return res.status(400).json({ error: "Name is required." });
    }

    if (!inquiry.phone) {
      return res.status(400).json({ error: "Please enter a valid phone number." });
    }

    if (req.body.email && !inquiry.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    await updateStore((store) => store.inquiries.unshift(inquiry));
    await forwardToInbox("Course Inquiry", inquiry);

    res.status(201).json({ ok: true, id: inquiry.id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/applications", submissionLimiter, async (req, res, next) => {
  try {
    const application = {
      ...submissionMeta(req),
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

    if (!application.name || !application.email || !application.phone || !application.course) {
      return res.status(400).json({ error: "Name, email, phone, and course are required." });
    }

    await updateStore((store) => store.applications.unshift(application));
    await forwardToInbox("Course Application", application);

    res.status(201).json({ ok: true, id: application.id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/newsletters", submissionLimiter, async (req, res, next) => {
  try {
    const subscription = {
      ...submissionMeta(req),
      email: email(req.body.email),
    };

    if (!subscription.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    await updateStore((store) => store.newsletters.unshift(subscription));
    await forwardToInbox("Newsletter Subscription", subscription);

    res.status(201).json({ ok: true, id: subscription.id });
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
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  app.listen(PORT, () => {
    console.log(`ASB backend running at http://localhost:${PORT}`);
  });
}
