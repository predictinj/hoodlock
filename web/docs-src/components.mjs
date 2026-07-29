/* Authoring helpers.
 *
 * Pages are plain modules that call these, so the markup for a callout or a
 * code block is defined once here rather than copy-pasted per page. That is the
 * whole reason this build exists: the blog ships the same stylesheet duplicated
 * across 35 files, and this section must not repeat that.
 */

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Heading ids are derived from the text so the TOC, anchors and deep links agree. */
export const slugify = (s) =>
  String(s).toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "")
    .trim().replace(/\s+/g, "-").slice(0, 60);

export const h2 = (text, id = slugify(text)) =>
  `<h2 id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h2>`;

export const h3 = (text, id = slugify(text)) =>
  `<h3 id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h3>`;

export const p = (...parts) => `<p>${parts.join(" ")}</p>`;

export const lede = (text) => `<p class="lede">${text}</p>`;

export const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

export const ol = (items) => `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;

/** Numbered steps with an optional bold lead-in: ["**Open the app.** Then…"] */
export const steps = (items) =>
  `<ol class="steps">${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;

export const box = (html) => `<div class="box">${html}</div>`;

const CALLOUTS = {
  info: { cls: "callout-info", label: "Note" },
  warn: { cls: "callout-warn", label: "Careful" },
  danger: { cls: "callout-danger", label: "Irreversible" },
};

/** callout("warn", "…") or callout("warn", "…", "Custom label") */
export const callout = (kind, html, label) => {
  const c = CALLOUTS[kind] || CALLOUTS.info;
  const body = html.trim().startsWith("<") ? html : `<p>${html}</p>`;
  return `<div class="callout ${c.cls}"><div class="ct">${esc(label || c.label)}</div>${body}</div>`;
};

export const info = (html) => callout("info", html);
export const warn = (html) => callout("warn", html);
export const danger = (html) => callout("danger", html);

/** Code block with a copy button. `lang` is a label only. No highlighting. */
export const code = (source, lang = "") =>
  `<div class="codewrap">${lang ? `<span class="lang">${esc(lang)}</span>` : ""}` +
  `<button class="copy" type="button" data-copy aria-label="Copy code to clipboard">Copy</button>` +
  `<pre><code>${esc(source.replace(/^\n/, "").replace(/\s+$/, ""))}</code></pre></div>`;

/** table([["Field","Type"]], [["key","string"]]) — wrapped so wide tables scroll, not the page. */
export const table = (head, rows) =>
  `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
  `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

/** Card grid for hub pages. items: [{href, title, desc}] */
export const cards = (items) =>
  `<div class="grid">${items.map((i) =>
    `<a class="cardlink" href="${i.href}"><h3>${i.title}</h3><p>${i.desc}</p></a>`).join("")}</div>`;

export const cta = (heading, body, href = "/app/locks", label = "Open HoodLock →") =>
  `<div class="cta-box"><h2>${heading}</h2><p>${body}</p><a class="btn" href="${href}">${label}</a></div>`;

/* Shortcuts for the links these pages make constantly. Keeping them here means a
   path change is one edit rather than thirty. */
export const doc = (slug, text) => `<a href="/docs/${slug}">${text}</a>`;
export const blog = (slug, text) => `<a href="/blog/${slug}">${text}</a>`;
export const app = (path, text) => `<a href="/app/${path}">${text}</a>`;
