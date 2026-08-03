#!/usr/bin/env node
/**
 * Revenue-share keeper: works out who is owed what, and proves it.
 *
 * Reads every lock of $LOCK from chain, applies the eligibility rule, splits a
 * round pro-rata by locked amount, and builds the Merkle tree that
 * LockRoundManager.openRound() needs.
 *
 * The list is the whole trust story. The contracts cannot verify that a root
 * describes a correct computation, so the defence is that anyone can redo it:
 * every run writes the full input list and the exact block it was read at, so a
 * holder can recompute the root and prove it wrong.
 *
 *   node scripts/revenue-keeper.mjs --dry            what a round would look like
 *   node scripts/revenue-keeper.mjs --block 1234567  snapshot a specific block
 *   node scripts/revenue-keeper.mjs --amount 5e21    split a specific amount
 *
 * It never signs anything. Opening the round is a separate, deliberate step.
 */
import { createPublicClient, http, defineChain, getAddress, formatUnits } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildTree } from "../shared/merkle.mjs";

const cfg = JSON.parse(readFileSync(new URL("../web/src/config.json", import.meta.url)));
const LOCK = getAddress("0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94");
const MIN_DURATION = 7 * 24 * 3600;   // the 7-day floor, on ORIGINAL duration
const MIN_AMOUNT = 1_000_000n * 10n ** 18n; // dust locks cost more gas than they earn

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (n) => process.argv.includes(`--${n}`);

const chain = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc) });

const LOCKER_ABI = [
  { type: "function", name: "locksByToken", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "getLock", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ components: [
      { name: "owner", type: "address" }, { name: "token", type: "address" },
      { name: "amount", type: "uint256" }, { name: "unlockTime", type: "uint64" },
      { name: "withdrawn", type: "bool" }], type: "tuple" }] },
];

/**
 * Creation times come from the Locked event, because a lock does not store one.
 *
 * Read from Blockscout rather than eth_getLogs: the chain caps getLogs at 2000
 * blocks and the locker is ~22M blocks deep, which is 11,000 round trips. The
 * app already reads logs this way for the same reason.
 */
async function lockedAtById() {
  const { keccak256, toHex } = await import("viem");
  const topic0 = keccak256(toHex("Locked(uint256,address,address,uint256,uint256)"));
  const out = new Map();
  let next = `${cfg.explorer}/api/v2/addresses/${getAddress(cfg.locker)}/logs`;
  let guard = 0;
  while (next && guard++ < 40) {
    const res = await fetch(next);
    if (!res.ok) break;
    const j = await res.json();
    for (const lg of j.items ?? []) {
      const t = lg.topics ?? [];
      // A log without the indexed id is not a Locked event; skip rather than
      // throw, so one odd entry cannot take the whole round down.
      if (!t[0] || t[0].toLowerCase() !== topic0.toLowerCase() || !t[1]) continue;
      const ts = Date.parse(lg.block_timestamp ?? lg.timestamp ?? "");
      if (!Number.isFinite(ts)) continue;
      out.set(Number(BigInt(t[1])), Math.floor(ts / 1000));
    }
    const p = j.next_page_params;
    next = p ? `${cfg.explorer}/api/v2/addresses/${getAddress(cfg.locker)}/logs?` +
      new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])) : null;
  }
  return out;
}

