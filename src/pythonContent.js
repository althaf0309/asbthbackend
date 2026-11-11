/**
 * Long-form copy for the Python keyword pages under /course-training/python-full-stack.
 *
 * The same file lives in backend/src/pythonContent.js (server render for
 * crawlers) and asb-ascend/src/data/pythonContent.js (React page). Keep the two
 * byte-identical so the HTML Google indexes matches what visitors see.
 *
 * Facts come from the Python Full Stack course record: 3-6 months, online and
 * offline, internship included, Django/Flask/REST/PostgreSQL/React/Docker.
 * Nothing here states a fee, a salary or a guaranteed placement.
 */

export const PYTHON_SEGMENT = "python-full-stack";
export const PYTHON_PRIMARY_SLUG = "python-full-stack-development-course-in-kerala";
export const PYTHON_LABEL = "Python Full Stack Development";
export const PYTHON_HERO = "/images/python-full-stack-course-hero.webp";

// Places within reach of the Kazhakootam campus; mirrors CAMPUS_AREA in answers.js.
const CAMPUS_TOWNS = [
  "trivandrum", "thiruvananthapuram", "kazhakootam", "kazhakkoottam", "kazhakkottam", "kazhakoottam", "technopark",
  "sreekaryam", "ulloor", "pattom", "kesavadasapuram", "kowdiar", "vellayambalam", "palayam", "thampanoor",
  "east fort", "karamana", "poojappura", "nemom", "balaramapuram", "neyyattinkara", "vizhinjam", "kovalam",
  "varkala", "attingal", "venjaramoodu", "nedumangad", "kattakada", "kilimanoor", "parassala", "peroorkada",
  "vattiyoorkavu", "pothencode", "kaniyapuram",
];

export const pythonPagePath = (page) =>
  page.slug === PYTHON_PRIMARY_SLUG ? `/course-training/${PYTHON_SEGMENT}` : `/course-training/${PYTHON_SEGMENT}/${page.slug}`;

export const pythonPageHeroImage = (page) => `/generated/python/${page.slug}.svg`;

export const isNearCampus = (place) => CAMPUS_TOWNS.includes(String(place || "").toLowerCase());
const isLocal = (place) => Boolean(place) && place.toLowerCase() !== "kerala";

const hash = (value) => [...String(value)].reduce((total, ch) => ((total * 31) + ch.charCodeAt(0)) >>> 0, 7);
const pick = (items, seed) => items[seed % items.length];

/** Topic the keyword leans on, so each page stresses a different part of the syllabus. */
export const pythonTopic = (title) => {
  const t = title.toLowerCase();
  if (/django|rest api/.test(t)) return "django";
  if (/full stack|web development/.test(t)) return "fullstack";
  if (/\bai\b|machine learning/.test(t)) return "ai";
  if (/beginner|foundation|without coding|after 12th|plus two|commerce|students/.test(t)) return "beginner";
  if (/developer|software|job|career|placement|freshers|seekers|switchers/.test(t)) return "career";
  if (/project|practical|hands-on|internship|live/.test(t)) return "projects";
  return "core";
};

export const pythonSkills = (page) => ({
  django: ["Django models, migrations and the ORM", "Views, templates, forms and the admin", "REST APIs with authentication and permissions", "PostgreSQL schema design and queries"],
  fullstack: ["Python core, OOP and clean modules", "Django and Flask backends with REST APIs", "React components and hooks talking to an API", "Docker builds and cloud deployment"],
  ai: ["Python data structures and libraries", "Clean, tested Python modules", "APIs that serve data and model results", "Deploying Python services with Docker"],
  beginner: ["Variables, data types, loops and functions", "Lists, dictionaries and file handling", "Object-oriented Python with small programs", "First Django web app with a database"],
  career: ["Production-style Django and Flask code", "REST API design and documentation", "Git workflow, code review and testing", "Portfolio projects you can demo in interviews"],
  projects: ["Planning a project from requirements", "Building features across backend and frontend", "Testing, debugging and fixing real issues", "Deploying and presenting the finished app"],
  core: ["Python core and object-oriented programming", "Django MVT, ORM and Flask microservices", "PostgreSQL, REST APIs and React", "Authentication, security and Docker deployment"],
}[pythonTopic(page.title)]);

