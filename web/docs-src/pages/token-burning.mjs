import { h2, p, ul, table, code, info, warn, danger, doc, blog, cta } from "../components.mjs";

export default {
  slug: "token-burning",
  navTitle: "Token burning",
  seoTitle: "Token Burning on Robinhood Chain | HoodLock",
  desc: "Send tokens to the dead address with a permanent on-chain record. What a burn actually proves, what it costs, and where the token itself sets the limit.",
  updated: "2026-07-29",
  h1: 'Token <span class="serif">burning.</span>',
  lede: "Sending tokens to an address nobody holds the key to, with a permanent public record of it. Final from our side — though whether it truly reduces supply depends on the token.",
  body: `
${h2("What happens")}
${p(`The burner moves tokens from your wallet to the dead address in a single transfer and writes a record:
who burned, which token, how much, and when.`)}
${code(`0x000000000000000000000000000000000000dEaD`, "address")}
${p(`The tokens never rest in the burner contract. There is no intermediate custody step where something
could go wrong or where a privileged function could intervene — the transfer goes straight from you to an
address nobody holds the key to.`)}

${danger(`<p><b>We cannot undo this.</b> There is no recovery, no support ticket and no admin override.
The dead address has no owner, so there is no one to ask. Burn the amount you mean to burn.</p>`)}

${h2("What a burn does and does not prove")}
${p(`This is the part worth reading carefully, because burning is routinely presented as stronger evidence
than it is.`)}
${warn(`<p><b>A transfer to the dead address does not reduce <code>totalSupply</code>.</b> The tokens are
parked at an unspendable address, not destroyed at the protocol level, so every "% of supply" figure still
counts them in the denominator unless the token implements a real burn.</p>
<p><b>And the token decides whether they stay there.</b> A mintable token can re-issue the same amount. An
upgradeable token can add a function that moves the dead address's balance. Neither is visible from the
burn record.</p>`)}
${warn(`<p><b>The recorded amount comes from the token itself.</b> The registry measures the dead address's
balance before and after, which means a token that reports whatever it likes can produce a burn record for
far more than was actually sent. A burn of a token you did not verify is a claim, not proof.</p>
<p>Before treating any burn — including one shown to you — as supply reduction: check the token's contract
address rather than its symbol, and check whether it is mintable or upgradeable.
${blog("how-to-verify-a-token-contract-on-blockscout", "How to read a contract on Blockscout")}.</p>`)}

${h2("Why burn through a contract at all")}
${p(`You could send tokens to the dead address yourself. The difference is the record.`)}
${ul([
  "A direct transfer is one line in a long transaction list that a reader has to find and interpret.",
  "A burn through the registry produces an indexed record and a proof page that states the amount, the share of supply it represented, and the transaction — readable by someone who has never used a block explorer.",
  "<code>totalBurnedOf(token)</code> gives a running total per token, so repeated burns add up to a number you can point at.",
])}

${h2("Where the line falls")}
${table(["A burn record establishes", "It does not establish"], [
  ["That a transfer to the dead address happened, on a specific date, in a specific transaction", "That <code>totalSupply</code> fell, unless the token burns rather than parks"],
  ["That HoodLock cannot return those tokens", "That the <i>token</i> cannot return them"],
  ["That the burner gave up whatever they actually held", "That what they held was worth anything"],
  ["An amount the token reported", "That the amount is true, if the token is not verified"],
  ["Nothing about the remaining supply", "Nothing about the token contract or the team"],
])}
${p(`On a verified, non-mintable, non-upgradeable token a burn is one of the strongest signals available —
precisely because there is no way back. That qualifier is doing real work in that sentence, and it is why
the checks above are worth the two minutes.`)}

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
${cta("Burn tokens", "A single hop to the dead address, with a proof page and a transaction anyone can check.", "/app/burn", "Open burn →")}
`,
  related: [
    { href: "/burn-checker", title: "Token burn checker", note: "see what a token has burned through HoodLock" },
    { href: "/docs/how-to-burn-tokens", title: "How to burn tokens" },
    { href: "/docs/token-locker", title: "Token locker", note: "the reversible alternative" },
    { href: "/blog/how-to-check-if-liquidity-is-burned", title: "How to check if liquidity is burned" },
    { href: "/blog/burning-vs-locking-liquidity", title: "Burning vs locking liquidity" },
  ],
};
