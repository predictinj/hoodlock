import { h2, p, ul, cards, info, doc, blog, app } from "../components.mjs";

const faq = (q, slug) => `<li><a href="/docs/faq#${slug}">${q}</a></li>`;

export default {
  slug: "",
  navTitle: "Docs",
  seoTitle: "HoodLock Documentation | Token Locking on Robinhood Chain",
  desc: "Documentation for locking, burning and vesting tokens on Robinhood Chain: guides, contract reference, REST API, embed widget and 62 answered questions.",
  updated: "2026-07-29",
  h1: 'Hood<span class="serif">Lock</span> documentation.',
  lede: "Everything about locking, burning and vesting tokens on Robinhood Chain — how to do it, what it guarantees, and how anyone can verify it without asking you.",
  body: `
${info(`New here? ${doc("quickstart", "The quickstart")} gets you from an empty page to a shareable proof
link in about a minute. Press <code>/</code> anywhere in these docs to search.`)}

${h2("Start here")}
${cards([
  { href: "/docs/quickstart", title: "Quickstart", desc: "Connect, lock, share the proof. The shortest path, with the reasoning linked rather than inlined." },
  { href: "/docs/fees", title: "Fees", desc: "One flat fee in ETH, charged once. No percentage of your tokens, and free withdrawals." },
  { href: "/docs/security", title: "Security model", desc: "What the contracts allow and forbid, and how to verify each claim yourself in five minutes." },
])}

${h2("Products")}
${cards([
  { href: "/docs/token-locker", title: "Token locker", desc: "Hold any ERC-20 until a date. Extend-only, non-custodial, with a public proof page." },
  { href: "/docs/liquidity-locker", title: "Liquidity locker", desc: "Lock v2-style LP tokens and settle the question buyers ask first." },
  { href: "/docs/token-vesting", title: "Token vesting", desc: "Irrevocable linear release with an optional cliff, for teams and contributors." },
  { href: "/docs/token-burning", title: "Token burning", desc: "Remove supply permanently, with an indexed record rather than a lone transfer." },
  { href: "/docs/proof-of-lock", title: "Proof of lock", desc: "The public page every record gets — live from the chain, no wallet needed." },
  { href: "/docs/lock-explorer", title: "Lock explorer", desc: "Every lock, burn and schedule on the chain, searchable by token or wallet." },
])}

${h2("Guides")}
${p(`Task by task, in the order people usually need them.`)}
${cards([
  { href: "/docs/how-to-lock-tokens", title: "Lock tokens", desc: "The full walkthrough, including how to choose a date you can defend." },
  { href: "/docs/how-to-lock-liquidity", title: "Lock LP tokens", desc: "Identify the right pair address and confirm the position is lockable at all." },
  { href: "/docs/how-to-create-vesting", title: "Create a vesting schedule", desc: "Four numbers, one irrevocable signature. What to check before it." },
  { href: "/docs/how-to-burn-tokens", title: "Burn tokens", desc: "Permanent by construction. Read it before you sign, not during." },
  { href: "/docs/how-to-extend-a-lock", title: "Extend a lock", desc: "Free, unlimited, and a stronger signal than one long lock set once." },
  { href: "/docs/how-to-verify-a-lock", title: "Verify someone else's lock", desc: "Four checks that separate a real commitment from a claim shaped like one." },
])}

${h2("For developers")}
${p(`Add locking to your own product and earn half the fee on what it generates.`)}
${cards([
  { href: "/docs/embed", title: "Embed widget", desc: "One script tag and a button. Your styling stays yours — we only render the modal." },
  { href: "/docs/api", title: "REST API", desc: "Prepared transactions for lock, burn and vesting if you want your own interface." },
  { href: "/docs/contracts", title: "Contracts", desc: "Verified addresses, functions, events and the guarantees each one enforces." },
  { href: "/docs/network", title: "Network", desc: "Chain id, RPC, explorer, deploy blocks and the indexing limits that matter." },
])}

${h2("Comparisons")}
${p(`Where HoodLock fits, and where it does not. Written from published terms only — where we could not
verify a claim about another platform, the page says so rather than filling the gap.`)}
${cards([
  { href: "/docs/vs/stonkbrokers", title: "vs StonkBrokers", desc: "Also on this chain, and it locks the v3 and v4 positions we cannot. Mostly complementary." },
  { href: "/docs/vs/multi-chain-lockers", title: "vs multi-chain lockers", desc: "Team Finance, PinkLock and the rest do not list Robinhood Chain. What to check before assuming." },
  { href: "/docs/vs/diy-locking", title: "vs locking it yourself", desc: "A timelock is twenty lines. An honest look at the other ninety percent of the job." },
])}

${h2("Common questions")}
<ul>
${faq("Can locked tokens be withdrawn early?", "can-locked-tokens-be-withdrawn-early")}
${faq("Who owns locked tokens?", "who-owns-locked-tokens")}
${faq("Can the team unlock tokens early?", "can-the-team-unlock-tokens-early")}
${faq("Can I extend a lock?", "can-i-extend-a-lock")}
${faq("Can HoodLock take my tokens?", "can-hoodlock-take-my-tokens")}
${faq("How do investors verify a lock?", "how-do-investors-verify-a-lock")}
${faq("Can a vesting schedule be cancelled?", "can-a-vesting-schedule-be-cancelled")}
${faq("Why can't I lock my Uniswap v3 position?", "why-cant-i-lock-my-uniswap-v3-position")}
</ul>
${p(`All 62 are on the ${doc("faq", "FAQ page")}, grouped by what you are trying to work out.`)}

${h2("Background reading")}
${p(`The documentation covers how HoodLock works. ${doc("learn", "Learn")} covers the underlying subject —
what locking proves, how to read a holder list, what a cliff signals, and how each launchpad on this chain
handles creator supply. Thirty-five articles, arranged by decision rather than by date.`)}
${ul([
  blog("what-is-a-liquidity-lock", "What is a liquidity lock?") + " — the concept, and its limits",
  blog("how-to-check-if-liquidity-is-locked", "How to check if liquidity is locked") + " — the buyer's five-minute check",
  blog("rug-pull-red-flags-checklist", "Rug pull red flags") + " — what to look at besides a lock",
  blog("token-locks-vs-vesting-vs-burning", "Locks vs vesting vs burning") + " — choosing between the three",
])}

${h2("Open the app")}
${p(`Documentation is only useful next to the thing it documents: ${app("locks", "lock tokens")},
${app("vesting", "create vesting")}, ${app("burn", "burn tokens")} or
${app("explore", "browse the explorer")}.`)}
`,
  related: null,
};
