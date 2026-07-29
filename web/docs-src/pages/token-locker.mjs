import { h2, h3, p, ul, table, info, warn, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "token-locker",
  navTitle: "Token locker",
  seoTitle: "Token Locker for Robinhood Chain | HoodLock",
  desc: "A non-custodial locker for any ERC-20 on Robinhood Chain: one flat fee, an extend-only unlock date, and a public proof page for every lock.",
  updated: "2026-07-29",
  h1: 'Token <span class="serif">locker.</span>',
  lede: "Move a balance into a contract that will only ever release it back to you, and only on or after a date you choose. Everything about it is public except the ability to undo it.",
  body: `
${h2("What it does")}
${p(`The locker holds ERC-20 tokens against a record: an owner, a token, an amount and an unlock time.
Until that time passes, nothing can withdraw them, not the owner, not us. After it passes, only the
owner can.`)}
${p(`That is the whole product. Its value is not the holding, which is easy, but the fact that a stranger
can verify the holding without asking anyone.`)}

${h2("What it guarantees")}
${table(["Guarantee", "Enforced by"], [
  ["Only the lock's owner can withdraw", "<code>onlyLockOwner</code> on <code>withdraw</code>"],
  ["Not before the unlock time", "A timestamp check in <code>withdraw</code>"],
  ["No admin can move locked tokens", "The absence of any such function. There is nothing to disable"],
  ["The unlock date can only move later", "<code>extend</code> requires a strictly greater timestamp"],
  ["The recorded amount is the balance the contract gained", "Measured before and after the transfer. Correct for simple fee-on-transfer; <b>not</b> for rebasing or reflection tokens, which are unsupported"],
])}
${p(`Each of these is checkable in the source on Blockscout — the ${doc("contracts", "contract reference")}
names the exact functions.`)}

${h2("What it does not do")}
${ul([
  "It does not release tokens automatically. Withdrawal is a transaction the owner sends when they choose. See " + doc("when-a-lock-expires", "when a lock expires") + ".",
  "It does not stop a lock from being transferred. Ownership can move to another wallet; the tokens stay put.",
  "It does not make a token safe. A locked supply says nothing about the contract's transfer logic — that is a separate check.",
])}
${warn(`<p>A lock is evidence about one balance, not a verdict on a project. ${blog("rug-pull-red-flags-checklist", "The red-flag checklist")}
covers what else to look at.</p>`)}

${h2("What can be locked")}
${table(["Asset", "Lockable", "Why"], [
  ["Project tokens, treasury, creator supply", "Yes", "Ordinary ERC-20 balances."],
  ["v2-style LP tokens", "Yes", "A v2 pool position <i>is</i> an ERC-20 token."],
  ["Uniswap v3 / v4 positions", "No", "Those positions are NFTs, and the locker holds ERC-20s."],
])}
${p(`${doc("liquidity-locker", "Locking liquidity")} goes into which kind you are holding and how to tell.`)}

${h2("Cost")}
${p(`A flat fee per lock, currently 0.005 ETH, read live from the contract, plus gas. No percentage of
the tokens, at any point, including withdrawal. ${doc("fees", "Fees")} has the detail.`)}
${info(`<p>Changing the fee affects new locks only. An existing lock is never re-priced, and withdrawal is
always free.</p>`)}

${h2("The proof page")}
${p(`Every lock gets a URL that renders the current state straight from the chain: token, amount, share of
supply, unlock date and status. It opens without a wallet and without an account, which is what makes it
usable as evidence in a listing application or a community post.`)}
${p(`See ${doc("proof-of-lock", "proof of lock")}, or browse existing locks in ${doc("lock-explorer", "the explorer")}.`)}

${h2("Get started")}
${ul([
  doc("how-to-lock-tokens", "Lock tokens") + " — the step-by-step",
  doc("how-to-extend-a-lock", "Extend a lock") + " — pushing a date further out",
  doc("how-to-verify-a-lock", "Verify someone else's lock") + " — checking a claim you were shown",
])}
${cta("Lock tokens", "Flat 0.005 ETH, no percentage of your tokens, and a proof link anyone can open without a wallet.")}
`,
  related: [
    { href: "/docs/liquidity-locker", title: "Liquidity locker" },
    { href: "/docs/token-vesting", title: "Token vesting", note: "for supply released over time" },
    { href: "/docs/security", title: "Security model" },
    { href: "/blog/what-is-a-liquidity-lock", title: "What is a liquidity lock?" },
  ],
};
