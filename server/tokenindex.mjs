/* One shared token → records index, built from event logs.
 *
 * The first version of the token pages scanned every lock, burn and schedule
 * from contract state to find the ones belonging to a single token. That is
 * O(records) per page: fine for one page and 21 locks, hopeless at hundreds of
 * pages and thousands of records, because the same scan repeats per token.
 *
 * Every state change we care about is an event — Locked, Withdrawn, Extended,
 * Burned, VestingCreated, Claimed — so the whole picture can be rebuilt from
 * logs once and shared. Page lookups become a Map read, and the cost of
 * publishing another hundred pages is zero.
 */
import { keccak256, toHex } from "viem";

const topic = (sig) => keccak256(toHex(sig)).toLowerCase();
const T = {
  locked:   topic("Locked(uint256,address,address,uint256,uint256)"),
  withdrawn: topic("Withdrawn(uint256,address,uint256)"),
  extended: topic("Extended(uint256,uint256)"),
  burned:   topic("Burned(uint256,address,address,uint256)"),
  created:  topic("VestingCreated(uint256,address,address,address,uint256,uint64,uint64,uint64)"),
  claimed:  topic("Claimed(uint256,address,uint256)"),
};

const t0 = (l) => (l.topics?.[0] || "").toLowerCase();
const num = (hex) => BigInt(hex || "0x0");
const addrOf = (t) => (t ? "0x" + t.slice(-40).toLowerCase() : null);
/** 32-byte word `i` of a log's data section. */
const word = (l, i) => {
  const d = l.data || "0x";
  const s = 2 + i * 64;
  return d.length >= s + 64 ? BigInt("0x" + d.slice(s, s + 64)) : 0n;
};

/**
 * Build the index. Returns Map<tokenAddress, {locks, burns, vesting}> where
 * each record already reflects later events — a withdrawn lock is marked
 * withdrawn, an extended one carries its current unlock time.
 */
export async function buildTokenIndex({ readLogs, LOCKER, BURNER, VESTING }) {
  const byToken = new Map();
  const bucket = (addr) => {
    const k = String(addr).toLowerCase();
    if (!byToken.has(k)) byToken.set(k, { locks: [], burns: [], vesting: [] });
    return byToken.get(k);
  };

  if (LOCKER) {
    const logs = await readLogs(LOCKER);
    const locks = new Map(); // id -> record, so later events can amend it
    for (const l of logs) {
      const k = t0(l);
      if (k === T.locked) {
        const id = Number(num(l.topics[1]));
        const rec = { id, token: addrOf(l.topics[3]), owner: addrOf(l.topics[2]),
          amount: word(l, 0), unlock: Number(word(l, 1)), withdrawn: false, ts: l.timestamp || 0 };
        locks.set(id, rec);
        bucket(rec.token).locks.push(rec);
      } else if (k === T.withdrawn) {
        // A withdrawal moves no counter and writes no new record — without
        // this the page would keep calling an emptied position "locked".
        const r = locks.get(Number(num(l.topics[1])));
        if (r) r.withdrawn = true;
      } else if (k === T.extended) {
        const r = locks.get(Number(num(l.topics[1])));
        if (r) r.unlock = Number(word(l, 0));
      }
    }
  }

  if (BURNER) {
    for (const l of await readLogs(BURNER)) {
      if (t0(l) !== T.burned) continue;
      const token = addrOf(l.topics[3]);
      bucket(token).burns.push({ id: Number(num(l.topics[1])), token,
        burner: addrOf(l.topics[2]), amount: word(l, 0), ts: l.timestamp || 0 });
    }
  }

  if (VESTING) {
    const schedules = new Map();
    for (const l of await readLogs(VESTING)) {
      const k = t0(l);
      if (k === T.created) {
        const id = Number(num(l.topics[1]));
        // data: creator, total, start, cliff, end — token and beneficiary are indexed
        const rec = { id, token: addrOf(l.topics[2]), beneficiary: addrOf(l.topics[3]),
          total: word(l, 1), claimed: 0n, start: Number(word(l, 2)),
          cliff: Number(word(l, 3)), end: Number(word(l, 4)), ts: l.timestamp || 0 };
        schedules.set(id, rec);
        bucket(rec.token).vesting.push(rec);
      } else if (k === T.claimed) {
        const r = schedules.get(Number(num(l.topics[1])));
        if (r) r.claimed += word(l, 0);
      }
    }
  }

  for (const b of byToken.values()) {
    b.locks.sort((a, c) => a.id - c.id);
    b.burns.sort((a, c) => a.id - c.id);
    b.vesting.sort((a, c) => a.id - c.id);
  }
  return byToken;
}

/**
 * Cached index shared by every token page. The underlying log reader already
 * serves stale while it refreshes, so this stays cheap even when it expires.
 */
export function makeTokenIndex({ readLogs, LOCKER, BURNER, VESTING, ttlMs = 60_000, log = () => {} }) {
  let cache = null, at = 0, inflight = null;
  const refresh = () => {
    if (inflight) return inflight;
    inflight = buildTokenIndex({ readLogs, LOCKER, BURNER, VESTING })
      .then((m) => { cache = m; at = Date.now(); return m; })
      .catch((e) => { log(`token index failed: ${e?.message || e}`); return cache || new Map(); })
      .finally(() => { inflight = null; });
    return inflight;
  };
  return {
    /** Records for one token. O(1) once the index is warm. */
    async get(address) {
      if (!cache) await refresh();
      else if (Date.now() - at > ttlMs) refresh().catch(() => {}); // serve stale, refresh behind
      const empty = { locks: [], burns: [], vesting: [] };
      return (cache && cache.get(String(address).toLowerCase())) || empty;
    },
    /** Every token we hold any record for — the seed list for page candidates. */
    async tokens() {
      if (!cache) await refresh();
      return [...(cache ? cache.keys() : [])];
    },
    warm: refresh,
    get builtAt() { return at; },
  };
}
