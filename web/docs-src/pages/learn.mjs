import { h2, p, cards, info, doc } from "../components.mjs";

/* The Learn hub is navigation, not content.
 *
 * Every topic here already has a written article on /blog. Writing a second
 * version under /docs would put two of our own URLs in front of the same query,
 * and Google would pick one, so both would lose. This page routes to the
 * existing articles instead, which concentrates authority rather than splitting
 * it, and keeps /docs for product documentation where the intent is different.
 */
const b = (slug, title, desc) => ({ href: `/blog/${slug}`, title, desc });

const SECTIONS = [
  ["Start here", "The ideas everything else assumes.", [
    b("what-is-a-liquidity-lock", "What is a liquidity lock?", "Why locking exists, what it proves, and what it deliberately does not."),
    b("what-are-lp-tokens", "What LP tokens actually are", "The receipt a pool gives you, and why it is the thing worth locking."),
    b("token-locks-vs-vesting-vs-burning", "Locks vs vesting vs burning", "Three different promises. Which one your situation actually calls for."),
    b("circulating-vs-total-supply", "Circulating vs total supply", "The gap between the two is where most misleading tokenomics live."),
  ]],
  ["For people buying", "How to check a project before you trust it.", [
    b("how-to-check-if-liquidity-is-locked", "How to check if liquidity is locked", "A five-minute check that separates a real lock from a claim."),
    b("how-to-check-if-liquidity-is-burned", "How to check if liquidity is burned", "Burned and locked are different commitments with different risks."),
    b("how-to-read-token-holder-distribution", "Reading holder distribution", "Who can move the price, and which addresses to discount."),
    b("how-to-verify-a-token-contract-on-blockscout", "Reading a contract on Blockscout", "What to look for in the source, and what unverified really means."),
    b("what-is-a-honeypot-token", "Honeypot tokens", "Tokens you can buy and cannot sell, and how to spot one first."),
    b("rug-pull-red-flags-checklist", "Rug pull red flags", "The checks you can run yourself, in order of how much they tell you."),
  ]],
  ["For people launching", "Decisions that are cheaper to get right than to fix.", [
    b("token-launch-checklist-robinhood-chain", "Token launch checklist", "What to have in place before the pool opens, not after."),
    b("how-to-prove-your-project-wont-rug", "How to prove you won't rug", "Verifiable commitments beat trust claims, because nobody believes those."),
    b("team-token-allocation-benchmarks", "Allocation benchmarks", "What sizes and schedules survive scrutiny, with the reasoning."),
    b("how-long-should-you-lock-liquidity", "How long should you lock?", "Durations that hold up, and what a short one signals."),
    b("locking-treasury-and-ecosystem-funds", "Locking treasury funds", "Committing a treasury without losing the ability to spend it."),
    b("how-to-choose-a-token-locker", "How to choose a locker", "The contract properties that decide whether a locker actually locks."),
  ]],
  ["Vesting in depth", "Schedules, cliffs and how holders read them.", [
    b("how-to-set-up-token-vesting", "Setting up vesting that holds", "Structuring a schedule for team, advisors and contributors."),
    b("what-is-a-vesting-cliff", "What a vesting cliff is", "Why the cliff, not the total, is the number holders look for."),
    b("what-is-a-token-unlock-schedule", "What an unlock schedule tells you", "Publishing one in advance, and reading someone else's."),
  ]],
  ["Mechanics", "What happens at the edges.", [
    b("what-happens-when-a-token-lock-expires", "When a lock expires", "How markets behave around unlock dates, and how to plan for it."),
    b("burning-vs-locking-liquidity", "Burning vs locking liquidity", "Permanent versus a deadline, and when each is the honest choice."),
    b("custodial-vs-non-custodial-locking", "Custodial vs non-custodial", "Who holds the tokens, and why the distinction is not academic."),
    b("how-to-lock-liquidity-on-robinhood-chain", "Locking liquidity on Robinhood Chain", "The general walkthrough, independent of any one platform."),
    b("how-to-burn-tokens-on-robinhood-chain", "Burning tokens with proof", "Removing supply permanently and making it checkable."),
  ]],
];

const LAUNCHPADS = [
  ["lock-dev-tokens-after-a-pons-launch", "Pons"],
  ["lock-lp-tokens-from-a-hood-launcher-classic-launch", "Hood Launcher"],
  ["lock-tokens-launched-on-hood-fun", "hood.fun"],
  ["lock-tokens-launched-on-robinfun", "Robinfun"],
  ["lock-tokens-launched-on-robinlaunch", "Robinlaunch"],
  ["vesting-alongside-a-bankr-launch", "Bankr"],
  ["lock-tokens-launched-on-lemon-fun", "Lemon.fun"],
  ["lock-tokens-launched-on-openfair", "Openfair"],
  ["lock-tokens-launched-on-metalaunch", "MetaLaunch"],
  ["lock-tokens-launched-on-arrowpad", "ArrowPad"],
  ["lock-creator-tokens-after-a-fendex-launch", "Fendex"],
];

export default {
  slug: "learn",
  navTitle: "Learn",
  seoTitle: "Learn About Token Locking on Robinhood Chain | HoodLock",
  desc: "A guided path through everything we have written on locking, vesting, burning and verifying tokens — organised by what you are trying to work out.",
  updated: "2026-07-29",
  h1: 'Learn.',
  lede: "Thirty-five articles, arranged by what you are trying to decide rather than by when they were written. Start wherever your question is.",
  body: `
${info(`These are longer-form explanations. If you want the product documentation instead — how HoodLock
itself works, what it costs and what the contracts guarantee — start at ${doc("quickstart", "the quickstart")}
or browse the sidebar.`)}

${SECTIONS.map(([title, sub, items]) => h2(title) + p(sub) + cards(items)).join("")}

${h2("Locking after a launchpad launch")}
${p(`Every launchpad on Robinhood Chain handles liquidity and creator supply differently, and the
difference decides what is actually left worth locking. One guide per platform, written from each one's
own published mechanics, including the cases where the honest answer is that nothing needs locking.`)}
${cards(LAUNCHPADS.map(([slug, name]) => ({
  href: `/blog/${slug}`,
  title: name,
  desc: "What the platform covers, what stays in your wallet, and which of the two matters.",
})))}
`,
  related: [
    { href: "/docs/faq", title: "FAQ", note: "shorter answers to specific questions" },
    { href: "/docs/quickstart", title: "Quickstart", note: "product documentation instead" },
    { href: "/blog", title: "All articles", note: "the full index" },
  ],
};
