/* Page shell. Every /docs page is rendered through render() below, so the head
 * contract, the structured data and the chrome are defined once.
 *
 * On schema choice: HowTo rich results were retired by Google in 2023, so the
 * step-by-step guides use TechArticle rather than HowTo — it describes what they
 * are and is still consumed. FAQPage is emitted only where every answer is also
 * rendered visibly, which is both the policy and the honest thing to do.
 */
import { SECTIONS, PAGES, SITE } from "./nav.mjs";
import { esc } from "./components.mjs";

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700" +
  "&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;600&display=swap";

/** Pull h2/h3 out of the rendered body for the table of contents. */
export function extractToc(html) {
  const out = [];
  const re = /<(h2|h3) id="([^"]+)">([\s\S]*?)<a class="anchor"/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ level: m[1] === "h2" ? 2 : 3, id: m[2], text: m[3].replace(/<[^>]+>/g, "").trim() });
  }
  return out;
}

const sidebar = (slug) => SECTIONS.map((s) =>
  `<div class="sbh">${esc(s.title)}</div><ul>${s.items.map((i) =>
    `<li><a href="/docs/${i.slug}"${i.slug === slug ? ' aria-current="page"' : ""}>${esc(i.title)}</a></li>`,
  ).join("")}</ul>`).join("");

const tocHtml = (toc) => !toc.length ? "" :
  `<aside class="toc" aria-label="On this page"><div class="toch">On this page</div><ul>${toc.map((t) =>
    `<li><a class="${t.level === 3 ? "lvl3" : ""}" href="#${t.id}">${esc(t.text)}</a></li>`,
  ).join("")}</ul></aside>`;

const pagerHtml = (slug) => {
  const i = PAGES.findIndex((x) => x.slug === slug);
  if (i < 0) return "";
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  if (!prev && !next) return "";
  return `<nav class="pager" aria-label="Previous and next page">` +
    (prev ? `<a href="/docs/${prev.slug}"><span class="d">Previous</span>${esc(prev.title)}</a>` : "<span></span>") +
    (next ? `<a class="next" href="/docs/${next.slug}"><span class="d">Next</span>${esc(next.title)}</a>` : "<span></span>") +
    `</nav>`;
};

const relatedHtml = (related) => !related?.length ? "" :
  `<section class="related"><h2>Related</h2><ul>${related.map((r) =>
    `<li><a href="${r.href}">${esc(r.title)}</a>${r.note ? ` — ${esc(r.note)}` : ""}</li>`).join("")}</ul></section>`;

/**
 * page = { slug, seoTitle, desc, h1, lede, body, kind, related, faqs, updated }
 * slug "" is the /docs hub.
 */
export function render(page, assets = { css: "docs.css", js: "docs.js" }) {
  const url = page.slug ? `${SITE}/docs/${page.slug}` : `${SITE}/docs`;
  const toc = page.slug ? extractToc(page.body) : [];

  const crumbs = [{ name: "HoodLock", url: `${SITE}/` }, { name: "Docs", url: `${SITE}/docs` }];
  if (page.slug) crumbs.push({ name: page.navTitle || page.h1Plain, url });

  const jsonld = [
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, i) => ({
        "@type": "ListItem", position: i + 1, name: c.name, ...(c.url ? { item: c.url } : {}),
      })),
    },
    page.slug ? {
      "@context": "https://schema.org", "@type": "TechArticle",
      headline: page.seoTitle, description: page.desc, url,
      datePublished: page.updated, dateModified: page.updated,
      author: { "@type": "Organization", name: "HoodLock", url: SITE },
      publisher: {
        "@type": "Organization", name: "HoodLock",
        logo: { "@type": "ImageObject", url: `${SITE}/hoodlock-logo.png` },
      },
      mainEntityOfPage: url,
    } : {
      "@context": "https://schema.org", "@type": "CollectionPage",
      name: page.seoTitle, description: page.desc, url,
      isPartOf: { "@type": "WebSite", name: "HoodLock", url: `${SITE}/` },
    },
  ];
  if (page.faqs?.length) {
    jsonld.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: page.faqs.map(([q, a]) => ({
        "@type": "Question", name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    });
  }

  const crumbNav = `<nav class="crumb" aria-label="Breadcrumb"><ol>` +
    `<li><a href="/">HoodLock</a></li>` +
    (page.slug ? `<li><a href="/docs">Docs</a></li><li>${esc(page.navTitle || "")}</li>` : `<li>Docs</li>`) +
    `</ol></nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.seoTitle)}</title>
<meta name="description" content="${esc(page.desc)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="HoodLock"><meta property="og:type" content="article">
<meta property="og:title" content="${esc(page.seoTitle)}">
<meta property="og:description" content="${esc(page.desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/hoodlockshare.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.seoTitle)}">
<meta name="twitter:description" content="${esc(page.desc)}">
<meta name="twitter:image" content="${SITE}/hoodlockshare.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="${FONTS}">
<link rel="stylesheet" href="${FONTS}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="${FONTS}"></noscript>
<link rel="icon" href="/favicon.ico" sizes="any">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
<link rel="stylesheet" href="/docs/${assets.css}">
<script defer src="/docs/${assets.js}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="progress" id="progress" aria-hidden="true"></div>
<nav class="nav">
  <a class="logo" href="/">Hood<b>Lock</b></a>
  <div class="search" role="search">
    <label class="skip" for="docsearch">Search documentation</label>
    <input id="docsearch" type="search" placeholder="Search the docs…" autocomplete="off"
           role="combobox" aria-expanded="false" aria-controls="docresults" aria-autocomplete="list">
    <div class="results" id="docresults" role="listbox" hidden></div>
  </div>
  <div class="nav-right">
    <button class="menu-btn" type="button" id="menuBtn" aria-expanded="false" aria-controls="sidebar">Menu</button>
    <a class="cta" href="/app">Launch App</a>
  </div>
</nav>
<div class="sb-backdrop" id="sbBackdrop" hidden></div>
<div class="shell">
<nav class="sb" id="sidebar" aria-label="Documentation">
  <button class="sb-close" type="button" id="sbClose" aria-label="Close menu">&times;</button>
  ${sidebar(page.slug)}
</nav>
<main id="main">
${crumbNav}
<h1>${page.h1}</h1>
${page.lede ? `<p class="lede">${page.lede}</p>` : ""}
${page.updated ? `<div class="meta">Updated ${page.updated} · HoodLock Team</div>` : ""}
${page.body}
${relatedHtml(page.related)}
${pagerHtml(page.slug)}
</main>
${tocHtml(toc)}
</div>
<footer>© 2026 HOODLOCK · ROBINHOOD CHAIN · <a href="/">hoodlock.tech</a></footer>
</body>
</html>
`;
}
