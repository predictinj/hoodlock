import { h2, h3, p, ul, steps, table, info, warn, danger, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "how-to-create-vesting",
  navTitle: "Create a vesting schedule",
  seoTitle: "Create a Vesting Schedule with HoodLock | Step-by-Step",
  desc: "Set up linear vesting on Robinhood Chain, alone or for a whole team at once, with the checks worth running before you sign something you cannot edit.",
  updated: "2026-07-29",
  h1: 'Create a <span class="serif">vesting schedule.</span>',
  lede: "Four numbers decide everything: how much, when it starts, when the cliff falls and when it ends. Get them right before you sign — a schedule cannot be edited afterwards.",
  body: `
${danger(`<p><b>No HoodLock function can cancel, edit or recover a schedule.</b> A wrong beneficiary
address or a wrong amount is permanent. Read this page before you start rather than during.</p>
<p>The token is the one exception: an upgradeable, pausable or blacklisting token can still undo or
freeze a schedule after the fact — and if you deployed the token, you may hold that power yourself. See
${doc("token-vesting", "how vesting works")}.</p>`)}

${h2("Decide the four numbers")}
${table(["Field", "What it means", "Common choice"], [
  ["<b>Amount</b>", "Total tokens in the schedule", "The whole allocation for that person"],
  ["<b>Start</b>", "When accrual begins", "Today, or a shared team start date"],
  ["<b>Cliff</b>", "Nothing is claimable before this", "One year on a multi-year schedule"],
  ["<b>End</b>", "Everything is claimable at this point", "Two to four years for team supply"],
])}
${p(`Between start and end, release is linear. Before the cliff it is zero even though time is accruing —
when the cliff passes, everything earned to that point becomes claimable at once. The exact formula is on
${doc("token-vesting", "the vesting page")}.`)}
${info(`<p>${blog("team-token-allocation-benchmarks", "Allocation benchmarks")} covers what sizes and
durations survive scrutiny, and ${blog("what-is-a-vesting-cliff", "what a cliff is")} covers how holders
read one.</p>`)}

${h2("Create it")}
${steps([
  `<b>Open vesting.</b> Go to ${app("vesting", "the vesting form")} with the wallet holding the tokens.`,
  `<b>Pick the token and amount.</b> Same as any other flow — from your balances or by address.`,
  `<b>Enter the beneficiary.</b> The address that will be able to claim. <b>Check it character by
   character.</b> This is the field that cannot be fixed later.`,
  `<b>Set start, cliff and end.</b> The form enforces the contract's rules, so an invalid combination
   will not reach a signature prompt.`,
  `<b>Review the summary.</b> Check the dates against what you intend to announce — a back-dated start
   makes part of the schedule claimable immediately (see below).`,
  `<b>Approve, then create.</b> Two transactions. The fee is charged once, here; claiming later is free.`,
])}

${h2("The rules the contract enforces")}
${table(["Rule", "Value"], [
  ["Minimum duration", "24 hours between start and end"],
  ["Ordering", "<code>start ≤ cliff ≤ end</code>"],
  ["Fee", "Exactly the fee — overpayment is <b>not</b> refunded, unlike locks and burns"],
  ["Batch size", "Up to 200 beneficiaries per transaction"],
])}
${warn(`<p>If you build transactions yourself rather than using the app, note that the API validates
<code>end - start ≥ 86400</code> while the contract validates <code>end &gt; block.timestamp +
MIN_DURATION</code>. A back-dated start can pass the first and fail the second. Validate against
<code>block.timestamp</code>. Details on the ${doc("api", "API page")}.</p>`)}

${h2("Vesting a whole team at once")}
${p(`Batch creation makes one schedule per beneficiary in a single transaction — same token, same timing,
different addresses and amounts. Up to 200 at a time, with the fee charged per schedule.`)}
${p(`It is the practical way to set up a cap table, and it produces one proof page per person rather than
one shared page, which is what you want when someone asks about a specific allocation.`)}

${h2("Be honest about back-dating")}
${warn(`<p>A schedule with a start date in the past is already partly vested the moment it exists. That is
legitimate — teams often vest from a date people actually joined — but a schedule that is 50% claimable on
day one is, in practice, half a transfer.</p>
<p><b>The proof page does not state this for you.</b> It shows what has vested <i>so far</i>, and it warns
when a future cliff will release a large chunk at once — but a schedule that was already substantially
vested when it was created reads, months later, exactly like one that vested honestly over that period.</p>
<p>So say it yourself, in your own announcement: the start date, and what share was already claimable on
day one. It costs nothing, and it is the one number a sceptical reader cannot reconstruct from the page.</p>`)}

${h2("After creating")}
${ul([
  "<b>The beneficiary claims</b>, when they choose. Nothing is pushed automatically and unclaimed tokens never expire.",
  "<b>Claims are free.</b> Gas only.",
  "<b>The beneficiary can hand over</b> to a new address themselves, for a wallet change. You cannot do it for them.",
  "<b>You cannot change anything.</b> Not the amount, not the dates, not the recipient.",
])}
${p(`Share the proof link the same way you would a lock — ${doc("proof-of-lock", "proof of lock")} covers
what it shows.`)}

${cta("Create a vesting schedule", "Flat 0.005 ETH per schedule, claims are free, and no HoodLock function can alter it afterwards.", "/app/vesting", "Open vesting →")}
`,
  related: [
    { href: "/docs/token-vesting", title: "Token vesting", note: "how release is calculated" },
    { href: "/docs/how-to-lock-tokens", title: "Lock tokens", note: "the reversible alternative" },
    { href: "/blog/how-to-set-up-token-vesting", title: "How to set up vesting that holds" },
  ],
};
