/* Three checker pages: /lock-checker, /burn-checker, /vesting-checker.
 *
 * Same mechanism as the app's Explore search — paste a contract address, get
 * that token's HoodLock records — but split into three pages because the search
 * that brings someone here is three different questions. Somebody typing "is
 * this robinhood token locked" and somebody typing "how much supply was burned"
 * want different answers, and one page cannot be the best result for both.
 *
 * Rendered on the server, submitted as a plain GET. No wallet, no bundle, no
 * JavaScript required: the answer is in the HTML of the response, which is also
 * what makes the result linkable and what a crawler sees.
 *
 * The site already has articles explaining how to check a lock. These pages
 * deliberately do not explain it again — they do it. Prose here stays short and
 * links out to those articles rather than restating them, so the tool pages and
 * the guides don't compete for the same query.
 */
import { esc, fmtUnits, day } from "./token.mjs";

const SITE = "https://hoodlock.tech";

/* ---------- per-kind copy ----------
 * Everything that differs between the three pages lives here, so the three
 * pages cannot drift apart in layout, only in what they say.
 */
export const KINDS = {
  lock: {
    path: "lock-checker",
    title: "Token Lock Checker — Robinhood Chain | HoodLock",
    desc: "Paste a Robinhood Chain contract address and see every lock HoodLock holds on it — amount, unlock date and a proof link. Read live from the chain. No wallet needed.",
    h1: "Is this token locked?",
    lede: "Paste a Robinhood Chain contract address. You'll see every lock HoodLock holds on that token — the amount, when it unlocks, and a proof page you can share.",
    label: "Token or LP contract address",
    noun: "lock", nounPlural: "locks",
    found: (n) => `${n} ${n === 1 ? "lock" : "locks"} on HoodLock`,
    none: "No HoodLock locks on this token",
    related: [
      ["/blog/how-to-check-if-liquidity-is-locked", "How to check if liquidity is locked before you buy"],
      ["/blog/what-is-a-liquidity-lock", "What a liquidity lock actually is"],
      ["/docs/how-to-lock-tokens", "Lock a token yourself"],
    ],
  },
  burn: {
    path: "burn-checker",
    title: "Token Burn Checker — Robinhood Chain | HoodLock",
    desc: "Paste a Robinhood Chain contract address and see every burn sent through HoodLock — amount, date and a proof link. Read live from the chain. No wallet needed.",
    h1: "Has this token been burned?",
    lede: "Paste a Robinhood Chain contract address. You'll see every burn sent through HoodLock for that token — how much, when, and a proof page you can share.",
    label: "Token or LP contract address",
    noun: "burn", nounPlural: "burns",
    found: (n) => `${n} ${n === 1 ? "burn" : "burns"} through HoodLock`,
    none: "No HoodLock burns for this token",
    related: [
      ["/blog/how-to-check-if-liquidity-is-burned", "How to check if liquidity is burned"],
      ["/blog/burning-vs-locking-liquidity", "Burning vs locking liquidity"],
      ["/docs/how-to-burn-tokens", "Burn tokens yourself"],
    ],
  },
  vesting: {
    path: "vesting-checker",
    title: "Token Vesting Checker — Robinhood Chain | HoodLock",
    desc: "Paste a Robinhood Chain contract address and see every vesting schedule HoodLock holds for it — total, cliff, end date and a proof link. Read live from the chain.",
    h1: "Does this token have vesting?",
    lede: "Paste a Robinhood Chain contract address. You'll see every vesting schedule created on HoodLock for that token — the total, the cliff, when it finishes, and a proof page you can share.",
    label: "Token contract address",
    noun: "vesting schedule", nounPlural: "vesting schedules",
    found: (n) => `${n} vesting ${n === 1 ? "schedule" : "schedules"} on HoodLock`,
    none: "No HoodLock vesting for this token",
    related: [
      ["/blog/what-is-a-vesting-cliff", "What a vesting cliff is"],
      ["/blog/team-token-allocation-benchmarks", "What a normal team allocation looks like"],
      ["/docs/token-vesting", "Set up vesting yourself"],
    ],
  },
};

const OTHERS = {
  lock: [["burn", "burn checker"], ["vesting", "vesting checker"]],
  burn: [["lock", "lock checker"], ["vesting", "vesting checker"]],
  vesting: [["lock", "lock checker"], ["burn", "burn checker"]],
};

/* The one thing every visitor needs to understand before they trust the answer,
   stated the same way on all three pages. A blank result is not proof of a
   negative — it only means nothing was done here. */
