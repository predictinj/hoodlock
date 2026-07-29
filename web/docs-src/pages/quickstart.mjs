import { h2, p, ul, steps, table, info, doc, blog, app, cta } from "../components.mjs";

export default {
  slug: "quickstart",
  navTitle: "Quickstart",
  seoTitle: "HoodLock Quickstart | Lock Your First Tokens in Two Minutes",
  desc: "Connect a wallet, lock a balance and share the proof link. The shortest path from arriving on Robinhood Chain to having something verifiable.",
  updated: "2026-07-29",
  h1: 'Quick <span class="serif">start.</span>',
  lede: "Two transactions and a link. This page is the fastest route; every step has a fuller page behind it if you want the reasoning.",
  body: `
${h2("What you need")}
${ul([
  "A wallet with the tokens you want to lock, on Robinhood Chain.",
  "A little ETH for gas, plus the flat fee — currently 0.005 ETH.",
  "Nothing else. There is no account, no sign-up and no email.",
])}

${h2("Do it")}
${steps([
  `<b>Open the app.</b> Go to ${app("locks", "hoodlock.tech/app/locks")} and connect. The app will ask
   your wallet to switch to Robinhood Chain, and to add the network if it does not have it — see
   ${doc("connect-wallet", "connecting a wallet")} if that step fails.`,
  `<b>Choose what to lock.</b> Pick a token from your balances or paste its contract address. <b>Max</b>
   fills the whole balance; locking part of a holding is normal.`,
  `<b>Pick a date.</b> Anything in the future works. You can push it further out later but never pull it
   in, so a shorter first lock you extend as you deliver is usually the better play.`,
  `<b>Approve, then lock.</b> Two prompts. The first authorises the contract for that amount; the second
   creates the lock.`,
  `<b>Share the proof link.</b> That link is the deliverable — it reads live from the chain and opens
   without a wallet.`,
])}

${h2("Which product do you actually want?")}
${table(["If you want to…", "Use", "Reversible?"], [
  ["Hold a balance until a date", doc("token-locker", "a lock"), "Yes, after the date"],
  ["Release supply gradually to someone", doc("token-vesting", "vesting"), "No — irrevocable once created"],
  ["Remove supply permanently", doc("token-burning", "a burn"), "No — permanent by construction"],
  ["Prove a pool cannot be pulled", doc("liquidity-locker", "an LP lock"), "Yes, after the date"],
])}
${info(`<p>Not sure between the first three? ${blog("token-locks-vs-vesting-vs-burning", "Locks vs vesting vs burning")}
compares them on the terms that matter, and the choice is easier to make before you sign than after.</p>`)}

${h2("Next")}
${ul([
  doc("fees", "What it costs") + " — one flat fee, no percentage",
  doc("proof-of-lock", "Proof of lock") + " — what the link shows and how to use it",
  doc("security", "Security model") + " — why nobody can take the tokens, including us",
])}
${cta("Lock your first tokens", "Flat 0.005 ETH, no percentage of your tokens, and a proof link anyone can open.")}
`,
  related: [
    { href: "/docs/connect-wallet", title: "Connecting a wallet" },
    { href: "/docs/how-to-lock-tokens", title: "How to lock tokens", note: "the full walkthrough" },
    { href: "/docs/fees", title: "Fees" },
  ],
};
