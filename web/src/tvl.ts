/* Total value locked — computed CLIENT-SIDE from the chain, no backend:
 *   locked amounts  ← locker getLock-reads (everything not withdrawn)
 *   token prices    ← the chain's Uniswap-v3 DEX (WETH pools, slot0 spot)
 *   ETH/USD         ← Coinbase's free spot API (cached as fallback)
 * Honest by design: each token's contribution is CAPPED at 2× the pool's actual
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

/* Varje rad på skärmen frågar efter ETH-priset. Utan avdubblering blev det ett
   Coinbase-anrop per rad mot samma URL, som köade bakom webbläsarens gräns på
   sex anslutningar per värd — sista svaret kom 1,5 s efter det första. */
let ethUsdInflight: Promise<number> | null = null;
let ethUsdVal = 0, ethUsdAt = 0;
async function ethUsdPrice(): Promise<number> {
  if (ethUsdVal > 0 && Date.now() - ethUsdAt < 60_000) return ethUsdVal;
  if (ethUsdInflight) return ethUsdInflight;
  ethUsdInflight = (async () => {
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
      const j: any = await r.json();
      const p = Number(j?.data?.amount);
      if (p > 0) {
        ethUsdVal = p; ethUsdAt = Date.now();
        try { localStorage.setItem("hl_ethusd", String(p)); } catch { /* */ }
        return p;
      }
    } catch { /* fall through */ }
    try { return Number(localStorage.getItem("hl_ethusd")) || 0; } catch { return 0; }
  })();
  try { return await ethUsdInflight; } finally { ethUsdInflight = null; }
}

// pool-cache i localStorage — factoryn ändrar sig aldrig för ett givet par
/* v2-nyckel: v1-cachen förgiftades under RPC-rate-limiting — misslyckade
   uppslag sparades som "none" och tokens blev oprissatta för alltid. */
function cachedPool(token: string): string | null | undefined {
  try {
    const v = localStorage.getItem(`hl_pool2_${token.toLowerCase()}`);
    if (v === null) return undefined;   // aldrig slått upp
    return v === "none" ? null : v;
  } catch { return undefined; }
}
function rememberPool(token: string, pool: string | null) {
  try { localStorage.setItem(`hl_pool2_${token.toLowerCase()}`, pool ?? "none"); } catch { /* */ }
}

/* Pool-cachen ligger i localStorage och skrivs först efter uppslaget, så N rader
   med samma token startade N identiska uppslag. Dela det pågående i stället. */
const poolInflight = new Map<string, Promise<`0x${string}` | null>>();
function findPool(pub: PublicClient, token: `0x${string}`): Promise<`0x${string}` | null> {
  const key = token.toLowerCase();
  const hit = cachedPool(token);
  if (hit !== undefined) return Promise.resolve(hit as `0x${string}` | null);
  const running = poolInflight.get(key);
  if (running) return running;
  const p = lookupPool(pub, token).finally(() => poolInflight.delete(key));
  poolInflight.set(key, p);
  return p;
}
async function lookupPool(pub: PublicClient, token: `0x${string}`): Promise<`0x${string}` | null> {
  // Alla fee-tiers samtidigt. VIKTIGT: ett misslyckat anrop får ALDRIG tolkas
  // som "ingen pool" — under rate-limiting cacheades det som "none" permanent
  // och token blev oprissatt för evigt. Fel kastas; bara verifierade svar
  // (alla fyra uppslag lyckades) får skrivas till cachen.
  const results = await Promise.all(FEES.map((fee) =>
    (pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [token, WETH, fee] }) as Promise<string>)
      .then((p) => ({ ok: true as const, p: p && p !== ZERO ? (p as `0x${string}`) : null }))
      .catch(() => ({ ok: false as const, p: null }))));
  if (results.some((r) => !r.ok)) throw new Error("pool lookup failed");
  const pools = results.map((r) => r.p);
  const bals = await Promise.all(pools.map((p) => p
    ? (pub.readContract({ address: WETH, abi: ERC20_MIN, functionName: "balanceOf", args: [p] }) as Promise<bigint>)
    : Promise.resolve(0n)));
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (p && bals[i] > 0n) { rememberPool(token, p); return p; }
  }
  rememberPool(token, null);
  return null;
}