async function main() {
  const head = await pub.getBlockNumber();
  const at = arg("block") ? BigInt(arg("block")) : head;
  const block = await pub.getBlock({ blockNumber: at });
  const now = Number(block.timestamp);

  console.log(`snapshot block ${at} (${new Date(now * 1000).toISOString()})`);

  const ids = await pub.readContract({
    address: getAddress(cfg.locker), abi: LOCKER_ABI, functionName: "locksByToken", args: [LOCK],
  });
  console.log(`locks on $LOCK: ${ids.length}`);

  const lockedAt = await lockedAtById();
  console.log(`creation times resolved: ${lockedAt.size}`);

  const rows = [];
  for (const id of ids) {
    const l = await pub.readContract({
      address: getAddress(cfg.locker), abi: LOCKER_ABI, functionName: "getLock",
      args: [id], blockNumber: at,
    });
    const reason = (() => {
      if (getAddress(l.token) !== LOCK) return "not $LOCK";
      if (l.withdrawn) return "withdrawn";
      if (Number(l.unlockTime) <= now) return "expired";
      const t0 = lockedAt.get(Number(id));
      if (t0 === undefined) return "creation time unknown";
      if (Number(l.unlockTime) - t0 < MIN_DURATION) return "under 7 days";
      if (l.amount < MIN_AMOUNT) return "below minimum";
      return null;
    })();
    rows.push({ id: Number(id), owner: getAddress(l.owner), amount: l.amount,
                unlockTime: Number(l.unlockTime), excluded: reason });
  }

  const eligible = rows.filter((r) => !r.excluded);
  // One entry per WALLET, not per lock: a holder with three locks is one payee.
  const byOwner = new Map();
  for (const r of eligible) byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0n) + r.amount);
  const totalWeight = [...byOwner.values()].reduce((a, b) => a + b, 0n);

  console.log(`eligible locks: ${eligible.length} across ${byOwner.size} wallet(s)`);
  console.log(`total weight  : ${Number(formatUnits(totalWeight, 18)).toLocaleString("en-US")} $LOCK`);
  for (const r of rows.filter((r) => r.excluded)) {
    console.log(`  skipped #${r.id} (${r.excluded})`);
  }
  if (!byOwner.size) { console.log("\nnothing to distribute"); return; }

  const amount = arg("amount") ? BigInt(arg("amount")) : 0n;
  if (amount === 0n) {
    console.log("\n--dry with no --amount: showing shares only");
    for (const [who, w] of byOwner) {
      console.log(`  ${who}  ${(Number((w * 1000000n) / totalWeight) / 10000).toFixed(4)}%`);
    }
    return;
  }

  // Largest-remainder allocation, so the parts sum to the whole exactly. Naive
  // integer division loses wei, and a distributor that promises more than it
  // holds cannot open the round at all.
  const entries = [];
  let allocated = 0n;
  const sorted = [...byOwner.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [who, w] of sorted) {
    const share = (amount * w) / totalWeight;
    entries.push({ address: who, amount: share });
    allocated += share;
  }
  let dust = amount - allocated;
  for (let i = 0; dust > 0n; i = (i + 1) % entries.length, dust--) entries[i].amount += 1n;

  const withIndex = entries.map((e, index) => ({ index, address: e.address, amount: e.amount }));
  const { root, proofFor } = buildTree(withIndex);

  const outDir = new URL("../data/revenue-rounds/", import.meta.url);
  mkdirSync(outDir, { recursive: true });
  const file = new URL(`round-${at}.json`, outDir);
  const payload = {
    snapshotBlock: String(at),
    snapshotTime: now,
    token: LOCK,
    rule: { minDurationSeconds: MIN_DURATION, minAmountWei: String(MIN_AMOUNT) },
    totalWeight: String(totalWeight),
    amount: String(amount),
    root,
    recipients: withIndex.map((e, i) => ({
      index: e.index, address: e.address, amount: String(e.amount),
      proof: proofFor(i),
    })),
    excluded: rows.filter((r) => r.excluded).map((r) => ({ id: r.id, reason: r.excluded })),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));

  console.log(`\nroot        : ${root}`);
  console.log(`recipients  : ${withIndex.length}`);
  console.log(`sum matches : ${withIndex.reduce((a, e) => a + e.amount, 0n) === amount}`);
  console.log(`written     : ${file.pathname}`);
  console.log(`\nopenRound(root, ${amount}, ${withIndex.length}, "<uri>")`);
  if (!has("dry")) console.log("\nThis script never signs. Open the round from the admin panel.");
}

main().catch((e) => { console.error(e); process.exit(1); });
