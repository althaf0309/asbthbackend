/**
 * Quick facts and quotable answers for course and keyword pages.
 *
 * Answer engines quote a passage, not a page, so each answer repeats the
 * institute, course, place and phone number instead of relying on the page
 * around it. Everything comes from the stored course record, so an edit in
 * admin updates every page, and nothing here may state a fact the record does
 * not hold: fees are given on request until they are recorded, and eligibility
 * is quoted from the prerequisites, not assumed from the search term.
 *
 * The server renders this for crawlers and /api/answers/* serves the same
 * blocks to the React pages, so the two can never drift apart.
 */
import { escapeHtml } from "./longContent.js";

const PHONE = "+91 87147 73304";
const INSTITUTE = "ASB Training Hub";
const CAMPUS = "near Technopark in Kazhakootam, Trivandrum";

// Places within reach of the campus; everywhere else is served live online,
// which is what the location pages already state.
const CAMPUS_AREA = new Set([
  "trivandrum", "thiruvananthapuram", "kazhakootam", "kazhakkottam", "kazhakoottam", "technopark", "sreekaryam",
  "ulloor", "pattom", "kesavadasapuram", "kowdiar", "vellayambalam", "palayam", "thampanoor", "east fort",
  "karamana", "poojappura", "nemom", "balaramapuram", "neyyattinkara", "vizhinjam", "kovalam", "varkala",
  "attingal", "venjaramoodu", "nedumangad", "kattakada", "kilimanoor", "parassala", "peroorkada",
  "vattiyoorkavu", "pothencode", "kaniyapuram",
]);

const listOf = (items = [], limit = 3) => {
  const picked = items.filter(Boolean).slice(0, limit);
  if (picked.length < 2) return picked.join("");
  return `${picked.slice(0, -1).join(", ")} and ${picked[picked.length - 1]}`;
};

const span = (course) => String(course.duration).toLowerCase();
const modeText = (course) => String(course.mode).toLowerCase().replace("&", "and");
const hasOnline = (course) => /online/i.test(course.mode || "");
// District pages combine names ("Kazhakootam & Technopark"), so check each part.
const isCampusArea = (place) =>
  String(place || "").toLowerCase().split(/\s*(?:&|,|\band\b)\s*/).some((part) => CAMPUS_AREA.has(part.trim()));
const isSpecificPlace = (place) => Boolean(place) && place.toLowerCase() !== "kerala";

/** How someone in this place actually attends, without implying a local branch. */
const attendance = (course, place) => {
  if (isSpecificPlace(place) && !isCampusArea(place)) {
    return hasOnline(course)
      ? `${INSTITUTE}'s campus is ${CAMPUS}, so learners in ${place} join through live-online batches`
      : `${INSTITUTE}'s classroom is ${CAMPUS}, so learners in ${place} travel to the campus`;
  }
  return hasOnline(course)
    ? `Classes run at ${INSTITUTE}'s campus ${CAMPUS}, with live-online batches for learners elsewhere in Kerala`
    : `Classes run at ${INSTITUTE}'s campus ${CAMPUS}`;
};

export const courseFacts = (course, place = "") => {
  const remote = isSpecificPlace(place) && !isCampusArea(place) && hasOnline(course);
  return [
    { label: "Duration", value: course.duration },
    { label: "Mode", value: remote ? `Live online from ${place}` : course.mode },
    { label: "Entry requirement", value: listOf(course.prerequisites, 2) },
    { label: "Internship", value: course.internship ? "Included" : "Ask admissions" },
    { label: "Certificate", value: course.certificate },
    { label: "Tools taught", value: listOf(course.tools, 4) },
    { label: "Career roles", value: listOf(course.careers, 3) },
    { label: "Campus", value: "Near Technopark, Kazhakootam, Trivandrum" },
    { label: "Fees", value: `On request: ${PHONE}` },
  ].filter((fact) => fact.value);
};

