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
const isCampusArea = (place) => CAMPUS_AREA.has(String(place || "").toLowerCase());
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
