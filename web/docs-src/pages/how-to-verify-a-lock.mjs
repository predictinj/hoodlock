import { h2, h3, p, ul, steps, table, info, warn, doc, blog, app } from "../components.mjs";

export default {
  slug: "how-to-verify-a-lock",
  navTitle: "Verify someone else's lock",
  seoTitle: "How to Verify a Token Lock on Robinhood Chain | HoodLock",
  desc: "Someone showed you a lock. Here is how to confirm it is real, that it covers the token you are actually buying, and that the amount means what they say.",
  updated: "2026-07-29",
  h1: 'Verify someone else\'s <span class="serif">lock.</span>',
  lede: "A screenshot proves nothing and a symbol proves less. Four checks, none of which need a wallet, separate a real commitment from a claim that merely looks like one.",
  body: `
${h2("Check the token address, not the ticker")}
${warn(`<p>This is the check that catches the most misdirection. Symbols are not unique and cost nothing to
copy — a lock page for a token called <code>$PEPE</code> is a lock on <b>whichever contract that page
names</b>, which may not be the one trading.</p>`)}
${steps([
  `<b>Get the real address.</b> Take it from the DEX pair you would actually buy from, or the project's
   own site. Not from a chat message and not from the screenshot.`,
  `<b>Compare it to the proof page.</b> Character for character, or at least the first and last six.`,
  `<b>If they differ, stop.</b> The lock is real and irrelevant — a locked balance of a lookalike token.`,
])}

${h2("Check the share of supply")}
${p(`Token counts are meaningless without a denominator. Ten million tokens sounds like a lot until the
supply turns out to be ten billion.`)}
${p(`Proof pages state the percentage of total supply directly, so this is usually one glance. If you are
reading a raw explorer transaction instead, divide the locked amount by <code>totalSupply()</code> on the
token contract.`)}
${info(`<p>For liquidity specifically, the number that matters is what share of the <b>pool</b> is locked,
not what share of the token supply. A pool with 90% of its LP locked and 10% loose can still be drained of
that 10%.</p>`)}

${h2("Check the date")}
${table(["What you see", "What it means"], [
  ["Unlock date far out", "A commitment, worth what the rest of the checks say"],
  ["Unlock date within weeks", "A countdown. Ask what happens on that day."],
  ["Already unlockable", "The tokens can be withdrawn right now. The lock is history, not a guarantee."],
  ["Withdrawn", "It ended. The page says so — read the status, not just the headline."],
])}
${p(`Locks can be extended but never shortened, so a date that has moved out since you last looked is a
real signal. ${doc("how-to-extend-a-lock", "Extending a lock")} explains the asymmetry.`)}

${h2("Check what is not locked")}
${p(`A lock is evidence about one balance. It says nothing about the rest of the supply, and that is
usually where the risk lives.`)}
${ul([
  "<b>Open the holder list.</b> " + blog("how-to-read-token-holder-distribution", "Reading holder distribution") + " covers what a healthy one looks like and what to discount.",
  "<b>Read the token contract.</b> A locked pool on a token that can be minted at will is not reassurance. " + blog("how-to-verify-a-token-contract-on-blockscout", "How to read a contract on Blockscout") + ".",
  "<b>Look for the rest of the team's supply.</b> One locked wallet and three unlocked ones is a different picture from what the one locked wallet suggests.",
])}

${h2("Search it yourself")}
${p(`You do not need a link from anyone. Paste the token address into ${app("explore", "the explorer")} and
you will see every lock, burn and vesting schedule against it, whoever created them. If a project claims a
lock that does not appear there, it was not made with HoodLock — which does not make it fake, but does
mean you should ask where it was made and verify it there.`)}

${h2("What a lock cannot tell you")}
${p(`Being precise about this is the difference between using locks well and over-trusting them.`)}
${table(["A lock proves", "A lock does not prove"], [
  ["Those tokens cannot move before that date", "That the token contract is safe"],
  ["Someone paid to commit publicly", "That the team is competent or honest"],
  ["The amount and the date, exactly", "That the remaining supply is well distributed"],
])}
${p(`${blog("rug-pull-red-flags-checklist", "The red-flag checklist")} covers the checks that sit either
side of this one.`)}
`,
  related: [
    { href: "/docs/proof-of-lock", title: "Proof of lock" },
    { href: "/docs/lock-explorer", title: "Lock explorer" },
    { href: "/blog/how-to-check-if-liquidity-is-locked", title: "How to check if liquidity is locked" },
    { href: "/blog/what-is-a-honeypot-token", title: "Honeypot tokens — and how to avoid one" },
  ],
};
