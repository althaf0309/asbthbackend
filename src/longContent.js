// Server-rendered copies of the long page content shown by the React app, so
// crawlers that do not run JavaScript receive the same text as visitors.
// Mirrors asb-ascend/src/components/LongLogisticsContent.tsx and
// LongCourseContent.tsx: change the text in both places together, or the HTML
// crawlers read will drift from the page visitors see.

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const hash = (value) => [...value].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 7);

const openings = [
  'The strongest learning plan starts with the full movement of goods, information and decisions rather than isolated definitions.',
  'A useful professional course connects each classroom concept to a decision that occurs in an actual operation.',
  'Career-ready learning requires a clear view of how suppliers, transport, storage, inventory and customers depend on one another.',
  'Practical competence grows when learners can explain a process, measure it and improve it under realistic constraints.',
];

const locationNotes = [
  'Local learners can compare travel, classroom and live-online options before selecting a batch that supports regular attendance.',
  'Candidates should confirm the current delivery mode and schedule because availability can change between admission cycles.',
  'The right batch should fit the learner’s starting level, weekly practice time and access to the training centre.',
];

const pageAngles = [
  'The worked example follows one order from source record to final handover, making every responsibility and control point visible.',
  'A comparison exercise asks learners to balance service, operating cost, lead time and risk before defending a recommendation.',
  'The practical record for this topic includes assumptions, source data, calculations, exceptions and the reason for each corrective action.',
  'A local scenario connects the concept with realistic supplier, transport, storage and customer constraints rather than an idealised process.',
  'Learners examine both the normal workflow and an exception case so they can recognise when escalation or investigation is required.',
  'The case study measures accuracy, turnaround time and service impact instead of judging the result only by visual presentation.',
  'An operations review separates symptoms from root causes and records which evidence would confirm or reject each possible explanation.',
  'The assignment compares a manual control with a system-supported control and explains where human verification remains necessary.',
  'A short audit task checks whether the records, physical flow and reported performance describe the same operating reality.',
  'The scenario includes a change in demand or capacity, requiring the learner to revise the original plan and document the trade-off.',
  'A communication exercise converts operational findings into a concise update for a supervisor, customer or partner team.',
  'Learners define an owner, frequency and evidence for each control so an improvement can continue after the initial project ends.',
  'The project identifies upstream and downstream effects, preventing a local improvement from shifting delay or cost to another team.',
  'A data-quality check looks for missing values, duplicate records, inconsistent units and timing differences before analysis begins.',
  'The review asks what could fail, how early warning would appear and which response protects people, goods and service commitments.',
  'The final recommendation states its limits and the additional evidence needed before applying it to a larger operation.',
];

const audiences = [
  'a first-time learner building a foundation for an operations role',
  'a graduate translating academic knowledge into workplace evidence',
  'a working professional preparing for wider coordination responsibility',
  'a career changer who needs a structured route into the sector',
  'an operations employee strengthening documentation and analysis skills',
  'a learner preparing to discuss practical decisions during interviews',
];

const scenarios = [
  'an inbound shipment arriving with a quantity and document mismatch',
  'a fast-moving item repeatedly reaching its reorder point too late',
  'a dispatch plan affected by limited capacity and an urgent customer order',
  'a warehouse zone showing avoidable travel and picking delays',
  'a supplier delay that changes inventory and delivery priorities',
  'a return that must be inspected, recorded and routed correctly',
  'a stock count that differs from the system balance',
  'a service complaint requiring traceability across several handovers',
];

const measures = [
  'order accuracy, lead time and exception frequency',
  'inventory accuracy, ageing and stock availability',
  'receiving turnaround, put-away time and location accuracy',
  'picking productivity, dispatch accuracy and on-time completion',
  'transport utilisation, delivery reliability and service cost',
  'damage rate, return reasons and corrective-action closure',
];

const deliverables = [
  'a process map with control points and named responsibilities',
  'a checked spreadsheet supported by assumptions and source notes',
  'an exception report with evidence, root causes and corrective actions',
  'a concise operations dashboard with definitions for every measure',
  'a standard operating checklist tested against a realistic case',
  'an improvement proposal that states costs, benefits, risks and limits',
];

