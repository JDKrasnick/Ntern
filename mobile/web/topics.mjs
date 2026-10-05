const studentPrograms = new Set(["internship", "co-op", "apprenticeship"]);
function studentRole(job) {
  return job.programType ? studentPrograms.has(job.programType) : /\b(?:intern(?:ship)?|co[ -]?op|apprentice(?:ship)?)\b/i.test(job.title);
}

export const topics = {
  software: {
    path: "/internships/software-engineering", title: "Software engineering internships", query: "software",
    description: "Find software engineering internships with Ntern. Learn what to check in a listing, browse matching roles, and apply on the employer’s official site.",
    matches: (job) => studentRole(job) && /\bsoftware\b/i.test(job.title),
    body: `<h1>Software engineering internships</h1>
      <p class="lede">A simpler way to follow software opportunities while you’re still studying. Ntern brings technical early-career roles into one free catalog and takes you straight to the official application.</p>
      <a class="primary" href="/jobs?topic=software">Browse software internships</a>
      <h2>Find a role that fits your next term</h2>
      <p>Software internships can focus on product engineering, backend systems, frontend interfaces, infrastructure, or testing. The title is a starting point: read the employer’s full description to understand the team, technologies, and work you would actually do.</p>
      <p>Check the expected start date, duration, location, and whether you need to return to school afterward. A co-op may run longer than a summer internship. Compare those dates with your academic calendar before committing to an application.</p>
      <h2>What Ntern helps you do</h2>
      <p>Browse without an account. Ntern combines reviewed employer feeds and attributed community sources, labels where listings came from, and links to each employer’s official application. The app gives you role preferences and device alerts without requiring sign-in. An account is only needed to sync saved applications or store a résumé or profile.</p>
      <h2>Check before applying</h2>
      <p>Use the employer’s page to confirm education requirements, location, pay, deadlines, and work authorization. Ntern’s summary helps you discover the role; it does not replace the full posting or promise eligibility. You review and submit the application yourself.</p>`,
  },
  ml: {
    path: "/internships/machine-learning", title: "Machine learning internships", query: "machine learning",
    description: "Discover machine learning internships with Ntern. Compare research and engineering work, check degree requirements, and reach official employer applications.",
    matches: (job) => studentRole(job) && /\bmachine learning\b/i.test(job.title),
    body: `<h1>Machine learning internships</h1>
      <p class="lede">Find machine learning opportunities without turning your search into another project. Ntern is a free technical-role radar for students, with a clear path to the employer’s official application.</p>
      <a class="primary" href="/jobs?topic=ml">Browse machine learning internships</a>
      <h2>Look beyond the model name</h2>
      <p>A machine learning role may involve experiments, data preparation, model evaluation, production systems, or a combination. Read the responsibilities to distinguish research work from applying models in a product or maintaining the infrastructure around them.</p>
      <p>Check the stated degree requirement. Some postings are intended for undergraduates, while others ask for a master’s or PhD student or a specific research background. A technical title alone does not establish eligibility. The employer’s full description is the place to confirm the requirement.</p>
      <h2>How Ntern supports the search</h2>
      <p>Ntern brings reviewed employer feeds and attributed community sources together, with source labels on role summaries. Browse without an account, then open the official application when a role fits. In the app, set preferences and device alerts without signing in; create an account if you want synced saved applications or a stored résumé or profile.</p>
      <h2>Prepare for the actual work</h2>
      <p>Choose projects to discuss that connect to the responsibilities in the posting. For an evaluation role, that might mean explaining your dataset, baseline, metric, and what changed after an experiment. For an engineering role, consider the reliability and deployment work around the model.</p>
      <p>Confirm location, dates, pay, and work authorization on the employer’s site. Ntern helps with discovery and handoff; you decide whether the role fits and submit the application yourself.</p>`,
  },
  graduate: {
    path: "/new-grad", title: "New-grad technical jobs", query: "grad",
    description: "Explore new-grad technical roles with Ntern. Understand graduate-program requirements, follow early-career opportunities, and apply directly with the employer.",
    matches: (job) => ["new-grad", "entry-level"].includes(job.programType)
      || (!job.programType && /\b(?:new[ -]?grad(?:uate)?|graduate (?:engineer|developer|program(?:me)?|scheme)|entry[ -]level)\b/i.test(job.title)),
    body: `<h1>New-grad technical roles</h1>
      <p class="lede">Move from studying to your first technical role with less noise. Ntern brings explicitly early-career opportunities into a free catalog, with source labels and official application links.</p>
      <a class="primary" href="/jobs?topic=graduate">Browse graduate roles</a>
      <h2>New grad, graduate program, or entry level?</h2>
      <p>A new-grad role is a hiring route for people finishing or recently finishing a degree. A graduate program may include rotations or a shared training cohort. An entry-level role may use a different title and eligibility window. Treat the employer’s stated criteria as the source of truth rather than assuming these labels mean the same thing.</p>
      <p>Before applying, check the allowed graduation dates, expected start date, degree field, and experience requirements. Read whether internships count toward any experience requirement. Confirm location and work authorization directly in the posting; a role appearing in an early-career catalog does not guarantee that every graduate can apply.</p>
      <h2>A browse-first way to stay current</h2>
      <p>Ntern combines reviewed employer career feeds and attributed community sources. Browse without an account and inspect the source label before following the official application link. The app supports role preferences and device alerts without sign-in. Sign in when you want to sync saved applications or store a résumé or profile.</p>
      <h2>Your application stays with the employer</h2>
      <p>Ntern helps you discover opportunities and reach the right form. The employer’s page contains the full responsibilities, requirements, and application process. You review and submit there yourself; Ntern does not apply on your behalf.</p>`,
  },
};

export function topicLinks() {
  return `<ul>${Object.values(topics).map((topic) => `<li><a href="${topic.path}">${topic.title}</a></li>`).join("")}</ul>`;
}
