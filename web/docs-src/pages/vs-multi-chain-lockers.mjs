import { h2, p, ul, table, info, warn, doc, blog } from "../components.mjs";

export default {
  slug: "vs/multi-chain-lockers",
  navTitle: "vs multi-chain lockers",
  seoTitle: "Can You Use Team Finance or PinkLock on Robinhood Chain?",
  desc: "The established multi-chain lockers do not list Robinhood Chain among their supported networks. What that means in practice and what to check before assuming.",
  updated: "2026-07-29",
  h1: 'Using an established locker on <span class="serif">Robinhood Chain.</span>',
  lede: "If you have launched before, you probably have a locker you already trust. The question is whether it reaches this chain — and for most of them, today, it does not.",
  body: `
${h2("The short answer")}
${p(`Robinhood Chain reached mainnet on 1 July 2026. The large multi-chain lockers have not, as of writing,
added it to their published network lists. A locker that does not support a chain cannot lock on it — there
is no workaround, because the contracts simply are not deployed there.`)}
${table(["Locker", "Published network support", "Robinhood Chain (4663)"], [
  ["Team Finance", "Ethereum, BNB Chain, Cronos, Fantom, Polygon", "Not listed"],
  ["PinkLock", "Ethereum, BNB Chain, Polygon and others", "Not listed"],
  ["FlokiFi", "15 EVM chains including Ethereum, BNB, Base, Arbitrum", "Not listed"],
])}
${warn(`<p>Network lists change, and this table is a snapshot taken on 2026-07-29 from each platform's own
published material. <b>Check the network selector on their site before concluding anything</b> — if one of
them has added the chain since, use whichever tool you prefer. We would rather you verified than took our
word for a competitor's roadmap.</p>`)}

${h2("Why chain support is not a formality")}
${p(`A locker is a set of deployed contracts, not a website. Supporting a new chain means deploying,
verifying and indexing there, and then supporting it operationally. It is a real decision with real cost,
which is why chains that launched four weeks ago are rarely on the list.`)}
${p(`It also means you cannot use a locker's reputation from another chain as evidence about this one. What
matters is the contract at the address your tokens would go to.`)}

${h2("What to check on any locker, including this one")}
${p(`If you are evaluating where to lock, these are the questions that actually separate lockers — and they
apply to us as much as to anyone.`)}
${ul([
  "<b>Is the contract verified on the chain's explorer?</b> If not, nothing else can be checked.",
  "<b>Is there a function that lets an admin move locked tokens?</b> Search the source for <code>withdraw</code>, <code>rescue</code> and <code>sweep</code>, and read who can call each.",
  "<b>Can an unlock date be shortened?</b> If it can, the date is a preference rather than a commitment.",
  "<b>What is the fee model, and is it capped?</b> A percentage of your tokens and a flat fee in ETH create very different incentives.",
  "<b>Can a stranger verify a lock without an account?</b> A lock nobody can check does not do the job you are paying for.",
])}
${p(`${blog("how-to-choose-a-token-locker", "How to choose a token locker")} works through each of these
properly, and ${doc("security", "our security model")} answers them for HoodLock with the specific
functions to read.`)}

${h2("What HoodLock covers")}
${table(["Asset", "Covered"], [
  ["Creator, team and treasury tokens (any ERC-20)", "<b>Yes</b>"],
  ["v2-style LP tokens, which are themselves ERC-20", "<b>Yes</b>"],
  ["Vesting schedules, single or batched", "<b>Yes</b>"],
  ["Token burning with an auditable record", "<b>Yes</b>"],
  ["Uniswap v3 and v4 positions", "No — those are NFTs, not ERC-20"],
])}
${info(`<p>If you hold a v3 or v4 position, check what your launchpad already did with it before looking
for somewhere to lock it. Most platforms on this chain lock or burn the position at graduation, in which
case it is no longer yours to move and the question is settled. ${doc("liquidity-locker", "The liquidity locker page")}
explains how to tell which kind of position you have.</p>`)}

${h2("If you would rather wait")}
${p(`That is a legitimate choice, and the trade-off is worth stating plainly. Waiting for a locker you
already trust means your tokens stay liquid and visible in a wallet in the meantime, which is exactly the
thing a lock is meant to resolve. Locking sooner with a platform you have verified yourself generally beats
locking later with one whose reputation you inherited from another chain.`)}
${p(`Either way, ${doc("how-to-verify-a-lock", "verify the lock")} once it exists.`)}

<p class="dim" style="font-size:12.5px;color:var(--dim);border-top:1px solid var(--line);margin-top:30px;padding-top:14px">
HoodLock is not affiliated with Team Finance, PinkLock, FlokiFi or StonkBrokers. Network support described
here is taken from each platform's own published material as of 2026-07-29 and changes over time — check
their own sites before relying on it.</p>
`,
  related: [
    { href: "/docs/vs/stonkbrokers", title: "HoodLock vs StonkBrokers" },
    { href: "/docs/security", title: "Security model" },
    { href: "/blog/how-to-choose-a-token-locker", title: "How to choose a token locker" },
    { href: "/blog/custodial-vs-non-custodial-locking", title: "Custodial vs non-custodial locking" },
  ],
};