const pagePlan = (props) => {
  const seed = hash(`${props.family}:${props.slug}:${props.intent}:${props.location || 'kerala'}`);
  return {
    audience: audiences[seed % audiences.length],
    scenario: scenarios[Math.floor(seed / 7) % scenarios.length],
    measures: measures[Math.floor(seed / 13) % measures.length],
    deliverable: deliverables[Math.floor(seed / 19) % deliverables.length],
  };
};

const intentText = {
  fees: 'For a fee-focused search, the page explains what to confirm before payment: tuition scope, assessment, certification conditions, materials, taxes and any optional charges.',
  admission: 'For admission planning, candidates should check eligibility, documents, start dates, seat availability and the exact syllabus before enrolling.',
  placement: 'Placement assistance should be assessed through employability preparation, interview practice and access to suitable openings; employment cannot be guaranteed.',
  internship: 'An internship can add workplace exposure when its responsibilities, supervision, duration and learning outcomes are clearly defined.',
  career: 'Career-focused learners should connect each module to target roles and collect evidence that they can explain during an interview.',
  'after-school': 'Learners joining after Plus Two or Class 12 benefit from foundations, clear terminology and frequent guided practice before advanced operational work.',
  graduate: 'Graduates can use the programme to add industry-specific operational skills to their existing academic background.',
  online: 'Live-online learning works best with scheduled interaction, demonstrations, exercises, feedback and consistent independent practice.',
  certification: 'Certification is most valuable when it follows assessed learning and is supported by projects that demonstrate applied competence.',
  institute: 'When comparing institutes, review trainer access, practical hours, syllabus depth, assessment and transparent student support.',
  comparison: 'A “best course” decision should be based on fit, practical depth and verified support rather than a broad promotional claim.',
  duration: 'Duration should be judged alongside weekly hours, practical assignments, assessment and the learner’s starting knowledge.',
  'near-me': 'A nearby option can reduce travel, but teaching quality, practical access and schedule fit should remain part of the decision.',
  question: 'This page answers the search directly and then provides the context needed to make a careful training decision.',
  course: 'The course pathway combines foundations, applied exercises, operational analysis and a documented project.',
};

