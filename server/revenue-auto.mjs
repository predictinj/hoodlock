/* Automated weekly revenue drop: 50% of fees -> $LOCK buyback -> Merkle airdrop.
 *
 * Every Saturday 21:30 Europe/Stockholm this module, on its own:
 *   1. freezes the week's pool (fees minus affiliate commission, halved),
 *   2. snapshots every $LOCK holder at the deadline block,
 *   3. buys $LOCK with the pool ETH on the verified UniversalRouter,
 *   4. funds a 7-day Merkle airdrop of the bought $LOCK, split by holdings,
 *   5. later sweeps whatever expired unclaimed and forwards it to the team.
 *
 * Security model, in order of importance:
 *  - The operating wallet is DEDICATED and holds only a small owner-funded
 *    float. It is never the fee collector. A full compromise loses the float,
 *    nothing else. The key lives only in REVENUE_PRIVATE_KEY.
 *  - Nothing runs unless REVENUE_DROP_ENABLED=true AND the key is set.
 *  - Hard caps: per-week spend cap, minimum-spend floor, gas reserve, a
 *    price-impact guard (spend vs the pool's real WETH depth) and a slippage
 *    bound on the swap. Anything outside the rails stops and waits for a
 *    human instead of improvising: status 'needs-owner', loud log, funds
 *    untouched in the ops wallet.
 *  - Every external address below was verified on-chain in the session that
 *    wrote this file: the router is the Blockscout-VERIFIED UniversalRouter
 *    the chain's traders actually use (its V3_SWAP_EXACT_IN takes a custom
 *    sixth minHopPriceX36 param, empty = disabled), the pool is the 1%-tier
 *    WETH/$LOCK Uniswap v3 pool, and the swap is simulated before broadcast.
 *  - Crash-safe: every step records its tx hash in SQLite before waiting on
 *    the receipt, and a restart resumes from recorded state instead of
 *    repeating a money movement. Steps are ordered so an interruption leaves
 *    funds parked in the ops wallet, never in limbo.
 *  - REVENUE_DRY=true computes and logs the full plan without broadcasting.
 */
import {
  getAddress, parseEther, formatEther, encodeAbiParameters, encodeFunctionData,
  encodePacked, createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { previousPayout, firstPayout, PAYOUT } from "../shared/revenue-schedule.mjs";

const SPLITTER_ARTIFACT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "revenue-splitter.json"), "utf8"));

/* ---- verified constants (chain 4663) ---- */
const LOCK = getAddress("0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const V3_POOL = getAddress("0x4562cA679DcCc38f2dd59d28B2eBFEC99f507AF2");   // WETH/LOCK 1% tier, token0 = WETH
const ROUTER = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");    // UniversalRouter, Blockscout-verified
const FEE_TIER = 10000;
const DEAD = "0x000000000000000000000000000000000000dead";
/* UniversalRouter command bytes + sentinels, from its verified source. */
const CMD_V3_SWAP_EXACT_IN = "00";
const CMD_WRAP_ETH = "0b";
const UR_MSG_SENDER = "0x0000000000000000000000000000000000000001";
const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "event", name: "Transfer", inputs: [
    { name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false } ] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" } ] },
];
const ROUTER_ABI = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [
    { name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" } ], outputs: [] },
];
const SPLITTER_ABI = [
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "pull", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "team", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ops", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const FEE_SOURCE_ABI = [
  { type: "function", name: "accruedFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeCollector", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const LOCKER_ABI = [
  { type: "function", name: "locksByToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "getLock", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "tuple", components: [
    { name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" },
    { name: "unlockTime", type: "uint256" }, { name: "withdrawn", type: "bool" } ] }] },
];
const AIRDROP_ABI = [
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "create", stateMutability: "payable", inputs: [
    { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "uint64" }, { type: "string" } ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getAirdrop", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "tuple", components: [
    { name: "creator", type: "address" }, { name: "endTime", type: "uint64" }, { name: "maxClaims", type: "uint32" },
    { name: "token", type: "address" }, { name: "claims", type: "uint32" }, { name: "swept", type: "bool" },
    { name: "merkleRoot", type: "bytes32" }, { name: "total", type: "uint128" }, { name: "remaining", type: "uint128" } ] }] },
  { type: "function", name: "sweep", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "event", name: "AirdropCreated", inputs: [
    { name: "id", type: "uint256", indexed: true }, { name: "token", type: "address", indexed: true },
    { name: "creator", type: "address", indexed: true }, { name: "merkleRoot", type: "bytes32", indexed: false },
    { name: "total", type: "uint256", indexed: false }, { name: "maxClaims", type: "uint32", indexed: false },
    { name: "endTime", type: "uint64", indexed: false }, { name: "uri", type: "string", indexed: false } ] },
];

