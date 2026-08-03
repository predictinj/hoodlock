#!/usr/bin/env node
/**
 * Deploy the revenue-share contracts.
 *
 *   node scripts/deploy-revenue.mjs --dry    print every constructor argument
 *   node scripts/deploy-revenue.mjs          send it
 *
 * The deployer is NOT the admin. Every contract takes `admin` as a constructor
 * argument and it is set to the owner wallet from the first block, so the key
 * used here controls nothing afterwards and holds only leftover gas. That is
 * what makes a freshly generated deploy key safe to treat as disposable.
 *
 * Order matters: the vault's `distributor` is immutable, so the manager must
 * exist first.
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const cfg = JSON.parse(readFileSync(new URL("../web/src/config.json", import.meta.url)));
const dry = process.argv.includes("--dry");

const OWNER  = getAddress("0x79c1230cAb12d53D040f5FE1F5279e1A481CCeA2"); // admin + sweep + keeper
const LOCK   = getAddress("0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94");
const WETH   = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const POOL   = getAddress("0x4562cA679DcCc38f2dd59d28B2eBFEC99f507AF2");
const AIRDROP = getAddress(cfg.airdrop);

const chain = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc) });

const artifact = (name) =>
  JSON.parse(readFileSync(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url)));

async function deploy(wallet, name, args) {
  const a = artifact(name);
  console.log(`\ndeploying ${name}`);
  for (const [i, v] of args.entries()) console.log(`   arg${i}: ${v}`);
  if (dry) return "0x(dry-run)";
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${name} deployment reverted`);
  console.log(`   -> ${rc.contractAddress}  gas ${rc.gasUsed}`);
  return rc.contractAddress;
}

async function main() {
  const key = JSON.parse(readFileSync(`${homedir()}/.config/hoodlock/deployer.json`, "utf8"));
  const account = privateKeyToAccount(key.privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });

  const bal = await pub.getBalance({ address: account.address });
  console.log(`deployer ${account.address}  ${formatEther(bal)} ETH`);
  console.log(`admin / keeper / sweepReceiver -> ${OWNER}`);

  // Manager first: the vault's distributor is immutable and must point at it.
  const manager = await deploy(wallet, "LockRoundManager", [LOCK, AIRDROP, OWNER, OWNER, OWNER]);
  const vault = await deploy(wallet, "LockBuybackVault", [POOL, WETH, LOCK, manager, OWNER]);

  // The live splitter's payees are immutable, so revenue is routed by a new one
  // whose ops side IS the vault. Pointing the four products at it is four
  // transactions the OWNER must sign; this key has no authority to do it.
  const splitter = await deploy(wallet, "RevenueSplitter", [OWNER, vault]);

  if (dry) { console.log("\n--dry: nothing sent"); return; }

  const out = { manager, vault, splitter, admin: OWNER, deployedBy: account.address, chainId: cfg.chainId };
  writeFileSync(new URL("../data/revenue-deploy.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\n" + JSON.stringify(out, null, 2));

  // Return the remainder rather than leaving it in a throwaway wallet.
  const left = await pub.getBalance({ address: account.address });
  const gas = 21000n;
  const price = await pub.getGasPrice();
  const fee = gas * price * 2n;
  if (left > fee) {
    const h = await wallet.sendTransaction({ to: OWNER, value: left - fee, gas });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`\nreturned ${formatEther(left - fee)} ETH to ${OWNER}`);
  }

  console.log(`
STILL REQUIRED, and only the owner wallet can do it:
  locker.setFeeCollector(${splitter})
  burner.setFeeCollector(${splitter})
  vesting.setFeeCollector(${splitter})
  airdrop.setFeeCollector(${splitter})
Until then fees keep going to the existing splitter and the vault stays empty.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
