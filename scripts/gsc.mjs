/**
 * Search Console, read only.
 *
 * Signs a JWT with the service account key, swaps it for an access token, and
 * calls the API directly. No client library, because the whole exchange is
 * forty lines and a dependency here would be a dependency in the deploy image
 * too.
 *
 * The key is read from ~/.config/hoodlock/gsc.json and never printed. It is
 * deliberately outside the repository, which is public.
 *
 * Usage:
 *   node scripts/gsc.mjs sites
 *   node scripts/gsc.mjs perf  <siteUrl> [days]
 *   node scripts/gsc.mjs pages <siteUrl>
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_PATH = process.env.GSC_KEY || join(homedir(), ".config", "hoodlock", "gsc.json");
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
  .toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function token() {
  const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: key.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claim)}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function api(path, tok, body) {
  const r = await fetch(`https://searchconsole.googleapis.com${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

const [cmd, site, daysArg] = process.argv.slice(2);
const tok = await token();

if (!cmd || cmd === "sites") {
  const j = await api("/webmasters/v3/sites", tok);
  const list = j.siteEntry || [];
  if (!list.length) {
    console.log("  No properties. The service account is authenticated but has not been added");
    console.log("  as a user on any Search Console property yet.");
  }
  for (const s of list) console.log(`  ${s.permissionLevel.padEnd(18)} ${s.siteUrl}`);
} else if (cmd === "perf") {
  const days = Number(daysArg || 90);
  const end = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);   // GSC lags ~2 days
  const start = new Date(Date.now() - (days + 2) * 86400e3).toISOString().slice(0, 10);
  const totals = await api(`/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, tok,
    { startDate: start, endDate: end, dimensions: [], rowLimit: 1 });
  const t = totals.rows?.[0];
  console.log(`  ${start} to ${end}`);
  console.log(t ? `  clicks ${t.clicks}   impressions ${t.impressions}   ctr ${(t.ctr * 100).toFixed(2)}%   avg position ${t.position.toFixed(1)}`
                : "  no data in this window");

  for (const dim of ["query", "page"]) {
    const j = await api(`/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, tok,
      { startDate: start, endDate: end, dimensions: [dim], rowLimit: 25 });
    console.log(`\n  top ${dim}s`);
    if (!j.rows?.length) { console.log("    (none)"); continue; }
    for (const r of j.rows) {
      console.log(`    ${String(r.impressions).padStart(6)} imp  ${String(r.clicks).padStart(4)} clk  pos ${r.position.toFixed(1).padStart(5)}  ${r.keys[0]}`);
    }
  }
} else if (cmd === "inspect") {
  /* The sitemap API's "indexed" count is unreliable and reports zero far more
     often than it is true, so ask about specific URLs instead. This is the only
     call that answers "is this page in the index" rather than implying it. */
  const urls = process.argv.slice(4);
  for (const u of urls) {
    try {
      const j = await api("/v1/urlInspection/index:inspect", tok,
        { inspectionUrl: u, siteUrl: site });
      const r = j.inspectionResult?.indexStatusResult || {};
      console.log(`  ${(r.verdict || "?").padEnd(8)} ${(r.coverageState || "").slice(0, 46).padEnd(48)} ${u.replace("https://hoodlock.tech", "")}`);
    } catch (e) {
      console.log(`  ERROR    ${String(e.message).slice(0, 60).padEnd(48)} ${u.replace("https://hoodlock.tech", "")}`);
    }
  }
} else if (cmd === "pages") {
  const j = await api(`/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`, tok);
  console.log("  sitemaps");
  for (const s of j.sitemap || []) {
    const w = (s.warnings ?? 0), e = (s.errors ?? 0);
    console.log(`    ${s.path}\n      submitted ${s.lastSubmitted?.slice(0, 10) ?? "?"}  downloaded ${s.lastDownloaded?.slice(0, 10) ?? "never"}  warnings ${w}  errors ${e}`);
    for (const c of s.contents || []) console.log(`      ${c.type}: ${c.submitted} submitted, ${c.indexed ?? "?"} indexed`);
  }
  if (!(j.sitemap || []).length) console.log("    (none submitted)");
}
