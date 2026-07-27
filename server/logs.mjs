/* Event-log reads that survive the chain's 2000-block eth_getLogs cap.
 *
 * Robinhood's public RPC rejects any getLogs spanning more than 2000 blocks
 * ("only allowed to search 2000 blocks per request"), and the chain is at
 * ~21M blocks — so the fromBlock:0 → latest queries this app was built on now
 * fail every time. They were wrapped in .catch(() => []), so they failed
 * silently and quietly zeroed every affiliate commission.
 *
 * Blockscout is an indexer and has no such limit: one request returns a
 * contract's logs including block_timestamp, which also removes the separate
 * getBlock call we previously made per log. RPC chunking stays as a fallback
 * for when Blockscout is unreachable.
 */

const CHUNK = 2000n;        // the chain's hard per-request cap
const MAX_CHUNK_CALLS = 400; // ~800k blocks; a safety valve, not a real limit

/** Normalised log shape shared by both sources. */
const shape = (address, topics, data, blockNumber, txHash, ts, decoded = null) => ({
  address, topics, data,
  blockNumber: BigInt(blockNumber),
  transactionHash: txHash,
  timestamp: ts,  // seconds; null when unknown (RPC fallback path)
  decoded,        // Blockscout decodes non-indexed params too; null on the RPC path
});

async function fromBlockscout(explorer, address, signal) {
  const out = [];
  let url = `${explorer}/api/v2/addresses/${address}/logs`;
  for (let page = 0; page < 25; page++) { // bounded: 25 pages is far past our volume
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`blockscout ${r.status}`);
    const j = await r.json();
    for (const it of j.items || []) {
      const ts = it.block_timestamp ? Math.floor(new Date(it.block_timestamp).getTime() / 1000) : null;
      out.push(shape(
        (it.address?.hash || address).toLowerCase(),
        it.topics || [],
        it.data ?? "0x",
        it.block_number,
        it.transaction_hash || it.tx_hash,
        ts,
        it.decoded || null,
      ));
    }
    const n = j.next_page_params;
    if (!n) break;
    url = `${explorer}/api/v2/addresses/${address}/logs?` + new URLSearchParams(n).toString();
  }
  return out;
}

async function fromRpcChunked(pub, address, fromBlock, head) {
  const out = [];
  let calls = 0;
  for (let b = fromBlock; b <= head && calls < MAX_CHUNK_CALLS; b += CHUNK, calls++) {
    const to = b + CHUNK - 1n > head ? head : b + CHUNK - 1n;
    let logs = [];
    try { logs = await pub.getLogs({ address, fromBlock: b, toBlock: to }); }
    catch { continue; } // a single bad window must not lose the whole history
    for (const l of logs) {
      out.push(shape(address.toLowerCase(), l.topics, l.data, l.blockNumber, l.transactionHash, null));
    }
  }
  return out;
}

/**
 * All logs for a contract, newest-last. Blockscout first (one call, carries
 * timestamps), chunked RPC as fallback. Cached for `ttlMs`.
 */
export function makeLogReader({ pub, explorer, ttlMs = 60_000, deployBlock = 0n, log = () => {} }) {
  const cache = new Map(); // address -> { at, logs }
  return async function readLogs(address) {
    const key = String(address).toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.logs;

    let logs = null;
    if (explorer) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 12_000);
        try { logs = await fromBlockscout(explorer, key, ac.signal); }
        finally { clearTimeout(t); }
      } catch (e) { log(`blockscout logs failed for ${key}: ${e?.message || e}`); }
    }

    if (logs === null) {
      try {
        const head = await pub.getBlockNumber();
        logs = await fromRpcChunked(pub, key, deployBlock, head);
        log(`fell back to chunked rpc for ${key}: ${logs.length} logs`);
      } catch (e) {
        log(`chunked rpc failed for ${key}: ${e?.message || e}`);
        return hit ? hit.logs : []; // stale data beats no data
      }
    }

    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1));
    cache.set(key, { at: Date.now(), logs });
    return logs;
  };
}

/** Keep only logs whose topic0 matches, decoding nothing else. */
export const byTopic = (logs, topic0) =>
  logs.filter((l) => (l.topics?.[0] || "").toLowerCase() === topic0.toLowerCase());

/** Indexed address argument at position `i` (topics[1..3]) as a 0x… address. */
export const addrArg = (l, i) => {
  const t = l.topics?.[i];
  return t ? "0x" + t.slice(-40) : null;
};

/**
 * An address parameter by name. Indexed params come from topics; non-indexed
 * ones need Blockscout's decoding, so `dataWord` says which 32-byte word of
 * `data` holds it when we're on the RPC fallback path.
 */
export const addrParam = (l, name, dataWord = null) => {
  const p = (l.decoded?.parameters || []).find((x) => x.name === name);
  if (p?.value) return String(p.value).toLowerCase();
  if (dataWord !== null && typeof l.data === "string" && l.data.length >= 2 + (dataWord + 1) * 64) {
    const w = l.data.slice(2 + dataWord * 64, 2 + (dataWord + 1) * 64);
    return "0x" + w.slice(-40);
  }
  return null;
};