/* Serverns prisendpoint som reserv: samma matte, körd på serverns IP och
   cachad där. null = kunde inte nås; { pool: null } = verifierat opoolad. */
const srvPriceCache = new Map<string, { at: number; v: any }>();
async function serverPrice(token: string): Promise<{ pool: string | null; wethPerToken?: number; depthWeth?: number; decimals?: number; ethUsd?: number } | null> {
  const k = token.toLowerCase();
  const hit = srvPriceCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  try {
    const r = await fetch(`/api/price/${k}`);
    if (!r.ok) return null;
    const v = await r.json();
    srvPriceCache.set(k, { at: Date.now(), v });
    return v;
  } catch { return null; }
}

/** WETH-värdet av `amount` råenheter av `token`, kapat vid poolens djup. */
async function tokenValueWeth(pub: PublicClient, token: `0x${string}`, amount: bigint, decimals: number): Promise<number | null> {
  try {
    const pool = await findPool(pub, token);
    if (!pool) return null;   // verifierat opoolad
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
  } catch {
    // direkta läsningar strypta — serverns cachade pris i stället
    const sp = await serverPrice(token);
    if (!sp || !sp.pool || !sp.wethPerToken) return null;
    const dec = sp.decimals ?? decimals;
    const amt = Number(amount) / 10 ** dec;
    return Math.min(amt * sp.wethPerToken, (sp.depthWeth ?? 0) * DEPTH_CAP);
  }
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
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Kapat USD-värde för en given mängd av en token (samma djup-politik som TVL:n). */
export async function amountValueUsd(pub: PublicClient, token: `0x${string}`, amount: bigint, decimals: number): Promise<number | null> {
  const ethUsd = await ethUsdPrice();
  if (!ethUsd) return null;
  const v = await tokenValueWeth(pub, token, amount, decimals);
  return v === null ? null : v * ethUsd;
}

/** USD-spotpris per HUMAN token (okapad) — för diagramserier m.m. */
export async function tokenPriceUsd(pub: PublicClient, token: `0x${string}`, decimals: number): Promise<number | null> {
  const ethUsd = await ethUsdPrice();
  if (!ethUsd) return null;
  try {
    const pool = await findPool(pub, token);
    if (!pool) return null;
    const slot0: any = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" });
    const sqrtP = Number(slot0[0] ?? slot0.sqrtPriceX96);
    if (!sqrtP) return null;
    const pRaw = (sqrtP / 2 ** 96) ** 2;
    const wethIsToken0 = WETH.toLowerCase() < token.toLowerCase();
    const wethPerToken = wethIsToken0 ? (1 / pRaw) * 10 ** (decimals - 18) : pRaw * 10 ** (decimals - 18);
    return wethPerToken * ethUsd;
  } catch {
    const sp = await serverPrice(token);
    return sp && sp.pool && sp.wethPerToken ? sp.wethPerToken * ethUsd : null;
  }
}

/** Djup-taket i USD för en token (2× poolens WETH-sida) — null om opoolad. */
export async function tokenDepthCapUsd(pub: PublicClient, token: `0x${string}`): Promise<number | null> {
  const ethUsd = await ethUsdPrice();
  if (!ethUsd) return null;
  try {
    const pool = await findPool(pub, token);
    if (!pool) return null;
    const bal = await pub.readContract({ address: WETH, abi: ERC20_MIN, functionName: "balanceOf", args: [pool] }) as bigint;
    return (Number(bal) / 1e18) * DEPTH_CAP * ethUsd;
  } catch {
    const sp = await serverPrice(token);
    return sp && sp.pool && sp.depthWeth ? sp.depthWeth * DEPTH_CAP * ethUsd : null;
  }
}
