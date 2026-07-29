import { h2, h3, p, ul, table, info, warn, doc, blog, cta } from "../components.mjs";

export default {
  slug: "liquidity-locker",
  navTitle: "Liquidity locker",
  seoTitle: "Liquidity Locker on Robinhood Chain | Lock LP Tokens",
  desc: "Lock v2-style LP tokens on Robinhood Chain and prove the pool cannot be pulled. What is lockable, what is an NFT, and how to tell them apart.",
  updated: "2026-07-29",
  h1: 'Liquidity <span class="serif">locker.</span>',
  lede: "Withdrawable liquidity is the single strongest reason a buyer walks away from a young token. Locking the LP position settles it — if the position is the kind that can be locked.",
  body: `
${h2("Why liquidity is the first question")}
${p(`Someone deciding whether to buy wants to know one thing before anything else: can the pool disappear.
If the LP tokens sit in a wallet, they can, in a single transaction. Nothing on-chain distinguishes a
creator who intends to pull from one who never would.`)}
${p(`A lock removes the question rather than answering it. The pool cannot be withdrawn until the date,
and anyone can confirm that without contacting you.`)}

${h2("Which positions can be locked")}
${p(`This is the part that trips people up, and it depends entirely on which kind of pool you are in.`)}
${table(["Pool type", "What you hold", "Lockable here"], [
  ["Uniswap v2 style (including SushiSwap v2 pools)", "An <b>ERC-20 LP token</b>", "<b>Yes</b>"],
  ["Uniswap v3", "An <b>NFT</b> position", "No"],
  ["Uniswap v4", "An <b>NFT</b> position", "No"],
])}
${p(`HoodLock's locker holds ERC-20 tokens. A v2 LP token is one, so it locks exactly like any other
balance. A v3 or v4 position is an NFT and cannot be held by this contract.`)}
${info(`<p>Robinhood Chain has a large Uniswap v2 deployment — tens of thousands of pairs — so v2 LP
locking is a real, common case here, not a legacy footnote. Whether <i>your</i> pool is v2 depends on
where your token launched.</p>`)}

${h2("How to tell which you have")}
${ul([
  "<b>Look in your wallet.</b> A v2 LP position shows up as a token balance, usually with a symbol like <code>UNI-V2</code> or <code>SLP</code>. A v3 or v4 position does not appear as a token at all.",
  "<b>Check the pair on the explorer.</b> A v2 pair contract has <code>token0()</code>, <code>token1()</code> and <code>totalSupply()</code>. If it has <code>totalSupply</code>, it mints LP tokens.",
  "<b>Check where you launched.</b> Most launchpads on this chain graduate to v3, and most of them already lock or burn the position for you — in which case there is nothing left for you to do.",
])}
${p(`${blog("how-to-check-if-liquidity-is-locked", "How to check if liquidity is locked")} walks through
verifying someone else's pool, which is the same skill applied to a token you did not launch.`)}

${h2("If your launchpad already handled it")}
${p(`Several platforms lock or burn liquidity permanently at graduation. If yours did, the liquidity
question is closed and locking again is not possible — the position is not yours to move.`)}
${p(`What usually remains in that case is different: fee revenue accruing to your wallet, a creator buy
from the curve, or a treasury. Those are ordinary ERC-20 balances and they are what a holder looks at
once liquidity is settled. The per-platform guides cover this launchpad by launchpad — see
${blog("lock-lp-tokens-from-a-hood-launcher-classic-launch", "the Hood Launcher guide")} for the one case
on this chain where the creator is handed withdrawable LP directly.`)}

${h2("Choosing a duration")}
${p(`Long enough to outlast the thing people are worried about. A pool locked for a month says the team
plans to be around for a month.`)}
${warn(`<p>Unlock dates extend but never shorten. Start with a duration you are sure of and push it out as
you ship — a lock extended three times reads better than one long lock set once, because the first is a
record of behaviour and the second is a single decision. See ${doc("how-to-extend-a-lock", "extending a lock")}.</p>`)}

${h2("Locking it")}
${p(`The LP token is just a token, so the flow is the ordinary one: paste the LP token address, choose an
amount and a date, approve, lock. Full steps in ${doc("how-to-lock-liquidity", "lock LP tokens")}.`)}
${cta("Lock LP tokens", "Same flat 0.005 ETH as any other lock, and the same proof page anyone can open.")}
`,
  related: [
    { href: "/docs/how-to-lock-liquidity", title: "How to lock LP tokens" },
    { href: "/docs/token-locker", title: "Token locker" },
    { href: "/blog/what-are-lp-tokens", title: "What LP tokens actually are" },
    { href: "/blog/burning-vs-locking-liquidity", title: "Burning vs locking liquidity" },
  ],
};
