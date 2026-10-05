export const siteOrigin = "https://ntern.app";
export const homeTitle = "Ntern — Technical internships and new-grad roles";
export const homeDescription = "Find technical internships, co-ops, apprenticeships, and entry-level roles. Browse without an account and apply on the employer’s official site.";

export const policyDescriptions = {
  privacy: "How Ntern collects, uses, and protects account, résumé, and device notification data.",
  terms: "Terms for using Ntern to discover early-career roles and reach official employer applications.",
  retention: "How long Ntern keeps account, application, document, and notification data, and how to delete it.",
  "source-policy": "How Ntern sources early-career roles, verifies official application links, and handles corrections.",
  support: "Get help with Ntern, report a listing problem, or request a data correction.",
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function metadata({ title, description, path = "/", noindex = false }) {
  const canonical = `${siteOrigin}${path}`;
  return `<title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta name="robots" content="${noindex ? "noindex, follow" : "index, follow"}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Ntern" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />`;
}

export function addMetadata(html, options) {
  return html.replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace("</head>", `${metadata(options)}</head>`);
}

export function sitemap(paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `  <url><loc>${escapeHtml(`${siteOrigin}${path}`)}</loc></url>`).join("\n")}\n</urlset>\n`;
}
