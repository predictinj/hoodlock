import { h2, p, ul, table, code, info, danger, doc, blog, cta } from "../components.mjs";

export default {
  slug: "token-burning",
  navTitle: "Token burning",
  seoTitle: "Token Burning on Robinhood Chain | HoodLock",
  desc: "Send tokens to the dead address with a permanent on-chain record. What burning proves, what it costs, and why it cannot be reversed.",
  updated: "2026-07-29",
  h1: 'Token <span class="serif">burning.</span>',
  lede: "Burning removes supply permanently. Not by policy — by arithmetic. Nothing can move tokens out of the dead address, including us.",
  body: `
${h2("What happens")}
${p(`The burner moves tokens from your wallet to the dead address in a single transfer and writes a record:
who burned, which token, how much, and when.`)}
${code(`0x000000000000000000000000000000000000dEaD`, "address")}
${p(`The tokens never rest in the burner contract. There is no intermediate custody step where something
could go wrong or where a privileged function could intervene — the transfer goes straight from you to an
address nobody holds the key to.`)}

${danger(`<p><b>This cannot be undone.</b> There is no recovery, no support ticket and no admin override.
The dead address has no owner, so there is no one to ask. Burn the amount you mean to burn.</p>`)}

${h2("Why burn through a contract at all")}
${p(`You could send tokens to the dead address yourself. The difference is the record.`)}
${ul([
  "A direct transfer is one line in a long transaction list that a reader has to find and interpret.",
  "A burn through the registry produces an indexed record and a proof page that states the amount, the share of supply it represented, and the transaction — readable by someone who has never used a block explorer.",
  "<code>totalBurnedOf(token)</code> gives a running total per token, so repeated burns add up to a number you can point at.",
])}

${h2("What burning proves, and what it does not")}
${table(["It proves", "It does not prove"], [
  ["That specific supply is permanently gone", "That the remaining supply is distributed well"],
  ["Nobody can sell those tokens", "That the token contract is safe to trade"],
  ["The team gave something up irreversibly", "That anything else about the project is committed"],
])}
${p(`Burning a large share of supply is a strong signal precisely because it is irreversible. It is also
the only one of the three products that gives you no way back, which is why it should be a considered
decision rather than a marketing gesture.`)}

${h2("Burning versus locking liquidity")}
${p(`For an LP position the two are genuinely different promises. A burn is permanent and needs no trust
at all; a lock is temporary and keeps the option to migrate the pool later. Neither is strictly better —
${blog("burning-vs-locking-liquidity", "the comparison")} lays out when each fits.`)}
${info(`<p>If you are considering burning LP to prove liquidity is permanent, check first whether your
launchpad already did it at graduation. Several on this chain do, and you cannot burn a position you no
longer control.</p>`)}

${h2("Cost")}
${p(`A flat fee — currently 0.005 ETH, read live from the contract — plus gas. Overpayment is refunded.
No percentage of the tokens. See ${doc("fees", "fees")}.`)}

${h2("Doing it")}
${p(`Full steps in ${doc("how-to-burn-tokens", "how to burn tokens")}. Two transactions: approve, then
burn. The confirmation screen states the amount and the share of supply before you sign.`)}
${cta("Burn tokens", "Permanent by construction, with a proof page and a transaction anyone can check.", "/app/burn", "Open burn →")}
`,
  related: [
    { href: "/docs/how-to-burn-tokens", title: "How to burn tokens" },
    { href: "/docs/token-locker", title: "Token locker", note: "the reversible alternative" },
    { href: "/blog/how-to-check-if-liquidity-is-burned", title: "How to check if liquidity is burned" },
    { href: "/blog/burning-vs-locking-liquidity", title: "Burning vs locking liquidity" },
  ],
};