export function initRevenueAuto({ pub, chain, transport, getDb, saveList, poolBetween, airdrop, locker, vesting, burner, teamWallet, log = console.log }) {
  const ENABLED = process.env.REVENUE_DROP_ENABLED === "true";
  const DRY = process.env.REVENUE_DRY === "true";
  const MAX_WEEKLY = Number(process.env.REVENUE_MAX_WEEKLY_ETH || 0.25);
  const SLIPPAGE_BPS = Number(process.env.REVENUE_SLIPPAGE_BPS || 300);
  const MAX_POOL_SHARE_BPS = Number(process.env.REVENUE_MAX_POOL_SHARE_BPS || 500);
  const GAS_RESERVE = Number(process.env.REVENUE_GAS_RESERVE_ETH || 0.002);
  const MIN_SPEND = Number(process.env.REVENUE_MIN_SPEND_ETH || 0.0002);

  let account = null, wallet = null;
  try {
    if (process.env.REVENUE_PRIVATE_KEY) {
      const pk = process.env.REVENUE_PRIVATE_KEY.startsWith("0x") ? process.env.REVENUE_PRIVATE_KEY : "0x" + process.env.REVENUE_PRIVATE_KEY;
      account = privateKeyToAccount(pk);
      wallet = createWalletClient({ account, chain, transport });
    }
  } catch (e) { log("[revenue] ops wallet init failed: " + (e?.message || e)); }

  if (!account) log("[revenue] no REVENUE_PRIVATE_KEY — weekly drop automation is OFF");
  else log(`[revenue] ops wallet ${account.address} — automation ${ENABLED ? (DRY ? "DRY-RUN" : "ENABLED") : "DISABLED (set REVENUE_DROP_ENABLED=true)"}`);

  /* Wallets that must never receive an allocation: infrastructure, venues and
   * the machinery itself. The team wallet is deliberately NOT here: by owner
   * decision its unlocked $LOCK earns like anyone's. Extendable via env. */
  const EXCLUDE = new Set([
    "0x0000000000000000000000000000000000000000", DEAD,
    LOCK.toLowerCase(), WETH.toLowerCase(), V3_POOL.toLowerCase(), ROUTER.toLowerCase(),
    String(airdrop || "").toLowerCase(), String(locker || "").toLowerCase(),
    String(vesting || "").toLowerCase(), String(burner || "").toLowerCase(),
    ...(process.env.REVENUE_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ].filter(Boolean));
  if (account) EXCLUDE.add(account.address.toLowerCase());

  function db() { return getDb(); }
  function initTable() {
    const d = db(); if (!d) return false;
    d.exec(`CREATE TABLE IF NOT EXISTS revenue_runs (
      deadline INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      pool_eth REAL, spend_eth REAL,
      snapshot_block INTEGER, recipients INTEGER,
      merkle_root TEXT, bought_lock TEXT,
      swap_tx TEXT, approve_tx TEXT, create_tx TEXT, airdrop_id INTEGER,
      error TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS revenue_meta (k TEXT PRIMARY KEY, v TEXT)`);
    return true;
  }
  const metaGet = (k) => db()?.prepare("SELECT v FROM revenue_meta WHERE k=?").get(k)?.v || null;
  const metaSet = (k, v) => db()?.prepare("INSERT INTO revenue_meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

  /* ---- the 50/50 splitter ----
   * Once the fee collectors point at it, the ops wallet's share arrives by
   * itself and the float problem disappears. The server deploys the splitter
   * on its own the first time the ops wallet holds enough for gas, remembers
   * the address in SQLite, and the admin console reads it from there to offer
   * the owner the four one-click setFeeCollector switches. */
  function splitterAddr() {
    const v = process.env.REVENUE_SPLITTER || metaGet("splitter");
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null;
  }
  let deploying = false;
  async function ensureSplitter() {
    if (!account || !ENABLED || DRY || deploying || splitterAddr() || !initTable()) return;
    try {
      const bal = await pub.getBalance({ address: account.address });
      if (bal < parseEther("0.0005")) return;   // not enough for deploy gas yet
      deploying = true;
      const hash = await wallet.deployContract({
        abi: SPLITTER_ARTIFACT.abi, bytecode: SPLITTER_ARTIFACT.bytecode,
        args: [getAddress(teamWallet), account.address],
      });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== "success" || !r.contractAddress) throw new Error("deploy reverted");
      // Trust nothing: read the payees back before remembering the address.
      const [t, o] = await Promise.all([
        pub.readContract({ address: r.contractAddress, abi: SPLITTER_ABI, functionName: "team" }),
        pub.readContract({ address: r.contractAddress, abi: SPLITTER_ABI, functionName: "ops" }),
      ]);
      if (t.toLowerCase() !== String(teamWallet).toLowerCase() || o.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error("deployed splitter payees do not match");
      }
      metaSet("splitter", r.contractAddress);
      log(`[revenue] splitter deployed at ${r.contractAddress} (team ${teamWallet}, ops ${account.address}) — owner can now route fees to it from /app/admin`);
    } catch (e) {
      log("[revenue] splitter deploy failed (will retry): " + (e?.message || e));
    } finally { deploying = false; }
  }

  /* Harvest everything the splitter can reach: drain the two pull-style fee
   * sources whose collector it is, then split whatever it holds. Failures
   * here never block the drop — the wallet spends what it has. */
  async function harvest() {
    const sp = splitterAddr();
    if (!sp) return;
    try {
      for (const src of [vesting, airdrop]) {
        if (!src) continue;
        const [collector, accrued] = await Promise.all([
          pub.readContract({ address: src, abi: FEE_SOURCE_ABI, functionName: "feeCollector" }).catch(() => null),
          pub.readContract({ address: src, abi: FEE_SOURCE_ABI, functionName: "accruedFees" }).catch(() => 0n),
        ]);
        if (!collector || collector.toLowerCase() !== sp.toLowerCase() || accrued === 0n) continue;
        const h = await send(sp, encodeFunctionData({ abi: SPLITTER_ABI, functionName: "pull", args: [src] }));
        await receiptOk(h);
        log(`[revenue] harvested ${formatEther(accrued)} ETH of accrued fees via the splitter`);
      }
      const balSp = await pub.getBalance({ address: sp });
      if (balSp > 0n) {
        const h = await send(sp, encodeFunctionData({ abi: SPLITTER_ABI, functionName: "release" }));
        await receiptOk(h);
        log(`[revenue] released ${formatEther(balSp)} ETH from the splitter (50/50)`);
      }
    } catch (e) { log("[revenue] harvest failed (drop continues on current balance): " + (e?.message || e)); }
  }
  const row = (deadlineSec) => db()?.prepare("SELECT * FROM revenue_runs WHERE deadline=?").get(deadlineSec) || null;
  function upsert(deadlineSec, fields) {
    const d = db(); if (!d) return;
    const cur = row(deadlineSec);
    if (!cur) d.prepare("INSERT INTO revenue_runs (deadline, status, updated_at) VALUES (?, 'pending', ?)").run(deadlineSec, Math.floor(Date.now() / 1000));
    const keys = Object.keys(fields);
    if (!keys.length) return;
    d.prepare(`UPDATE revenue_runs SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE deadline=?`)
      .run(...keys.map((k) => fields[k]), Math.floor(Date.now() / 1000), deadlineSec);
  }

  /* Last block whose timestamp is <= ts: the chain state the snapshot honors,
   * exact even when execution runs late (server restart, downtime). */
  async function blockAt(ts) {
    let hi = await pub.getBlock({ blockTag: "latest" });
    if (Number(hi.timestamp) <= ts) return Number(hi.number);
    let lo = 0n, hiN = hi.number;
    while (lo < hiN) {
      const mid = (lo + hiN + 1n) / 2n;
      const b = await pub.getBlock({ blockNumber: mid });
      if (Number(b.timestamp) <= ts) lo = mid; else hiN = mid - 1n;
    }
    return Number(lo);
  }

  /* Holder balances at `blockNumber`, replayed from Transfer events. Event
   * replay is the one source that cannot misreport a holder the way an
   * explorer holder-API can; totals are still spot-checked against balanceOf
   * for the largest recipients before any money moves. */
  async function holdersAt(blockNumber) {
    const ev = ERC20_ABI.find((x) => x.type === "event");
    let logs;
    try {
      logs = await pub.getLogs({ address: LOCK, event: ev, fromBlock: 0n, toBlock: BigInt(blockNumber) });
    } catch {
      logs = [];
      const CHUNK = 5_000_000n;
      for (let from = 0n; from <= BigInt(blockNumber); from += CHUNK) {
        const to = from + CHUNK - 1n > BigInt(blockNumber) ? BigInt(blockNumber) : from + CHUNK - 1n;
        logs.push(...await pub.getLogs({ address: LOCK, event: ev, fromBlock: from, toBlock: to }));
      }
    }
    const bal = new Map();
    for (const l of logs) {
      const from = String(l.args.from).toLowerCase(), to = String(l.args.to).toLowerCase(), v = l.args.value;
      if (v === 0n) continue;
      if (from !== "0x0000000000000000000000000000000000000000") bal.set(from, (bal.get(from) || 0n) - v);
      bal.set(to, (bal.get(to) || 0n) + v);
    }
    /* $LOCK sitting in the locker still belongs to whoever locked it, so it
     * is re-attributed to the lock owner. Team locks are the exception: they
     * are out of circulation by owner decision and earn nothing. */
    try {
      const ids = await pub.readContract({ address: locker, abi: LOCKER_ABI, functionName: "locksByToken", args: [LOCK] });
      for (const id of ids) {
        const l = await pub.readContract({ address: locker, abi: LOCKER_ABI, functionName: "getLock", args: [id] }).catch(() => null);
        if (!l || l.withdrawn || String(l.token).toLowerCase() !== LOCK.toLowerCase()) continue;
        const owner = String(l.owner).toLowerCase();
        if (owner === String(teamWallet).toLowerCase()) continue;
        bal.set(owner, (bal.get(owner) || 0n) + l.amount);
      }
    } catch (e) { log("[revenue] locker re-attribution failed (continuing without): " + (e?.message || e)); }
    for (const a of EXCLUDE) bal.delete(a);
    for (const [a, v] of bal) if (v <= 0n) bal.delete(a);
    return bal;
  }

  /* Spot-swap quote from the pool's own slot0. token0 = WETH so token1-per-
   * token0 price is (sqrtP/2^96)^2; the 1% pool fee and the slippage bound
   * come off the top. Small spends vs a depth-capped pool keep impact low;
   * the depth guard above this refuses anything that would not be small. */
  async function quoteOut(spendWei) {
    const s = await pub.readContract({ address: V3_POOL, abi: POOL_ABI, functionName: "slot0" });
    const sqrtP = s[0];
    const num = sqrtP * sqrtP;                       // Q192 price
    const afterFee = spendWei * BigInt(10_000 - Math.round(FEE_TIER / 100)) / 10_000n;   // 1% pool fee
    const out = (afterFee * num) / (2n ** 192n);
    const minOut = out * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n;
    return { expected: out, minOut };
  }

  function swapCalldata(spendWei, minOut) {
    const path = encodePacked(["address", "uint24", "address"], [WETH, FEE_TIER, LOCK]);
    const commands = `0x${CMD_WRAP_ETH}${CMD_V3_SWAP_EXACT_IN}`;
    const inputs = [
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [UR_ADDRESS_THIS, spendWei]),
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }, { type: "uint256[]" }],
        [UR_MSG_SENDER, spendWei, minOut, path, false, []],
      ),
    ];
    return { commands, inputs };
  }

  async function send(to, data, value = 0n) {
    const hash = await wallet.sendTransaction({ to, data, value });
    return hash;
  }
  async function receiptOk(hash) {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return r;
  }

  /* The full weekly run. Every step is guarded by recorded state so a crash
   * or restart resumes instead of re-spending. */
  let running = false;
  async function executeRun(deadlineMs) {
    if (running || !initTable()) return;
    running = true;
    const deadlineSec = Math.floor(deadlineMs / 1000);
    try {
      const cur = row(deadlineSec);
      if (cur && ["complete", "skipped", "needs-owner"].includes(cur.status)) return;
      upsert(deadlineSec, {});

      // 1. Freeze the pool for [previous boundary, deadline).
      const prevBoundary = previousPayout(deadlineMs - 1) ?? (firstPayout() - 7 * 86_400_000);
      const pool = await poolBetween(Math.floor(prevBoundary / 1000), deadlineSec);
      upsert(deadlineSec, { pool_eth: pool });
      if (pool < MIN_SPEND) {
        upsert(deadlineSec, { status: "skipped", error: `pool ${pool.toFixed(6)} ETH below minimum` });
        log(`[revenue] drop ${deadlineSec}: skipped, pool ${pool.toFixed(6)} ETH below ${MIN_SPEND}`);
        return;
      }

      // 2. Bring in the wallet's own share first: drain the pull-style fee
      // sources through the splitter and split its balance. Only then look at
      // what there is to spend.
      if (!DRY) await harvest();
      const balWei = await pub.getBalance({ address: account.address });
      const bal = Number(formatEther(balWei));
      const spend = Math.min(pool, MAX_WEEKLY, Math.max(0, bal - GAS_RESERVE));
      if (spend < MIN_SPEND) {
        upsert(deadlineSec, { error: `ops wallet underfunded: ${bal.toFixed(5)} ETH, need ~${(pool + GAS_RESERVE).toFixed(5)}` });
        log(`[revenue] drop ${deadlineSec}: WAITING FOR FUNDS — ops wallet ${account.address} has ${bal.toFixed(5)} ETH, pool is ${pool.toFixed(5)} ETH`);
        return;   // stays pending; retried every tick until the window goes stale
      }
      const spendWei = parseEther(spend.toFixed(18));

      // 3. Depth guard: never push more than a sliver of the pool's real WETH.
      const wethDepth = await pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [V3_POOL] });
      if (spendWei > wethDepth * BigInt(MAX_POOL_SHARE_BPS) / 10_000n) {
        upsert(deadlineSec, { status: "needs-owner", error: `spend ${spend.toFixed(5)} ETH exceeds ${MAX_POOL_SHARE_BPS / 100}% of pool depth ${formatEther(wethDepth)} WETH — run manually or raise liquidity` });
        log(`[revenue] drop ${deadlineSec}: NEEDS OWNER — spend too large for pool depth`);
        return;
      }

      // 4. Snapshot holders at the deadline block.
      const snapBlock = cur?.snapshot_block || await blockAt(deadlineSec);
      upsert(deadlineSec, { snapshot_block: snapBlock });
      const holders = await holdersAt(snapBlock);
      const eligibleSum = [...holders.values()].reduce((s, v) => s + v, 0n);
      if (eligibleSum <= 0n || holders.size === 0) {
        upsert(deadlineSec, { status: "skipped", error: "no eligible holders at snapshot" });
        return;
      }
      // Spot-check the biggest holders against balanceOf at the snapshot block.
      const top = [...holders.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
      for (const [addr, v] of top) {
        const onchain = await pub.readContract({ address: LOCK, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(addr)], blockNumber: BigInt(snapBlock) }).catch(() => null);
        // Locker re-attribution legitimately makes our number exceed balanceOf;
        // it must never be SMALLER than the chain's answer.
        if (onchain !== null && v < onchain) throw new Error(`snapshot underestimates ${addr}: ${v} < ${onchain}`);
      }

      const { expected, minOut } = await quoteOut(spendWei);

      if (DRY) {
        log(`[revenue] DRY drop ${deadlineSec}: pool ${pool.toFixed(6)} ETH, spend ${spend.toFixed(6)} ETH, ` +
          `holders ${holders.size}, expected ~${formatEther(expected)} $LOCK (min ${formatEther(minOut)}), snapshot block ${snapBlock}`);
        return;
      }

      // 5. Buyback (skipped on resume if already broadcast).
      let bought;
      const before = await pub.readContract({ address: LOCK, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
      if (!cur?.swap_tx) {
        const { commands, inputs } = swapCalldata(spendWei, minOut);
        const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 600)] });
        // Simulate first: a revert costs nothing and aborts the run cleanly.
        await pub.call({ account: account.address, to: ROUTER, data, value: spendWei });
        const hash = await send(ROUTER, data, spendWei);
        upsert(deadlineSec, { swap_tx: hash, spend_eth: spend });
        await receiptOk(hash);
        const after = await pub.readContract({ address: LOCK, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        bought = after - before;
        if (bought < minOut) throw new Error(`swap returned ${bought}, below minOut ${minOut}`);
      } else {
        await receiptOk(cur.swap_tx);
        bought = cur.bought_lock ? BigInt(cur.bought_lock) : before;   // resumed: balance IS the bought amount (wallet holds nothing else)
        if (bought <= 0n) throw new Error("resume: no bought balance found");
      }
      upsert(deadlineSec, { bought_lock: bought.toString() });
      log(`[revenue] drop ${deadlineSec}: bought ${formatEther(bought)} $LOCK for ${spend.toFixed(6)} ETH`);

      // 6. Allocations, floor-rounded so the total can never exceed bought.
      const entries = [];
      for (const [addr, v] of holders) {
        const amount = (bought * v) / eligibleSum;
        if (amount > 0n) entries.push({ address: addr, amount });
      }
      if (!entries.length) throw new Error("no non-zero allocations");
      const { root, count, total } = saveList(db(), entries);
      upsert(deadlineSec, { merkle_root: root, recipients: count });

      // 7. Approve exactly the airdrop total, then fund the drop.
      const allowance = await pub.readContract({ address: LOCK, abi: ERC20_ABI, functionName: "allowance", args: [account.address, airdrop] });
      if (allowance < total) {
        const ah = await send(LOCK, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [airdrop, total] }));
        upsert(deadlineSec, { approve_tx: ah });
        await receiptOk(ah);
      }
      if (!row(deadlineSec)?.create_tx) {
        const fee = await pub.readContract({ address: airdrop, abi: AIRDROP_ABI, functionName: "quote", args: [count] });
        // MIN_WINDOW is a hard 7 days from creation time, so the deadline gets
        // a margin on top; claims close shortly after the next drop lands.
        const endTime = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400 + 3 * 3600);
        const data = encodeFunctionData({ abi: AIRDROP_ABI, functionName: "create", args: [LOCK, root, total, count, endTime, ""] });
        await pub.call({ account: account.address, to: airdrop, data, value: fee });
        const ch = await send(airdrop, data, fee);
        upsert(deadlineSec, { create_tx: ch });
        const r = await receiptOk(ch);
        const created = r.logs.find((l) => l.address.toLowerCase() === String(airdrop).toLowerCase());
        const id = created ? Number(BigInt(created.topics[1])) : null;
        upsert(deadlineSec, { airdrop_id: id, status: "complete", error: null });
        log(`[revenue] drop ${deadlineSec}: COMPLETE — airdrop #${id}, ${formatEther(total)} $LOCK to ${count} holders`);
      } else {
        await receiptOk(row(deadlineSec).create_tx);
        upsert(deadlineSec, { status: "complete", error: null });
      }
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 400);
      upsert(deadlineSec, { error: msg });
      log(`[revenue] drop ${deadlineSec} FAILED (will retry): ${msg}`);
    } finally {
      running = false;
    }
  }

  /* Expired drops sweep back to the ops wallet (the contract pays the
   * creator), then everything the ops wallet holds in $LOCK forwards to the
   * team wallet — but only when no run is mid-flight, because between the
   * buyback and the funding the ops wallet legitimately holds the drop. */
  let lastSweepCheck = 0;
  async function sweepMatured() {
    if (!account || DRY || !ENABLED || running) return;
    if (Date.now() - lastSweepCheck < 10 * 60_000) return;
    lastSweepCheck = Date.now();
    try {
      const ev = AIRDROP_ABI.find((x) => x.type === "event");
      const logs = await pub.getLogs({ address: airdrop, event: ev, args: { creator: account.address }, fromBlock: 0n, toBlock: "latest" });
      const now = Math.floor(Date.now() / 1000);
      for (const l of logs) {
        const id = Number(l.args.id);
        const a = await pub.readContract({ address: airdrop, abi: AIRDROP_ABI, functionName: "getAirdrop", args: [BigInt(id)] });
        if (a.swept || Number(a.endTime) === 0 || now < Number(a.endTime) || a.remaining === 0n) continue;
        const h = await send(airdrop, encodeFunctionData({ abi: AIRDROP_ABI, functionName: "sweep", args: [BigInt(id)] }));
        await receiptOk(h);
        log(`[revenue] swept expired drop #${id}: ${formatEther(a.remaining)} $LOCK back`);
      }
      // Forward any held $LOCK, and any ETH beyond the working buffer, to the
      // team wallet — outside a run the ops wallet is a conduit, not a vault.
      const prev = previousPayout(Date.now());
      const curStatus = prev ? row(Math.floor(prev / 1000))?.status : null;
      if (!curStatus || ["complete", "skipped", "needs-owner"].includes(curStatus)) {
        const balLock = await pub.readContract({ address: LOCK, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        if (balLock > 0n) {
          const h = await send(LOCK, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [getAddress(teamWallet), balLock] }));
          await receiptOk(h);
          log(`[revenue] forwarded ${formatEther(balLock)} $LOCK to the team wallet`);
        }
        /* The affiliate deduction means the wallet's automatic 50% inflow can
         * slightly exceed what the drops spend. Anything above the working
         * buffer belongs to the team; with the splitter live this keeps the
         * hot wallet permanently small. */
        const buffer = parseEther(String(process.env.REVENUE_ETH_BUFFER || 0.01));
        const balEth = await pub.getBalance({ address: account.address });
        if (splitterAddr() && balEth > buffer * 2n) {
          const surplus = balEth - buffer;
          const h = await wallet.sendTransaction({ to: getAddress(teamWallet), value: surplus });
          await receiptOk(h);
          log(`[revenue] forwarded ${formatEther(surplus)} ETH surplus to the team wallet`);
        }
      }
    } catch (e) { log("[revenue] sweep pass failed: " + (e?.message || e)); }
  }

  /* One tick a minute. The run only fires inside the 6 days after a deadline
   * (a drop older than that is stale: better to skip a week loudly than to
   * pay out a surprise late), and everything downstream is idempotent. */
  let lastDeployCheck = 0;
  setInterval(() => {
    if (!ENABLED || !account) return;
    const now = Date.now();
    if (now - lastDeployCheck > 5 * 60_000) { lastDeployCheck = now; void ensureSplitter(); }
    const prev = previousPayout(now);
    if (prev && now - prev < 6 * 86_400_000) {
      const st = row(Math.floor(prev / 1000))?.status;
      if (!st || !["complete", "skipped", "needs-owner"].includes(st)) void executeRun(prev);
    }
    void sweepMatured();
  }, 60_000);

  return {
    /* Widget/status contract: complete only from a really-finished run. */
    status() {
      const prev = previousPayout(Date.now());
      if (!prev || !initTable()) return { state: "unknown" };
      const r = row(Math.floor(prev / 1000));
      if (r?.status === "complete") return { state: "complete", at: r.updated_at };
      if (Date.now() - prev < PAYOUT.processingMs && ENABLED && account) return { state: "processing" };
      return { state: "unknown" };
    },
    /* Owner preview: the full plan for the CURRENT week, computed live,
     * nothing broadcast. */
    async preview() {
      const now = Date.now();
      const since = previousPayout(now) ?? (firstPayout() - 7 * 86_400_000);
      const pool = await poolBetween(Math.floor(since / 1000), Math.floor(now / 1000));
      const balWei = account ? await pub.getBalance({ address: account.address }) : 0n;
      const head = await pub.getBlock({ blockTag: "latest" });
      const holders = await holdersAt(Number(head.number));
      const eligibleSum = [...holders.values()].reduce((s, v) => s + v, 0n);
      const top = [...holders.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 8)
        .map(([a, v]) => ({ address: a, sharePct: eligibleSum > 0n ? Number(v * 10_000n / eligibleSum) / 100 : 0 }));
      const spend = Math.min(pool, MAX_WEEKLY, Math.max(0, Number(formatEther(balWei)) - GAS_RESERVE));
      const q = spend >= MIN_SPEND ? await quoteOut(parseEther(spend.toFixed(18))) : null;
      const prevRow = previousPayout(now) ? row(Math.floor(previousPayout(now) / 1000)) : null;
      return {
        enabled: ENABLED, dry: DRY, opsWallet: account?.address || null,
        splitter: splitterAddr(),
        opsBalanceEth: Number(formatEther(balWei)),
        caps: { maxWeeklyEth: MAX_WEEKLY, slippageBps: SLIPPAGE_BPS, maxPoolShareBps: MAX_POOL_SHARE_BPS, minSpendEth: MIN_SPEND },
        poolSoFarEth: pool, plannedSpendEth: spend,
        expectedLock: q ? formatEther(q.expected) : null, minLock: q ? formatEther(q.minOut) : null,
        holders: holders.size, topHolders: top,
        lastRun: prevRow || null,
      };
    },
    tick: () => { const p = previousPayout(Date.now()); if (p) return executeRun(p); },
    splitter: () => (initTable() ? splitterAddr() : null),
    opsWallet: () => account?.address || null,
  };
}