export const pythonDescription = (page) => {
  const place = isLocal(page.location) ? ` for learners in ${page.location}` : "";
  return `${page.title}: Python full stack training with Django, Flask, REST APIs, PostgreSQL and React, guided projects and an internship${place} from ASB Training Hub.`;
};

const attendText = (place) => {
  if (!isLocal(place)) return "Classes run at the ASB Training Hub campus near Technopark in Kazhakootam, Trivandrum, with live-online batches for learners anywhere in Kerala.";
  if (isNearCampus(place)) return `Learners in ${place} can attend the classroom near Technopark in Kazhakootam, Trivandrum, or join a live-online batch when travel does not fit their week.`;
  return `ASB Training Hub's campus is near Technopark in Kazhakootam, Trivandrum, so learners in ${place} join through live-online batches with the same trainers, projects and code reviews. There is no separate branch in ${place}.`;
};

const intentFocus = {
  fees: "Because this search is about fees, note that ASB Training Hub gives the current fee on request rather than publishing a figure that can go out of date. Ask what the fee covers: teaching hours, the internship, project reviews, the certificate and any exam or software costs, and get the payment terms in writing before you pay.",
  admission: "For admission, the course lists basic computer skills and logical thinking as the starting requirements, and no prior coding is needed. Share your education and goals with admissions so they can confirm the batch and starting level.",
  placement: "Placement support means resume guidance, interview practice and referrals to suitable openings. It is not a guarantee of a job; selection depends on the employer, your projects and how well you explain your work.",
  internship: "The Python Full Stack course includes an internship. Ask how it is arranged for your batch, what you will build, who reviews your code and how long it runs.",
  career: "Career-focused learners should map each module to a target role, such as Python full stack developer, backend engineer or API engineer, and collect project evidence they can explain in an interview.",
  "after-school": "If you have finished Plus Two or Class 12, the listed requirements are basic computer skills and logical thinking, with no prior coding required. Call admissions before applying so they can confirm whether you can join and which batch suits you.",
  graduate: "Graduates from any stream can use the course to add practical development skills to their degree. Earlier exposure to programming helps, but the course starts from Python basics.",
  online: "Live-online batches use the same syllabus, trainers and project reviews as the classroom. Online learning works when you attend live, code along, ask questions and submit work for review every week.",
  certification: "The course awards an industry-recognized programming certificate with a hands-on project portfolio. The certificate carries the most weight when you can show and explain the projects behind it.",
  institute: "When comparing Python institutes, look at trainer access, practical hours per week, how projects are reviewed, whether you deploy real apps and what support continues after the classes end.",
  comparison: "A best course is the one that fits your starting level and goal. Compare syllabus depth, practical hours, project reviews and honest career support rather than a promotional ranking.",
  duration: "The course runs for 3 to 6 months. The exact length depends on the batch, weekly hours and how much project work you complete.",
  "near-me": "A nearby classroom reduces travel, but teaching quality, practice time and schedule fit matter just as much as distance.",
  question: "This page answers the question directly, then gives the context you need to decide on Python training with confidence.",
  course: "The course moves from Python foundations to Django, Flask, REST APIs, PostgreSQL, React and deployment, finishing with a capstone project you ship end to end.",
};