const answerWriters = {
  where: (c, place) => ({
    q: isSpecificPlace(place) ? `Where can I study ${c.title} in ${place}?` : `Where can I study ${c.title} in Kerala?`,
    a: `${INSTITUTE} teaches ${c.title} over ${span(c)}, covering ${listOf(c.syllabus)}. ${attendance(c, place)}. Call or WhatsApp ${PHONE} for the current syllabus and next batch.`,
  }),
  duration: (c, place) => ({
    q: `How long is ${c.title} at ${INSTITUTE}?`,
    a: `${c.title} at ${INSTITUTE} runs for ${span(c)}, and the mode is ${modeText(c)}. ${attendance(c, place)}. Call ${PHONE} to confirm weekly hours and the next start date before you enrol.`,
  }),
  who: (c) => ({
    q: `Who can join ${c.title} at ${INSTITUTE}?`,
    a: `${INSTITUTE} lists these requirements for ${c.title}: ${listOf(c.prerequisites)}. It suits ${listOf(c.whoShouldJoin).toLowerCase()}. Share your education and experience on ${PHONE} and the admissions team will confirm the right starting level.`,
  }),
  afterSchool: (c) => ({
    q: `Can I join ${c.title} after Plus Two?`,
    a: `${INSTITUTE} lists these requirements for ${c.title}: ${listOf(c.prerequisites)}. If you have finished Plus Two or Class 12, call or WhatsApp ${PHONE} before applying, and admissions will confirm whether you can join.`,
  }),
  graduate: (c) => ({
    q: `Can graduates join ${c.title} at ${INSTITUTE}?`,
    a: `Graduates can apply for ${c.title} at ${INSTITUTE}, which lists these requirements: ${listOf(c.prerequisites)}. The ${span(c)} course adds practical skills in ${listOf(c.syllabus, 2)}. Call ${PHONE} to confirm the batch that fits your background.`,
  }),
  jobs: (c) => ({
    q: `What jobs can I get after ${c.title}?`,
    a: `${c.title} at ${INSTITUTE} prepares learners for roles such as ${listOf(c.careers, 4)}. Job titles and pay vary by employer and experience. Call ${PHONE} to discuss which role suits your background and how the course prepares you for it.`,
  }),
  placement: (c) => ({
    q: `Does ${c.title} at ${INSTITUTE} include placement support?`,
    a: `${INSTITUTE} supports ${c.title} learners with resume guidance, interview preparation and eligible job referrals for roles such as ${listOf(c.careers, 2)}. Placement is not guaranteed; selection depends on the employer and the candidate. Ask ${PHONE} about current support.`,
  }),
  internship: (c) => ({
    q: `Does ${c.title} at ${INSTITUTE} include an internship?`,
    a: c.internship
      ? `Yes. ${c.title} at ${INSTITUTE} includes internship experience alongside projects such as ${listOf(c.projects, 2)}. Call or WhatsApp ${PHONE} to confirm how the internship is arranged for your batch and what it involves.`
      : `${c.title} at ${INSTITUTE} is built around applied projects such as ${listOf(c.projects, 2)}. Internship options can change between batches, so call or WhatsApp ${PHONE} to confirm what is available for yours before you enrol.`,
  }),
  certificate: (c) => ({
    q: `What certificate do I get after ${c.title}?`,
    a: `Learners who complete ${c.title} at ${INSTITUTE} receive this award: ${c.certificate} Call ${PHONE} to ask what you must complete to receive it and how it applies to the roles you are targeting.`,
  }),
  fees: (c, place) => ({
    q: isSpecificPlace(place) ? `What is the fee for ${c.title} in ${place}?` : `What is the fee for ${c.title}?`,
    a: `${INSTITUTE} gives the current fee for ${c.title} on request. Call or WhatsApp ${PHONE}, or use the enquiry form, to get the fee, what it includes, the ${span(c)} schedule and the next batch date before you pay.`,
  }),
  admission: (c) => ({
    q: `How do I apply for ${c.title} at ${INSTITUTE}?`,
    a: `Apply for ${c.title} through the application page on the ${INSTITUTE} website, or call ${PHONE}. The admissions team checks your eligibility against these requirements: ${listOf(c.prerequisites, 2)}. They then confirm the fee, schedule and next batch.`,
  }),
  online: (c) => ({
    q: `Can I study ${c.title} online?`,
    a: hasOnline(c)
      ? `Yes. ${INSTITUTE} offers ${c.title} as ${modeText(c)}, so learners outside Trivandrum can attend live-online batches. Batch availability changes between admission cycles, so call or WhatsApp ${PHONE} to confirm the current online schedule.`
      : `${INSTITUTE} currently lists ${c.title} as ${modeText(c)} at its campus ${CAMPUS}. Call or WhatsApp ${PHONE} to ask whether an online batch is available for your dates.`,
  }),
};