const sections = [
  ['Understanding the learning pathway', (p) => `${openings[hash(p.title) % openings.length]} ${p.title} is approached as a structured pathway covering terminology, process relationships, records, performance measures and day-to-day decision making. Learners first map how an order or material moves, identify the people and documents involved, and recognise where delay, damage, shortage or excess cost may arise. The instructor then connects these observations to planning methods and digital systems. ${intentText[p.intent] || intentText.course} This approach helps a learner move beyond memorising terms and begin reasoning about real operating situations.`],
  ['Core logistics and supply-chain foundations', (p) => `Every participant needs a dependable foundation in procurement, inbound movement, storage, inventory, order fulfilment, transport and customer service. The programme explains how demand information becomes a purchasing or replenishment decision, how lead time affects availability, and why inaccurate records create cost throughout the chain. Learners compare push and pull flows, service and cost trade-offs, and the roles of manufacturers, distributors, freight partners and retailers. For ${p.title}, examples are selected to match the search intent while keeping the wider system visible. Exercises use process maps and simple operating data so learners can trace causes instead of treating each problem as an isolated event.`],
  ['Warehouse and inventory operations', (p) => `Warehouse learning covers receiving, inspection, put-away, location control, storage, replenishment, picking, packing, dispatch and returns. Inventory topics include item identification, stock accuracy, cycle counting, ABC classification, safety stock, reorder thinking and ageing control. Learners examine why a physical quantity may differ from a system balance and practise a disciplined investigation using transaction history and location checks. ${p.family === 'warehouse' ? 'Because this page focuses on warehouse and inventory management, operational control and safe material flow receive additional attention.' : 'These warehouse foundations are connected to the wider supply chain so local optimisation does not create delays elsewhere.'} Safety, housekeeping and clear standard procedures are treated as operating requirements rather than optional additions.`],
  ['Transport, freight and distribution planning', (p) => `Goods may move by road, rail, sea or air, and the suitable choice depends on urgency, volume, handling needs, route availability and total landed cost. Learners review shipment planning, consolidation, basic freight terminology, delivery documentation and last-mile coordination. They consider the effect of vehicle utilisation, route planning, failed delivery and waiting time on both cost and customer experience. Case exercises ask learners to choose between alternatives and explain the assumptions behind the choice. The aim is not to memorise every international rule, but to understand the questions an operations professional must ask and the records required for accountable execution.`],
  ['Documentation and digital working skills', (p) => `Reliable operations depend on accurate records. Training therefore includes purchase and receiving records, stock movements, dispatch documents, proof of delivery, exception notes and basic reporting. Learners practise spreadsheet organisation, validation, filtering and summary calculations before examining how warehouse, transport and enterprise systems use the same underlying information. Barcode and scanning concepts show how identification supports speed and traceability. Digital exercises emphasise careful entry, access control, backups and review because a polished dashboard cannot repair unreliable source data. By documenting the steps behind a result, learners create work that can be checked, improved and explained to a supervisor.`],
  ['Practical classes and applied projects', (p) => `Instructor-led sessions combine explanation, demonstration, guided exercises and independent work. A typical progression begins with a process map, adds operational records, introduces performance measures and ends with an improvement proposal. Projects may include a warehouse layout review, inventory classification, receiving checklist, dispatch dashboard, route comparison or fulfilment workflow. Each project states the problem, available data, assumptions, method, result and limitations. Feedback is used to revise the work rather than simply assign a score. For ${p.title}, the final evidence should show that the learner can apply ideas to a realistic scenario and communicate the reasoning clearly.`],
  ['Quality, safety and responsible operations', (p) => `Operational speed has little value when it causes injury, product damage, regulatory failure or unreliable records. Learners examine safe movement, personal protective equipment, clear pedestrian and equipment zones, load awareness, incident reporting and escalation. Quality topics include inspection, traceability, damage prevention, temperature or handling requirements where relevant, and root-cause thinking. Sustainability is discussed through waste reduction, packaging choices, route efficiency, returns and better inventory decisions. Exercises encourage learners to identify a risk, choose a control and define how the control will be monitored. Legal and company-specific requirements must always be confirmed with the responsible organisation.`],
  ['Who can join and how to prepare', (p) => `${p.title} can be relevant to students, Plus Two learners, graduates, job seekers, retail or warehouse staff, purchasing teams, transport coordinators and professionals moving into operations. Previous industry experience can help, but beginners can start when the batch provides clear foundations. Comfort with basic arithmetic, spreadsheets and workplace communication supports faster progress; these skills can also be strengthened during preparation. Learners should bring a laptop when required, attend consistently and reserve time each week for assignments. Before enrolling, share education, experience and career goals with the admissions team so they can explain the suitable level and prerequisites.`],
  ['Career roles and employability preparation', (p) => `Relevant entry and progression roles can include logistics coordinator, warehouse associate, inventory controller, dispatch executive, procurement assistant, transport coordinator, operations analyst and supply-chain support positions. Job titles and requirements vary by employer, so learners study current role descriptions and identify recurring skills. Resume guidance focuses on specific tasks, tools and project outcomes rather than unsupported claims. Interview practice covers process explanation, stock discrepancies, delivery exceptions, safety decisions and improvement ideas. Placement support may include preparation and sharing eligible profiles for available opportunities, but selection depends on the employer, candidate performance, experience and market conditions.`],
  ['How to compare course options', (p) => `Compare a course using the detailed syllabus, practical hours, trainer interaction, project depth, assessment method and support available after class. Confirm whether examples reflect current operations and whether learners work with records and scenarios rather than only slides. Ask what the advertised duration means in actual teaching hours, how missed sessions are handled, and what must be completed to receive a certificate. Fees should be explained in writing with inclusions and payment terms. ${p.location ? `${locationNotes[hash(p.title + p.location) % locationNotes.length]} This is especially relevant for learners searching in ${p.location}.` : locationNotes[hash(p.title) % locationNotes.length]} A careful comparison reduces surprises and improves the chance of completing the programme successfully.`],
  ['Online, classroom and blended learning', (p) => `Classroom learning offers a fixed routine, direct interaction and group exercises. Live-online learning can serve candidates who cannot travel regularly, while blended delivery may combine both. The label alone does not determine quality: learners should confirm whether online sessions are live, whether questions receive answers, how practical work is reviewed and whether recordings are available under the provider’s policy. A productive format includes demonstrations, individual tasks, feedback and milestones. Whichever mode is selected, regular participation matters more than passive access to material. Current availability, timing and batch size should be confirmed directly because schedules can change between admission periods.`],
  ['Assessment, portfolio and next steps', (p) => `Assessment should show whether the learner can perform, explain and improve a task. Short checks test vocabulary and calculations; scenario work tests judgement; and the final project tests integration and communication. Learners keep process maps, spreadsheets, checklists, reports and presentation material as a compact portfolio, while removing confidential information. Improvement after feedback is part of the evidence. To explore ${p.title}, use the enquiry form to request the current syllabus, duration, fee, eligibility, delivery mode and batch schedule. Review those details against your goal, ask for clarification where needed, and plan steady weekly practice before committing to an admission date.`],
  ['Building a dependable learning routine', (p) => `Progress in ${p.label} comes from repeated practice rather than one final assignment. A learner can divide each week between concept review, spreadsheet or documentation exercises, process observation and project improvement. Keeping a short learning journal makes errors, assumptions and corrective actions visible. When a result looks wrong, check the source record, unit, date, location and transaction sequence before changing several factors together. Discussing a process with classmates also reveals missing steps and unclear terminology. This routine strengthens accuracy, communication and confidence while helping learners retain the foundations after scheduled classes finish. Regular reflection also makes project evidence easier to present during assessments, interviews and early workplace responsibilities.`],
];


