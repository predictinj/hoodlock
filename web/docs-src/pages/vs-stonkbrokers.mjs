import { h2, p, ul, table, info, warn, doc, blog } from "../components.mjs";

export default {
  slug: "vs/stonkbrokers",
  navTitle: "vs StonkBrokers",
  seoTitle: "HoodLock vs StonkBrokers | Which Locker Fits Your Position",
  desc: "Both run on Robinhood Chain and they hold different assets. What each covers, how the pricing models differ, and which question you are actually asking.",
  updated: "2026-07-29",
  h1: 'HoodLock vs <span class="serif">StonkBrokers.</span>',
  lede: "Both run on Robinhood Chain and they hold different things. What you are holding decides which question you are actually asking — so start there rather than with the platforms.",
  body: `
${info(`<p>Everything below comes from each platform's own published material as of 2026-07-29, and both
sets of contracts are on-chain and readable. Verify before relying on any of it — terms change.</p>`)}

${h2("What each one locks")}
${p(`This is the whole decision, and it is usually settled before price enters into it.`)}
${table(["Asset", "HoodLock", "StonkBrokers"], [
  ["Plain ERC-20 (creator supply, treasury, team tokens)", "<b>Yes</b>", "No"],
  ["Uniswap v2 style LP tokens", "<b>Yes</b>", "No"],
  ["Uniswap v3 LP position NFTs", "No", "<b>Yes</b>"],
  ["Uniswap v4 native-ETH liquidity", "No", "<b>Yes</b>"],
  ["Token vesting schedules", "<b>Yes</b>", "Not offered"],
  ["Token burning with a record", "<b>Yes</b>", "Not offered"],
])}
${p(`HoodLock's locker holds ERC-20 tokens, which is why a v3 or v4 position — an NFT — falls outside it.
If your launchpad graduated you to a v3 pool, check what it did with the position first: most lock or burn
it at graduation, in which case the liquidity question is already settled and what remains is your creator
supply.`)}
${p(`${doc("liquidity-locker", "The liquidity locker page")} explains how to tell which kind of position
you have, which is worth doing before you choose a platform.`)}

${h2("Pricing")}
${table(["", "HoodLock", "StonkBrokers"], [
  ["Model", "Flat fee in ETH", "Percentage of the position, or of collected fees"],
  ["Cost", "0.005 ETH per lock, burn or schedule", "0.5% of locked liquidity at lock time, <b>or</b> 20% of every swap-fee collect"],
  ["Scales with position size", "No", "Yes"],
  ["Withdrawal", "Free", "—"],
])}
${p(`The models differ in kind rather than degree. A flat fee costs the same on a large treasury as on a
small one; a percentage does not. Conversely, a percentage-of-fees model can be cheaper for a position
that never collects much.`)}
${warn(`<p>The 20% option is charged on <b>every</b> collect for the life of the lock, not once. On a pool
with real volume, that compounds into a materially different number from the 0.5% upfront option. Model
both against your expected volume rather than assuming the smaller percentage is cheaper.</p>`)}

${h2("Custody")}
${p(`Both platforms publish contracts you can read, and both state that no admin key can seize locked
liquidity. Ours is checkable rather than asserted: all three contracts are verified on Blockscout, and the
vesting contract was built against a written threat model with a full test suite.`)}
${p(`${doc("security", "The security model")} names the exact functions to search for and what you should
find — that is the check worth running on any locker, ours included.`)}

${h2("What this means in practice")}
${p(`A project that graduated to a v3 pool typically has two separate things to think about: the pool
position, and the creator supply sitting in a wallet. They are different commitments.`)}
${table(["If you hold…", "Where it stands"], [
  ["Creator, team or treasury tokens", "Lock or vest with HoodLock"],
  ["A v2-style LP token", "Lock with HoodLock"],
  ["A vesting schedule for contributors", "HoodLock, single or batched"],
  ["A Uniswap v3 or v4 position NFT", "Outside what HoodLock holds. Check what your launchpad did with it — most lock or burn it at graduation."],
])}
${p(`The last row is worth checking before anything else: if the position was locked at graduation, it is
not yours to move and there is nothing left to do. What usually remains is the creator supply, which is
exactly what ${doc("token-locker", "the locker")} is for.`)}

${h2("What neither of us can tell you")}
${p(`A lock on either platform is evidence about one position. It says nothing about the token contract,
the distribution of the remaining supply, or the people behind the project.
${blog("rug-pull-red-flags-checklist", "The checks that sit either side of a lock")} matter at least as
much as the lock itself.`)}

<p class="dim" style="font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:30px;padding-top:14px">
HoodLock is not affiliated with StonkBrokers. Terms described here come from their published material as of
2026-07-29 and change over time — verify at
<a href="https://stonkbrokers.cash/locker" target="_blank" rel="noopener">stonkbrokers.cash/locker</a> and
on-chain before relying on them.</p>
`,
  related: [
    { href: "/docs/liquidity-locker", title: "Liquidity locker", note: "which position do you have?" },
    { href: "/docs/fees", title: "Fees" },
    { href: "/docs/security", title: "Security model" },
    { href: "/blog/how-to-choose-a-token-locker", title: "How to choose a token locker" },
  ],
};