const KEYWORD_INTENT = {
  fees: "fees", duration: "duration", admission: "admission", placement: "placement", internship: "internship",
  career: "jobs", "after-school": "afterSchool", graduate: "graduate", online: "online", certification: "certificate",
};

// Questions the blocks truly answer, so the page's own wording can lead. Salary
// and "is it a good career" are not here: the record holds no salary data, so
// those pages open with the career roles under a plain heading instead.
const QUESTION_INTENT = [
  [/\b(fees?|cost)\b/i, "fees"],
  [/\b(duration|how long)\b/i, "duration"],
  [/\b(eligibility|qualification)\b/i, "who"],
  [/\b(after (12th|plus two|class 12)|plus two)\b/i, "afterSchool"],
  [/\bafter (a )?(degree|graduation)\b/i, "graduate"],
  [/\bplacement\b/i, "placement"],
  [/\binternship\b/i, "internship"],
  [/\b(where|which institute|best)\b/i, "where"],
];

const primaryIntent = (page) => {
  const fromQuestion = QUESTION_INTENT.find(([pattern]) => pattern.test(page.title))?.[1];
  const aboutCareers = /\b(salary|jobs?|careers?)\b/i.test(page.title) ? "jobs" : "";
  return KEYWORD_INTENT[page.intent] || fromQuestion || aboutCareers || "where";
};

const write = (key, course, place) => {
  const answer = answerWriters[key](course, place);
  return { ...answer, a: answer.a.replace(/\s+/g, " ").trim() };
};

/** The standard answers on a course's own page. */
export const courseAnswers = (course) =>
  ["where", "duration", "who", "jobs", "certificate", "fees"].map((key) => write(key, course, ""));

/** Answers for a keyword page: what was searched first, then the essentials. */
export const keywordAnswers = (page, course, place = "") => {
  const primary = primaryIntent(page);
  const order = [...new Set([primary, "where", "duration", "who", "jobs", "fees", "certificate"])].slice(0, 6);
  return order.map((key, index) => {
    const answer = write(key, course, place);
    // A question page leads with its own wording when the block answers it.
    const answersTitle = index === 0 && page.question && QUESTION_INTENT.some(([pattern, intent]) => intent === key && pattern.test(page.title));
    return answersTitle ? { ...answer, q: page.title } : answer;
  });
};

// ---- Search result snippets ------------------------------------------------
// The title and description are the whole advert in a results page. Both are
// built from the same record, kept within what Google displays, and open with
// the words the person searched, which Google shows in bold.
const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 155;
const SMALL_WORDS = new Set(["a", "an", "and", "at", "after", "for", "in", "near", "of", "or", "the", "to", "with"]);

