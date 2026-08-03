#!/usr/bin/env node
/**
 * Raise the LOCK/WETH pool's oracle cardinality.
 *
 * The vault prices its buyback from a 30-minute TWAP and refuses to fall back
 * to spot, so `observe(1800)` must answer reliably or execute() reverts. With
 * cardinality 1 the pool stores a single observation, and whether a 30-minute
 * lookback resolves depends entirely on how long ago the last swap was: quiet
 * pool, works; a swap a minute ago, reverts. Intermittent is worse than broken.
 *
 * Cardinality is capacity, not history. Slots fill one per swap, so this only
 * starts the clock; the pool must then trade for the window to become real.
 *
 * Permissionless: anybody may call this on any pool. The key here only pays gas.
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const cfg = JSON.parse(readFileSync(new URL("../web/src/config.json", import.meta.url)));
const POOL = getAddress("0x4562cA679DcCc38f2dd59d28B2eBFEC99f507AF2");

/**
 * 120 slots. At today's ~13 minutes between swaps that is ~26 hours of history,
 * and it still covers the 30-minute window if trading speeds up to one swap a
 * minute. Under-provisioning here means the vault silently starts reverting the
 * day the pool gets busy, which is exactly when a buyback matters.
 */
const TARGET = 120;

const chain = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" },
    { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "increaseObservationCardinalityNext", stateMutability: "nonpayable",
    inputs: [{ type: "uint16" }], outputs: [] },
];

const pub = createPublicClient({ chain, transport: http(cfg.rpc) });

async function main() {
  const key = JSON.parse(readFileSync(`${homedir()}/.config/hoodlock/deployer.json`, "utf8"));
  const account = privateKeyToAccount(key.privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });

  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer ${account.address}  ${formatEther(bal)} ETH`);

  const before = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" });
  console.log(`cardinality now ${before[3]}, next ${before[4]}`);
  if (before[4] >= TARGET) { console.log("already provisioned"); return; }

  const hash = await wallet.writeContract({
    address: POOL, abi: POOL_ABI, functionName: "increaseObservationCardinalityNext", args: [TARGET],
  });
  console.log(`tx ${hash}`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`status ${rc.status}  gas ${rc.gasUsed}  cost ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} ETH`);

  const after = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" });
  console.log(`cardinality now ${after[3]}, next ${after[4]}`);
  console.log("\nnext grows one slot per swap. Re-check observe(1800) before deploying.");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
