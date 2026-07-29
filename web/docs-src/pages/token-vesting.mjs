import { h2, h3, p, ul, table, code, info, warn, danger, doc, blog, cta } from "../components.mjs";

export default {
  slug: "token-vesting",
  navTitle: "Token vesting",
  seoTitle: "How HoodLock Vesting Works | Linear Release, Cliffs and Limits",
  desc: "The release formula, the cliff, what the contract can and cannot undo, and the hard limits written into it — plus when a lock is the better instrument.",
  updated: "2026-07-29",
  h1: 'Token <span class="serif">vesting.</span>',
  lede: "A lock says “not before this date”. Vesting says “a little at a time, starting here, finishing there” — which is what team and contributor allocations actually need.",
  body: `
${h2("How release is calculated")}
${p(`A schedule has four numbers: a total, a start, an optional cliff and an end. Between start and end the
claimable amount grows linearly. Before the cliff it is zero, regardless of how much time has passed.`)}
${code(`before cliff        →  0
between cliff and end →  total × (now − start) / (end − start) − already claimed
at or after end     →  everything remaining`, "text")}
${info(`<p>The final claim sweeps the exact remainder rather than recomputing the fraction, so a schedule
always finishes at precisely the total. No dust is stranded.</p>`)}

${h3("What a cliff is for")}
${p(`A cliff is a date before which nothing is claimable, even though time is accruing. When it passes,
everything earned up to that point becomes claimable at once. The usual reason is commitment: a one-year
cliff on a four-year schedule means someone who leaves in month eleven takes nothing.`)}
${p(`${blog("what-is-a-vesting-cliff", "What a vesting cliff is")} covers how holders read one.`)}

${h2("What the contract forbids")}
${danger(`<p><b>No HoodLock function can cancel, edit or reverse a schedule.</b> There is no revoke, no
sweep and no rescue. Check the beneficiary address and the amount before you sign — a mistake cannot be
undone by us.</p>`)}
${warn(`<p><b>The token is the exception, and it matters.</b> A token that is upgradeable, pausable,
mintable, or that can blacklist an address can still make a schedule worthless or unclaimable after the
fact. Where the schedule's creator is also the token's deployer — the common case for team vesting —
they may retain exactly that power, whatever this contract does.</p>
<p>It cuts the other way too. Because there is no rescue path, a token that pauses or freezes the
beneficiary locks the tokens <b>permanently</b>, with no recourse from anyone. Irrevocable and
unrecoverable are the same property.</p>`)}
${table(["Constraint", "Value", "Why it exists"], [
  ["Minimum duration", "24 hours", "Stops a schedule that would be fully vested the moment it is created."],
  ["Maximum fee", "0.05 ETH, hard-coded", "A ceiling the admin can never exceed, whatever else changes."],
  ["Batch limit", "200 beneficiaries", "Bounds gas on a single <code>createMany</code> call."],
])}
${p(`The admin can change the fee and the fee collector, and nothing else. No admin function can touch an
existing schedule. See the ${doc("contracts", "contract reference")}.`)}

${h2("Claiming")}
${ul([
  "<b>The beneficiary claims</b>, not the creator. Claiming is a transaction they send when they choose.",
  "<b>Claims are free.</b> The fee is charged once, at creation. Claiming costs gas only.",
  "<b>Nothing arrives automatically.</b> Unclaimed tokens accumulate and stay claimable — there is no expiry.",
  "<b>The beneficiary can be transferred</b> by the current beneficiary, for a wallet change or a handover.",
])}

${h2("Vesting or locking?")}
${table(["If the supply is…", "Use"], [
  ["One allocation you hold and intend to keep", doc("token-locker", "a lock")],
  ["Going to a team, advisors or contributors over time", "vesting"],
  ["A treasury you need to spend from on a schedule", "several locks on different dates"],
  ["Meant never to return", doc("token-burning", "a burn")],
])}
${p(`${blog("token-locks-vs-vesting-vs-burning", "Locks vs vesting vs burning")} compares all three in
full, and ${blog("team-token-allocation-benchmarks", "allocation benchmarks")} covers what sizes and
schedules hold up to scrutiny.`)}

${h2("Batches")}
${p(`<code>createMany</code> creates one schedule per beneficiary in a single transaction, up to 200, all
sharing the same token and the same timing. The fee is charged per schedule. It is the practical way to
set up a whole team at once.`)}

${h2("The proof page")}
${p(`Each schedule gets a public page showing the total, the amount already claimed, the cliff and end
dates, and the percentage released. Because no HoodLock function can alter a schedule, that page describes
a commitment we cannot walk back for you. See ${doc("proof-of-lock", "proof of lock")}.`)}

${warn(`<p>One thing worth stating on your own page rather than leaving to inference: <b>what share of the
schedule had already vested when it was created</b>. A schedule back-dated so that half of it is claimable
on day one is technically vesting and practically a transfer. Our proof pages show it; say it yourself
before someone else does.</p>`)}

${cta("Create a vesting schedule", "Flat 0.005 ETH per schedule, claims are free, and no HoodLock function can alter it afterwards.", "/app/vesting", "Open vesting →")}
`,
  related: [
    { href: "/vesting-checker", title: "Token vesting checker", note: "see a token's schedules" },
    { href: "/docs/how-to-create-vesting", title: "How to create a vesting schedule" },
    { href: "/docs/token-locker", title: "Token locker" },
    { href: "/blog/how-to-set-up-token-vesting", title: "How to set up vesting that holds" },
    { href: "/blog/what-is-a-token-unlock-schedule", title: "What an unlock schedule tells you" },
  ],
};
