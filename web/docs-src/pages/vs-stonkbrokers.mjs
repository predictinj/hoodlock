import { h2, p, ul, table, info, warn, doc, blog, cta } from "../components.mjs";

export default {
  slug: "vs/stonkbrokers",
  navTitle: "vs StonkBrokers",
  seoTitle: "HoodLock vs StonkBrokers | Flat Fee vs a Percentage of Your Liquidity",
  desc: "One charges a flat 0.005 ETH whatever your position is worth. The other takes a percentage of it, or a fifth of every fee you collect. What that costs in practice.",
  updated: "2026-07-29",
  h1: 'HoodLock vs <span class="serif">StonkBrokers.</span>',
  lede: "The difference that decides it is pricing. We charge a flat fee in ETH that never moves with the size of your position. They take a percentage of the position — or a fifth of every fee it ever collects.",
  body: `
${info(`<p>Figures below come from each platform's own published material as of 2026-07-29. Terms change —
verify before relying on them.</p>`)}

${h2("Cost, on a real position")}
${p(`This is where the two models separate, and it is not close.`)}
${table(["", "HoodLock", "StonkBrokers"], [
  ["Model", "<b>Flat fee in ETH</b>", "0.5% of the position, or 20% of every fee collect"],
  ["A $10,000 position", "<b>0.005 ETH</b>", "$50 upfront, or 20% of every collect"],
  ["A $100,000 position", "<b>0.005 ETH — unchanged</b>", "$500 upfront, or 20% of every collect"],
  ["A $1,000,000 position", "<b>0.005 ETH — still unchanged</b>", "$5,000 upfront, or 20% of every collect"],
  ["Withdrawing", "<b>Free</b>", "—"],
  ["Extending a lock", "<b>Free</b>", "—"],
])}
${warn(`<p>The percentage-of-fees option is charged on <b>every</b> collect for the life of the lock, not
once. On a pool doing real volume it keeps taking a fifth, indefinitely.</p>`)}
${p(`We take <b>no percentage of your tokens at any point</b> — not on the way in, not on the way out. A
locker paid out of the thing it is holding has a reason to want you locking more of it; charging a flat fee
in ETH removes that incentive entirely. ${doc("fees", "The full fee breakdown")}.`)}

${h2("What each one covers")}
${p(`HoodLock is four products behind one proof format. StonkBrokers is one.`)}
${table(["", "HoodLock", "StonkBrokers"], [
  ["Creator, team and treasury tokens — any ERC-20", "<b>Yes</b>", "No"],
  ["v2-style LP tokens", "<b>Yes</b>", "No"],
  ["Token vesting, single or batched up to 200 people", "<b>Yes</b>", "Not offered"],
  ["Token burning with an auditable record", "<b>Yes</b>", "Not offered"],
  ["Public proof page per record, opens without a wallet", "<b>Yes</b>", "—"],
  ["Embed widget and REST API for your own site", "<b>Yes</b>", "—"],
  ["Uniswap v3 / v4 position NFTs", "See below", "Yes"],
])}

${h2("About v3 and v4 positions")}
${p(`Worth being precise, because it reads like a gap and usually is not one.`)}
${p(`A v3 or v4 liquidity position is an <b>NFT</b>, a different kind of asset from everything else here.
<b>In most cases it is also already locked.</b> The launchpads on this chain that graduate to v3 — hood.fun,
Robinlaunch, ArrowPad, Openfair among them — lock or burn the position at graduation, permanently and
without being asked. It is not yours to move, so there is nothing to pay a percentage for.`)}
${info(`<p>Which means if you graduated to a v3 pool, the liquidity question is already answered. What is
still sitting in your wallet — creator supply, accruing fee revenue, a treasury, team allocations — is
unlocked, visible on the holder list, and is the next thing a buyer asks about. That is exactly what
HoodLock is built for. ${doc("liquidity-locker", "How to tell which position you hold")}.</p>`)}

${h2("Verifying either one")}
${p(`Both publish contracts you can read. Ours are verified on Blockscout, the vesting contract was built
against a written threat model with a full test suite, and <b>no admin function in any of the three can move
a user's tokens</b> — you can confirm that yourself in about five minutes.`)}
${p(`${doc("security", "The security model")} names the exact functions to search for and what you should
find. Run that same check on any locker you are considering; it is the one that actually separates them.`)}

${h2("The short version")}
${ul([
  "<b>Flat 0.005 ETH, charged once.</b> Never a percentage of your tokens, never a cut of your fees. Withdrawing and extending are free.",
  "<b>Four products in one place.</b> Locking, LP locking, vesting and burning, with one proof page format across all of them.",
  "<b>Built for what is actually in your wallet.</b> On this chain liquidity is usually locked at graduation, so creator supply and team allocations are the open question — and they are ours.",
  "<b>Free to integrate.</b> " + doc("embed", "An embed widget") + " and " + doc("api", "a REST API") + ", with partners earning half the fee on what they generate.",
])}

${cta("Lock with a flat fee", "0.005 ETH whatever your position is worth. No percentage, ever — and a proof page anyone can open without a wallet.")}

${h2("What no lock can tell you")}
${p(`A lock on any platform is evidence about one balance. It says nothing about the token contract or how
the rest of the supply is distributed.
${blog("rug-pull-red-flags-checklist", "The checks that sit either side of a lock")} matter as much as the
lock itself.`)}

<p class="dim" style="font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:30px;padding-top:14px">
HoodLock is not affiliated with StonkBrokers. Terms described here come from their published material as of
2026-07-29 and change over time — verify on-chain before relying on them. Dollar figures are arithmetic on
the published percentages, shown for scale, not quotes.</p>
`,
  related: [
    { href: "/docs/fees", title: "Fees", note: "flat, and why that matters" },
    { href: "/docs/liquidity-locker", title: "Liquidity locker" },
    { href: "/docs/security", title: "Security model" },
    { href: "/blog/how-to-choose-a-token-locker", title: "How to choose a token locker" },
  ],
};
