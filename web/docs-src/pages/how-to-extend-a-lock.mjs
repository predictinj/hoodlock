import { h2, p, ul, steps, table, info, warn, doc, blog, app } from "../components.mjs";

export default {
  slug: "how-to-extend-a-lock",
  navTitle: "Extend a lock",
  seoTitle: "Extend a Token Lock on Robinhood Chain | HoodLock",
  desc: "Push an unlock date further out for free. Why extend-only is enforced by the contract, and why a lock extended repeatedly reads better than one long lock.",
  updated: "2026-07-29",
  h1: 'Extend a <span class="serif">lock.</span>',
  lede: "Unlock dates move in one direction. You can always push a lock further out, never pull it in, and the contract is what enforces that rather than a policy.",
  body: `
${h2("Why it only moves one way")}
${p(`<code>extend</code> requires the new timestamp to be strictly greater than the current one. There is
no function that shortens a lock, so a team cannot quietly bring a date forward when it becomes
inconvenient, and nobody has to take their word for it.`)}
${p(`That is what makes an unlock date meaningful as a commitment rather than a preference. See the
${doc("contracts", "contract reference")} for the exact check.`)}

${h2("Extend it")}
${steps([
  `<b>Open My locks.</b> Go to ${app("locks", "the app")} with the wallet that owns the lock.`,
  `<b>Find the lock</b> and choose <b>Extend</b>.`,
  `<b>Pick a later date.</b> Anything earlier than the current unlock time is rejected before it reaches
   your wallet.`,
  `<b>Confirm.</b> One transaction, gas only — <b>extending is free</b>.`,
])}
${info(`<p>The proof page updates immediately. Anyone holding the old link sees the new date the next time
they open it, so there is nothing to re-share.</p>`)}

${h2("The strategy worth understanding")}
${p(`Most teams set one long lock at launch and never touch it. Extending repeatedly is the better play,
and the reason is about evidence rather than mechanics.`)}
${table(["Approach", "What a reader sees"], [
  ["One 12-month lock set at launch", "A decision made once, before anything was proven"],
  ["A 3-month lock extended three times", "A team that kept choosing to stay, on the record, after each milestone"],
])}
${p(`The second costs the same — extending is free, and produces a history rather than a single data
point. It also avoids the trap of a long lock set optimistically at launch that the team later resents.`)}
${p(`${blog("how-long-should-you-lock-liquidity", "How long should you lock liquidity")} works through
choosing the first duration.`)}

${h2("Before the date arrives")}
${warn(`<p>An unlock date that passes without comment is read as a countdown that ended. If you intend to
stay locked, <b>extend before it expires</b>, not after — a lock that lapses for a week and is then
re-created is a different fact from one that never lapsed, and holders who are watching will notice which
one happened.</p>`)}
${p(`Nothing happens automatically at expiry. See ${doc("when-a-lock-expires", "when a lock expires")}.`)}

${h2("What extending does not change")}
${ul([
  "<b>The amount.</b> To lock more, create a second lock. Locks are independent records.",
  "<b>The owner.</b> Ownership transfers separately, and the tokens stay where they are.",
  "<b>Vesting schedules.</b> Those are irrevocable and have no extend function — the dates are fixed at creation.",
])}
`,
  related: [
    { href: "/docs/when-a-lock-expires", title: "When a lock expires" },
    { href: "/docs/token-locker", title: "Token locker" },
    { href: "/blog/what-happens-when-a-token-lock-expires", title: "When a lock expires on Robinhood Chain" },
  ],
};
