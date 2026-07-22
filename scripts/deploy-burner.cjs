/* Deploy RobinhoodBurner to Robinhood Chain mainnet.
   Reads the deployer mnemonic from MNEMONIC_FILE (default /tmp/mn.txt).
   Copies fee + feeCollector from the live RobinhoodLocker so burns always
   launch with the same fee as locks. Writes the address into web/src/config.json. */
const fs = require("fs");
const path = require("path");
const { createWalletClient, createPublicClient, http, defineChain } = require("viem");
const { mnemonicToAccount } = require("viem/accounts");

const root = path.join(__dirname, "..");
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "RobinhoodBurner.abi.json"), "utf8"));
const bytecode = fs.readFileSync(path.join(__dirname, "build", "RobinhoodBurner.bytecode.txt"), "utf8").trim();
const lockerAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "build", "RobinhoodLocker.abi.json"), "utf8"));
const cfgPath = path.join(root, "web", "src", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const mnemonic = fs.readFileSync(process.env.MNEMONIC_FILE || "/tmp/mn.txt", "utf8").trim();

const account = mnemonicToAccount(mnemonic);
const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pc = createPublicClient({ chain, transport: http(cfg.rpc) });
const wc = createWalletClient({ account, chain, transport: http(cfg.rpc) });

(async () => {
  console.log("deployer:", account.address);
  const bal = await pc.getBalance({ address: account.address });
  console.log("gas ETH:", Number(bal) / 1e18);
  const [fee, collector] = await Promise.all([
    pc.readContract({ address: cfg.locker, abi: lockerAbi, functionName: "fee" }),
    pc.readContract({ address: cfg.locker, abi: lockerAbi, functionName: "feeCollector" }),
  ]);
  console.log("locker fee:", fee.toString(), "| feeCollector:", collector, "(burner launches with the same)");
  const hash = await wc.deployContract({ account, chain, abi, bytecode, args: [fee, collector] });
  console.log("deploy tx:", hash);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120000 });
  console.log("status:", rc.status, "| RobinhoodBurner:", rc.contractAddress);
  // Hand admin to the fee collector so the (throwaway) deployer key is never needed again.
  if (collector.toLowerCase() !== account.address.toLowerCase()) {
    const ah = await wc.writeContract({ account, chain, address: rc.contractAddress, abi, functionName: "setAdmin", args: [collector] });
    const arc = await pc.waitForTransactionReceipt({ hash: ah, timeout: 120000 });
    console.log("setAdmin →", collector, "| status:", arc.status);
  }
  cfg.burner = rc.contractAddress;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log("wrote web/src/config.json");
})().catch((e) => { console.error("ERROR:", e.shortMessage || e.message); process.exit(1); });