const titleCase = (text) =>
  String(text).split(" ").map((word, index) => {
    if (/[A-Z0-9]/.test(word.slice(1)) || /[0-9]/.test(word)) return word;
    if (index > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");

const firstThatFits = (options, limit) => options.find((option) => option.length <= limit) || options[options.length - 1];
const courseKind = (course) => (/diploma/i.test(course.title) ? "Diploma" : "Training");
const monthsLabel = (course) => String(course.duration).replace(/months?/i, "Month");

const attendanceShort = (course, place) => {
  if (isSpecificPlace(place) && !isCampusArea(place)) return hasOnline(course) ? `Live online from ${place}.` : "Classes near Technopark, Trivandrum.";
  return hasOnline(course) ? "Online or near Technopark, Trivandrum." : "Classes near Technopark, Trivandrum.";
};

const snippetLead = {
  fees: (c) => `get the current fee, schedule and next batch for the ${monthsLabel(c).toLowerCase()} ${courseKind(c).toLowerCase()}.`,
  afterSchool: (c) => `check eligibility for the ${monthsLabel(c).toLowerCase()} ${courseKind(c).toLowerCase()} with ASB admissions.`,
  placement: (c) => `${monthsLabel(c).toLowerCase()} course with resume help, interview practice and job referrals.`,
  jobs: (c) => `prepare for roles like ${listOf(c.careers, 2)} in ${span(c)}.`,
  internship: (c) => `${monthsLabel(c).toLowerCase()} course built around applied projects. Ask about internships.`,
  certificate: (c) => `${monthsLabel(c).toLowerCase()} ${courseKind(c).toLowerCase()} with an ASB certificate and project portfolio.`,
  admission: (c) => `apply for the next batch of the ${monthsLabel(c).toLowerCase()} ${courseKind(c).toLowerCase()}.`,
  default: (c) => `learn ${listOf(c.syllabus, 2)} in ${span(c)} at ASB.`,
};

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Title and description for a keyword page's search result. */
export const keywordSeo = (page, course, place = "") => {
  const intent = primaryIntent(page);
  const base = page.question ? page.title.replace(/\?$/, "") : titleCase(page.title);
  const benefit = /diploma/i.test(base) ? "" : `: ${monthsLabel(course)} ${courseKind(course)}`;
  const title = firstThatFits([
    ...(page.question || !benefit ? [] : [`${base}${benefit} | ASB`]),
    `${base} | ASB Training Hub`,
    `${base} | ASB`,
    `${base.replace(/Logistics and Supply Chain Management/i, "Logistics & Supply Chain")} | ASB`,
  ], TITLE_LIMIT);

  const lead = (snippetLead[intent] || snippetLead.default)(course);
  const where = attendanceShort(course, place);
  const opener = page.question ? `${page.title.endsWith("?") ? page.title : `${page.title}?`} ` : `${base}: `;
  const body = page.question ? capitalise(lead) : lead;
  const description = firstThatFits([
    `${opener}${body} ${where} Call ${PHONE}.`,
    `${opener}${body} ${where}`,
    `${opener}${body} Call ${PHONE}.`,
    `${opener}${body}`,
    // Long keywords: a shorter promise keeps the searched words in the opener.
    `${opener}${monthsLabel(course)} ${courseKind(course).toLowerCase()}. ${where} Call ${PHONE}.`,
    `${opener}${monthsLabel(course)} ${courseKind(course).toLowerCase()}. ${where}`,
    `${capitalise(lead)} ${where} Call ${PHONE}.`,
    `${capitalise(lead)} ${where}`,
  ], DESCRIPTION_LIMIT);
  return { title, description };
};

/** Title and description for a course's own page. */
export const courseSeo = (course) => {
  // Stored titles were clipped mid-word ("| ASB Training…"); rebuild the ending.
  const base = String(course.metaTitle || `${course.title} Course in Trivandrum`)
    .replace(/\s*\|\s*ASB.*$/i, "")
    .replace(/[…\s]+$/, "");
  const title = firstThatFits([
    `${base} | ASB Training Hub`,
    `${base} | ASB`,
    `${base.replace(/ Course in /i, " in ")} | ASB`,
  ], TITLE_LIMIT);
  const summary = course.metaDescription || `${course.description} ${course.duration}, ${modeText(course)}.`;
  const description = firstThatFits([
    `${summary} Near Technopark, Trivandrum. Call ${PHONE}.`,
    `${summary} Call ${PHONE}.`,
    summary,
  ], DESCRIPTION_LIMIT);
  return { title, description };
};

// The same keyword is published as a guide (/ai-guides) and as a course page
// (/keyword-courses) from one record. Distinct titles and descriptions keep the
// two from competing for the same search; the React pages use the same rules.
const COURSE_WORDS = /\b(course|courses|training|certification|program|programme|diploma|bootcamp|class|classes|internship)\b/i;

export const guidePageSeo = (guide) => {
  if (guide.kind === "question") {
    const title = guide.title.replace(/\?$/, "");
    // The same question is also a course page under /course-training; the guide says it is the answer.
    return { title: firstThatFits([`${title}? Quick Answer | ASB`, `${title}? Answered | ASB`, `${title} | ASB Guide`], TITLE_LIMIT), description: guide.description };
  }
  return {
    title: firstThatFits([`${guide.title} Guide | ASB Training Hub`, `${guide.title} Guide | ASB`], TITLE_LIMIT),
    description: firstThatFits([
      `Guide to ${guide.title}: what it covers, who it suits and how to compare courses. From ASB Training Hub, Trivandrum.`,
      `Guide to ${guide.title}: what it covers, who it suits and how to compare courses.`,
    ], DESCRIPTION_LIMIT),
  };
};

export const keywordCoursePageSeo = (item) => {
  // "RAG" and "RAG Course" are separate records; only the second says "Course".
  const options = COURSE_WORDS.test(item.title)
    ? [`${item.title}: Modules & Projects | ASB`, `${item.title}: Syllabus | ASB`, `${item.title} Syllabus | ASB`]
    : [`${item.title}: What You Will Learn | ASB`, `${item.title}: Skills & Projects | ASB`, `${item.title} Skills | ASB`];
  return {
    title: firstThatFits(options, TITLE_LIMIT),
    description: item.description,
  };
};

/** A course offered in a district: named once, with how classes run there. */
export const locationCourseName = (course, location) =>
  `${COURSE_WORDS.test(course.title) ? course.title : `${course.title} Course`} in ${location.name}`;

export const locationCourseSeo = (course, location) => {
  const name = locationCourseName(course, location);
  const how = /classroom/i.test(location.delivery) ? "Classroom & Online" : "Live Online";
  // Worded apart from the keyword page for the same course and place.
  const where = attendanceShort(course, location.name);
  const description = firstThatFits([
    `${name}. ${monthsLabel(course)} ${courseKind(course).toLowerCase()} covering ${listOf(course.syllabus, 2)}. ${where} Call ${PHONE}.`,
    `${name}. ${monthsLabel(course)} ${courseKind(course).toLowerCase()} covering ${listOf(course.syllabus, 1)}. ${where} Call ${PHONE}.`,
    `${name}. ${monthsLabel(course)} ${courseKind(course).toLowerCase()}. ${where} Call ${PHONE}.`,
    `${name}. ${monthsLabel(course)} ${courseKind(course).toLowerCase()}. ${where}`,
  ], DESCRIPTION_LIMIT);
  return { title: firstThatFits([`${name}: ${how} | ASB`, `${name} (${how})`, `${name} Batches | ASB`], TITLE_LIMIT), description };
};

/** District topic pages say how classes run there, which sets them apart from the keyword pages. */
export const topicPageTitle = (topic, location) => {
  const how = /classroom/i.test(location.delivery) ? "Classroom & Online" : "Live Online";
  const base = `${topic.name} in ${location.name}`;
  return firstThatFits([`${base}: ${how} | ASB`, `${base} (${how})`, `${base} | ASB`], TITLE_LIMIT);
};

/** District topic pages: one line per topic and district, inside the result limit. */
export const topicPageDescription = (topic, location) =>
  firstThatFits([
    `${topic.name} in ${location.name}: ${location.delivery.toLowerCase()} batches with guided projects and career support. Call ${PHONE}.`,
    `${topic.name} in ${location.name}: ${location.delivery.toLowerCase()} batches with guided projects and career support.`,
    `${topic.name} in ${location.name}: ${/classroom/i.test(location.delivery) ? "classroom and online" : "live online"} batches with guided projects. Call ${PHONE}.`,
  ], DESCRIPTION_LIMIT);

// ---- Topic pages -------------------------------------------------------------
// AI guide, keyword-course and AI landing pages name a topic ("RAG Course",
// "Prompt Engineering"), not a course. They are answered from the ASB course
// whose syllabus, tools or outcomes actually mention that topic.
const TOPIC_NOISE = new Set(("course courses training certification certificate kerala india best top online offline with for the and " +
  "classes class job oriented job-oriented placement placements internship live projects project beginners beginner working professionals " +
  "weekend professional industry support assistance near me institute program programme advanced basic a an of to what is how can i " +
  "learn does do which where are career careers jobs salary fees fee duration in from by after").split(" "));

export const aiCourseForTopic = (title, courses) => {
  const ai = courses.filter((c) => c.category === "ai" && c.published !== false);
  const text = String(title).toLowerCase();
  const tokens = text.replace(/[^a-z0-9+ ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !TOPIC_NOISE.has(t));
  const haystack = (c) => [c.title, ...(c.syllabus || []), ...(c.tools || []), ...(c.learningOutcomes || [])].join(" ").toLowerCase();
  const has = (value, t) => new RegExp(`\\b${t.replace(/[+]/g, "\\+")}\\b`).test(value);
  // A topic in the course's own title outweighs a passing mention in its syllabus.
  const scored = ai.map((c) => ({ c, score: tokens.reduce((sum, t) => sum + (has(c.title.toLowerCase(), t) ? 3 : has(haystack(c), t) ? 1 : 0), 0) }));
  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (best?.score) {
    const tied = scored.filter((s) => s.score === best.score).map((s) => s.c);
    const prefer = /agent|mcp|autonom/.test(text) ? "agentic-ai" : /generative|genai|gen ai|llm|prompt|chatgpt|rag/.test(text) ? "generative-ai" : "";
    return tied.find((c) => c.slug === prefer) || tied[0];
  }
  const fallback = /agent|mcp|autonom/.test(text) ? "agentic-ai" : /generative|genai|gen ai|llm|prompt|chatgpt|rag/.test(text) ? "generative-ai" : "artificial-intelligence";
  return ai.find((c) => c.slug === fallback) || ai[0];
};

// ---- District topic pages ("ERP Courses in Kochi") ---------------------------
// These cover a category, so facts and answers describe its courses together.
const unique = (values) => [...new Set(values.filter(Boolean))];

export const topicFacts = (topic, courses, location) => {
  const first = courses[0];
  if (!first) return [];
  const remote = isSpecificPlace(location.name) && !isCampusArea(location.name);
  const withInternship = courses.filter((c) => c.internship).length;
  return [
    { label: "Courses", value: `${courses.length}: ${listOf(courses.map((c) => c.title), 3)}${courses.length > 3 ? " and more" : ""}` },
    { label: "Duration", value: unique(courses.map((c) => c.duration)).join(" or ") },
    { label: "Mode", value: remote ? `Live online from ${location.name}` : unique(courses.map((c) => c.mode)).join(" or ") },
    { label: "Internship", value: withInternship ? `${withInternship} of ${courses.length} courses include one` : "Ask admissions" },
    { label: "Campus", value: "Near Technopark, Kazhakootam, Trivandrum" },
    { label: "Fees", value: `On request: ${PHONE}` },
  ];
};

export const topicAnswers = (topic, courses, location) => {
  if (!courses.length) return [];
  const first = courses[0];
  const place = location.name;
  const names = courses.map((c) => c.title);
  const durations = unique(courses.map((c) => span(c)));
  const withInternship = courses.filter((c) => c.internship).map((c) => c.title);
  const tidy = (a) => a.replace(/\s+/g, " ").trim();
  return [
    {
      q: `Which ${topic.shortName} courses can I join from ${place}?`,
      a: tidy(`${INSTITUTE} offers ${listOf(names, 4)}${names.length > 4 ? ` and ${names.length - 4} more ${topic.shortName} courses` : ""}. ${attendance(first, place)}. Call or WhatsApp ${PHONE} to choose the right one.`),
    },
    {
      q: `How long are ${topic.shortName} courses at ${INSTITUTE}?`,
      a: tidy(`${topic.shortName} courses at ${INSTITUTE} run for ${durations.join(" or ")}, depending on the course and batch. Learners from ${place} can ask about weekly hours and the next start date on ${PHONE} before choosing a batch.`),
    },
    {
      q: `Do ${topic.shortName} courses at ${INSTITUTE} include an internship?`,
      a: tidy(withInternship.length
        ? `${withInternship.length} of the ${names.length} ${topic.shortName} courses at ${INSTITUTE} include an internship, including ${listOf(withInternship, 2)}. Call ${PHONE} from ${place} to confirm how the internship works for your batch.`
        : `${topic.shortName} courses at ${INSTITUTE} are built around applied projects. Internship options can change between batches, so learners from ${place} should call ${PHONE} to confirm what is available.`),
    },
    {
      q: `Who can join ${topic.shortName} courses at ${INSTITUTE}?`,
      a: tidy(`${INSTITUTE} lists requirements such as ${listOf(unique(courses.flatMap((c) => c.prerequisites || [])), 3).toLowerCase()} for its ${topic.shortName} courses. Learners from ${place} can share their background on ${PHONE} to confirm the right starting course.`),
    },
    {
      q: `What is the fee for ${topic.shortName} courses in ${place}?`,
      a: tidy(`${INSTITUTE} gives the current fee for each ${topic.shortName} course on request, because each course differs in length and content. Call or WhatsApp ${PHONE}, or use the enquiry form, to get the fee and next batch date.`),
    },
  ];
};

export const answersHtml = (facts, answers) => `
<section id="quick-facts"><h2>Quick facts</h2><dl>${facts.map((f) => `<dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd>`).join("")}</dl></section>
<section id="course-answers"><h2>Common questions</h2>${answers.map((item) => `<h3>${escapeHtml(item.q)}</h3><p class="citable-answer">${escapeHtml(item.a)}</p>`).join("")}</section>`;

/** FAQ schema fed by the answers, and which text is the direct answer. */
export const answersJsonLd = (url, answers, extraFaqs = []) => [
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [...answers, ...extraFaqs].map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  },
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    url,
    speakable: { "@type": "SpeakableSpecification", cssSelector: [".citable-answer"] },
  },
];
