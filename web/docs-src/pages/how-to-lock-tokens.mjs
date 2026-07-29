import { h2, h3, p, ul, steps, table, info, warn, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "how-to-lock-tokens",
  navTitle: "Lock tokens",
  seoTitle: "How to Lock Tokens on Robinhood Chain | HoodLock Docs",
  desc: "Step-by-step: lock any ERC-20 on Robinhood Chain, choose an unlock date you can defend, and share a proof link that opens without a wallet.",
  updated: "2026-07-29",
  h1: 'How to <span class="serif">lock tokens.</span>',
  lede: "Locking moves a balance into a contract that will only release it back to you, and only on or after a date you set. It takes two transactions and about a minute.",
  body: `
${h2("Before you start")}
${ul([
  `The wallet holding the tokens, connected to Robinhood Chain. See ${doc("connect-wallet", "connecting a wallet")} if the network is not in your wallet yet.`,
  `A little ETH for gas, plus the flat fee, currently 0.005 ETH, read live from the contract. See ${doc("fees", "fees")}.`,
  "The token's contract address, if it is not already in your wallet's token list.",
])}

${h2("Lock the tokens")}
${steps([
  `<b>Open the locker.</b> Go to ${app("locks", "the lock form")} and connect your wallet.`,
  `<b>Pick the token.</b> Choose it from your wallet's balances, or paste the contract address. Take the
   address from the project's own site or the DEX pair — never from a chat message, where lookalike
   addresses are a standard scam.`,
  `<b>Enter an amount.</b> <b>Max</b> fills in the whole balance. You can lock part of a holding and keep
   the rest liquid; most teams do.`,
  `<b>Choose an unlock date.</b> The presets cover the common cases. Anything in the future is valid.`,
  `<b>Approve, then lock.</b> The first transaction lets the contract move that amount of that token; the
   second creates the lock. Two prompts, in that order.`,
  `<b>Share the proof link.</b> Every lock gets a page that reads live from the chain and opens without a
   wallet. That link is the part that does the work. See ${doc("proof-of-lock", "proof of lock")}.`,
])}

${h2("Choosing a date you can defend")}
${p(`An unlock date is a claim about how long you intend to stay. The number matters less than whether it
survives contact with a sceptical holder.`)}
${table(["Situation", "A defensible starting point"], [
  ["Creator allocation after a launch", "6–12 months, extended as you ship"],
  ["Treasury the project needs to spend from", "Several tranches on different dates, not one block"],
  ["Team and contributor supply", "Vesting instead. See below"],
  ["LP tokens from a v2-style pool", "At least as long as your roadmap's first milestone"],
])}
${info(`<p>Unlock dates can be pushed further out but <b>never pulled in</b>. That asymmetry is worth using:
a shorter first lock you extend as you deliver builds a public record that a single long lock does not.
See ${doc("how-to-extend-a-lock", "extending a lock")}.</p>`)}

${h2("When locking is the wrong tool")}
${p(`A lock releases everything on one date. That is the right shape for a single allocation you intend to
hold, and the wrong shape for supply going to several people over time.`)}
${ul([
  `<b>Use ${doc("token-vesting", "vesting")}</b> for team and contributor allocations — gradual release with an
   optional cliff says something about time rather than about a single day.`,
  `<b>Use ${doc("token-burning", "burning")}</b> when the supply should never come back. Burning is irreversible;
   locking is not.`,
])}
${p(`${blog("token-locks-vs-vesting-vs-burning", "Locks vs vesting vs burning")} compares the three in full.`)}

${h2("What cannot be locked")}
${p(`HoodLock's locker holds ERC-20 tokens. That covers project tokens, treasury balances and v2-style LP
tokens, which are themselves ERC-20.`)}
${warn(`A Uniswap v3 or v4 liquidity position is an <b>NFT</b>, not an ERC-20, so it cannot be locked here.
Many launchpads on this chain already lock or burn those positions at graduation. ${doc("how-to-lock-liquidity", "Locking LP tokens")}
explains how to tell which kind you hold.`)}

${h2("After the lock")}
${ul([
  `The lock appears in ${app("locks", "My locks")} and in ${doc("lock-explorer", "the explorer")}.`,
  `Withdrawal becomes available at the unlock time, to the lock's owner only. Nothing happens automatically. See ${doc("when-a-lock-expires", "when a lock expires")}.`,
  "Ownership of the lock can be transferred; the tokens stay where they are.",
])}

${cta("Lock tokens now", "Flat 0.005 ETH, no percentage of your tokens, and a proof link anyone can open without a wallet.")}
`,
  related: [
    { href: "/docs/proof-of-lock", title: "Proof of lock", note: "the link you share" },
    { href: "/docs/how-to-extend-a-lock", title: "Extend a lock" },
    { href: "/docs/fees", title: "Fees" },
    { href: "/blog/how-long-should-you-lock-liquidity", title: "How long should you lock?" },
  ],
};
