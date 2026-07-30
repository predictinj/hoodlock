import { h2, h3, p, ul, table, code, info, warn, danger, doc, blog, cta } from "../components.mjs";

export default {
  slug: "airdrops",
  navTitle: "Airdrops",
  seoTitle: "Airdrops on HoodLock | Merkle Claims, Pricing and Deadlines",
  desc: "How a HoodLock airdrop works: the creator funds a Merkle root, recipients take their own share, and the recipient list is published so claims outlive this website.",
  updated: "2026-07-30",
  h1: 'Airdrops that <span class="serif">arrive.</span>',
  lede: "Most airdrops push tokens into wallets that never asked for them, and the sender pays gas for every recipient who ignores it. HoodLock inverts that: you fund it once, and each recipient comes and takes their own share.",
  body: `
${h2("What actually happens")}
${p(`You paste a list of wallets and amounts. The browser reduces that list to a single 32-byte Merkle root
and sends it to the contract along with the tokens. The list itself is published, because the root alone is
useless to a recipient: they need the list to build the proof that they are in it.`)}
${p(`A recipient then opens the app, and the contract checks their proof against the root before releasing
exactly the amount their entry says. Nobody can claim twice, and nobody who is not in the list can claim at
all.`)}
${info(`<p>The list lives at <code>/api/airdrop/&lt;id&gt;/list.json</code> and is downloadable by anyone.
That is deliberate. If it existed only on our server, a non-custodial contract would still depend on our
uptime, because nobody could rebuild a proof without us.</p>`)}

${h2("What it costs")}
${p(`The fee scales with the number of wallets you declare, and the contract clamps it so no single airdrop
can ever be charged more than the hard cap written into the code. Both parameters are currently zero, so
funding an airdrop is free. You still pay network gas, and recipients pay their own gas to claim.`)}
${code(`fee = min(base + perWallet × recipients, MAX_FEE)`, "text")}
${h3("Why declaring fewer wallets does not save money")}
${p(`The number you pay for is also the ceiling on how many claims succeed. Declare ten wallets and airdrop
to five thousand, and the eleventh person is refused. Under-declaring breaks your own airdrop rather than
saving anything, which is what makes the price enforceable without us checking anything off chain.`)}

${h2("Deadlines, and the choice that cannot be undone")}
${table(
  ["Setting", "What it means"],
  [
    ["A deadline", "Unclaimed tokens can be returned to you, but only after that date. Until then nobody can move them, including you."],
    ["No deadline", "Claimable forever. You permanently give up the ability to take the unclaimed tokens back."],
  ],
)}
${danger(`<p><b>The deadline is fixed at creation and cannot be changed afterwards.</b> There is no way to
close an airdrop early, extend it, or reclaim tokens before the date you set. That restriction is the whole
reason a recipient can trust the page.</p>`)}
${p(`A deadline must be at least seven days out. A one-day window would let an airdrop advertise a promise
it could withdraw before most people saw it.`)}

${h2("Reading an airdrop honestly")}
${p(`The contract cannot add up a Merkle tree, so nothing stops a creator funding less than their list
promises, or paying for fewer claims than they have recipients. In both cases claims succeed until the money
or the ceiling runs out, and everyone after that is refused.`)}
${warn(`<p>Each airdrop page compares the published list against what the chain actually holds and says
plainly when the airdrop cannot pay everyone on it. Being on a list is not the same as there being something
left, and the page will tell you which one you are looking at.</p>`)}
${p(`Airdrops of the same token share the contract's balance, but each one is bounded by its own deposit:
an airdrop whose tree over-promises can never spend another airdrop's tokens.`)}

${h2("Lists, duplicates and formats")}
${p(`Paste addresses one per line for an equal split, or <code>address:amount</code> lines for individual
amounts. Commas, tabs and equals signs work too, because these lists come out of spreadsheets and chat.`)}
${ul([
  "An address appearing twice is merged and the amounts are added, because the tree needs one entry per wallet and dropping the second would quietly cost somebody tokens.",
  "Every pasted row stays on screen, flagged, with the combined total, so a shorter recipient count never looks like the tool lost a line.",
  "Lines that are not usable are listed with their line number rather than skipped in silence.",
])}

${h2("What HoodLock does not do")}
${p(`It does not review the projects that create airdrops, or the tokens they use. Anyone can fund one, and a
page on this domain records what happened on chain rather than endorsing it. Check the token before acting on
an airdrop of it: ${blog("rug-pull-red-flags-checklist", "the red flags checklist")} runs in about ten
minutes.`)}

${cta("Fund an airdrop", "Free while the fee is switched off. One transaction, and recipients take it from there.", "/app/airdrops", "Open HoodLock")}
`,
  faqs: [
    ["Why do recipients have to claim instead of receiving it?",
     "Because pushing tokens to thousands of wallets costs the sender gas for every recipient who never wanted them, and fills wallets with things nobody asked for. Here the tokens wait in the contract until the wallet that owns them asks, which is also why the claim brings people to a page that can show them what they actually got."],
    ["Can I take back tokens nobody claimed?",
     "Only if you set a deadline, and only after it passes. An airdrop created with no deadline is claimable forever and can never be swept, which is a permanent choice made at creation."],
    ["What happens if I lose the recipient list?",
     "Nothing, as long as it was published. The full list is downloadable from the airdrop's page, and anyone can rebuild a claim proof from it without HoodLock being involved."],
    ["Can two airdrops use the same list?",
     "Yes, and they will share the published list correctly, because anyone claiming against either is genuinely on it. Each airdrop is still bounded by its own deposit."],
    ["Does an airdrop show up in the lock explorer?",
     "No. Locks, burns and vesting appear there; airdrops have their own index at /airdrops and their own checker."],
  ],
  related: [
    { href: "/airdrop-checker", title: "Airdrop checker", note: "see what any wallet can still take" },
    { href: "/airdrops", title: "Every airdrop on the chain", note: "" },
    { href: "/docs/contracts", title: "Contract addresses", note: "including the airdrop contract" },
  ],
};
