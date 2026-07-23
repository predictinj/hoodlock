/* Total value locked — computed CLIENT-SIDE from the chain, no backend:
 *   locked amounts  ← locker getLock-reads (everything not withdrawn)
 *   token prices    ← the chain's Uniswap-v3 DEX (WETH pools, slot0 spot)
 *   ETH/USD         ← Coinbase's free spot API (cached as fallback)
 * Honest by design:每 token's contribution is CAPPED at 2× the pool's actual
 * WETH depth, so a huge lock of a thin-pool token can't inflate the number.
 * Tokens without a WETH pool are counted as "unpriced", never guessed. */
import type { PublicClient } from "viem";

const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as `0x${string}`;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as `0x${string}`;
const FEES = [10000, 3000, 500, 100];
const DEPTH_CAP = 2; // max bidrag per token = 2× poolens WETH-djup

const FACTORY_ABI = [{ type: "function", name: "getPool", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
  outputs: [{ type: "address" }] }] as const;
const POOL_ABI = [{ type: "function", name: "slot0", stateMutability: "view", inputs: [],
  outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "a", type: "uint16" },
    { name: "b", type: "uint16" }, { name: "c", type: "uint16" }, { name: "d", type: "uint8" }, { name: "e", type: "bool" }] }] as const;
const ERC20_MIN = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

export interface TvlResult {
  usd: number;
  eth: number;
  pricedTokens: number;
  unpricedTokens: number;
  ethUsd: number;
}

async function ethUsdPrice(): Promise<number> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const j: any = await r.json();
    const p = Number(j?.data?.amount);
    if (p > 0) { try { localStorage.setItem("hl_ethusd", String(p)); } catch { /* */ } return p; }
  } catch { /* fall through */ }
  try { return Number(localStorage.getItem("hl_ethusd")) || 0; } catch { return 0; }
}

// pool-cache i localStorage — factoryn ändrar sig aldrig för ett givet par
function cachedPool(token: string): string | null | undefined {
  try {
    const v = localStorage.getItem(`hl_pool_${token.toLowerCase()}`);
    if (v === null) return undefined;   // aldrig slått upp
    return v === "none" ? null : v;
  } catch { return undefined; }
}
function rememberPool(token: string, pool: string | null) {
  try { localStorage.setItem(`hl_pool_${token.toLowerCase()}`, pool ?? "none"); } catch { /* */ }
}

async function findPool(pub: PublicClient, token: `0x${string}`): Promise<`0x${string}` | null> {
  const hit = cachedPool(token);
  if (hit !== undefined) return hit as `0x${string}` | null;
  for (const fee of FEES) {
    try {
      const pool = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [token, WETH, fee] }) as string;
      if (pool && pool !== ZERO) {
        // kräver faktiskt WETH-djup — en tom pool är ingen priskälla
        const bal = await pub.readContract({ address: WETH, abi: ERC20_MIN, functionName: "balanceOf", args: [pool as `0x${string}`] }) as bigint;
        if (bal > 0n) { rememberPool(token, pool); return pool as `0x${string}`; }
      }
    } catch { /* prova nästa fee-tier */ }
  }
  rememberPool(token, null);
  return null;
}

/** WETH-värdet av `amount` råenheter av `token`, kapat vid poolens djup. */
async function tokenValueWeth(pub: PublicClient, token: `0x${string}`, amount: bigint, decimals: number): Promise<number | null> {
  const pool = await findPool(pub, token);
  if (!pool) return null;
  try {
    const [slot0, poolWeth] = await Promise.all([
      pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<any>,
      pub.readContract({ address: WETH, abi: ERC20_MIN, functionName: "balanceOf", args: [pool] }) as Promise<bigint>,
    ]);
    const sqrtP = Number(slot0[0] ?? slot0.sqrtPriceX96);
    if (!sqrtP) return null;
    const pRaw = (sqrtP / 2 ** 96) ** 2; // token1_raw per token0_raw
    const wethIsToken0 = WETH.toLowerCase() < token.toLowerCase();
    const amt = Number(amount) / 10 ** decimals;
    // WETH-humant värde av 1 humant token
    const wethPerToken = wethIsToken0
      ? (1 / pRaw) * 10 ** (decimals - 18)
      : pRaw * 10 ** (decimals - 18);
    const raw = amt * wethPerToken;
    const depth = Number(poolWeth) / 1e18;
    return Math.min(raw, depth * DEPTH_CAP);
  } catch { return null; }
}

/** Räkna TVL över alla ej uttagna lås. locks = [{token, amount, withdrawn}] */
export async function computeTvl(
  pub: PublicClient,
  locks: { token: string; amount: bigint; withdrawn: boolean }[],
): Promise<TvlResult> {
  const perToken = new Map<string, bigint>();
  for (const l of locks) {
    if (l.withdrawn) continue;
    const k = l.token.toLowerCase();
    perToken.set(k, (perToken.get(k) ?? 0n) + l.amount);
  }
  const ethUsd = await ethUsdPrice();
  let eth = 0, priced = 0, unpriced = 0;
  await Promise.all([...perToken.entries()].map(async ([token, amount]) => {
    try {
      const decimals = Number(await pub.readContract({ address: token as `0x${string}`, abi: ERC20_MIN, functionName: "decimals" }).catch(() => 18));
      const v = await tokenValueWeth(pub, token as `0x${string}`, amount, decimals);
      if (v === null) { unpriced++; return; }
      eth += v; priced++;
    } catch { unpriced++; }
  }));
  return { usd: eth * ethUsd, eth, pricedTokens: priced, unpricedTokens: unpriced, ethUsd };
}

export function fmtUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** USD-spotpris per HUMAN token (okapad) — för diagramserier m.m. */
export async function tokenPriceUsd(pub: PublicClient, token: `0x${string}`, decimals: number): Promise<number | null> {
  const ethUsd = await ethUsdPrice();
  if (!ethUsd) return null;
  const pool = await findPool(pub, token);
  if (!pool) return null;
  try {
    const slot0: any = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" });
    const sqrtP = Number(slot0[0] ?? slot0.sqrtPriceX96);
    if (!sqrtP) return null;
    const pRaw = (sqrtP / 2 ** 96) ** 2;
    const wethIsToken0 = WETH.toLowerCase() < token.toLowerCase();
    const wethPerToken = wethIsToken0 ? (1 / pRaw) * 10 ** (decimals - 18) : pRaw * 10 ** (decimals - 18);
    return wethPerToken * ethUsd;
  } catch { return null; }
}

/** Djup-taket i USD för en token (2× poolens WETH-sida) — null om opoolad. */
export async function tokenDepthCapUsd(pub: PublicClient, token: `0x${string}`): Promise<number | null> {
  const ethUsd = await ethUsdPrice();
  if (!ethUsd) return null;
  const pool = await findPool(pub, token);
  if (!pool) return null;
  try {
    const bal = await pub.readContract({ address: WETH, abi: ERC20_MIN, functionName: "balanceOf", args: [pool] }) as bigint;
    return (Number(bal) / 1e18) * DEPTH_CAP * ethUsd;
  } catch { return null; }
}
