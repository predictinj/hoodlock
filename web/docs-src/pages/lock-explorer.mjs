import { h2, p, ul, table, info, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "lock-explorer",
  navTitle: "Lock explorer",
  seoTitle: "Lock Explorer | Browse Locks, Burns and Vesting on Robinhood Chain",
  desc: "Browse every lock, burn and vesting schedule on Robinhood Chain, search by token or wallet, and open the proof page for any record.",
  updated: "2026-07-29",
  h1: 'Lock <span class="serif">explorer.</span>',
  lede: "Every record HoodLock has ever created, in one list, readable without connecting anything.",
  body: `
${h2("What it shows")}
${p(`${app("explore", "The explorer")} lists locks, burns and vesting schedules together, newest first, with
the token, the amount, the date and the current status on each row. Clicking a row opens its
${doc("proof-of-lock", "proof page")}.`)}
${p(`Locks, burns and schedules are interleaved rather than separated, because the question a reader
usually has is “what has happened to this token”, not “show me one product”.`)}

${h2("Searching")}
${table(["Search by", "What you get"], [
  ["Token address", "Every record against that token, whoever created it"],
  ["Wallet address", "Every record created by that wallet, across tokens"],
])}
${info(`<p>Search takes a contract address, not a symbol. Symbols are not unique — several tokens on this
chain share one — so an address is the only unambiguous way to ask the question. Copy it from the DEX pair
or the project's own site rather than from a chat message.</p>`)}

${h2("Token pages")}
${p(`Tokens with enough on-chain history get a standing page that gathers every lock, burn and schedule
against them, along with supply and holder context. Those pages update as the chain does — a token with no
locks today will show them once they exist, without anyone republishing anything.`)}

${h2("Reading a row honestly")}
${p(`Three habits make the difference between using the explorer well and being misled by it.`)}
${ul([
  "<b>Read the share of supply, not the token count.</b> Large numbers are cheap; percentages are not.",
  "<b>Check the unlock date, not just that a lock exists.</b> A lock expiring next week is a countdown, not a commitment.",
  "<b>Look at what is <i>not</i> locked.</b> A locked position tells you about that balance only. " + blog("how-to-read-token-holder-distribution", "Holder distribution") + " tells you about the rest.",
])}

${h2("For the record")}
${p(`Everything the explorer displays is read from the chain at request time. It holds no private index of
its own and shows nothing that could not be reconstructed from the contracts directly — the
${doc("contracts", "contract reference")} lists the enumeration functions it uses.`)}

${cta("Browse the explorer", "Every lock, burn and vesting schedule on Robinhood Chain — no wallet needed.", "/app/explore", "Open explorer →")}
`,
  related: [
    { href: "/docs/proof-of-lock", title: "Proof of lock" },
    { href: "/docs/how-to-verify-a-lock", title: "Verify someone else's lock" },
    { href: "/blog/how-to-check-if-liquidity-is-locked", title: "How to check if liquidity is locked" },
  ],
};
