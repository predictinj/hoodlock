import { h2, p, ul, steps, table, info, warn, doc, blog, app } from "../components.mjs";

export default {
  slug: "when-a-lock-expires",
  navTitle: "When a lock expires",
  seoTitle: "Lock Expiry: Withdraw, Extend or Let It Lapse | HoodLock",
  desc: "Nothing moves automatically at the unlock date. What actually changes, what holders see, and which of the three options costs you least.",
  updated: "2026-07-29",
  h1: 'When a lock <span class="serif">expires.</span>',
  lede: "Expiry is not an event. No tokens move, no transaction fires and nothing is sent anywhere — a permission simply becomes available to one address.",
  body: `
${h2("What actually happens")}
${p(`At the unlock time, exactly one thing changes: <code>withdraw</code> stops reverting for the lock's
owner. The tokens stay in the contract until that owner sends a transaction. They can stay there
indefinitely.`)}
${table(["Common belief", "Reality"], [
  ["Tokens are returned automatically", "Nothing is pushed. The owner must withdraw."],
  ["The lock disappears", "The record stays on-chain permanently, with its status updated."],
  ["The proof link stops working", "It keeps working and shows the current status honestly."],
  ["There is a grace period", "There is not. The moment passes and withdrawal is available."],
])}
${info(`<p>Because withdrawal is a deliberate act, an expired lock that has not been withdrawn is
informative in itself — it says the owner had the option and has not taken it.</p>`)}

${h2("What holders see")}
${p(`The proof page and the explorer both switch the status from locked to unlockable, and then to
withdrawn if and when that happens. Nobody has to be told; anyone watching the token sees it.`)}
${warn(`<p>Assume someone is watching the date. On a token with an engaged community, the unlock date is
often better known than the team expects, and a date that passes in silence reads as a countdown that
ended. Saying what you plan to do beforehand costs nothing.</p>`)}

${h2("Your options as the date approaches")}
${table(["Option", "Cost", "How it reads"], [
  ["<b>Extend</b> before expiry", "Gas only — extending is free", "Strongest. A continuous record with no gap."],
  ["Let it expire and leave it", "Nothing", "Ambiguous. The option to sell exists and is visible."],
  ["Withdraw and re-lock", "A new fee", "Weakest. There is a gap, and gaps get noticed."],
  ["Withdraw", "Gas only", "Honest, if you say why."],
])}
${p(`Extending is almost always the right move if you intend to stay locked — see
${doc("how-to-extend-a-lock", "extending a lock")}. It is free, it happens before the gap rather than
after, and it keeps the record unbroken.`)}

${h2("Withdrawing")}
${steps([
  `<b>Open My locks</b> in ${app("locks", "the app")} with the owning wallet.`,
  `<b>Find the expired lock</b> — it will show as unlockable.`,
  `<b>Withdraw.</b> One transaction, gas only. <b>There is no withdrawal fee.</b>`,
])}
${p(`The full amount returns to the lock's current owner. If ownership was transferred at some point, it
goes to the current owner, not the original creator.`)}

${h2("Planning around it")}
${ul([
  "<b>Do not set a date you will resent.</b> Extending is free and shortening is impossible, so err short and extend.",
  "<b>Stagger a treasury.</b> Several locks on different dates beat one large lock expiring in a single block, both operationally and in how it reads.",
  "<b>Put the date in your own documentation.</b> If holders learn it from you rather than from a chart, the conversation starts differently.",
])}
${p(`${blog("what-happens-when-a-token-lock-expires", "The longer discussion")} covers how markets
typically react around unlock dates, and ${blog("what-is-a-token-unlock-schedule", "unlock schedules")}
covers publishing them in advance.`)}

${h2("Vesting is different")}
${p(`Schedules have no expiry in this sense. Tokens become claimable progressively and unclaimed amounts
never lapse — the beneficiary can claim years later. There is nothing to extend and nothing to miss. See
${doc("token-vesting", "token vesting")}.`)}
`,
  related: [
    { href: "/docs/how-to-extend-a-lock", title: "Extend a lock" },
    { href: "/docs/token-locker", title: "Token locker" },
    { href: "/blog/what-happens-when-a-token-lock-expires", title: "When a lock expires on Robinhood Chain" },
  ],
};
