/* Renders web/docs-src/pages/*.mjs into web/public/docs/.
 *
 * Idempotent: running it twice produces byte-identical output, which is what
 * lets `npm run docs:build && git diff --exit-code web/public/docs` prove the
 * committed HTML still matches its source.
 *
 * Output is committed because the Docker build runs `vite build`, which copies
 * web/public verbatim and knows nothing about this script. The Dockerfile also
 * runs this first, so the two can never disagree.
 */
import { readdir, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render, extractToc } from "./layout.mjs";
import { PAGES, priorityFor, SITE } from "./nav.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "docs");
const PAGEDIR = join(HERE, "pages");

const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/* ---------------------------------------------------------------------------
 * Keyword-collision guard.
 *
 * The site already has 35 blog articles. A /docs page that targets the same
 * query as one of them puts two of our own URLs in front of the same search,
 * and the ranking one wins at the other's expense — so writing it actively
 * costs us traffic rather than adding any.
 *
 * Rather than leaving that as a rule someone has to remember, the build checks
 * it. Titles are reduced to their significant terms (stopwords and brand words
 * removed) and compared by Jaccard overlap against every blog title.
 *
 *   >= FAIL   the two pages are chasing the same query. Retitle, or declare it.
 *   >= WARN   close enough to be worth a second look. Printed, not fatal.
 *
 * A page may declare `overlaps: ["blog-slug"]` to accept a collision — but only
 * if it also links to that article, so the acknowledgement routes authority to
 * the canonical page instead of competing with it.
 * ------------------------------------------------------------------------- */
const FAIL = 0.6, WARN = 0.34;
const STOP = new Set(("a an the of on on in to for and or with your you how what is are it its when why do " +
  "does can i my be at as from that this vs").split(" "));
const BRAND = new Set(["hoodlock", "robinhood", "chain", "docs", "doc", "guide", "step"]);

const terms = (title) => {
  const t = title.replace(/\|.*$/, "").toLowerCase();
  return new Set((t.match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w) && !BRAND.has(w)));
};
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

async function guardAgainstCannibalisation(pages) {
  const blogDir = join(HERE, "..", "public", "blog");
  if (!existsSync(blogDir)) return;
  const posts = [];
  for (const f of (await readdir(blogDir)).filter((f) => f.endsWith(".html") && f !== "index.html")) {
    const html = await readFile(join(blogDir, f), "utf8");
    const m = /<title>(.*?)<\/title>/s.exec(html);
    if (m) posts.push({ slug: f.replace(/\.html$/, ""), terms: terms(m[1]) });
  }

  const failures = [], warnings = [];
  for (const p of pages) {
    const pt = terms(p.seoTitle);
    for (const post of posts) {
      const j = jaccard(pt, post.terms);
      if (j < WARN) continue;
      const declared = (p.overlaps || []).includes(post.slug);
      const links = p.body.includes(`/blog/${post.slug}`);
      const where = `/docs/${p.slug || ""} ↔ /blog/${post.slug} (${j.toFixed(2)})`;
      if (j >= FAIL && !declared) {
        failures.push(`${where}\n      shared terms: ${[...pt].filter((x) => post.terms.has(x)).join(", ")}` +
          `\n      → retitle so the intent differs, or add overlaps: ["${post.slug}"] and link to it`);
      } else if (declared && !links) {
        failures.push(`${where}\n      declared as an accepted overlap but does not link to it`);
      } else if (j >= WARN) {
        warnings.push(`${where}${declared ? " — declared" : ""}`);
      }
    }
  }
  for (const w of warnings) console.log(`  near-miss  ${w}`);
  if (failures.length) {
    throw new Error(`keyword collision with existing blog posts:\n    ${failures.join("\n    ")}`);
  }
}

async function main() {
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "vs"), { recursive: true });

  const files = (await readdir(PAGEDIR)).filter((f) => f.endsWith(".mjs")).sort();
  const pages = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(PAGEDIR, f)).href);
    const page = mod.default;
    if (!page || typeof page.slug !== "string") throw new Error(`${f}: missing default export or slug`);
    pages.push(page);
  }

  // Fail loudly on the mistakes that are invisible until Google finds them.
  const seenSlug = new Set(), seenTitle = new Set(), seenDesc = new Set();
  for (const p of pages) {
    if (seenSlug.has(p.slug)) throw new Error(`duplicate slug: ${p.slug}`);
    if (seenTitle.has(p.seoTitle)) throw new Error(`duplicate <title>: ${p.seoTitle}`);
    if (seenDesc.has(p.desc)) throw new Error(`duplicate description on ${p.slug}`);
    if (!p.desc || p.desc.length < 60) throw new Error(`${p.slug}: description too short`);
    if (p.desc.length > 165) throw new Error(`${p.slug}: description too long (${p.desc.length})`);
    seenSlug.add(p.slug); seenTitle.add(p.seoTitle); seenDesc.add(p.desc);
  }

  // Every non-hub page must be in the nav, or it would be an orphan.
  const navSlugs = new Set(PAGES.map((p) => p.slug));
  for (const p of pages) {
    if (p.slug && !navSlugs.has(p.slug) && !p.slug.startsWith("vs/")) {
      throw new Error(`${p.slug} is not in nav.mjs — it would be orphaned`);
    }
  }

  await guardAgainstCannibalisation(pages);

  const index = [];
  for (const p of pages) {
    const html = render(p);
    const file = p.slug ? `${p.slug}.html` : "index.html";
    await writeFile(join(OUT, file), html);
    index.push({
      url: p.slug ? `/docs/${p.slug}` : "/docs",
      title: p.navTitle || strip(p.h1),
      desc: p.desc,
      headings: extractToc(p.body).map((t) => t.text).join(" · "),
    });
  }

  await writeFile(join(OUT, "docs.css"), await readFile(join(HERE, "styles.css"), "utf8"));
  await writeFile(join(OUT, "docs.js"), await readFile(join(HERE, "runtime.js"), "utf8"));
  await writeFile(join(OUT, "search.json"), JSON.stringify(index));

  // Sitemap triples, pasted into server/index.mjs — printed so the two stay in step.
  const triples = pages.map((p) =>
    `      ["/docs${p.slug ? "/" + p.slug : ""}", "monthly", "${priorityFor(p.slug)}"],`).join("\n");
  await writeFile(join(OUT, "..", "..", "docs-src", ".sitemap-triples.txt"), triples + "\n");

  const bytes = JSON.stringify(index).length;
  console.log(`docs: ${pages.length} pages → web/public/docs/`);
  console.log(`      search index ${(bytes / 1024).toFixed(1)} kB · ${SITE}/docs`);
}

main().catch((e) => { console.error("docs build failed:", e.message); process.exit(1); });
