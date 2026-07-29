import { h2, p, ul, table, info, warn, doc, blog } from "../components.mjs";

export default {
  slug: "vs/stonkbrokers",
  navTitle: "vs StonkBrokers",
  seoTitle: "HoodLock vs StonkBrokers | Which Locker Fits Your Position",
  desc: "Both run on Robinhood Chain and they lock different things. A factual comparison of asset support and pricing, from each platform's own published terms.",
  updated: "2026-07-29",
  h1: 'HoodLock vs <span class="serif">StonkBrokers.</span>',
  lede: "The honest headline: these two barely overlap. StonkBrokers locks the positions we cannot, and we lock the ones it does not. Which you need is decided by what you are holding, not by which is better.",
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
${p(`HoodLock's locker holds ERC-20 tokens, which is why a v3 position — an NFT — is out of reach for it.
StonkBrokers built for exactly that case. If your launchpad graduated you to a v3 pool and handed you the
position, they are the ones who can hold it.`)}
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

${h2("Custody and admin")}
${p(`Both platforms state that no admin key can seize locked liquidity, and both publish contracts you can
read. StonkBrokers has been audited by HashLock and publishes the report.`)}
${p(`HoodLock's contracts are verified on Blockscout, and the vesting contract was built against a written
threat model with a full test suite. <b>We have not had a third-party audit</b>, and we do not describe
verification as one — ${doc("security", "the security model")} is explicit about the difference and about
which functions to read for yourself.`)}
${info(`<p>If a third-party audit is a hard requirement for your treasury or your investors, that is a real
and legitimate reason to prefer an audited platform for the assets it supports. We would rather say that
than pretend the distinction does not exist.</p>`)}

${h2("Choosing")}
${table(["If you hold…", "Use"], [
  ["Creator, team or treasury tokens", "HoodLock"],
  ["A v2-style LP token", "HoodLock"],
  ["A Uniswap v3 or v4 position NFT", "StonkBrokers"],
  ["A vesting schedule for contributors", "HoodLock"],
  ["Both a v3 position and a team allocation", "Both — they are not alternatives"],
])}
${p(`That last row is the common case and it is not a diplomatic dodge. A project that graduated to v3
typically has a pool position <i>and</i> creator supply sitting in a wallet, and those are two separate
commitments requiring two different tools.`)}

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