const scopeLine = (k) =>
  `This checks HoodLock's own contracts on Robinhood Chain. If it finds ${k.nounPlural}, they are real and you can open the proof yourself. If it finds none, it means the token has no ${k.nounPlural} <b>on HoodLock</b> — it may still be ${k.noun === "burn" ? "burned" : k.noun === "lock" ? "locked" : "vesting"} somewhere else, or nowhere at all. We can only speak for our own contracts.`;

function faqs(k) {
  const common = [
    ["Do I need a wallet to use this?",
     "No. The page reads Robinhood Chain directly and shows the same records to everyone. Connecting a wallet is only needed if you want to create a lock, burn or schedule of your own."],
    ["Where does the answer come from?",
     `Straight from HoodLock's contracts on Robinhood Chain, re-read on every search. There is no database of submissions in between, so a ${k.noun} created a minute ago shows up on the next search.`],
    [`What if it shows no ${k.nounPlural}?`,
     `It means this token has no ${k.nounPlural} on HoodLock. That is not the same as saying the token has none anywhere — another service may hold ${k.nounPlural} we cannot see. Treat a blank result as "not with us", not as proof.`],
    ["Can a project fake a result here?",
     "No. Every record shown is an on-chain record with a transaction behind it, and each one links to a proof page and to the block explorer. Nothing on this page is self-reported."],
  ];
  const own = {
    lock: [["Does a lock mean the token is safe?",
      "It means those specific tokens cannot be moved until the unlock date, which removes one specific risk. It says nothing about the rest of the supply, who holds it, or whether the contract itself is sound. Check the <a href=\"/blog/rug-pull-red-flags-checklist\">rest of the checklist</a> too."]],
    burn: [["Is a burn reversible?",
      "No. HoodLock sends burned tokens to the dead address in a single transaction, and nothing can retrieve them — not the project, and not us."]],
    vesting: [["Can a project cancel a vesting schedule?",
      "No. HoodLock vesting is irreversible once created: the schedule cannot be revoked, paused or clawed back, and the tokens release on the timetable written into the contract."]],
  }[k.noun === "vesting schedule" ? "vesting" : k.noun];
  return [...common, ...own];
}

/* ---------- result ---------- */

function resultBlock(k, kind, q, token, recs) {
  if (!q) return "";
  if (!token) {
    return `<div class="res">
      <div class="q">Result</div>
      <div class="a none">Couldn't read that address as a token</div>
      <p class="stamp">Check that it's a contract address on Robinhood Chain (42 characters, starting 0x). Wallet addresses and addresses from other chains won't resolve here.</p>
    </div>`;
  }

  const now = Math.floor(Date.now() / 1000);
  const dec = token.decimals;
  const sym = esc(token.symbol);
  let rows = [], headline, tone;

  if (kind === "lock") {
    const active = recs.locks.filter((l) => !l.withdrawn && l.unlock > now);
    const past = recs.locks.filter((l) => l.withdrawn || l.unlock <= now);
    headline = active.length ? k.found(active.length) : k.none;
    tone = active.length ? "ok" : "none";
    rows = [
      ...active.map((l) => [`lock/${l.id}`, `${fmtUnits(l.amount, dec)} $${sym}`, `locked until ${day(l.unlock)}`, "active"]),
      ...past.map((l) => [`lock/${l.id}`, `${fmtUnits(l.amount, dec)} $${sym}`,
        l.withdrawn ? "withdrawn" : `unlocked ${day(l.unlock)}`, "past"]),
    ];
  } else if (kind === "burn") {
    headline = recs.burns.length ? k.found(recs.burns.length) : k.none;
    tone = recs.burns.length ? "ok" : "none";
    rows = recs.burns.map((b) => [`burn/${b.id}`, `${fmtUnits(b.amount, dec)} $${sym}`,
      b.ts ? `burned ${day(b.ts)}` : "burned", "active"]);
  } else {
    headline = recs.vesting.length ? k.found(recs.vesting.length) : k.none;
    tone = recs.vesting.length ? "ok" : "none";
    rows = recs.vesting.map((v) => [`vesting/${v.id}`, `${fmtUnits(v.total, dec)} $${sym}`,
      `cliff ${day(v.cliff)} · ends ${day(v.end)}`, v.end > now ? "active" : "past"]);
  }

  // What the other two pages would find, so a visitor who asked the wrong
  // question still gets pointed at the right one instead of a dead end.
  const elsewhere = [
    kind !== "lock" && recs.locks.filter((l) => !l.withdrawn && l.unlock > now).length
      ? [`/lock-checker?a=${token.address}`, `${recs.locks.filter((l) => !l.withdrawn && l.unlock > now).length} active lock(s)`] : null,
    kind !== "burn" && recs.burns.length ? [`/burn-checker?a=${token.address}`, `${recs.burns.length} burn(s)`] : null,
    kind !== "vesting" && recs.vesting.length ? [`/vesting-checker?a=${token.address}`, `${recs.vesting.length} vesting schedule(s)`] : null,
  ].filter(Boolean);

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  return `<div class="res">
  <div class="q">${esc(token.name)} <span class="sym">$${sym}</span></div>
  <div class="a ${tone}">${esc(headline)}</div>
  ${rows.length ? `<table>${rows.map(([ref, amt, when, state]) =>
    `<tr class="${state}"><td><a href="/proof/${ref}">#${ref.split("/")[1]}</a></td><td>${amt}</td><td>${esc(when)}</td></tr>`).join("")}</table>` : ""}
  <div class="stamp">read from Robinhood Chain at ${esc(stamp)}</div>
  ${elsewhere.length ? `<p class="also">Also on this token: ${elsewhere.map(([h, t]) => `<a href="${h}">${esc(t)}</a>`).join(" · ")}</p>` : ""}
  <div class="links">
    <a href="/token/${esc(token.address)}">Full token page</a>
    <a href="https://robinhoodchain.blockscout.com/token/${esc(token.address)}" target="_blank" rel="noopener">Contract on Blockscout ↗</a>
  </div>
</div>`;
}

