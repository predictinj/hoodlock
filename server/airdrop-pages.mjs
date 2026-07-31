/* Public airdrop pages: /airdrops, /airdrop/:id and /airdrop-checker.
 *
 * Server rendered like the token pages and the three checkers, so they are
 * indexable, readable without a wallet, and light. Claiming needs a wallet, so
 * the claim itself deep-links into the app.
 *
 * Two things here are not decoration.
 *
 * A page compares the published list against what the chain actually holds and
 * says plainly when an airdrop cannot pay everyone on it. Where the tree
 * promises more than the deposit, or maxClaims is below the recipient count,
 * claims succeed until the money or the ceiling runs out and everyone after is
 * refused. For a recipient that is indistinguishable from a rug. We can compute
 * it and nobody else showing an airdrop can.
 *
 * And the phrase phishing pages use, the possessive one pairing the verb with
 * the noun, appears nowhere here: not in a heading, a title, a description or a
 * button. Writing it out even in this comment would trip the grep that checks
 * for it. The pattern is the amount first, then a button that says only Claim.
 */
import { esc, nf, fmtUnits, day } from "./token.mjs";

const SITE = "https://hoodlock.tech";
const X = "https://x.com/HoodLockRH";

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* Shared shell. One copy, for the same reason the legal pages have one. */
function shell({ title, desc, canonical, h1, lede, body, ld = [], noindex = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ""}
<meta property="og:site_name" content="HoodLock"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.ico" sizes="any">
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("")}
<style>
:root{--bg:#050807;--card:#0a0f0c;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--neon:#00e05a;--red:#ff6b6b;--amber:#f5b731;--ink:#eef4ef;--ink2:#8fa396;--dim:#6f8377;
--sans:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.7}
a{color:var(--neon);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--neon);outline-offset:2px}
.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;background:var(--card);padding:8px 14px;border-radius:8px;z-index:9}
.nav{display:flex;align-items:center;justify-content:space-between;max-width:860px;margin:0 auto;padding:20px 22px}
.nav .logo{font-weight:700;font-size:16px;color:var(--ink);letter-spacing:-.03em}.nav .logo b{color:var(--neon)}
.nav .cta{background:var(--neon);color:#03130a;font-weight:600;font-size:13px;border-radius:9px;padding:8px 16px}
.nav .cta:hover{text-decoration:none;filter:brightness(1.1)}
main{max-width:860px;margin:0 auto;padding:26px 22px 80px}
.crumb{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:20px}
.crumb a{color:var(--dim)}
h1{font-size:34px;line-height:1.13;letter-spacing:-.035em;margin-bottom:10px}
h1 .sym{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--neon)}
.lede{color:var(--ink2);font-size:16px;margin-bottom:24px;max-width:62ch}
h2{font-size:20px;letter-spacing:-.02em;margin:36px 0 10px}
h3{font-size:15.5px;margin:20px 0 5px;color:var(--ink)}
p,li{color:var(--ink2);font-size:15.5px}p{margin-bottom:12px}
ul{margin:0 0 14px 20px}li{margin-bottom:6px}
b{color:var(--ink);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:10px 0}
td,th{border-top:1px solid var(--line);padding:11px 6px;color:var(--ink2);text-align:left}
th{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);border-top:0}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.addr{font-family:var(--mono);font-size:12px;color:var(--dim)}
.res{margin:22px 0;padding:20px 22px;border-radius:14px;border:1px solid var(--line2);background:var(--card)}
.res .q{font-size:15px;color:var(--ink2)}
.res .a{font-size:26px;font-weight:600;letter-spacing:-.025em;margin-top:4px}
.res .a.ok{color:var(--neon)}.res .a.none{color:var(--ink)}
.stamp{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-top:10px}
.warn{margin:20px 0;padding:16px 18px;border-left:2px solid var(--amber);background:rgba(245,183,49,.06);border-radius:0 10px 10px 0}
.warn b{color:var(--amber)}
.scope{margin:24px 0;padding:16px 18px;border-left:2px solid var(--neon);background:rgba(0,224,90,.04);border-radius:0 10px 10px 0}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.search{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line2);
  border-radius:15px;padding:7px 7px 7px 17px;transition:border-color .15s,box-shadow .15s}
