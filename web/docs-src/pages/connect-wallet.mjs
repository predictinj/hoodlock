import { h2, h3, p, ul, table, code, info, warn, doc } from "../components.mjs";

export default {
  slug: "connect-wallet",
  navTitle: "Connecting a wallet",
  seoTitle: "Connect a Wallet to Robinhood Chain | HoodLock Docs",
  desc: "Which wallets work with HoodLock on Robinhood Chain, how the network gets added automatically, and what to do when a connection fails.",
  updated: "2026-07-29",
  h1: 'Connecting a <span class="serif">wallet.</span>',
  lede: "HoodLock is non-custodial, so connecting is the only account there is. Nothing is stored on our side and no signature is needed just to look around.",
  body: `
${h2("Supported wallets")}
${p(`Any wallet that supports Robinhood Chain works. The app discovers browser wallets automatically
through EIP-6963, so anything installed shows up in the list without us maintaining one.`)}
${table(["Route", "Notes"], [
  ["Browser extension", "MetaMask, Rabby, Phantom, Trust and anything else that announces itself. Discovered automatically."],
  ["WalletConnect", "For mobile wallets and anything not installed in this browser. Opens a QR or a deep link."],
  ["Wallet in-app browser", "Opening hoodlock.tech inside your wallet's own browser is the most reliable route on mobile."],
])}
${warn(`<p>Mobile wallet apps <b>cannot inject into Safari or Chrome</b>. On a phone you either use
WalletConnect or open the site inside the wallet's own browser — a mobile wallet will never appear in the
extension list, however many times you reload.</p>`)}

${h2("The network")}
${p(`HoodLock runs only on Robinhood Chain, chain id <code>4663</code>. The app asks your wallet to switch,
and to add the chain if it is missing, so you rarely need to do anything by hand. The parameters are on
the ${doc("network", "network page")} if you prefer to add it yourself.`)}
${info(`<p>Transactions are submitted through <b>your wallet's</b> RPC, not ours. If your wallet has chain
4663 configured with a broken endpoint, sending will fail no matter what the site does — remove the
network and let the app re-add it.</p>`)}

${h2("What connecting does and does not do")}
${ul([
  "<b>It does not give us access to anything.</b> Connecting shares your address. It grants no permission to move tokens.",
  "<b>Browsing needs nothing.</b> Proof pages, the explorer and these docs all work with no wallet at all.",
  "<b>Approvals are per token, per amount.</b> Locking asks the token contract to authorise a specific amount for the locker — not a blanket permission over your wallet.",
])}

${h2("When it fails")}
${h3("The wallet does not appear in the list")}
${ul([
  "On desktop: check the extension is unlocked, then reload. A locked wallet does not announce itself.",
  "On mobile: use WalletConnect or the wallet's in-app browser.",
  "If several wallets are installed, one can claim the injection slot. Disable the others temporarily or pick yours explicitly from the list.",
])}

${h3("Connected, but the network will not switch")}
${p(`Some wallets refuse to add a chain they do not recognise. Add it manually with the parameters on the
${doc("network", "network page")}, then reconnect.`)}

${h3("“HTTP request failed” or a transaction that will not send")}
${p(`Usually the public RPC rate-limiting a read-heavy session. Reload and try again. If a lock
transaction was submitted but the confirmation never arrived, check <b>My locks</b> before retrying —
it very likely landed, and sending again would create a second lock and charge a second fee.`)}
${p(`More cases in ${doc("troubleshooting", "troubleshooting")}.`)}

${h3("Approval succeeded but the lock did not")}
${p(`These are two separate transactions. If the first went through and the second did not, nothing is
lost — the approval simply sits unused. Start the lock again; you will not be asked to approve twice for
the same amount.`)}

${h2("Disconnecting")}
${p(`Disconnect in the app clears the stored choice so the next visit does not reconnect silently. It does
not revoke token approvals — those live in the token contract. Revoke them from your wallet's approvals
screen or a revoke tool if you want them gone.`)}
`,
  related: [
    { href: "/docs/network", title: "Network", note: "chain id, RPC, explorer" },
    { href: "/docs/troubleshooting", title: "Troubleshooting" },
    { href: "/docs/quickstart", title: "Quickstart" },
  ],
};
