/* /terms and /privacy.
 *
 * One renderer for both, because two static files would mean two copies of the
 * same stylesheet, which is how the blog ended up with the same CSS duplicated
 * 35 times.
 *
 * Everything in the privacy policy was read out of the code before it was
 * written here: the tables in server/index.mjs, the localStorage keys in
 * web/src, and the third-party hosts the pages actually contact. A privacy
 * policy that describes something other than what the software does is worse
 * than none, because it is a false statement rather than a missing one.
 */
import { esc } from "./token.mjs";

const SITE = "https://hoodlock.tech";
const X = "https://x.com/HoodLockRH";

const PAGES = {
  terms: {
    path: "terms",
    title: "Terms of Use | HoodLock",
    desc: "The terms you agree to by using HoodLock: non-custodial software on Robinhood Chain, flat fees, no control over your tokens, and no vetting of third-party projects.",
    h1: "Terms of use",
    updated: "30 July 2026",
    lede: "HoodLock is software that talks to contracts on Robinhood Chain. It never holds your tokens and it cannot move them. These terms say what that means in practice, and what it does not protect you from.",
    body: [
      ["What HoodLock is", `
<p>HoodLock is a set of contracts on Robinhood Chain, plus a website for using them. The contracts lock ERC-20 tokens until a date, send tokens to the dead address, release them on a vesting schedule, or hold an airdrop that recipients claim themselves.</p>
<p>It is non-custodial. Your tokens go from your wallet into a contract, and only the rules written into that contract can move them out. HoodLock has no key that overrides those rules, which also means we cannot reverse a transaction, recover tokens sent to the wrong place, or unlock something early because you asked.</p>
<p>The contracts are not upgradeable. What was deployed is what runs, and their source is published on Blockscout so you can read it before you use it.</p>`],
      ["What you are responsible for", `
<p>Checking the contract addresses you are interacting with. Phishing sites copy this one.</p>
<p>The token you choose. HoodLock locks whatever ERC-20 you point it at and makes no judgement about it. A token whose owner can mint, pause, blacklist or upgrade it can undo what a lock appears to promise, and no lock can prevent that.</p>
<p>The dates and amounts you enter. They cannot be edited afterwards. An unlock date can be pushed further out and never pulled in, a vesting schedule cannot be cancelled, and a burn cannot be undone by anyone including us.</p>
<p>Your own keys. We cannot help you recover a wallet.</p>`],
      ["Airdrops and third-party content", `
<p>Anybody can create an airdrop, and anybody can publish a page for one. HoodLock does not review, endorse or vet the projects that do, the tokens they use, or the claims they make. A page on this domain is a record of what happened on chain, not a recommendation.</p>
<p>If you create an airdrop, you confirm that you have the right to publish the recipient list you upload, and that publishing it does not breach anyone's rights. Recipient lists are published deliberately, so that claims keep working even if this website disappears. Do not upload a list you are not willing to make public.</p>
<p>You may not use HoodLock to distribute a token you do not have the right to distribute, to impersonate another project, or to run anything designed to mislead the people claiming from it. We will remove a page from this website if we become aware of it. We cannot remove anything from the chain, because nobody can.</p>
<p>To report an airdrop or a page, message <a href="${X}" target="_blank" rel="noopener">@HoodLockRH</a> on X. That is the contact route for everything, and it is the only one.</p>`],
      ["Fees", `
<p>Each contract charges a flat fee in ETH for creating a record, and the fee is read live from the contract rather than from this page, so what you are shown before you confirm is what the contract will take. Withdrawing, claiming and extending are free of any HoodLock fee. You still pay the network's own gas.</p>
<p>Every contract caps its fee in code at a level no administrator can raise. We can lower a fee or raise it within that cap, and a change never applies to a record that already exists.</p>`],
      ["No advice, and no warranty", `
<p>Nothing here is financial, investment, legal or tax advice. A lock, a burn or a vesting schedule tells you one specific fact about one specific pile of tokens. It says nothing about whether a project is honest or a token is worth buying.</p>
<p>The software is provided as it is, without warranty of any kind. To the extent the law allows, HoodLock is not liable for lost tokens, lost profits, or any loss arising from using it, from a token behaving unexpectedly, from a mistake you made entering a transaction, or from the chain itself failing.</p>`],
      ["Changes", `
<p>These terms may change, and the date at the top says when they last did. Continuing to use HoodLock after that is how you accept the new version. HoodLock is not affiliated with Robinhood Markets, Inc.</p>`],
    ],
  },

  privacy: {
    path: "privacy",
    title: "Privacy | HoodLock",
    desc: "What HoodLock stores and what it does not. No cookies, no analytics and no trackers, stated precisely rather than as a slogan.",
    h1: "Privacy",
    updated: "30 July 2026",
    lede: "HoodLock sets no cookies, runs no analytics and loads no trackers. That is easy to claim and hard to verify, so this page lists exactly what is stored, where, and who else sees anything.",
    body: [
      ["What this site stores about you", `
<p>On our server, in a database:</p>
<ul>
<li><b>Wallet addresses that connected</b>, with the first and last time and a visit count. This is how the number of users on the admin dashboard is counted.</li>
<li><b>Referral attributions</b>, linking a wallet address to the referral code that brought it, so an affiliate can be paid.</li>
<li><b>Affiliate accounts</b>: the code, its label, its click count, the wallet that owns it and its commission rate.</li>
<li><b>Affiliate payout requests</b>: the code, the wallet, the amount, the status and the transaction that paid it.</li>
<li><b>Airdrop recipient lists</b> uploaded by whoever created an airdrop. These are published on purpose, so a recipient can still build a claim proof if this website goes away.</li>
</ul>
<p>We do not store your name, your email, your IP address or anything you have not put into the site yourself. There is no account and nothing to sign up for.</p>`],
      ["What your own browser stores", `
<p>In local storage, not cookies, which means it never travels with a request:</p>
<ul>
<li>Which wallet you last connected, so the page does not ask again on every visit.</li>
<li>A referral code, if you arrived through one.</li>
<li>A cached ETH price and cached lock timestamps, so pages load faster.</li>
<li>A session token, only if you sign in to the admin or affiliate console.</li>
</ul>
<p>Clearing your browser storage removes all of it and signs you out. Nothing there is sent anywhere except the session token, which goes only to this site.</p>`],
      ["Who else sees anything", `
<p><b>Google Fonts.</b> Every page loads its typefaces from Google's servers, which means Google receives your IP address when a page loads. We are moving these to our own server to close that gap.</p>
<p><b>Blockscout.</b> Pages that show token data read it from the Robinhood Chain explorer. Where your browser makes that request directly, Blockscout sees your IP.</p>
<p><b>X.</b> Only if you click a link to it.</p>
<p>Nobody else. There is no advertising network, no session recorder, no heatmap and no analytics product of any kind, self-hosted or otherwise.</p>`],
      ["The chain is public and permanent", `
<p>Everything you do through HoodLock is a transaction on Robinhood Chain: the wallet, the token, the amount and the time are public, permanent and outside anyone's control including ours. Deleting something from this website does not and cannot remove it from the chain.</p>
<p>Wallet addresses are pseudonymous rather than anonymous. If your address is publicly linked to you somewhere else, everything it has done here is linked to you too.</p>`],
      ["Removal", `
<p>Ask via <a href="${X}" target="_blank" rel="noopener">@HoodLockRH</a> on X and we will delete what we hold about a wallet address: its connection record, its referral attribution and its affiliate rows. We cannot delete on-chain records, and we cannot delete a published airdrop list without breaking the claims that depend on it, so if you want a list removed, say so before the airdrop is created.</p>
<p>We do not sell data. There is nothing to sell.</p>`],
    ],
  },
};