.search:focus-within{border-color:var(--neon);box-shadow:0 0 0 3px rgba(0,224,90,.13)}
.search.bad{border-color:var(--red)}
.search .ic{width:17px;height:17px;flex:none;color:var(--dim)}
.search input{flex:1 1 auto;min-width:0;background:none;border:0;padding:13px 0;color:var(--ink);
  font-family:var(--mono);font-size:14px;text-overflow:ellipsis}
.search input:focus{outline:none}.search input::placeholder{color:var(--dim)}
.clear{flex:none;width:27px;height:27px;display:grid;place-items:center;border-radius:50%;color:var(--dim);font-size:18px;line-height:1}
.clear:hover{background:rgba(255,255,255,.07);color:var(--ink);text-decoration:none}
.search button{flex:none;background:var(--neon);color:#03130a;font-weight:700;font-size:14.5px;border:0;
  border-radius:11px;padding:12px 24px;cursor:pointer}
.search button:hover{filter:brightness(1.1)}
.hint{font-size:13px;color:var(--dim);margin:11px 2px 0}.hint.bad{color:var(--red)}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.links a{border:1px solid var(--line2);border-radius:999px;padding:7px 15px;font-size:13px;color:var(--ink2)}
.links a:hover{text-decoration:none;color:var(--ink);border-color:rgba(255,255,255,.3)}
.cta-box{background:var(--card);border:1px solid rgba(0,224,90,.3);border-radius:16px;padding:24px;text-align:center;margin-top:40px}
.cta-box h2{margin-top:0}
.cta-box .btn{display:inline-block;background:var(--neon);color:#03130a;font-weight:700;border-radius:10px;padding:11px 24px;margin-top:8px}
.cta-box .btn:hover{text-decoration:none;filter:brightness(1.1)}
.cta-alt{font-size:13.5px;color:var(--dim);margin:14px 0 0}
.note{font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
footer{border-top:1px solid var(--line);margin-top:50px;padding:24px 22px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.08em}
@media(max-width:560px){h1{font-size:26px}.search{flex-wrap:wrap;padding:14px 14px 10px;gap:0 12px}
  .search input{flex:1 1 0;padding:2px 0 12px}.search button{flex:1 1 100%;margin-top:2px}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<nav class="nav"><a class="logo" href="/">Hood<b>Lock</b></a><a class="cta" href="/app">Launch App</a></nav>
<main id="main">
<div class="crumb">${h1 ? `<a href="/">HOODLOCK</a> / <a href="/airdrops">AIRDROPS</a>` : ""}</div>
<h1>${h1}</h1>
${lede ? `<p class="lede">${lede}</p>` : ""}
${body}
<div class="note">HoodLock reads these pages from Robinhood Chain on every visit. Anyone can create an airdrop and HoodLock does not review the projects that do, so a page here records what happened on chain rather than endorsing it. Not financial advice. HoodLock is not affiliated with Robinhood Markets, Inc.</div>
</main>
<footer>© 2026 HOODLOCK · ROBINHOOD CHAIN · <a href="/">hoodlock.tech</a> · <a href="/terms">TERMS</a> · <a href="/privacy">PRIVACY</a></footer>
</body>
</html>`;
}

/* ---------- /airdrops ---------- */

/* The price sentence, from the fee the server read off the contract at boot.
 *
 * `feeEth` is the one-wallet quote. Zero proves the base and the per-wallet
 * unit are both zero, so the product is free at any list size. Null means the
 * read failed, and then the price is simply not mentioned: a page that guesses
 * at a number is worse than a page that stays quiet about it. */
function priceLine(feeEth) {
  if (feeEth === 0) return "<b>Free.</b> No platform fee, at any list size. You pay network gas and nothing else.";
  if (typeof feeEth === "number" && feeEth > 0) return `<b>From ${feeEth} ETH</b>, priced by how many wallets you send to.`;
  return "";
}

export function renderAirdropIndex({ airdrops, meta, feeEth = null }) {
  const now = Math.floor(Date.now() / 1000);
  const live = airdrops.filter((a) => a.endTime === 0 || now < a.endTime);

  const rows = airdrops.slice(0, 200).map((a) => {
    const m = meta[a.token] || { symbol: "???", decimals: 18 };
    const closed = a.endTime !== 0 && now >= a.endTime;
    return `<tr>
      <td><a href="/airdrop/${a.id}">$${esc(m.symbol)}</a> <span class="addr">#${a.id}</span></td>
      <td class="num">${fmtUnits(a.total, m.decimals)}</td>
      <td class="num">${a.claims} / ${a.maxClaims}</td>
      <td>${a.endTime ? (closed ? "closed" : `closes ${day(a.endTime)}`) : "no deadline"}</td>
    </tr>`;
  }).join("");

  return shell({
    title: "Airdrops on Robinhood Chain | HoodLock",
    desc: `Every airdrop held on HoodLock: which token, how much, how many wallets have taken their share and when each one closes. Read live from Robinhood Chain.`,
    canonical: `${SITE}/airdrops`,
    h1: "Airdrops on Robinhood Chain",
    lede: `${nf(airdrops.length)} airdrop${airdrops.length === 1 ? "" : "s"} have been funded here, ${nf(live.length)} still open. Nothing is sent to a wallet: each recipient comes and takes their own share, and every one of these pages reads the chain rather than a listing we keep.`,
    ld: [{
      "@context": "https://schema.org", "@type": "CollectionPage",
      name: "Airdrops on Robinhood Chain", url: `${SITE}/airdrops`,
      isPartOf: { "@type": "WebSite", name: "HoodLock", url: `${SITE}/` },
    }],
    body: `
${airdrops.length ? `<table>
<thead><tr><th>Token</th><th style="text-align:right">Total</th><th style="text-align:right">Taken</th><th>Closes</th></tr></thead>
<tbody>${rows}</tbody></table>
${airdrops.length > 200 ? `<p class="hint">Showing the 200 most recent of ${nf(airdrops.length)}.</p>` : ""}`
  : `<div class="res"><div class="a none">No airdrops yet</div>
     <p class="stamp">Be the first. Funding one takes a token address, a list of wallets and a single transaction.</p></div>`}

<h2>Check one address against all of them</h2>
<p>Paste a wallet address into the <a href="/airdrop-checker">airdrop checker</a> and it will show every amount that address can still take, across every airdrop held here, without connecting anything.</p>

<div class="cta-box">
  <h2>Running an airdrop?</h2>
  <p>Fund it once and let recipients take their own share. They come to a page that reads the chain, which is also why the tokens never land in a wallet that never asked for them.</p>
  <a class="btn" href="/app/airdrops">Fund an airdrop →</a>
  <p class="cta-alt">${priceLine(feeEth)} <a href="/blog/how-to-airdrop-tokens-on-robinhood-chain">How to airdrop tokens on Robinhood Chain</a> or read the <a href="/docs/airdrops">reference</a>.</p>
</div>`,
  });
}

/* ---------- /airdrop/:id ---------- */

export function renderAirdropPage({ a, m, list, listURI, query, hit, feeEth = null, site = SITE }) {
  const now = Math.floor(Date.now() / 1000);
  const closed = a.endTime !== 0 && now >= a.endTime;
  const sym = esc(m.symbol);
  const url = `${site}/airdrop/${a.id}`;

  /* The honest arithmetic. If the published list promises more than the chain
     holds, or the ceiling is below the number of recipients, some people on
     that list will be refused. Say so. */
  const promised = list ? list.total : null;
  const underfunded = promised !== null && promised > a.total;
  const ceilingShort = list && a.maxClaims < list.count;

  const result = query
    ? (hit
      ? `<div class="res">
           <div class="q">${esc(shortAddr(query))} is on this list</div>
           <div class="a ok">${fmtUnits(BigInt(hit.amount), m.decimals)} $${sym}</div>
           <p class="stamp">${hit.claimed ? "Already taken by this address." : closed ? "This airdrop has closed." : "Still unclaimed."}</p>
           ${!hit.claimed && !closed ? `<div class="links"><a href="/app/airdrops">Open the app to claim</a></div>` : ""}
         </div>`
      : `<div class="res"><div class="q">${esc(shortAddr(query))}</div>
           <div class="a none">Not on this list</div>
           <p class="stamp">This address is not among the ${nf(list ? list.count : a.maxClaims)} wallets in this airdrop. If a project told you otherwise, ask which address they used.</p></div>`)
    : "";

  const faqs = [
    ["How do I take my share?",
     `Open the app, connect the wallet that is on the list, and the amount appears with a button. Nothing is sent to you automatically, by design: the tokens sit in the contract until the wallet that owns them asks.`],
    ["Who can take these tokens back?",
     a.endTime === 0
       ? `Nobody, ever. This airdrop was created with no deadline, which is a permanent choice: the creator gave up the ability to reclaim anything, and the tokens stay claimable indefinitely.`
       : `Only the creator, and only after ${day(a.endTime)}. Until then the tokens cannot be moved by the creator, by HoodLock, or by anyone else. That restriction is the whole reason this page means anything.`],
    ["Is this token safe?",
     `This page says nothing about that. It records that somebody funded an airdrop of this token, which is a fact about the tokens in the contract and not a judgement about the project. Anyone can create an airdrop here. Check the <a href="/token/${esc(a.token)}">token's own page</a> and the <a href="/blog/rug-pull-red-flags-checklist">red flags checklist</a> before you act on it.`],
    ["Can I check the list myself?",
     list ? `Yes. The <a href="/api/airdrop/${a.id}/list.json">full recipient list</a> is published, so anyone can rebuild a claim proof from it. That is deliberate: it means the claims keep working even if this website disappears.`
          : `The creator has not published a list here, so this page can only show what the chain records. Without a published list nobody can build a proof, which means nobody can claim.`],
  ];

  return shell({
    title: `$${m.symbol} airdrop on Robinhood Chain, ${a.claims} of ${a.maxClaims} taken | HoodLock`,
    desc: `${fmtUnits(a.total, m.decimals)} $${m.symbol} funded for ${nf(a.maxClaims)} wallets. ${a.claims} taken so far, ${fmtUnits(a.remaining, m.decimals)} still unclaimed. Read live from Robinhood Chain.`,
    canonical: url,
    noindex: !!query,
    h1: `$${m.symbol} <span class="sym">airdrop</span>`,
    lede: `${fmtUnits(a.total, m.decimals)} $${sym} funded on Robinhood Chain for ${nf(a.maxClaims)} wallets. Recipients take their own share; nothing is sent out.`,
    ld: [
      { "@context": "https://schema.org", "@type": "WebPage", name: `$${m.symbol} airdrop`, url,
        isPartOf: { "@type": "WebSite", name: "HoodLock", url: `${site}/` } },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, ans]) => ({
        "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: ans.replace(/<[^>]+>/g, "") } })) },
    ],
    body: `
<table>
<tr><td>Token</td><td class="num"><a href="/token/${esc(a.token)}">$${sym}</a> <span class="addr">${esc(shortAddr(a.token))}</span></td></tr>
<tr><td>Funded</td><td class="num">${fmtUnits(a.total, m.decimals)} $${sym}</td></tr>
<tr><td>Taken so far</td><td class="num">${a.claims} of ${nf(a.maxClaims)} wallets, ${fmtUnits(a.claimed, m.decimals)} $${sym}</td></tr>
<tr><td>Still unclaimed</td><td class="num">${fmtUnits(a.remaining, m.decimals)} $${sym}</td></tr>
<tr><td>Deadline</td><td class="num">${a.endTime ? (closed ? `closed ${day(a.endTime)}` : day(a.endTime)) : "none, claimable forever"}</td></tr>
<tr><td>Funded by</td><td class="num addr">${esc(shortAddr(a.creator))}</td></tr>
</table>

${underfunded || ceilingShort ? `<div class="warn"><p style="margin:0"><b>This airdrop cannot pay everyone on its list.</b> ${
  underfunded ? `The published list promises ${fmtUnits(promised, m.decimals)} $${sym} but only ${fmtUnits(a.total, m.decimals)} was funded. ` : ""}${
  ceilingShort ? `The creator paid for ${nf(a.maxClaims)} claims but the list holds ${nf(list.count)} addresses. ` : ""}Claims are accepted until the money or the ceiling runs out, and everyone after that is refused. Nothing here is broken; it is what was funded.</p></div>` : ""}

<h2>Is an address on this list?</h2>
<form method="get" action="/airdrop/${a.id}">
  <label class="vh" for="a">Wallet address</label>
  <div class="search${query && !hit ? "" : ""}">
    <svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.8 12.8 17 17"/></svg>
    <input id="a" name="a" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
      placeholder="Paste a wallet address" value="${esc(query || "")}" aria-describedby="hint">
    ${query ? `<a class="clear" href="/airdrop/${a.id}" aria-label="Clear">×</a>` : ""}
    <button type="submit">Check</button>
  </div>
  <p class="hint" id="hint">No wallet, no sign-in. Claiming needs the wallet itself; looking does not.</p>
</form>

${result}

<div class="scope"><p style="margin:0">Every figure above is read from Robinhood Chain when this page loads. ${
  list ? `The recipient list is <a href="/api/airdrop/${a.id}/list.json">published in full</a>, so anyone can rebuild a proof without us.` : `No recipient list has been published for this airdrop, so nobody can build a claim proof for it.`}</p></div>

<h2>Common questions</h2>
${faqs.map(([q, ans]) => `<h3>${esc(q)}</h3>\n<p>${ans}</p>`).join("\n")}

<div class="links">
  <a href="https://robinhoodchain.blockscout.com/address/${esc(a.token)}" target="_blank" rel="noopener">Token on Blockscout ↗</a>
  <a href="/airdrops">All airdrops</a>
  <a href="/airdrop-checker">Check every airdrop at once</a>
  <a href="${X}" target="_blank" rel="noopener">Report this page ↗</a>
</div>

<div class="cta-box">
  <h2>On this list?</h2>
  <p>Open the app with the wallet that is on it. The amount appears with a button, and the tokens move when you press it and not before.</p>
  <a class="btn" href="/app/airdrops">Open HoodLock →</a>
  <p class="cta-alt">Running your own? <a href="/app/airdrops">Fund an airdrop</a>. ${priceLine(feeEth)}</p>
</div>`,
  });
}

/* ---------- /airdrop-checker ---------- */

export function renderAirdropChecker({ query, bad, results, meta, feeEth = null, site = SITE }) {
  const total = results ? results.length : 0;
  const rows = (results || []).map((r) => {
    const m = meta[r.token] || { symbol: "???", decimals: 18 };
    return `<tr>
      <td><b>${fmtUnits(BigInt(r.amount), m.decimals)} $${esc(m.symbol)}</b></td>
      <td><a href="/airdrop/${r.id}">airdrop #${r.id}</a></td>
      <td>${r.endTime ? `closes ${day(r.endTime)}` : "no deadline"}</td>
      <td>${r.shortfall ? `<span style="color:var(--amber)">underfunded</span>` : ""}</td>
    </tr>`;
  }).join("");

  const faqs = [
    ["Do I need to connect a wallet?",
     "Not to look. Paste any address and this reads the same records for everyone. Connecting is only needed to actually take the tokens, because that is a transaction from the wallet that owns them."],
    ["Why is nothing sent to me automatically?",
     "Because an airdrop that pushes tokens into wallets fills them with things nobody asked for, and costs the sender gas for every recipient who never wanted it. Here the tokens wait in the contract until the wallet that owns them asks."],
    ["It says nothing is waiting, but a project told me otherwise.",
     "Then either they used a different address, or their airdrop is not held here. This can only see airdrops created through HoodLock. Ask the project which contract they used."],
    ["What does underfunded mean?",
     "That the airdrop's list promises more than was actually funded, or that it paid for fewer claims than it has recipients. Claims are accepted until it runs out. Being on the list does not guarantee there will still be something left."],
  ];

  const body = `
<form method="get" action="/airdrop-checker">
  <label class="vh" for="a">Wallet address</label>
  <div class="search${bad ? " bad" : ""}">
    <svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.8 12.8 17 17"/></svg>
    <input id="a" name="a" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
      placeholder="Paste a wallet address" value="${esc(query || "")}" aria-describedby="hint"${bad ? ' aria-invalid="true"' : ""}>
    ${query ? `<a class="clear" href="/airdrop-checker" aria-label="Clear">×</a>` : ""}
    <button type="submit">Check</button>
  </div>
  <p class="hint${bad ? " bad" : ""}" id="hint">${bad
    ? "That doesn't look like a wallet address. It should be 42 characters and start with 0x."
    : "Any wallet address on Robinhood Chain. No wallet, no sign-in."}</p>
</form>

${query && !bad ? (total
  ? `<div class="res">
       <div class="q">${esc(shortAddr(query))} can take</div>
       <div class="a ok">${total} airdrop${total === 1 ? "" : "s"}</div>
       <table><tbody>${rows}</tbody></table>
       <div class="links"><a href="/app/airdrops">Open the app to claim</a></div>
     </div>`
  : `<div class="res"><div class="q">${esc(shortAddr(query))}</div>
       <div class="a none">Nothing waiting</div>
       <p class="stamp">This address is not on any airdrop list held here, or it has already taken everything it was owed.</p></div>`) : ""}

<div class="scope"><p style="margin:0">This checks airdrops created through HoodLock. An empty result means nothing is waiting <b>here</b>, not that no project has ever airdropped to this address. We can only speak for our own contracts.</p></div>

<h2>How it works</h2>
<p>Every airdrop funded through HoodLock stores a Merkle root on chain and publishes its recipient list. This looks your address up in each of those lists, then asks the chain whether that entitlement has already been taken. Both halves matter: the list says what you are owed, and only the chain knows whether it is still there.</p>

<h2>Common questions</h2>
${faqs.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${a}</p>`).join("\n")}

