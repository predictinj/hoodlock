import { h2, h3, p, ul, table, info, warn, doc, app } from "../components.mjs";

export default {
  slug: "troubleshooting",
  navTitle: "Troubleshooting",
  seoTitle: "HoodLock Troubleshooting | Failed Transactions and Wallet Errors",
  desc: "Fixes for the problems that actually come up: transactions that will not send, approvals that stall, missing locks and vesting schedules that revert.",
  updated: "2026-07-29",
  h1: 'Trouble<span class="serif">shooting.</span>',
  lede: "Ordered by how often they happen. If your problem is not here, check the transaction on the explorer first — the revert reason is usually the answer.",
  body: `
${h2("“HTTP request failed” while browsing")}
${p(`The public RPC is rate limited and a read-heavy page can lose a call. Reload. If it recurs, the
explorer or a different network moment is usually the cause rather than your wallet.`)}
${p(`This affects reading, not signing. Your transactions go through your wallet's own RPC.`)}

${h2("A transaction was submitted but never confirmed")}
${warn(`<p><b>Check before retrying.</b> Open ${app("locks", "My locks")} or the explorer and look for the
record. A lock that was created but whose receipt was lost looks identical to one that failed, and
sending again creates a <b>second lock</b> and charges a <b>second fee</b>.</p>`)}
${p(`If the widget reported <code>unconfirmed: true</code>, that means exactly this: broadcast succeeded,
receipt unknown, most likely landed.`)}

${h2("The approval went through but the lock did not")}
${p(`These are two separate transactions and the approval is not wasted. It sits unused until you use it.
Start the lock again; you should not be asked to approve the same amount twice.`)}
${p(`If you are asked to approve again, the amount you are now locking is larger than what you approved.`)}

${h2("My wallet does not appear")}
${table(["Situation", "Fix"], [
  ["Desktop, extension installed", "Unlock the extension, then reload. A locked wallet does not announce itself."],
  ["Mobile browser", "Mobile wallets cannot inject into Safari or Chrome. Use WalletConnect or the wallet's in-app browser."],
  ["Several wallets installed", "One can claim the injection slot. Pick yours explicitly from the list, or disable the others temporarily."],
])}
${p(`More detail in ${doc("connect-wallet", "connecting a wallet")}.`)}

${h2("The network will not switch")}
${p(`Some wallets refuse to add an unfamiliar chain automatically. Add Robinhood Chain by hand with the
parameters on the ${doc("network", "network page")}, then reconnect.`)}
${info(`<p>If the network is already in your wallet but transactions fail to send, the saved RPC endpoint
may be wrong. Remove the network and let the app add it again.</p>`)}

${h2("A vesting schedule reverted")}
${p(`The contract enforces rules the form usually catches first. If you are building transactions yourself,
these are the ones that bite:`)}
${table(["Rule", "Requirement"], [
  ["Minimum duration", "<code>end &gt; block.timestamp + 24 hours</code>"],
  ["Ordering", "<code>start ≤ cliff ≤ end</code>"],
  ["Fee", "<code>msg.value == fee</code> <b>exactly</b> — overpayment is not refunded and reverts"],
  ["Token", "Must be a contract address, not an EOA"],
])}
${warn(`<p>The most common cause: the API validates <code>end - start ≥ 86400</code> while the contract
validates against <code>block.timestamp</code>. A <b>back-dated start</b> passes the first and fails the
second. Validate against <code>block.timestamp</code>. See the ${doc("api", "API page")}.</p>`)}

${h2("My lock is not in the explorer")}
${ul([
  "Give it a moment — the explorer reads from an indexer that can lag a block or two behind your wallet.",
  "Confirm the transaction actually succeeded on the explorer, not just that it was sent.",
  "Check you are looking at the right token address. Searching by symbol is not possible precisely because symbols repeat.",
])}

${h2("The token amount looks wrong")}
${p(`Two usual causes. <b>Decimals</b>: if you are building transactions yourself, amounts are in the
token's smallest unit, so a token with 18 decimals needs 18 zeros. <b>Fee-on-transfer</b>: the locker
records what it actually received, so a token that taxes transfers will show slightly less locked than you
sent. That is the honest number, not an error.`)}

${h2("I sent tokens directly to a contract address")}
${warn(`<p>Tokens transferred straight to the locker or burner address, rather than through the app,
<b>are not recoverable</b>. There is no rescue function — that absence is the same property that stops
anyone taking locked tokens. Always go through the app or the ${doc("api", "API")}.</p>`)}

${h2("Still stuck")}
${p(`Open the transaction on the explorer and read the revert reason. It names the failing check directly,
and the ${doc("contracts", "contract reference")} explains what each one enforces.`)}
`,
  related: [
    { href: "/docs/connect-wallet", title: "Connecting a wallet" },
    { href: "/docs/network", title: "Network" },
    { href: "/docs/contracts", title: "Contracts" },
  ],
};
