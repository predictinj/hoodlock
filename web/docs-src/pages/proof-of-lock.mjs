import { h2, h3, p, ul, table, info, warn, doc, blog, cta } from "../components.mjs";

export default {
  slug: "proof-of-lock",
  navTitle: "Proof of lock",
  seoTitle: "Proof of Lock Pages | Share and Verify a Lock on Robinhood Chain",
  desc: "Every HoodLock lock, burn and vesting schedule gets a public page that reads live from the chain and opens without a wallet. What it shows and how to use it.",
  updated: "2026-07-29",
  h1: 'Proof of <span class="serif">lock.</span>',
  lede: "A lock nobody can see does no work. Every record gets a URL that renders current on-chain state, opens without a wallet, and is safe to hand to someone who does not trust you.",
  body: `
${h2("The problem it solves")}
${p(`Telling people your tokens are locked is worth nothing. Anyone can say it. Pointing at a block
explorer is technically sufficient and practically useless, because the person you are trying to convince
usually cannot read one and should not have to.`)}
${p(`A proof page is the middle ground: it states the facts in plain language, and every fact on it is read
from the chain at the moment the page loads.`)}

${h2("What each page shows")}
${table(["Field", "Notes"], [
  ["Token", "Symbol, name and contract address, linked to the explorer"],
  ["Amount", "Locked, burned or vesting, in the token's own units"],
  ["Share of supply", "The amount as a percentage of total supply, which is usually the number people actually want"],
  ["Unlock or schedule dates", "Unlock date for a lock; start, cliff and end for a schedule"],
  ["Status", "Locked, unlockable, withdrawn, burned, or the percentage vested and claimed"],
  ["Transaction", "A direct link to the transaction that created the record"],
])}
${info(`<p>The page is generated per record, so the state is never cached into something stale. If a lock is
extended, withdrawn or claimed against, the page shows that the next time it is opened. It is a live view,
not a certificate issued once.</p>`)}

${h2("URL shapes")}
${table(["Record", "URL"], [
  ["Lock", "<code>hoodlock.tech/proof/lock/&lt;id&gt;</code>"],
  ["Burn", "<code>hoodlock.tech/proof/burn/&lt;id&gt;</code>"],
  ["Vesting schedule", "<code>hoodlock.tech/proof/vesting/&lt;id&gt;</code>"],
])}
${p(`Each also carries a share card, so pasting one into a social post or a chat renders a preview with the
token and the amount rather than a bare link.`)}

${h2("Where to use it")}
${ul([
  "<b>In your pinned post and your docs.</b> The link is the claim; the words around it are commentary.",
  "<b>In listing and directory applications.</b> Most ask for evidence of locked liquidity, and a URL that a reviewer can open without installing a wallet is the easiest form to supply.",
  "<b>When someone asks in your community.</b> Answering with a link ends the conversation in a way that answering with a sentence does not.",
  "<b>In your own interface.</b> If you run a token page or a launchpad, embedding the link next to the supply figures saves your users the question.",
])}

${h2("Verifying one you were shown")}
${p(`A proof page is evidence about one record, and there are two things worth checking before you treat it
as evidence about a project.`)}
${warn(`<p><b>Check the token address, not the symbol.</b> Symbols are not unique and cost nothing to copy.
A proof page for a token called <code>$PEPE</code> is a proof page for whichever contract that page names —
compare it to the address of the token actually trading.</p>`)}
${warn(`<p><b>Check the share of supply.</b> A lock of ten million tokens sounds substantial until you learn
the supply is ten billion. The page states the percentage precisely so you do not have to work it out.</p>`)}
${p(`${doc("how-to-verify-a-lock", "Verify someone else's lock")} walks through the full check, and
${blog("how-to-read-token-holder-distribution", "reading holder distribution")} covers what the rest of the
supply is doing.`)}

${h2("Token pages")}
${p(`Alongside per-record proof pages, HoodLock publishes a page per token that clears a quality threshold,
summarising every lock, burn and schedule against that token in one place. Those are reachable from
${doc("lock-explorer", "the explorer")}.`)}

${cta("Create something worth linking to", "Lock, burn or vest — every record gets a page anyone can open.")}
`,
  related: [
    { href: "/lock-checker", title: "Token lock checker", note: "look a token up by its contract address" },
    { href: "/docs/how-to-verify-a-lock", title: "Verify someone else's lock" },
    { href: "/docs/lock-explorer", title: "Lock explorer" },
    { href: "/blog/how-to-prove-your-project-wont-rug", title: "How to prove you won't rug" },
    { href: "/blog/how-to-check-if-liquidity-is-locked", title: "How to check if liquidity is locked" },
  ],
};
