import { h2, h3, p, ul, table, code, info, warn, doc, blog } from "../components.mjs";

export default {
  slug: "network",
  navTitle: "Network",
  seoTitle: "Robinhood Chain Network Details for HoodLock | Docs",
  desc: "Chain id, RPC endpoint, explorer and gas token for Robinhood Chain, plus the indexing limits that shape how HoodLock reads history.",
  updated: "2026-07-29",
  h1: 'Network <span class="serif">details.</span>',
  lede: "HoodLock runs only on Robinhood Chain. Everything below is what a wallet, a script or an indexer needs to talk to it.",
  body: `
${h2("Parameters")}
${table(["Field", "Value"], [
  ["Network name", "Robinhood Chain"],
  ["Chain id", "<code>4663</code> (<code>0x1237</code>)"],
  ["Gas token", "ETH"],
  ["RPC", "<code>https://rpc.mainnet.chain.robinhood.com</code>"],
  ["Explorer", '<a href="https://robinhoodchain.blockscout.com">robinhoodchain.blockscout.com</a> (Blockscout)'],
  ["Stack", "Ethereum L2, Arbitrum stack"],
])}

${p(`Adding the network by hand is rarely necessary — the app and the embed widget both ask the wallet to
switch, and add the chain if it is missing. ${doc("connect-wallet", "Connecting a wallet")} covers the
cases where that fails.`)}

${code(`await window.ethereum.request({
  method: "wallet_addEthereumChain",
  params: [{
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  }],
});`, "javascript")}

${h2("Contract addresses")}
${p(`The locker, burner and vesting addresses are on the ${doc("contracts", "contract reference")}, along
with the functions and events each one exposes.`)}

${h2("Reading history")}
${p(`If you are indexing HoodLock events yourself, two limits on the public RPC matter more than anything
else about it.`)}
${table(["Limit", "Value", "What it means for you"], [
  ["<code>eth_getLogs</code> block span", "2,000 blocks", "A full-history scan has to be chunked. The chain is past 21 million blocks, so that is a lot of calls."],
  ["<code>eth_getLogs</code> result size", "10,000 logs", "A busy contract can hit this inside a single 2,000-block window."],
])}
${info(`<p>Blockscout's API returns a contract's full log history in one request and is the faster path for
a backfill. Keep a chunked RPC scan as the fallback — if the indexer is briefly unavailable, a scan that
silently returns nothing looks identical to a contract with no activity, and every number downstream
will be wrong without anything appearing to fail.</p>`)}

${h3("Deploy blocks")}
${p(`Start a backfill here rather than at block zero.`)}
${table(["Contract", "Deploy block"], [
  ["Locker", "<code>4,591,195</code>"],
  ["Burner", "<code>16,820,186</code>"],
  ["Vesting", "<code>20,301,744</code>"],
])}

${h2("Multicall")}
${p(`Multicall3 is deployed at the canonical address, so batched reads work with the usual tooling —
viem, ethers and wagmi will find it without configuration.`)}
${code(`0xcA11bde05977b3631167028862bE2a173976CA11`, "address")}
${p(`Reverts stay isolated per call, so one failing read in a batch does not take the others down with it.`)}

${h2("Rate limits")}
${warn(`<p>The public RPC is rate limited by design and the provider's own documentation says to use a
dedicated endpoint in production. A read-heavy page can drop a call under load. If you are building on
top of HoodLock, put your own RPC behind a fallback transport rather than relying on the public one.</p>`)}
${p(`Note that transaction submission goes through the user's wallet and its RPC, not yours — a wallet
configured with a broken endpoint for chain 4663 will fail to submit no matter what your app does.`)}
`,
  related: [
    { href: "/docs/contracts", title: "Contracts", note: "addresses, functions, events" },
    { href: "/docs/connect-wallet", title: "Connecting a wallet" },
    { href: "/docs/api", title: "REST API" },
  ],
};
