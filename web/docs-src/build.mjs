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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render, extractToc } from "./layout.mjs";
import { PAGES, SECTIONS, priorityFor, SITE } from "./nav.mjs";

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

/* The dynamic /sitemap.xml falls back to this file whenever the chain reads it
 * needs exceed their 8s deadline. It had drifted 33 URLs behind, which means a
 * crawler arriving during a slow moment saw a sitemap missing most of the site.
 *
 * Rather than maintaining it by hand, derive it from the same `statics` array
 * the live route uses. It cannot go stale again without the build going stale
 * too, and the build is what Docker runs.
 */
async function writeStaticSitemap() {
  const server = join(HERE, "..", "..", "server", "index.mjs");
  if (!existsSync(server)) return;
  const src = await readFile(server, "utf8");
  const block = /const statics = \[([\s\S]*?)\n    \];/.exec(src);
  if (!block) { console.log("  note: could not read statics[] — sitemap fallback left alone"); return; }

  const rows = [...block[1].matchAll(/\["([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\]/g)]
    .map(([, path, changefreq, priority]) => ({ path, changefreq, priority }));
  if (!rows.length) return;

  /* No <lastmod>. It is optional in the protocol, and stamping today's date here
     would make the build non-deterministic: the same source would produce a
     different file tomorrow, leaving the working tree permanently dirty and
     making the idempotency check that guards this whole section meaningless.
     The live sitemap carries real per-URL dates; this fallback only needs to
     list the URLs. */
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Fallback only, served when the live sitemap's chain reads time out. It\n` +
    `     omits <lastmod> deliberately so this file is byte-stable; the live route\n` +
    `     supplies dates and also lists proof and token pages.\n` +
    `     Regenerated by web/docs-src/build.mjs — do not edit by hand. -->\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    rows.map((r) =>
      `  <url><loc>${SITE}${r.path}</loc>` +
      `<changefreq>${r.changefreq}</changefreq><priority>${r.priority}</priority></url>`).join("\n") +
    `\n</urlset>\n`;
  await writeFile(join(HERE, "..", "public", "sitemap.xml"), xml);
  console.log(`      static sitemap fallback: ${rows.length} URLs`);
}

/* llms.txt — a curated map for AI crawlers, per the llmstxt.org convention.
 *
 * Deliberately not a sitemap dump: the value is in the short descriptions and in
 * the facts block, which lets a model answer "what is the fee" or "what is the
 * locker address" without fetching anything. Generated from nav.mjs and the page
 * files so it cannot drift from the pages it describes.
 *
 * Worth being clear-eyed: the convention is not standardised and no engine has
 * committed to reading it. It costs nothing and cannot hurt; it is not a ranking
 * mechanism.
 */
async function writeLlmsTxt(pages) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const line = (slug) => {
    const p = bySlug.get(slug);
    return p ? `- [${p.navTitle}](${SITE}/docs/${slug}): ${p.desc}` : null;
  };

  const sections = SECTIONS.map((s) => {
    const items = s.items.map((i) => line(i.slug)).filter(Boolean);
    return items.length ? `## ${s.title}\n\n${items.join("\n")}` : null;
  }).filter(Boolean);

  // Blog titles and descriptions, read from the published pages themselves.
  const blogDir = join(HERE, "..", "public", "blog");
  let blog = "";
  if (existsSync(blogDir)) {
    const rows = [];
    for (const f of (await readdir(blogDir)).filter((f) => f.endsWith(".html") && f !== "index.html").sort()) {
      const html = await readFile(join(blogDir, f), "utf8");
      const t = /<h1>([\s\S]*?)<\/h1>/.exec(html);
      const d = /<meta name="description" content="([^"]*)"/.exec(html);
      if (t && d) {
        rows.push(`- [${strip(t[1]).replace(/\.$/, "")}](${SITE}/blog/${f.replace(/\.html$/, "")}): ${d[1]}`);
      }
    }
    if (rows.length) blog = `## Learn (background articles)\n\n${rows.join("\n")}`;
  }

  const out = `# HoodLock

> Non-custodial token locker, burner and vesting platform on Robinhood Chain
> (an Ethereum L2 on the Arbitrum stack, chain id 4663). Locks ERC-20 tokens
> until a date, sends tokens to the dead address with an auditable record, or
> releases them linearly to a beneficiary. Every record gets a public proof page
> that reads live from the chain and opens without a wallet.

HoodLock is not affiliated with Robinhood Markets, Inc.

## Key facts

- Chain: Robinhood Chain, id 4663. RPC https://rpc.mainnet.chain.robinhood.com, explorer https://robinhoodchain.blockscout.com
- Locker contract: 0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f
- Burner contract: 0x6bf43ca706faa8ea46803299c191484e82280652
- Vesting contract: 0x910e19bcC4bce46999994Ed7297E0Fc4431ec72E
- Fee: a flat 0.005 ETH per lock, burn or vesting schedule, read live from each contract. No percentage of tokens is ever taken. Withdrawing, claiming and extending are free.
- Unlock dates can be extended but never shortened. No admin function can move a user's locked tokens.
- Vesting schedules cannot be cancelled or edited by any HoodLock function. Hard fee cap 0.05 ETH, minimum duration 24 hours, batch limit 200.
- What can be locked: any ERC-20, including v2-style LP tokens. Uniswap v3 and v4 positions are NFTs and cannot be locked.
- All three contracts are verified on Blockscout, so the published source is the bytecode that runs.
- Scope of the guarantees: they describe HoodLock's own functions. A token that is mintable, upgradeable, pausable or that can blacklist an address can still undo or freeze what a lock, burn or schedule appears to promise.

## Tools

Each takes a token contract address and answers one question from the chain,
server-rendered, no wallet and no JavaScript required. A result reflects
HoodLock's own contracts only — an empty result means "no record with HoodLock",
not "no record anywhere".

- [Token lock checker](${SITE}/lock-checker): every lock HoodLock holds on a token — amount, unlock date, proof link
- [Token burn checker](${SITE}/burn-checker): every burn sent through HoodLock for a token — amount, date, proof link
- [Token vesting checker](${SITE}/vesting-checker): every vesting schedule on a token — total, cliff, end date, proof link
- [Lock explorer](${SITE}/app/explore): every lock, burn and schedule across the chain
- Token pages at ${SITE}/token/<address> carry the same records plus holders, supply and liquidity.

${sections.join("\n\n")}

${blog}

## Notes for retrieval

- All pages under /docs, /blog, /token and /proof are static server-rendered HTML and need no JavaScript.
- Pages under /app are an application shell; the useful content is on the pages above.
- ${SITE}/docs/faq answers 62 common questions with the full answer visible in the page text.
- Sitemap: ${SITE}/sitemap.xml
`;
  await writeFile(join(HERE, "..", "public", "llms.txt"), out);
  console.log(`      llms.txt: ${(out.length / 1024).toFixed(1)} kB`);
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

  /* Content-hash the stylesheet and runtime so they can be cached for a year
   * instead of revalidated on every page. A docs site is many small documents;
   * two conditional requests per navigation is a cost worth removing. */
  const hash = (s) => createHash("sha256").update(s).digest("base64url").slice(0, 8);
  const css = await readFile(join(HERE, "styles.css"), "utf8");
  const js = await readFile(join(HERE, "runtime.js"), "utf8");
  const assets = { css: `docs-${hash(css)}.css`, js: `docs-${hash(js)}.js` };
  await writeFile(join(OUT, assets.css), css);
  await writeFile(join(OUT, assets.js), js);

  const index = [];
  for (const p of pages) {
    const html = render(p, assets);
    const file = p.slug ? `${p.slug}.html` : "index.html";
    await writeFile(join(OUT, file), html);
    index.push({
      url: p.slug ? `/docs/${p.slug}` : "/docs",
      title: p.navTitle || strip(p.h1),
      desc: p.desc,
      headings: extractToc(p.body).map((t) => t.text).join(" · "),
    });
  }

  await writeFile(join(OUT, "search.json"), JSON.stringify(index));

  // Sitemap triples, pasted into server/index.mjs — printed so the two stay in step.
  const triples = pages.map((p) =>
    `      ["/docs${p.slug ? "/" + p.slug : ""}", "monthly", "${priorityFor(p.slug)}"],`).join("\n");
  await writeFile(join(OUT, "..", "..", "docs-src", ".sitemap-triples.txt"), triples + "\n");

  await writeStaticSitemap();
  await writeLlmsTxt(pages);

  const bytes = JSON.stringify(index).length;
  console.log(`docs: ${pages.length} pages → web/public/docs/`);
  console.log(`      search index ${(bytes / 1024).toFixed(1)} kB · ${SITE}/docs`);
}

main().catch((e) => { console.error("docs build failed:", e.message); process.exit(1); });