export function renderLegal(which, { site = SITE } = {}) {
  const p = PAGES[which];
  const url = `${site}/${p.path}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: p.title.split(" |")[0],
    description: p.desc,
    url,
    dateModified: "2026-07-30",
    isPartOf: { "@type": "WebSite", name: "HoodLock", url: `${site}/` },
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="HoodLock"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${url}"><meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Instrument+Serif:ital@1&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.ico" sizes="any">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
:root{--bg:#050807;--card:#0a0f0c;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--neon:#00e05a;--ink:#eef4ef;--ink2:#8fa396;--dim:#6f8377;
--sans:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.75}
a{color:var(--neon);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--neon);outline-offset:2px}
.nav{display:flex;align-items:center;justify-content:space-between;max-width:760px;margin:0 auto;padding:20px 22px}
.nav .logo{font-weight:700;font-size:16px;color:var(--ink);letter-spacing:-.03em}.nav .logo b{color:var(--neon)}
.nav .cta{background:var(--neon);color:#03130a;font-weight:600;font-size:13px;border-radius:9px;padding:8px 16px}
.nav .cta:hover{text-decoration:none;filter:brightness(1.1)}
main{max-width:760px;margin:0 auto;padding:26px 22px 80px}
.crumb{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:20px}
.crumb a{color:var(--dim)}
h1{font-size:34px;line-height:1.14;letter-spacing:-.035em;margin-bottom:10px}
.updated{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:22px}
.lede{color:var(--ink2);font-size:16.5px;margin-bottom:8px;max-width:62ch}
h2{font-size:20px;letter-spacing:-.02em;margin:38px 0 8px}
p,li{color:var(--ink2);font-size:15.5px}p{margin-bottom:13px}
ul{margin:0 0 14px 20px}li{margin-bottom:7px}
b{color:var(--ink);font-weight:600}
.note{font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:40px;padding-top:16px}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}
.links a{border:1px solid var(--line2);border-radius:999px;padding:7px 15px;font-size:13px;color:var(--ink2)}
.links a:hover{text-decoration:none;color:var(--ink);border-color:rgba(255,255,255,.3)}
footer{border-top:1px solid var(--line);margin-top:50px;padding:24px 22px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:.08em}
@media(max-width:520px){h1{font-size:27px}}
</style>
</head>
<body>
<nav class="nav"><a class="logo" href="/">Hood<b>Lock</b></a><a class="cta" href="/app">Launch App</a></nav>
<main>
<div class="crumb"><a href="/">HOODLOCK</a> / ${esc(p.h1.toUpperCase())}</div>
<h1>${esc(p.h1)}</h1>
<div class="updated">Last updated ${esc(p.updated)}</div>
<p class="lede">${esc(p.lede)}</p>

${p.body.map(([h, html]) => `<h2>${esc(h)}</h2>\n${html.trim()}`).join("\n")}

<div class="links">
  <a href="/${which === "terms" ? "privacy" : "terms"}">${which === "terms" ? "Privacy" : "Terms of use"}</a>
  <a href="/docs">Documentation</a>
  <a href="${X}" target="_blank" rel="noopener">@HoodLockRH ↗</a>
</div>

<div class="note">HoodLock is not affiliated with Robinhood Markets, Inc.</div>
</main>
<footer>© 2026 HOODLOCK · ROBINHOOD CHAIN · <a href="/">hoodlock.tech</a></footer>
</body>
</html>`;
}

export const LEGAL_PAGES = Object.keys(PAGES);
