/* Deploy RobinhoodLocker to Robinhood Chain mainnet.
   Reads the deployer mnemonic from MNEMONIC_FILE (default /tmp/mn.txt).
   Deploys with fee=0 (free to bootstrap adoption) and feeCollector=deployer.
   Writes the deployed address to web/src/config.json. */
const fs = require("fs");
const path = require("path");
const { createWalletClient, createPublicClient, http, defineChain, getAddress } = require("viem");
const { mnemonicToAccount } = require("viem/accounts");

const root = path.join(__dirname, "..");
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "abi.json"), "utf8"));
const bytecode = fs.readFileSync(path.join(__dirname, "build", "bytecode.txt"), "utf8").trim();
const mnemonic = fs.readFileSync(process.env.MNEMONIC_FILE || "/tmp/mn.txt", "utf8").trim();

const account = mnemonicToAccount(mnemonic);
const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
const pc = createPublicClient({ chain, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const wc = createWalletClient({ account, chain, transport: http("https://rpc.mainnet.chain.robinhood.com") });

(async () => {
  console.log("deployer:", account.address);
  const bal = await pc.getBalance({ address: account.address });
  console.log("gas ETH:", Number(bal) / 1e18);
  const hash = await wc.deployContract({ account, chain, abi, bytecode, args: [0n, account.address] });
  console.log("deploy tx:", hash);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120000 });
  console.log("status:", rc.status, "| RobinhoodLocker:", rc.contractAddress);
  const cfg = { chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", locker: rc.contractAddress };
  fs.writeFileSync(path.join(root, "web", "src", "config.json"), JSON.stringify(cfg, null, 2));
  console.log("wrote web/src/config.json");
})().catch((e) => { console.error("ERROR:", e.shortMessage || e.message); process.exit(1); });