<div class="links">
  <a href="/airdrops">Every airdrop on the chain</a>
  <a href="/lock-checker">Lock checker</a>
  <a href="/burn-checker">Burn checker</a>
  <a href="/vesting-checker">Vesting checker</a>
</div>

<div class="cta-box">
  <h2>Running an airdrop?</h2>
  <p>Fund it once, and every recipient gets a page like this one instead of a transaction they never asked for. ${priceLine(feeEth)}</p>
  <a class="btn" href="/app/airdrops">Fund an airdrop →</a>
</div>`;

  return shell({
    title: "Airdrop Checker for Robinhood Chain | HoodLock",
    desc: "Paste a wallet address and see every amount it can still take across all HoodLock airdrops on Robinhood Chain. No wallet and no sign-in needed to look.",
    canonical: `${site}/airdrop-checker`,
    noindex: !!query,
    h1: "What can this wallet claim?",
    lede: "Every amount a wallet is owed across all the airdrops held here, with the amount it can still take rather than the amount it was once promised. Read live from Robinhood Chain.",
    ld: [
      { "@context": "https://schema.org", "@type": "WebApplication", name: "Airdrop Checker for Robinhood Chain",
        url: `${site}/airdrop-checker`, applicationCategory: "FinanceApplication", operatingSystem: "Any",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: "HoodLock", url: `${site}/` } },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map(([q, a]) => ({
        "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })) },
    ],
    body,
  });
}