/* ---------- page ---------- */

export function renderChecker({ kind, q = "", token = null, recs = null, site = SITE }) {
  const k = KINDS[kind];
  const url = `${site}/${k.path}`;
  const list = faqs(k);

  // A result URL is one of billions and says nothing a crawler should index, so
  // it stays out of the index and points at the bare tool as its canonical.
  const noindex = !!q;

  const ld = [
    { "@context": "https://schema.org", "@type": "WebApplication", name: k.title.split(" —")[0],
      url, applicationCategory: "FinanceApplication", operatingSystem: "Any",
      description: k.desc, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@type": "Organization", name: "HoodLock", url: `${site}/` } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "HoodLock", item: `${site}/` },
      { "@type": "ListItem", position: 2, name: k.h1, item: url },
    ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: list.map(([qq, a]) => ({
      "@type": "Question", name: qq,
      acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") },
    })) },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(k.title)}</title>
<meta name="description" content="${esc(k.desc)}">
<link rel="canonical" href="${url}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ""}
<meta property="og:site_name" content="HoodLock"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(k.title)}"><meta property="og:description" content="${esc(k.desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.ico" sizes="any">
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("")}
<style>
:root{--bg:#050807;--card:#0a0f0c;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--neon:#00e05a;--red:#ff6b6b;--ink:#eef4ef;--ink2:#8fa396;--ink3:#59695e;--dim:#6f8377;
--sans:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.7}
a{color:var(--neon);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--neon);outline-offset:2px}
.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;background:var(--card);padding:8px 14px;border-radius:8px;z-index:9}
.nav{display:flex;align-items:center;justify-content:space-between;max-width:760px;margin:0 auto;padding:20px 22px}
.nav .logo{font-weight:700;font-size:16px;color:var(--ink);letter-spacing:-.03em}.nav .logo b{color:var(--neon)}
.nav .cta{background:var(--neon);color:#03130a;font-weight:600;font-size:13px;border-radius:9px;padding:8px 16px}
.nav .cta:hover{text-decoration:none;filter:brightness(1.1)}
main{max-width:760px;margin:0 auto;padding:26px 22px 80px}
.crumb{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:22px}
.crumb a{color:var(--dim)}
h1{font-size:34px;line-height:1.12;letter-spacing:-.035em;margin-bottom:12px}
.lede{color:var(--ink2);font-size:16px;margin-bottom:26px;max-width:60ch}
form{display:flex;gap:10px;flex-wrap:wrap}
label{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
input{flex:1 1 320px;background:var(--card);border:1px solid var(--line2);border-radius:11px;padding:13px 15px;
  color:var(--ink);font-family:var(--mono);font-size:13.5px}
input::placeholder{color:var(--ink3)}
input:focus{outline:none;border-color:var(--neon)}
button{background:var(--neon);color:#03130a;font-family:var(--sans);font-weight:700;font-size:14.5px;border:0;
  border-radius:11px;padding:13px 26px;cursor:pointer}
button:hover{filter:brightness(1.1)}
.res{margin-top:26px;padding:20px 22px;border-radius:14px;border:1px solid var(--line2);background:var(--card)}
.res .q{font-size:15px;color:var(--ink2)}.res .q .sym{font-family:var(--serif);font-style:italic;color:var(--neon)}
.res .a{font-size:23px;font-weight:600;letter-spacing:-.025em;margin-top:4px}
.res .a.ok{color:var(--neon)}.res .a.none{color:var(--ink)}
.res table{width:100%;border-collapse:collapse;font-size:14px;margin-top:14px}
.res td{border-top:1px solid var(--line);padding:10px 4px;color:var(--ink2)}
.res td:first-child{font-family:var(--mono);font-size:12.5px;width:64px}
.res td:last-child{text-align:right;color:var(--dim);font-size:13px}
.res tr.past td{color:var(--ink3)}
.stamp{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-top:12px}
.also{font-size:14px;color:var(--ink2);margin-top:12px}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.links a{border:1px solid var(--line2);border-radius:999px;padding:7px 15px;font-size:13px;color:var(--ink2)}
.links a:hover{text-decoration:none;color:var(--ink);border-color:rgba(255,255,255,.3)}
.scope{margin-top:30px;padding:16px 18px;border-left:2px solid var(--neon);background:rgba(0,224,90,.04);border-radius:0 10px 10px 0}
.scope b{color:var(--ink)}
h2{font-size:20px;letter-spacing:-.02em;margin:40px 0 10px}
h3{font-size:15.5px;margin:22px 0 5px;color:var(--ink)}
p,li{color:var(--ink2);font-size:15px}p{margin-bottom:12px}
.cta-box{background:var(--card);border:1px solid rgba(0,224,90,.3);border-radius:16px;padding:24px;text-align:center;margin-top:44px}
.cta-box h2{margin-top:0}
.cta-box .btn{display:inline-block;background:var(--neon);color:#03130a;font-weight:700;border-radius:10px;padding:11px 24px;margin-top:8px}
.cta-box .btn:hover{text-decoration:none;filter:brightness(1.1)}
.note{font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
footer{border-top:1px solid var(--line);margin-top:50px;padding:24px 22px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.08em}
@media(max-width:520px){h1{font-size:27px}button{flex:1 1 100%}}
</style>
</head>
<body>
<a class="skip" href="#tool">Skip to the checker</a>
<nav class="nav"><a class="logo" href="/">Hood<b>Lock</b></a><a class="cta" href="/app">Launch App</a></nav>
<main id="tool">
<div class="crumb"><a href="/">HOODLOCK</a> / ${esc(k.h1.toUpperCase())}</div>

<h1>${esc(k.h1)}</h1>
<p class="lede">${esc(k.lede)}</p>

<form method="get" action="/${k.path}">
  <div style="flex:1 1 320px">
    <label for="a">${esc(k.label)}</label>
    <input id="a" name="a" type="text" inputmode="text" spellcheck="false" autocomplete="off"
      placeholder="0x…" value="${esc(q)}" aria-describedby="scope">
  </div>
  <button type="submit">Check</button>
</form>

${resultBlock(k, kind, q, token, recs)}

<div class="scope" id="scope"><p style="margin:0">${scopeLine(k)}</p></div>

<h2>How it works</h2>
<p>Every ${k.noun} made through HoodLock is a transaction on Robinhood Chain, and the record lives in the contract — not in a listing we maintain. This page reads those contracts each time you search, so what you see is the chain's answer, not ours. Each result links to a permanent proof page and to the contract on Blockscout, so you can confirm it without taking our word for it.</p>

<h2>Common questions</h2>
${list.map(([qq, a]) => `<h3>${esc(qq)}</h3>\n<p>${a}</p>`).join("\n")}

<h2>Keep reading</h2>
<ul>${k.related.map(([h, t]) => `<li><a href="${h}">${esc(t)}</a></li>`).join("")}</ul>
<p style="margin-top:14px">Checking something else? ${OTHERS[kind].map(([o, t]) => `<a href="/${KINDS[o].path}">${esc(t)}</a>`).join(" · ")} · <a href="/app/explore">browse every record</a></p>

<div class="cta-box">
  <h2>Locking your own token?</h2>
  <p>Lock, burn or vest on Robinhood Chain for a flat fee, and get a proof link your holders can check on this page the moment it confirms.</p>
  <a class="btn" href="/app/locks">Open HoodLock →</a>
</div>

<div class="note">HoodLock reads Robinhood Chain live on every search. Nothing here is financial advice, and a record's existence says nothing about whether a token is a good investment. HoodLock is not affiliated with Robinhood Markets, Inc.</div>
</main>
<footer>© 2026 HOODLOCK · ROBINHOOD CHAIN · <a href="/">hoodlock.tech</a></footer>
</body>
</html>`;
}
