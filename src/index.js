import express from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const submissionsFile = path.join(dataDir, "submissions.json");
const blogsFile = path.join(dataDir, "blogs.json");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "asb-admin-token";

app.use(express.json({ limit: "15mb" }));
app.use("/uploads", express.static(uploadDir));

const emptyStore = {
  inquiries: [],
  applications: [],
  newsletters: [],
};

const readStore = async () => {
  try {
    const raw = await readFile(submissionsFile, "utf8");
    return { ...emptyStore, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore;
    throw error;
  }
};

const writeStore = async (store) => {
  await mkdir(dataDir, { recursive: true });
  await writeFile(submissionsFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
};

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
    imageUrl: "/blog/why-sap-career-2024.png",
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
    imageUrl: "/blog/python-vs-java.png",
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
    imageUrl: "/blog/ai-jobs-kerala.png",
    imageAlt: "AI career opportunities",
    content: "<p>Kerala's technology ecosystem is seeing strong interest in AI, machine learning, automation, and data analytics. Students who can build real projects, explain model choices, and deploy applications have a clear advantage.</p>",
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
    imageUrl: "/blog/internship-tips.png",
    imageAlt: "Internship preparation",
    content: "<p>A good internship is about consistency. Ask questions, document your work, request feedback, and build a small portfolio of what you contributed.</p>",
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
    imageUrl: "/blog/erp-implementation.png",
    imageAlt: "ERP implementation guide",
    content: "<p>ERP implementation connects business requirements with system configuration. A consultant must understand process mapping, master data, testing, user training, and go-live support.</p>",
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
    imageUrl: "/blog/generative-ai-future.png",
    imageAlt: "Generative AI future",
    content: "<p>Generative AI is changing how teams create content, automate support, analyze documents, and build software. The best learners combine prompt skills with real application development.</p>",
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

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const slugify = (value) =>
  text(value, 120)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || createId();

const sanitizeHtml = (value) =>
  text(value, 20000)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");

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

const requireAdmin = (req, res, next) => {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Admin authentication required." });
  }
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "asb-backend" });
});

app.post("/api/admin/login", (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASSWORD) {
    return res.json({ ok: true, token: ADMIN_TOKEN });
  }
  res.status(401).json({ error: "Invalid username or password." });
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
    const store = await readStore();
    const list = getSubmissionList(store, req.params.type);
    if (!list) return res.status(400).json({ error: "Invalid submission type." });

    const index = list.findIndex((item) => item.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Submission not found." });

    const current = list[index];
    const updated = {
      ...current,
      status: text(req.body.status, 40) || current.status || "new",
      note: text(req.body.note, 1000),
      updatedAt: new Date().toISOString(),
    };

    list[index] = updated;
    await writeStore(store);
    res.json({ ok: true, submission: { ...updated, type: req.params.type } });
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
    const blog = {
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

    blogs.unshift(blog);
    await writeBlogs(blogs);
    res.status(201).json({ ok: true, blog });
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/blogs/:slug", requireAdmin, async (req, res, next) => {
  try {
    const blogs = await readBlogs();
    const index = blogs.findIndex((blog) => blog.slug === req.params.slug);
    if (index === -1) return res.status(404).json({ error: "Blog not found." });

    const title = text(req.body.title, 180);
    const content = sanitizeHtml(req.body.content);
    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required." });
    }

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

    const updated = {
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

    blogs[index] = updated;
    await writeBlogs(blogs);
    res.json({ ok: true, blog: updated });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/blogs/:slug", requireAdmin, async (req, res, next) => {
  try {
    const blogs = await readBlogs();
    const nextBlogs = blogs.filter((blog) => blog.slug !== req.params.slug);
    if (nextBlogs.length === blogs.length) {
      return res.status(404).json({ error: "Blog not found." });
    }

    await writeBlogs(nextBlogs);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inquiries", async (req, res, next) => {
  try {
    const inquiry = {
      ...submissionMeta(req),
      name: text(req.body.name, 120),
      email: email(req.body.email),
      phone: text(req.body.phone, 30),
      course: text(req.body.course, 120),
      message: text(req.body.message, 1000),
    };

    if (!inquiry.name || !inquiry.phone) {
      return res.status(400).json({ error: "Name and phone are required." });
    }

    if (req.body.email && !inquiry.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    const store = await readStore();
    store.inquiries.unshift(inquiry);
    await writeStore(store);

    res.status(201).json({ ok: true, id: inquiry.id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/applications", async (req, res, next) => {
  try {
    const application = {
      ...submissionMeta(req),
      name: text(req.body.name, 120),
      email: email(req.body.email),
      phone: text(req.body.phone, 30),
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

    const store = await readStore();
    store.applications.unshift(application);
    await writeStore(store);

    res.status(201).json({ ok: true, id: application.id });
  } catch (error) {
    next(error);
  }
});

app.post("/api/newsletters", async (req, res, next) => {
  try {
    const subscription = {
      ...submissionMeta(req),
      email: email(req.body.email),
    };

    if (!subscription.email) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }

    const store = await readStore();
    store.newsletters.unshift(subscription);
    await writeStore(store);

    res.status(201).json({ ok: true, id: subscription.id });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`ASB backend running at http://localhost:${PORT}`);
});