const topicLead = {
  django: "This page focuses on Django: models, the ORM, views, templates, forms, the admin, authentication and REST APIs backed by PostgreSQL.",
  fullstack: "This page focuses on the full stack: a Python backend in Django or Flask, a PostgreSQL database, a React frontend and Docker-based deployment working as one application.",
  ai: "This page focuses on Python as a foundation for AI and data work. The Python Full Stack course teaches the language, APIs and deployment that AI projects depend on; dedicated AI and machine learning courses build on it.",
  beginner: "This page focuses on beginners. The course starts with variables, data types, loops and functions, and no prior coding is required.",
  career: "This page focuses on getting job-ready: writing code the way teams do, building portfolio projects and preparing for developer interviews.",
  projects: "This page focuses on practical work: guided exercises, project milestones, code reviews and an internship alongside the classes.",
  core: "This page covers the full Python learning path, from core syntax to deployed web applications.",
};

const audiences = [
  "a student who wants a first programming skill that leads to real projects",
  "a fresher who needs a portfolio before applying for developer roles",
  "a career changer moving into software from a non-technical job",
  "a graduate from a non-computer stream who wants a practical tech skill",
  "a frontend developer who wants to own the backend and database as well",
  "a working coder who wants structured Django, API and deployment practice",
];

const anchorProjects = [
  "a SaaS dashboard with user accounts, roles and billing screens",
  "a realtime chat app that uses WebSockets",
  "an e-commerce store with a cart, orders and a payment gateway",
  "a portfolio website with a CMS backend",
];

const practiceHabits = [
  "Commit code to Git after every working step so you can explain how the project grew.",
  "Write a short test before fixing a bug, so the same bug cannot quietly return.",
  "Read the error message and the traceback line by line before changing any code.",
  "Keep a learning log of concepts, commands and mistakes, and review it each week.",
  "Explain your code aloud to a classmate; gaps in understanding show up quickly.",
  "Rebuild a small feature from memory a few days after the class that taught it.",
];