/** Long-form content for a logistics or warehouse keyword page. */
export const logisticsLongHtml = (props) => {
  const plan = pagePlan(props);
  const lead = `This page is designed for ${plan.audience}. Its anchor exercise examines ${plan.scenario}. Learners use ${plan.measures} to judge the result and finish with ${plan.deliverable}. ${props.location ? `Examples are discussed in the context of learners exploring study options around ${props.location}, while the operating methods remain transferable across employers and regions.` : "The exercise connects the search topic to a concrete decision, measurable evidence and a result that can be explained during assessment or interview preparation."}`;
  const parts = sections.map(([heading, copy], index) => {
    const suffix = index === 0 && props.location ? ` in ${props.location}` : "";
    const angle = pageAngles[hash(`${props.slug}:${index}`) % pageAngles.length];
    return `<section><h2>${escapeHtml(heading + suffix)}</h2><p>${escapeHtml(`${copy(props)} ${angle}`)}</p></section>`;
  });
  return `<section><h2>${escapeHtml(`A learning plan shaped for ${props.title}`)}</h2><p>${escapeHtml(lead)}</p></section>${parts.join("")}`;
};

const courseSections = [
  ['What this learning path means','This course is a practical learning path rather than a collection of disconnected tool demonstrations. Learners begin by understanding the problem, the intended user, the available data and the standard by which a useful result will be judged. Concepts are connected to realistic tasks so technical vocabulary becomes working knowledge. Counselling helps beginners, graduates, developers and working professionals choose the right foundation before advanced implementation. The aim is to understand how inputs, models, tools, workflows, evaluation and human decisions work together, then apply that understanding independently.'],
  ['Foundations before frameworks','Strong results come from foundations that remain useful when software changes. The programme explains model behaviour, prompting, context, data quality, workflow design, evaluation and responsible use before concentrating on one framework. Learners practise breaking a large requirement into smaller steps, selecting reliable sources, documenting assumptions and checking output against a clear standard. Coding support can begin at the required level, but every learner is encouraged to understand the logic behind an implementation. This makes it easier to compare new tools, troubleshoot unexpected behaviour and explain decisions during interviews or workplace reviews.'],
  ['Instructor-led practical training','Classes combine explanation, live demonstration, guided practice and independent exercises. An instructor first models the reasoning behind a workflow, then learners reproduce the important steps and adapt them to a different use case. Reviews focus on why an approach works, where it may fail and how the result can be measured. Doubt-clearing sessions address technical questions and project decisions. Instead of copying a finished example, learners maintain notes, prompts, test cases and implementation records. These materials provide evidence of learning and make revision easier before assessments, project demonstrations and interviews.'],
  ['Projects and portfolio evidence','A useful portfolio explains the problem, intended user, chosen approach, evaluation method and result. Learners build progressively: a focused exercise establishes one skill, an integrated workflow combines several skills, and a capstone demonstrates end-to-end application. Projects may cover knowledge assistance, document workflows, research support, customer service, content operations or responsible business automation. Each project includes limitations and improvement ideas because employers value candidates who can assess their own work. Guidance covers presentation, repository organisation, readable documentation and a concise demonstration that a reviewer can understand without lengthy explanation.'],
  ['Tools, data and responsible implementation','Modern AI systems depend on more than model access. Learners examine how data is collected, prepared, retrieved and protected; how external tools are connected; and how results are logged for review. Exercises discuss privacy, permission, bias, hallucination, security and human oversight in practical terms. A workflow should reveal when confidence is low, avoid exposing sensitive information and provide a sensible route for human approval. Evaluation is an ongoing process using representative examples instead of a one-time visual check. These habits help learners build systems that are useful, maintainable and safer to operate.'],
  ['Who can join and how to prepare','The pathway can suit students, graduates, software learners, analysts, operations professionals, managers, entrepreneurs and career changers. The starting module depends on previous experience. Beginners may first review computer fundamentals, logical problem solving and basic Python, while experienced developers can move more quickly into architecture and integration. Learners should bring curiosity, regular practice time and willingness to revise work after feedback. A personal laptop and consistent attendance support practical progress. Before enrolment, request the current syllabus, prerequisites, delivery mode, assessment approach and expected weekly practice commitment.'],
  ['Career preparation and realistic outcomes','Career support works best when it connects demonstrable skill with a realistic target role. Learners identify roles that match their background, study relevant job descriptions and select projects that show the required abilities. Resume guidance focuses on specific contributions and outcomes instead of long lists of tool names. Interview preparation includes explaining architecture, trade-offs, errors, testing and lessons learned. Possible directions include AI application development, automation, workflow design, model evaluation, data support, product operations and domain implementation. Referrals depend on eligibility and available openings; responsible course guidance does not describe placement as guaranteed.'],
  ['How to compare training options','Compare programmes by examining the detailed syllabus, trainer access, practical hours, project depth, assessment method and support after class. A list of popular tools is not enough because tools change quickly and can hide missing foundations. Ask whether projects are reviewed individually, whether evaluation and responsible use are taught, and whether the course matches your current knowledge. Confirm fees, batch timing, classroom or live-online availability, certificate conditions and refund terms before paying. The suitable option provides a clear progression from your starting point to a result you can demonstrate independently.'],
  ['Online and classroom learning','Classroom learning offers direct interaction, a structured routine and access to peers, while live-online learning can reduce travel and support learners outside Trivandrum. Both modes require active practice; watching recordings alone rarely creates dependable skill. A useful online batch includes live explanations, screen-based demonstrations, guided exercises, feedback and opportunities to ask questions. Learners should confirm current delivery options because not every batch is offered in every mode. People across Kerala can request the latest online, classroom and hybrid schedule and select a format that allows consistent participation.'],
  ['Assessment and continuous improvement','Assessment should measure whether a learner can apply knowledge, explain choices and improve a weak result. Short exercises check individual concepts, project reviews examine integration, and the final demonstration tests communication as well as implementation. Feedback should lead to a revised version rather than end with a score. Learners build a simple evaluation set, record failures and compare improvements so progress is visible. This disciplined process supports reliable project work and gives candidates specific examples to discuss when an interviewer asks about troubleshooting, quality, safety or lessons learned.'],
  ['Building a sustainable learning routine','Long-term skill grows through frequent focused practice. Learners can divide each week between concept review, guided implementation, independent experimentation and project documentation. Keeping a learning journal makes mistakes and improvements visible, while version control preserves meaningful project stages. When a tool produces an unexpected result, the learner should isolate the input, configuration, data and evaluation conditions before changing several things at once. Peer explanation is also useful because teaching a workflow exposes gaps in understanding. A sustainable routine values steady progress, rest and reflection, helping learners retain foundations after the scheduled classes finish.'],
  ['Next steps and course enquiry','Start by sharing your education, work experience, existing technical skills and desired outcome. The admissions team can explain the suitable level, current syllabus, duration, fee, batch schedule and delivery mode. Review the information carefully and ask about any topic important to your goal. After enrolment, reserve regular weekly practice time and define one portfolio outcome early. Consistent exercises, honest evaluation and instructor feedback produce stronger progress than rushing through many tools. Use the enquiry form on this page or the tracked WhatsApp button to request current details directly from ASB Training Hub.']
];

/** Long-form content for an Agentic or Generative AI keyword page. */
export const aiCourseLongHtml = ({ title, label, place }) =>
  courseSections.map(([heading, text], i) => `<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(`${i === 0 ? `${title} focuses on ${label}${place ? ` for learners connected with ${place}` : ""}. ` : ""}${text}`)}</p></section>`).join("");
