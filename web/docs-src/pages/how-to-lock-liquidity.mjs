import { h2, h3, p, ul, steps, table, info, warn, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "how-to-lock-liquidity",
  navTitle: "Lock LP tokens",
  seoTitle: "Lock LP Tokens with HoodLock | Step-by-Step",
  desc: "Find your LP token address, confirm it is a v2-style ERC-20 position, and lock it in the HoodLock app. With the checks that catch a wrong address first.",
  updated: "2026-07-29",
  h1: 'Lock <span class="serif">LP tokens.</span>',
  lede: "An LP token from a v2-style pool is an ordinary ERC-20, so locking it uses the same flow as any other token. The work is in identifying the right one.",
  body: `
${info(`<p>New to the idea? ${blog("what-is-a-liquidity-lock", "What a liquidity lock is")} covers why it
matters and ${blog("what-are-lp-tokens", "what LP tokens actually are")} covers the mechanics. This page is
the procedure.</p>`)}

${h2("First: confirm you can lock it")}
${p(`Only v2-style positions are ERC-20 tokens. Uniswap v3 and v4 positions are NFTs and cannot be held by
the locker — no amount of trying will make that work, so check before you start.`)}
${table(["Check", "v2-style (lockable)", "v3 / v4 (not lockable)"], [
  ["Appears in your wallet as a token balance", "Yes", "No"],
  ["Symbol", "<code>UNI-V2</code>, <code>SLP</code> or similar", "None — it is an NFT"],
  ["Pair contract has <code>totalSupply()</code>", "Yes", "No"],
])}
${p(`${doc("liquidity-locker", "The liquidity locker page")} goes into how to tell them apart in more
detail, including what to do if your launchpad already locked the position for you.`)}

${h2("Find the LP token address")}
${p(`This is the step people get wrong, because there are two addresses in play and only one is right.`)}
${warn(`<p>You need the <b>pair contract address</b>, not the address of either token in the pair. Locking
requires the LP token itself — the thing minted to you when you added liquidity.</p>`)}
${ul([
  "<b>From your wallet.</b> The LP balance is usually listed with the pair symbol. Copy its contract address from there.",
  "<b>From the DEX.</b> Open your position and copy the pool or pair address.",
  "<b>From the explorer.</b> On the pair contract, <code>token0()</code> and <code>token1()</code> should return the two tokens you supplied. If they do, you have the right address.",
])}

${h2("Lock it")}
${steps([
  `<b>Open the locker.</b> Go to ${app("locks", "the lock form")} and connect the wallet holding the LP tokens.`,
  `<b>Paste the LP token address.</b> The form will resolve it and show the pair, which is your
   confirmation that you have the right contract. If it shows something you do not recognise, stop and
   re-check the address.`,
  `<b>Enter the amount.</b> <b>Max</b> locks the whole position. Locking all of it is the common choice
   here — a partially locked pool answers the question only partially.`,
  `<b>Pick an unlock date.</b> Long enough to outlast whatever people are worried about. See below.`,
  `<b>Approve, then lock.</b> Two transactions: authorise the amount, then create the lock.`,
  `<b>Publish the proof link.</b> Put it where buyers look — pinned post, docs, listing applications.
   ${doc("proof-of-lock", "Proof of lock")} covers the shape.`,
])}

${h2("Choosing the duration")}
${p(`There is no correct number, but there are defensible ones. A pool locked for thirty days says the
team plans to be around for thirty days, and readers will treat it exactly that literally.`)}
${ul([
  "<b>Match your roadmap.</b> A lock that expires before your first milestone invites the obvious question.",
  "<b>Extend rather than over-promise.</b> Dates move later but never earlier, so a shorter lock you extend as you ship builds a record that a single long lock cannot.",
  "<b>Say when it expires.</b> Someone will notice the date regardless. Naming it yourself costs nothing and reads better.",
])}
${p(`${blog("how-long-should-you-lock-liquidity", "How long should you lock liquidity")} works through the
trade-off properly.`)}

${h2("After locking")}
${ul([
  "The pool keeps trading. Locking the LP token does not freeze the pool — swaps, fees and price all continue as normal.",
  "Fees accrued to a v2 position stay in the reserves and are realised when the LP is eventually withdrawn.",
  "The lock is visible in " + doc("lock-explorer", "the explorer") + " immediately.",
])}
${warn(`<p>Locking liquidity says nothing about the token contract itself. A locked pool on a token that
can be minted at will is not the reassurance it appears to be —
${blog("how-to-verify-a-token-contract-on-blockscout", "read the contract")} as well.</p>`)}

${cta("Lock your LP tokens", "Same flat 0.005 ETH as any lock, and a proof page anyone can open without a wallet.")}
`,
  related: [
    { href: "/docs/liquidity-locker", title: "Liquidity locker" },
    { href: "/docs/how-to-extend-a-lock", title: "Extend a lock" },
    { href: "/blog/how-to-check-if-liquidity-is-locked", title: "How to check if liquidity is locked" },
    { href: "/blog/burning-vs-locking-liquidity", title: "Burning vs locking liquidity" },
  ],
};
