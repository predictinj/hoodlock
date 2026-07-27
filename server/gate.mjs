/* Which tokens deserve a page.
 *
 * The chain mints tens of thousands of tokens a day and nearly all die within
 * hours. Publishing a page each would be a doorway farm: Google penalises the
 * whole domain, and nobody searches a token that lived half a day. The gate is
 * not hygiene around the token pages — it is the thing that makes them work.
 *
 * Candidates come from places that have already done some filtering, so we
 * never look at the ninety thousand: our own records, the explorer's indexed
 * token list, and DexScreener, which only lists pairs that have liquidity.
 */

const UA = { "User-Agent": "Mozilla/5.0 (compatible; HoodLock/1.0)" };
const DEXS = "https://api.dexscreener.com/latest/dex/tokens";
const BATCH = 30;   // DexScreener accepts this many addresses per request

export const DEFAULTS = {
  minAgeHours: 72,        // survived the window most tokens die in
  minLiquidityUsd: 25_000,
  minVolume24Usd: 5_000,
  minHolders: 250,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/** Every ERC-20 the explorer has indexed. Already sorted by activity. */
export async function explorerTokens(explorer, { maxPages = 20, pauseMs = 250 } = {}) {
  const out = [];
  let url = `${explorer}/api/v2/tokens?type=ERC-20`;
  for (let i = 0; i < maxPages && url; i++) {
    let d;
    try { d = await j(url); } catch { break; }
    for (const t of d.items || []) {
      const a = String(t.address || t.address_hash || "").toLowerCase();
      if (a) out.push({ address: a, symbol: t.symbol, holders: Number(t.holders || t.holders_count || 0) });
    }
    const n = d.next_page_params;
    url = n ? `${explorer}/api/v2/tokens?type=ERC-20&` + new URLSearchParams(
      Object.entries(n).filter(([, v]) => v != null)).toString() : null;
    await sleep(pauseMs);
  }
  return out;
}

/**
 * Market data for many tokens at once. DexScreener takes 30 addresses per
 * call, so screening several hundred costs about a dozen requests rather than
 * one per token.
 */
export async function screenMarket(addresses, { pauseMs = 300, log = () => {} } = {}) {
  const byToken = new Map();
  const absorb = (pairs) => {
    for (const p of pairs || []) {
      const a = String(p.baseToken?.address || "").toLowerCase();
      if (!a) continue;
      const liq = Number(p.liquidity?.usd || 0);
      const prev = byToken.get(a);
      // Keep the deepest pair — that's the one worth judging the token on.
      if (!prev || liq > prev.liquidityUsd) {
        byToken.set(a, {
          address: a,
          symbol: p.baseToken?.symbol || null,
          liquidityUsd: liq,
          volume24: Number(p.volume?.h24 || 0),
          createdAt: p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null,
          logo: p.info?.imageUrl || null,
        });
      }
    }
  };

  for (let i = 0; i < addresses.length; i += BATCH) {
    try { absorb((await j(`${DEXS}/${addresses.slice(i, i + BATCH).join(",")}`)).pairs); } catch { /* retried below */ }
    await sleep(pauseMs);
  }

  // The response caps at roughly thirty *pairs*, not thirty tokens, so one
  // token with many pairs can consume the whole batch and silently crowd the
  // rest out. Anything still missing is asked for on its own — otherwise those
  // tokens fail the gate for having no liquidity when they simply weren't
  // answered for.
  const missing = addresses.filter((a) => !byToken.has(String(a).toLowerCase()));
  if (missing.length) log(`re-querying ${missing.length} tokens crowded out of their batch`);
  for (const a of missing) {
    try { absorb((await j(`${DEXS}/${a}`)).pairs); } catch { /* genuinely absent */ }
    await sleep(pauseMs);
  }
  return byToken;
}

/**
 * Decide on one token. `hasRecords` short-circuits everything: a token we hold
 * a lock, burn or vesting schedule for always gets a page, because that page
 * is the proof its owner paid us for.
 */
export function qualify(row, { hasRecords = false, thresholds = DEFAULTS, now = Date.now() } = {}) {
  if (hasRecords) return { pass: true, why: ["has HoodLock records"] };
  const fail = [];
  const ageH = row.createdAt ? (now / 1000 - row.createdAt) / 3600 : null;
  if (ageH == null) fail.push("no pair");
  else if (ageH < thresholds.minAgeHours) fail.push(`age ${ageH.toFixed(0)}h < ${thresholds.minAgeHours}h`);
  if ((row.liquidityUsd || 0) < thresholds.minLiquidityUsd)
    fail.push(`liquidity $${Math.round(row.liquidityUsd || 0)} < $${thresholds.minLiquidityUsd}`);
  if ((row.volume24 || 0) < thresholds.minVolume24Usd)
    fail.push(`volume $${Math.round(row.volume24 || 0)} < $${thresholds.minVolume24Usd}`);
  if (row.holders != null && row.holders < thresholds.minHolders)
    fail.push(`holders ${row.holders} < ${thresholds.minHolders}`);
  return { pass: fail.length === 0, why: fail };
}

/**
 * The full pass: gather candidates, screen them, and return the ones that
 * qualify. `ownTokens` are addresses we already hold records for.
 */
export async function selectTokens({ explorer, ownTokens = [], thresholds = DEFAULTS, log = () => {} }) {
  const own = new Set(ownTokens.map((a) => String(a).toLowerCase()));
  const listed = await explorerTokens(explorer);
  log(`explorer listed ${listed.length} tokens`);

  const byAddr = new Map();
  for (const t of listed) byAddr.set(t.address, { ...t });
  for (const a of own) if (!byAddr.has(a)) byAddr.set(a, { address: a, holders: null });

  const market = await screenMarket([...byAddr.keys()], { log });
  log(`dexscreener returned pairs for ${market.size} of ${byAddr.size}`);

  const rows = [];
  for (const [addr, base] of byAddr) {
    const row = { ...base, ...(market.get(addr) || {}) };
    const verdict = qualify(row, { hasRecords: own.has(addr), thresholds });
    rows.push({ ...row, ...verdict });
  }
  rows.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return rows;
}