const sectionList = [
  ["Python foundations", (p, s) => `Every learner starts with the core language: variables, data types, strings, lists, tuples, dictionaries and sets, then conditions, loops and functions. The course moves on to modules, packages, virtual environments, file handling and exceptions, and then object-oriented Python with classes, inheritance and composition. Small programs follow each topic, such as a marks calculator, a contact book or a file-based inventory. ${s.topic === "beginner" ? "Because this page is for beginners, the first weeks go slowly and repeat key ideas with many short exercises." : "Learners who already know some Python can move faster through this stage and spend more time on design and testing."} Writing readable, well-named code is treated as a skill from the first day.`],
  ["Django: models, views and the ORM", (p, s) => `Django is the main backend framework in the course. Learners use its model-view-template (MVT) pattern to build database-backed web apps: models and migrations, the ORM for queries, views and URL routing, templates, forms with validation, and the built-in admin. Authentication covers sign-up, login, password reset, permissions and user roles. ${s.topic === "django" ? "Since this page targets Django, its projects add class-based views, query optimisation, custom admin actions and Django REST APIs." : "Django is taught alongside the rest of the stack, so learners see where it fits in a complete application."}`],
  ["Flask microservices and REST API design", () => "Flask shows how a lightweight Python service is built. Learners create JSON APIs, handle routes and HTTP methods, validate input, return correct status codes and structure larger apps with blueprints. REST API design covers resources, versioning, pagination, filtering, error responses and documentation, plus token-based authentication. APIs are tested with automated requests, so learners understand what a frontend or mobile app actually receives."],
  ["PostgreSQL and database design", () => "Real applications live on their data. The course teaches relational design with PostgreSQL: tables, keys, relationships, normalisation and constraints. Learners write SQL queries with joins, grouping and filters, then compare them with the same queries in the Django ORM. Indexes, migrations, transactions and backups are covered so learners can keep data correct and fast as an app grows."],
  ["React on the frontend", (p, s) => `A full stack developer also builds the screens people use. Learners create React components, manage state with hooks, handle forms and routing, and call the Python APIs they built. ${s.topic === "fullstack" ? "On this full stack track, the React work connects to Django and Flask APIs in the same project, so learners handle login tokens, loading states and errors from end to end." : "The aim is to understand how the frontend and backend exchange data, so learners can work across the whole application."}`],
  ["Authentication and security", () => "Security is taught as part of everyday coding. Learners store passwords safely with hashing, compare sessions with token-based login, protect forms against cross-site request forgery, prevent SQL injection and cross-site scripting, and check permissions on every API. Secrets such as keys and database passwords stay in environment variables, never in the code."],
  ["Git, Docker and cloud deployment", () => "An app is not finished until other people can use it. Learners work with Git branches and pull requests, write a Dockerfile, run the app and database together with containers, and deploy to a cloud host such as AWS or Render. They configure environment settings, static files, logs and a production database, then fix the problems that only show up after deployment."],
  ["Projects, internship and portfolio", (p, s) => `The course includes an internship and ends with a capstone project shipped end to end. The anchor project suggested for this page is ${s.project}. Other course projects include a SaaS dashboard with authentication and billing, a realtime chat app with WebSockets, an e-commerce store with a payment gateway and a portfolio website with a CMS backend. Each project is reviewed by a trainer, and learners write a short README that explains the problem, the stack, the decisions made and the known limits.`],
  ["Who can join", (p, s) => `The listed requirements are basic computer skills and logical thinking, and no prior coding is required. The course suits IT students and freshers, career changers entering tech, frontend developers going full stack and working coders levelling up. This page has ${s.audience} in mind. Commerce, arts and science students can learn Python as well; steady weekly practice matters more than a background in computer science. Share your education and goals with admissions to confirm the right starting batch.`],
  ["Career roles after the course", () => "The course prepares learners for roles such as Python full stack developer, backend engineer, API engineer and DevOps-aware developer. Job titles, requirements and pay vary by employer and experience, so learners study real job descriptions and build projects that match them. Career support includes resume reviews, mock interviews on Python, Django, SQL and APIs, and referrals to suitable openings. Placement is not guaranteed; selection depends on the employer and the candidate."],
  ["Classroom and live-online batches", (p) => `${attendText(p.location)} Both modes follow the same syllabus, with live explanations, coding along, exercises and trainer feedback. Batch timings change between admission cycles, so ask whether a weekday or weekend batch is running and confirm the schedule before enrolling.`],
  ["Fees, duration and how to compare courses", () => "The Python Full Stack course runs for 3 to 6 months. ASB Training Hub gives the current fee on request at +91 87147 73304, so you get the up-to-date amount, what it includes and the payment terms in writing. When comparing Python courses, check the detailed syllabus, practical hours per week, how projects are reviewed, whether you deploy real apps, how missed classes are handled and what you must complete to receive the certificate."],
  ["A weekly routine that works", (p, s) => `Progress in Python comes from frequent, focused practice. A good week mixes concept review, coding along in class, independent exercises and one project milestone. ${s.habit} When a program fails, isolate the input, check the data and change one thing at a time. This routine builds confidence and gives you real examples to talk about in interviews.`],
];

/** The lead section and the long-form sections for one Python keyword page. */
export const pythonPageSections = (page) => {
  const seed = hash(`python:${page.slug}`);
  const state = {
    topic: pythonTopic(page.title),
    audience: pick(audiences, seed),
    project: pick(anchorProjects, Math.floor(seed / 7)),
    habit: pick(practiceHabits, Math.floor(seed / 13)),
  };
  const where = isLocal(page.location) ? ` in ${page.location}` : "";
  const lead = {
    heading: `How ASB Training Hub teaches ${page.title}`,
    text: `${topicLead[state.topic]} ${intentFocus[page.intent] || intentFocus.course} ${attendText(page.location)} Learners finish with ${state.project} and other deployed projects they can show to employers.`,
  };
  const sections = sectionList.map(([heading, write], index) => ({
    heading: index === 0 && where ? `${heading} for learners${where}` : heading,
    text: write(page, state).replace(/\s+/g, " ").trim(),
  }));
  return [lead, ...sections];
};
