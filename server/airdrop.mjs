/* Airdrop storage, indexing and proofs.
 *
 * The chain holds everything about an airdrop except the recipient list, which
 * is too large to put there. So this module stores exactly one thing, the list,
 * and reads the rest from events.
 *
 * The list is keyed on its Merkle root rather than on an airdrop id, and that
 * is a security property rather than a convenience. Two airdrops may share a
 * root, which was confirmed on chain during the audit: nothing stops a second
 * creator using a root a first creator is about to use. Had a list been bound
 * to one id, front-running an upload with a one-wei airdrop would have attached
 * someone else's list to the attacker's airdrop. Keyed on the root there is no
 * binding to hijack, and two airdrops sharing a root correctly share the list,
 * because anyone claiming against either is genuinely on it.
 *
 * Uploads arrive before the creation transaction confirms, so a list starts
 * unbound and is pruned if no airdrop ever uses it. Without that, an open
 * upload endpoint is a way to fill the disk.
 */
import { keccak256, toHex, getAddress } from "viem";
import { buildTree, merkleProof } from "../shared/merkle.mjs";
import { normaliseList } from "../shared/airdrop-list.mjs";

export const T_AIRDROP_CREATED = keccak256(
  toHex("AirdropCreated(uint256,address,address,bytes32,uint256,uint32,uint64,string)"),
);
export const T_AIRDROP_CLAIMED = keccak256(toHex("Claimed(uint256,uint256,address,uint256)"));
export const T_AIRDROP_SWEPT = keccak256(toHex("Swept(uint256,address,uint256)"));

/** An unbound list is kept this long before it is assumed abandoned. */
const UNBOUND_TTL = 24 * 3600;
/** Refuse a list larger than this. The UI stops well before it. */
export const MAX_LIST = 100_000;

export function initAirdropTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS airdrop_lists (
      root TEXT PRIMARY KEY,
      list_json TEXT NOT NULL,
      count INTEGER NOT NULL,
      total TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      bound INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS airdrop_lists_unbound ON airdrop_lists (bound, uploaded_at);
  `);
}

/**
 * Store a list, but only after recomputing its root from the entries and
 * finding that it matches what the uploader claims. We are never trusted, and
 * neither is the uploader.
 */
export function saveList(db, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("empty list");
  if (entries.length > MAX_LIST) throw new Error(`list over ${MAX_LIST} entries`);

  const clean = entries.map((e) => {
    const address = String(e.address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error("bad address in list");
    const amount = BigInt(e.amount);
    if (amount <= 0n) throw new Error("non-positive amount in list");
    return { address, amount };
  });

  // Normalise here as well as in the browser. The root is a function of the
  // normalised set, so if the two disagreed the stored list would produce a
  // different root than the one on chain and no proof would verify.
  const { entries: norm, count, total } = normaliseList(clean);
  const { root } = buildTree(norm);

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO airdrop_lists (root, list_json, count, total, uploaded_at, bound)
     VALUES (?,?,?,?,?,0) ON CONFLICT(root) DO NOTHING`,
  ).run(root, JSON.stringify(norm.map((e) => [e.address, e.amount.toString()])), count, total.toString(), now);

  return { root, count, total };
}

export function getList(db, root) {
  const row = db.prepare("SELECT * FROM airdrop_lists WHERE root = ?").get(String(root).toLowerCase());
  if (!row) return null;
  return {
    root: row.root,
    count: row.count,
    total: BigInt(row.total),
    entries: JSON.parse(row.list_json).map(([address, amount]) => ({ address, amount: BigInt(amount) })),
  };
}

/** Mark every root that an on-chain airdrop uses, so pruning cannot take it. */
export function bindRoots(db, roots) {
  if (!roots.length) return;
  const stmt = db.prepare("UPDATE airdrop_lists SET bound = 1 WHERE root = ? AND bound = 0");
  for (const r of roots) stmt.run(String(r).toLowerCase());
}

export function pruneUnbound(db) {
  const cutoff = Math.floor(Date.now() / 1000) - UNBOUND_TTL;
  return db.prepare("DELETE FROM airdrop_lists WHERE bound = 0 AND uploaded_at < ?").run(cutoff).changes;
}

/* ---------- trees, cached ----------
 * Building the levels is O(n) and a proof off them is O(log n). Rebuilding per
 * request measured at 593ms for a 50,000-entry list, so the levels are kept.
 */
const treeCache = new Map();
const TREE_CACHE_MAX = 12;

function treeFor(db, root) {
  const key = String(root).toLowerCase();
  if (treeCache.has(key)) return treeCache.get(key);
  const list = getList(db, key);
  if (!list) return null;
  const tree = buildTree(list.entries);
  const byAddress = new Map(list.entries.map((e, index) => [e.address, { index, amount: e.amount }]));
  const built = { tree, list, byAddress };
  if (treeCache.size >= TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value);
  treeCache.set(key, built);
  return built;
}

/** What this address is owed in this list, with the proof to claim it. */
export function proofFor(db, root, address) {
  const built = treeFor(db, root);
  if (!built) return null;
  const hit = built.byAddress.get(String(address).toLowerCase());
  if (!hit) return null;
  return {
    index: hit.index,
    account: getAddress(address),
    amount: hit.amount.toString(),
    proof: merkleProof(built.tree.levels, hit.index),
  };
}

