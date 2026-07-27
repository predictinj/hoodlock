/* Per-token pages.
 *
 * The chain mints on the order of tens of thousands of tokens a day, almost
 * all of which die within hours, so there is no page-per-token here — only
 * tokens that cleared a quality gate get one. This module assembles the data
 * and renders it; the gate and the sitemap wiring live with the caller.
 *
 * Every stated fact carries the time it was read. A page that says "no lock
 * found" without a timestamp becomes false the moment someone locks, and a
 * search snippet can lag the page by weeks — "as of <time>" stays true.
 */

const BS_UA = { "User-Agent": "Mozilla/5.0 (compatible; HoodLock/1.0)" };
const DEXS = "https://api.dexscreener.com/latest/dex/tokens";

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const nf = (n) => Number(n).toLocaleString("en-US");
const isBurnAddr = (a) => /^0x0{40}$/i.test(a || "") || /dead$/i.test(a || "");

function fmtUnits(v, dec) {
  const s = (BigInt(v) / 10n ** BigInt(dec)).toString();
  return nf(s);
}
function pctOf(part, total) {
  if (!total || total === 0n) return null;
  return (Number((BigInt(part) * 10000n) / BigInt(total)) / 100).toFixed(2);
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

async function j(url, opts) {
  const r = await fetch(url, { headers: BS_UA, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/**
 * Everything a token page shows, read live. Returns null when the token
 * doesn't look like an ERC-20 we can describe.
 */
export async function tokenData({ address, explorer, pub, contracts, abis }) {
  const addr = String(address).toLowerCase();
  const [meta, counters, holders, verified, dex] = await Promise.all([
    j(`${explorer}/api/v2/tokens/${addr}`).catch(() => null),
    j(`${explorer}/api/v2/tokens/${addr}/counters`).catch(() => null),
    j(`${explorer}/api/v2/tokens/${addr}/holders`).catch(() => null),
    j(`${explorer}/api/v2/smart-contracts/${addr}`).catch(() => null),
    j(`${DEXS}/${addr}`).catch(() => null),
  ]);
  if (!meta || !meta.symbol) return null;

  const dec = Number(meta.decimals || 18);
  const supply = BigInt(meta.total_supply || "0");

  // Holder concentration, with the addresses that are *supposed* to hold a lot
  // taken out — without this every token looks dangerous.
  const items = (holders && holders.items) || [];
  const burnedHeld = items.filter((h) => isBurnAddr(h.address?.hash)).reduce((s, h) => s + BigInt(h.value || 0), 0n);
  const wallets = items.filter((h) => !h.address?.is_contract && !isBurnAddr(h.address?.hash));
  const top10 = wallets.slice(0, 10).reduce((s, h) => s + BigInt(h.value || 0), 0n);

  // Deepest pair, which is the only one worth quoting a price from.
  const pairs = (dex && dex.pairs) || [];
  const pair = pairs.length
    ? pairs.reduce((a, b) => (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a))
    : null;

  // HoodLock's own records. These are the only claims we can make with
  // authority, and the only ones the page states without hedging.
  const recs = { locks: [], burns: [], vesting: [] };
  const { LOCKER, BURNER, VESTING } = contracts;
  const scan = async (target, abi, counter, getter, pick) => {
    if (!target) return [];
    const n = Number(await pub.readContract({ address: target, abi, functionName: counter }).catch(() => 0));
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = await pub.readContract({ address: target, abi, functionName: getter, args: [BigInt(i)] }).catch(() => null);
      const hit = r && pick(r, i);
      if (hit) out.push(hit);
    }
    return out;
  };
  recs.locks = await scan(LOCKER, abis.locker, "totalLocks", "locks", (r, i) =>
    String(r[1]).toLowerCase() === addr ? { id: i, amount: r[2], unlock: Number(r[3]), withdrawn: r[4] } : null);
  recs.burns = await scan(BURNER, abis.burner, "totalBurns", "getBurn", (r, i) =>
    String(r.token ?? r[1]).toLowerCase() === addr ? { id: i, amount: r.amount ?? r[2], ts: Number(r.timestamp ?? r[3]) } : null);
  recs.vesting = await scan(VESTING, abis.vesting, "totalSchedules", "getSchedule", (r, i) =>
    String(r.token ?? r[0]).toLowerCase() === addr
      ? { id: i, total: r.total ?? r[2], claimed: r.claimed ?? r[3], end: Number(r.end ?? r[6]) } : null);

  const now = Math.floor(Date.now() / 1000);
  const activeLocks = recs.locks.filter((l) => !l.withdrawn && l.unlock > now);

  return {
    address: meta.address || address,
    name: meta.name || meta.symbol,
    symbol: meta.symbol,
    decimals: dec,
    supply,
    holders: Number(counters?.token_holders_count || meta.holders_count || 0),
    transfers: Number(counters?.transfers_count || 0),
    verified: verified ? verified.is_verified === true : null,
    priceUsd: pair ? Number(pair.priceUsd || 0) : (Number(meta.exchange_rate) || 0),
    marketCap: Number(pair?.marketCap || meta.circulating_market_cap || 0),
    liquidityUsd: Number(pair?.liquidity?.usd || 0),
    volume24: Number(pair?.volume?.h24 || 0),
    buys24: Number(pair?.txns?.h24?.buys || 0),
    sells24: Number(pair?.txns?.h24?.sells || 0),
    pairCreatedAt: pair?.pairCreatedAt ? Math.floor(pair.pairCreatedAt / 1000) : null,
    dexUrl: pair?.url || null,
    logo: pair?.info?.imageUrl || null,
    website: pair?.info?.websites?.[0]?.url || null,
    twitter: (pair?.info?.socials || []).find((s) => s.type === "twitter")?.url || null,
    topWalletsPct: pctOf(top10, supply),
    burnAddrPct: pctOf(burnedHeld, supply),
    recs,
    activeLocks,
    checkedAt: new Date(),
  };
}

/* ---------- copy generated from the data ---------- */

/** The sentence someone searched for, answered first. */
function verdictLine(d) {
  const bits = [];
  if (d.activeLocks.length) bits.push(`${d.activeLocks.length} active HoodLock lock${d.activeLocks.length > 1 ? "s" : ""}`);
  else if (d.recs.locks.length) bits.push("past locks only — none currently active");
  else bits.push("no HoodLock lock found");
  if (d.recs.vesting.length) bits.push(`${d.recs.vesting.length} vesting schedule${d.recs.vesting.length > 1 ? "s" : ""}`);
  if (d.recs.burns.length) bits.push(`${d.recs.burns.length} recorded burn${d.recs.burns.length > 1 ? "s" : ""}`);
  return bits.join(" · ");
}

/** Prose that differs per token rather than one template with the numbers swapped. */
function summary(d) {
  const s = [];
  s.push(`$${esc(d.symbol)} has ${nf(d.holders)} holders on Robinhood Chain and a total supply of ${fmtUnits(d.supply, d.decimals)}.`);
  if (d.burnAddrPct && Number(d.burnAddrPct) > 0.5) {
    s.push(`${d.burnAddrPct}% of that supply sits at burn addresses and can never move again.`);
  }
  if (d.topWalletsPct != null) {
    const p = Number(d.topWalletsPct);
    s.push(p > 40
      ? `The ten largest ordinary wallets hold ${d.topWalletsPct}% between them, which is concentrated enough that a few holders set the price.`
      : p > 20
        ? `The ten largest ordinary wallets hold ${d.topWalletsPct}%, which is normal for a young token but worth watching.`
        : `The ten largest ordinary wallets hold ${d.topWalletsPct}%, so supply is reasonably spread.`);
    s.push(`Contracts, pools and burn addresses are excluded from that figure — they hold large balances by design.`);
  }
  if (d.verified === false) s.push(`The contract source is <b>not verified</b>, so nothing about its behaviour can be checked independently.`);
  else if (d.verified) s.push(`The contract source is verified, so its behaviour can be read directly.`);
  if (d.activeLocks.length) {
    const soonest = d.activeLocks.reduce((a, b) => (b.unlock < a.unlock ? b : a));
    s.push(`The earliest of its active locks unlocks on ${day(soonest.unlock)}.`);
  }
  return s.join(" ");
}

function faqs(d) {
  const t = `$${d.symbol}`;
  const stamp = d.checkedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const out = [
    [`Is ${t} liquidity locked?`,
     d.activeLocks.length
       ? `${t} has ${d.activeLocks.length} active lock recorded on HoodLock as of ${stamp}. Open the proof page to see the amount and unlock date read live from the chain.`
       : `No HoodLock lock was found for ${t} as of ${stamp}. That covers HoodLock's own locker only — the tokens may be locked with another service, or the liquidity may be burned, so check the LP token's holder list before concluding anything.`],
    [`How many holders does ${t} have?`,
     `${nf(d.holders)} addresses hold ${t} on Robinhood Chain, across ${nf(d.transfers)} transfers, as of ${stamp}.`],
    [`Is the ${t} contract verified?`,
     d.verified
       ? `Yes. The source code is verified on Blockscout, which means the readable code provably matches the bytecode deployed on-chain.`
       : `No. The source is not verified on Blockscout, so the transfer logic, supply cap and owner privileges cannot be checked by anyone outside the team.`],
  ];
  if (d.recs.vesting.length) {
    out.push([`Does ${t} have token vesting?`,
      `Yes — ${d.recs.vesting.length} vesting schedule${d.recs.vesting.length > 1 ? "s are" : " is"} recorded on HoodLock for ${t}. Vesting schedules created on HoodLock are irrevocable and cannot be cancelled or edited.`]);
  }
  return out;
}

/* ---------- rendering ---------- */

export function renderTokenPage(d, { site = "https://hoodlock.tech", slug, noindex = false } = {}) {
  const url = `${site}/token/${slug}`;
  const stampIso = d.checkedAt.toISOString();
  const stamp = stampIso.slice(0, 16).replace("T", " ") + " UTC";
  const title = `${esc(d.symbol)} Token — Locks, Burns & Holder Breakdown | Robinhood Chain`;
  // The description carries the answer, not an invitation — that is what wins
  // the click when this sits next to five other results.
  const desc = [
    `${nf(d.holders)} holders`,
    d.burnAddrPct && Number(d.burnAddrPct) > 0.5 ? `${d.burnAddrPct}% of supply burned` : null,
    verdictLine(d),
    d.verified === false ? "contract NOT verified" : d.verified ? "contract verified" : null,
  ].filter(Boolean).join(" · ") + `. Checked live on Robinhood Chain.`;

  const rows = [
    ["Holders", nf(d.holders)],
    ["Transfers", nf(d.transfers)],
    ["Total supply", fmtUnits(d.supply, d.decimals)],
    d.priceUsd ? ["Price", `$${d.priceUsd < 0.01 ? d.priceUsd.toPrecision(3) : d.priceUsd.toFixed(4)}`] : null,
    d.marketCap ? ["Market cap", `$${nf(Math.round(d.marketCap))}`] : null,
    d.liquidityUsd ? ["Liquidity", `$${nf(Math.round(d.liquidityUsd))}`] : null,
    d.volume24 ? ["Volume 24h", `$${nf(Math.round(d.volume24))}`] : null,
    d.buys24 || d.sells24 ? ["Trades 24h", `${nf(d.buys24)} buys · ${nf(d.sells24)} sells`] : null,
    ["Contract source", d.verified === false ? `<span class="bad">not verified</span>` : d.verified ? `verified` : "unknown"],
    d.topWalletsPct != null ? ["Top 10 wallets", `${d.topWalletsPct}% <span class="dim">contracts &amp; burn addresses excluded</span>`] : null,
    d.burnAddrPct != null ? ["At burn addresses", `${d.burnAddrPct}%`] : null,
    d.pairCreatedAt ? ["Pair created", day(d.pairCreatedAt)] : null,
  ].filter(Boolean);

  const recRow = (label, list, kind, fmt) => `<tr><td>${label}</td><td>${
    list.length
      ? list.map((r) => `<a href="${site}/proof/${kind}/${r.id}">#${r.id}</a> ${fmt(r)}`).join("<br>")
      : `<span class="dim">none found as of ${esc(stamp)}</span>`
  }</td></tr>`;

  const faqList = faqs(d);
  const ld = [
    { "@context": "https://schema.org", "@type": "WebPage", name: title, description: desc, url,
      dateModified: stampIso,
      isPartOf: { "@type": "WebSite", name: "HoodLock", url: `${site}/` } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "HoodLock", item: `${site}/` },
      { "@type": "ListItem", position: 2, name: "Tokens", item: `${site}/app/explore` },
      { "@type": "ListItem", position: 3, name: `$${d.symbol}`, item: url },
    ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqList.map(([q, a]) => ({
      "@type": "Question", name: q,
      acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") },
    })) },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:site_name" content="HoodLock"><meta property="og:type" content="website">
<meta property="og:title" content="${title}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.ico" sizes="any">
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("")}
<style>
:root{--bg:#050807;--card:#0a0f0c;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--neon:#00e05a;--red:#ff6b6b;--amber:#f5b731;--ink:#eef4ef;--ink2:#8fa396;--ink3:#59695e;
--sans:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.7}
a{color:var(--neon);text-decoration:none}a:hover{text-decoration:underline}
.nav{display:flex;align-items:center;justify-content:space-between;max-width:880px;margin:0 auto;padding:20px 22px}
.nav .logo{font-weight:700;font-size:16px;color:var(--ink);letter-spacing:-.03em}.nav .logo b{color:var(--neon)}
.nav .cta{background:var(--neon);color:#03130a;font-weight:600;font-size:13px;border-radius:9px;padding:8px 16px}
.nav .cta:hover{text-decoration:none;filter:brightness(1.1)}
main{max-width:880px;margin:0 auto;padding:26px 22px 80px}
.crumb{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);margin-bottom:20px}
.crumb a{color:var(--ink3)}
.head{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.ico{width:52px;height:52px;border-radius:50%;object-fit:cover;border:1px solid var(--line2);background:var(--card);flex:none}
.ico-fb{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:#12351f;color:var(--neon);
  font-weight:700;font-size:18px;border:1px solid var(--line2);flex:none}
h1{font-size:30px;line-height:1.15;letter-spacing:-.03em}
h1 .sym{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--neon)}
.addr{font-family:var(--mono);font-size:11.5px;color:var(--ink3);word-break:break-all;margin-top:2px}
.verdict{margin:22px 0 6px;padding:18px 20px;border-radius:14px;border:1px solid var(--line2);background:var(--card)}
.verdict .q{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3)}
.verdict .a{font-size:20px;font-weight:600;letter-spacing:-.02em;margin-top:6px}
.verdict .a.ok{color:var(--neon)}.verdict .a.none{color:var(--ink)}
.stamp{font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-top:8px}
h2{font-size:19px;letter-spacing:-.02em;margin:34px 0 10px}
h3{font-size:15.5px;margin:22px 0 6px}
p,li{color:var(--ink2);font-size:15px}p{margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:8px 0 4px}
td{border-top:1px solid var(--line);padding:11px 4px;color:var(--ink2);vertical-align:top}
td:first-child{color:var(--ink3);width:38%}
td:last-child{color:var(--ink);text-align:right}
.dim{color:var(--ink3);font-size:12.5px}
.bad{color:var(--red)}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.links a{border:1px solid var(--line2);border-radius:999px;padding:7px 15px;font-size:13px;color:var(--ink2)}
.links a:hover{text-decoration:none;color:var(--ink);border-color:rgba(255,255,255,.3)}
.cta-box{background:var(--card);border:1px solid rgba(0,224,90,.3);border-radius:16px;padding:24px;text-align:center;margin-top:40px}
.cta-box .btn{display:inline-block;background:var(--neon);color:#03130a;font-weight:700;border-radius:10px;padding:11px 24px;margin-top:10px}
.cta-box .btn:hover{text-decoration:none;filter:brightness(1.1)}
.note{font-size:12.5px;color:var(--ink3);border-top:1px solid var(--line);margin-top:34px;padding-top:16px}
footer{border-top:1px solid var(--line);margin-top:50px;padding:24px 22px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--ink3);letter-spacing:.08em}
@media(max-width:520px){h1{font-size:24px}td:first-child{width:46%}}
</style>
</head>
<body>
<nav class="nav"><a class="logo" href="/">Hood<b>Lock</b></a><a class="cta" href="/app">Launch App</a></nav>
<main>
<div class="crumb"><a href="/">HOODLOCK</a> / <a href="/app/explore">TOKENS</a> / $${esc(d.symbol)}</div>

<div class="head">
  ${d.logo ? `<img class="ico" src="${esc(d.logo)}" alt="${esc(d.symbol)} logo" width="52" height="52" loading="eager">`
           : `<div class="ico-fb">${esc(d.symbol.slice(0, 2).toUpperCase())}</div>`}
  <div>
    <h1>${esc(d.name)} <span class="sym">$${esc(d.symbol)}</span></h1>
    <div class="addr">${esc(d.address)}</div>
  </div>
</div>

<div class="verdict">
  <div class="q">Is $${esc(d.symbol)} locked?</div>
  <div class="a ${d.activeLocks.length ? "ok" : "none"}">${esc(verdictLine(d))}</div>
  <div class="stamp">as of ${esc(stamp)} · read live from Robinhood Chain</div>
</div>

<h2>What the chain says</h2>
<p>${summary(d)}</p>

<table>
${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("\n")}
</table>

<h2>HoodLock records</h2>
<table>
${recRow("Locks", d.recs.locks, "lock", (r) => `${fmtUnits(r.amount, d.decimals)} $${esc(d.symbol)} until ${day(r.unlock)}${r.withdrawn ? " (withdrawn)" : ""}`)}
${recRow("Burns", d.recs.burns, "burn", (r) => `${fmtUnits(r.amount, d.decimals)} $${esc(d.symbol)} on ${day(r.ts)}`)}
${recRow("Vesting", d.recs.vesting, "vesting", (r) => `${fmtUnits(r.total, d.decimals)} $${esc(d.symbol)} until ${day(r.end)}`)}
</table>
<p class="dim">These cover HoodLock's own contracts only. Tokens may also be locked elsewhere or liquidity burned directly — <a href="/blog/how-to-check-if-liquidity-is-locked">how to check the rest</a>.</p>

<div class="links">
  <a href="https://robinhoodchain.blockscout.com/token/${esc(d.address)}" target="_blank" rel="noopener">Contract on Blockscout ↗</a>
  ${d.dexUrl ? `<a href="${esc(d.dexUrl)}" target="_blank" rel="noopener">Chart ↗</a>` : ""}
  ${d.website ? `<a href="${esc(d.website)}" target="_blank" rel="noopener">Project site ↗</a>` : ""}
  ${d.twitter ? `<a href="${esc(d.twitter)}" target="_blank" rel="noopener">X ↗</a>` : ""}
</div>

<h2>Common questions</h2>
${faqList.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${a}</p>`).join("\n")}

<div class="cta-box">
  <h2 style="margin-top:0">${d.activeLocks.length ? `Verify the $${esc(d.symbol)} lock yourself` : `Is this your project?`}</h2>
  <p>${d.activeLocks.length
      ? `Every HoodLock position has a permanent proof page that reads live from the chain — no wallet needed.`
      : `Lock tokens, vest a team allocation or burn supply on Robinhood Chain, and get a proof link holders can check.`}</p>
  <a class="btn" href="${d.activeLocks.length ? `/proof/lock/${d.activeLocks[0].id}` : "/app/locks"}">${d.activeLocks.length ? "Open proof page →" : "Start locking →"}</a>
</div>

<div class="note">HoodLock reads this page from Robinhood Chain each time it is refreshed. Figures describe the chain at ${esc(stamp)} and are not financial advice. HoodLock is not affiliated with Robinhood Markets, Inc.</div>
</main>
<footer>© 2026 HOODLOCK · ROBINHOOD CHAIN · <a href="/">hoodlock.tech</a></footer>
</body>
</html>`;
}
