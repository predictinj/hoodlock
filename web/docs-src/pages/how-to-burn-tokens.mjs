import { h2, p, ul, steps, table, info, danger, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "how-to-burn-tokens",
  navTitle: "Burn tokens",
  seoTitle: "Burning in the HoodLock App | Steps and Safeguards",
  desc: "The exact flow for removing supply through the HoodLock burn registry, the confirmations you get before signing, and the mistakes that cost the most.",
  updated: "2026-07-29",
  h1: 'Burn <span class="serif">tokens.</span>',
  lede: "Two transactions, and the supply is gone for good. Read the whole page first — this is the one action on HoodLock with no way back.",
  body: `
${danger(`<p><b>Burning cannot be reversed.</b> The tokens go to an address nobody holds the key to. There
is no recovery, no support path and no admin override, because there is nobody to ask. Burn the amount you
mean to burn.</p>`)}

${h2("Decide first")}
${p(`Burning and locking answer different questions, and the choice is easier before you sign.`)}
${table(["Goal", "Use"], [
  ["Remove supply permanently and prove it", doc("token-burning", "burn")],
  ["Show commitment but keep the option to migrate later", doc("token-locker", "lock")],
  ["Release supply gradually to people", doc("token-vesting", "vesting")],
])}
${info(`<p>For LP positions specifically, ${blog("burning-vs-locking-liquidity", "burning vs locking liquidity")}
lays out the trade-off — a burn needs no trust at all, a lock keeps the option to move the pool.</p>`)}

${h2("Burn it")}
${steps([
  `<b>Open the burn form.</b> Go to ${app("burn", "the burn page")} and connect the wallet holding the tokens.`,
  `<b>Pick the token.</b> From your balances or by contract address.`,
  `<b>Enter the amount.</b> The form shows the share of total supply this represents — that percentage is
   what people will quote, so check it is what you intend.`,
  `<b>Read the confirmation.</b> It states the amount and that the action is irreversible. This is the last
   point at which stopping costs nothing.`,
  `<b>Approve, then burn.</b> Two transactions. The tokens move from your wallet straight to the dead
   address in a single transfer. They never sit in our contract.`,
  `<b>Share the proof link.</b> The page states the amount, the share of supply and the transaction.`,
])}

${h2("What gets recorded")}
${p(`The registry writes who burned, which token, how much and when, and exposes a running total per token
through <code>totalBurnedOf</code>. That is the difference between burning through the registry and sending
tokens to the dead address yourself: both destroy the supply, but only one produces something a reader can
check without knowing how to read a block explorer.`)}

${h2("Common mistakes")}
${ul([
  "<b>Burning the wrong token.</b> Symbols repeat across contracts. Verify the address, not the ticker.",
  "<b>Burning LP you did not mean to.</b> Burning an LP token removes liquidity permanently — the pool shrinks. That is sometimes the intent and sometimes a very expensive misunderstanding.",
  "<b>Burning before checking the launchpad.</b> Several platforms already burn LP at graduation. You cannot burn a position you no longer hold, and you should not need to.",
  "<b>Treating a burn as a substitute for distribution.</b> Removing supply does not fix a concentrated holder list — " + blog("how-to-read-token-holder-distribution", "the distribution") + " is a separate question.",
])}

${h2("After burning")}
${p(`Total supply drops by the burned amount, so every percentage derived from it shifts. If you publish
tokenomics, update them — a burn that makes your own documentation wrong undercuts the point of doing it.`)}
${p(`${blog("how-to-check-if-liquidity-is-burned", "How to check if liquidity is burned")} shows what a
reader will do with your claim.`)}

${cta("Burn tokens", "Permanent by construction, with a proof page and a transaction anyone can verify.", "/app/burn", "Open burn →")}
`,
  related: [
    { href: "/docs/token-burning", title: "Token burning" },
    { href: "/docs/proof-of-lock", title: "Proof of lock" },
    { href: "/blog/burning-vs-locking-liquidity", title: "Burning vs locking liquidity" },
  ],
};