/* ---------- reading the chain ---------- */

const num = (hex) => BigInt(hex || "0x0");
const addrOf = (t) => (t ? "0x" + t.slice(-40).toLowerCase() : null);
const word = (data, i) => {
  const d = data || "0x";
  const s = 2 + i * 64;
  return d.length >= s + 64 ? BigInt("0x" + d.slice(s, s + 64)) : 0n;
};

/**
 * Every airdrop, rebuilt from events, with later events folded in so a record
 * reflects what is true now rather than what was true at creation.
 *
 * Claims are counted here rather than read one call at a time, which is what
 * keeps the cost of the hundredth airdrop the same as the first.
 */
export async function buildAirdropIndex({ readLogs, AIRDROP }) {
  const byId = new Map();
  if (!AIRDROP) return byId;

  const logs = await readLogs(String(AIRDROP).toLowerCase());
  for (const l of logs) {
    const t0 = (l.topics?.[0] || "").toLowerCase();
    const id = Number(num(l.topics?.[1]));

    if (t0 === T_AIRDROP_CREATED.toLowerCase()) {
      // data: merkleRoot, total, maxClaims, endTime, listURI(offset)
      byId.set(id, {
        id,
        token: addrOf(l.topics[2]),
        creator: addrOf(l.topics[3]),
        root: "0x" + (l.data || "0x").slice(2, 66),
        total: word(l.data, 1),
        maxClaims: Number(word(l.data, 2)),
        endTime: Number(word(l.data, 3)),
        claims: 0,
        claimed: 0n,
        swept: 0n,
        ts: l.timestamp || 0,
      });
    } else if (t0 === T_AIRDROP_CLAIMED.toLowerCase()) {
      const r = byId.get(id);
      if (r) { r.claims += 1; r.claimed += word(l.data, 1); }
    } else if (t0 === T_AIRDROP_SWEPT.toLowerCase()) {
      const r = byId.get(id);
      if (r) r.swept = word(l.data, 0);
    }
  }
  for (const r of byId.values()) r.remaining = r.total - r.claimed - r.swept;
  return byId;
}

/**
 * Cached index, same serve-stale-and-refresh behaviour as the token index, so a
 * slow chain read never blocks a page.
 */
export function makeAirdropIndex({ readLogs, AIRDROP, getDb = () => null, ttlMs = 60_000, log = () => {} }) {
  let cache = null, at = 0, inflight = null;
  const refresh = () => {
    if (inflight) return inflight;
    inflight = buildAirdropIndex({ readLogs, AIRDROP })
      .then((m) => {
        cache = m; at = Date.now();
        // Anything the chain refers to must survive pruning. Read through a
        // getter because the database opens after this index is constructed.
        const db = getDb();
        if (db) { try { bindRoots(db, [...m.values()].map((r) => r.root)); } catch { /* not fatal */ } }
        return m;
      })
      .catch((e) => { log(`airdrop index failed: ${e?.message || e}`); return cache || new Map(); })
      .finally(() => { inflight = null; });
    return inflight;
  };
  return {
    async all() {
      if (!cache) await refresh();
      else if (Date.now() - at > ttlMs) refresh().catch(() => {});
      return cache || new Map();
    },
    async get(id) { return (await this.all()).get(Number(id)) || null; },
    warm: refresh,
    get builtAt() { return at; },
  };
}

/**
 * Everything one address can still claim, across every airdrop.
 *
 * Deliberately reads the list rather than the chain for eligibility, and the
 * chain for whether it has already been taken, because those are the two
 * different questions and only the chain can answer the second.
 */
export async function eligibleFor({ index, db, pub, AIRDROP, ABI, address, log = () => {} }) {
  const who = String(address).toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const out = [];

  for (const a of (await index.all()).values()) {
    if (a.endTime !== 0 && now >= a.endTime) continue;      // closed
    if (a.claims >= a.maxClaims) continue;                   // ceiling reached
    const hit = proofFor(db, a.root, who);
    if (!hit) continue;

    let claimed = false;
    try {
      claimed = await pub.readContract({
        address: AIRDROP, abi: ABI, functionName: "isClaimed", args: [BigInt(a.id), BigInt(hit.index)],
      });
    } catch (e) {
      /* Left as unclaimed on purpose: hiding an entitlement because a read
         failed would strand somebody, whereas offering one that turns out to be
         taken costs a reverted transaction and nothing else.
         Logged rather than swallowed. A silent catch here hid a batching
         problem for several rounds of debugging, and it would have hidden a
         real RPC fault in production just as well. */
      log(`isClaimed read failed for airdrop ${a.id} index ${hit.index}: ${e?.shortMessage || e?.message || e}`);
    }
    if (claimed) continue;

    const amount = BigInt(hit.amount);
    out.push({
      id: a.id, token: a.token, index: hit.index, amount: amount.toString(),
      endTime: a.endTime, proof: hit.proof,
      // Honest about the race: the tree may promise more than was funded.
      shortfall: amount > a.remaining,
    });
  }
  return out;
}
