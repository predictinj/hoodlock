/* HoodLock server — serves the static site AND powers affiliate tracking.
 * The static site is served no matter what; if the DB or chain layer fails to
 * init, only the /api and /r routes degrade — the app stays up. */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, verifyMessage, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const cfg = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));

const ADMIN = (process.env.ADMIN_WALLET || "0x79c1230cab12d53d040f5fe1f5279e1a481ccea2").toLowerCase();
const PORT = process.env.PORT || 8080;
const REF_RE = /^[A-Za-z0-9_-]{3,32}$/;

/* ---------- chain ---------- */
const CHAIN = defineChain({ id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } });
const pub = createPublicClient({ chain: CHAIN, transport: http(cfg.rpc) });
const LOCKER = getAddress(cfg.locker);
const LOCKED_EVENT = { type: "event", name: "Locked", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
  { name: "unlockTime", type: "uint256", indexed: false } ] };
const FEE_ABI = [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

let FEE_ETH = 0.005; // sane default; refreshed from chain at boot
pub.readContract({ address: LOCKER, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { FEE_ETH = Number(f) / 1e18; })
  .catch(() => { /* keep default */ });

// owner -> number of locks, cached 60s (drives affiliate revenue attribution)
let lockCache = { at: 0, byOwner: new Map() };
async function lockCounts() {
  if (Date.now() - lockCache.at < 60_000) return lockCache.byOwner;
  const logs = await pub.getLogs({ address: LOCKER, event: LOCKED_EVENT, fromBlock: 0n, toBlock: "latest" });
  const byOwner = new Map();
  for (const lg of logs) { const o = String(lg.args.owner).toLowerCase(); byOwner.set(o, (byOwner.get(o) || 0) + 1); }
  lockCache = { at: Date.now(), byOwner };
  return byOwner;
}

/* ---------- db (degrades gracefully) ---------- */
let db = null;
try {
  const { default: Database } = await import("better-sqlite3");
  const dir = process.env.DB_DIR || (existsSync("/data") ? "/data" : join(__dirname, "..", "data"));
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, "hoodlock.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliates (code TEXT PRIMARY KEY, label TEXT, clicks INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS attributions (wallet TEXT PRIMARY KEY, code TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS connections (wallet TEXT PRIMARY KEY, first_ts INTEGER, last_ts INTEGER, hits INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, owner_wallet TEXT, amount_eth REAL, status TEXT, tx_hash TEXT, requested_at INTEGER, paid_at INTEGER);
  `);
  // public affiliates: an affiliates row with an owner earns 30% (NULL = internal campaign)
  const cols = db.prepare("PRAGMA table_info(affiliates)").all().map((c) => c.name);
  if (!cols.includes("owner_wallet")) db.exec("ALTER TABLE affiliates ADD COLUMN owner_wallet TEXT");
  console.log("[hoodlock] db ready at", dir);
} catch (e) {
  console.error("[hoodlock] DB unavailable — affiliate features disabled, site still serves:", e?.message || e);
}

/* ---------- admin auth (wallet signature) ---------- */
const sessions = new Map(); // token -> exp (ms)
function newToken() { return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function validToken(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { if (exp) sessions.delete(t); return false; }
  return true;
}

/* ---------- public affiliate program ---------- */
const nowSec = () => Math.floor(Date.now() / 1000);
const COMMISSION = 0.30;
const CODE_RE = /^[a-z0-9_-]{3,20}$/;
const RESERVED = new Set(["hoodlock", "admin", "app", "api", "r", "blog", "official", "support", "www", "help", "docs", "test"]);
const normCode = (c) => String(c || "").toLowerCase();
const codeValid = (c) => CODE_RE.test(c) && !RESERVED.has(c);

// ETH/USD for the $10 claim gate (5-min cache; same source as the frontend)
let ethUsdCache = { at: 0, v: 0 };
async function ethUsd() {
  if (Date.now() - ethUsdCache.at < 5 * 60_000 && ethUsdCache.v > 0) return ethUsdCache.v;
  try {
    const j = await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot")).json();
    const p = Number(j?.data?.amount);
    if (p > 0) ethUsdCache = { at: Date.now(), v: p };
  } catch { /* keep last */ }
  return ethUsdCache.v;
}

// per-owner lock block-timestamps (drives post-attribution commission), cached 60s
const blockTsCache = new Map();
async function blockTsOf(bn) {
  const k = bn.toString();
  if (blockTsCache.has(k)) return blockTsCache.get(k);
  const b = await pub.getBlock({ blockNumber: bn });
  const ts = Number(b.timestamp);
  blockTsCache.set(k, ts);
  return ts;
}
let lockRecCache = { at: 0, byOwner: new Map() };
async function lockRecords() {
  if (Date.now() - lockRecCache.at < 60_000) return lockRecCache.byOwner;
  const logs = await pub.getLogs({ address: LOCKER, event: LOCKED_EVENT, fromBlock: 0n, toBlock: "latest" });
  const byOwner = new Map();
  for (const lg of logs) {
    const owner = String(lg.args.owner).toLowerCase();
    const ts = await blockTsOf(lg.blockNumber);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(ts);
  }
  lockRecCache = { at: Date.now(), byOwner };
  return byOwner;
}

// 30% × fee × locks by attributed wallets that happened AFTER attribution (excl. self)
async function affiliateEarnings(code, ownerWallet) {
  const records = await lockRecords();
  const attrs = db.prepare("SELECT wallet, ts FROM attributions WHERE LOWER(code) = ?").all(code.toLowerCase());
  let lockers = 0, qualifyingLocks = 0;
  for (const a of attrs) {
    const w = a.wallet.toLowerCase();
    if (w === ownerWallet.toLowerCase()) continue;   // block same-wallet self-referral
    const q = (records.get(w) || []).filter((t) => t > a.ts).length;
    if (q > 0) { lockers++; qualifyingLocks += q; }
  }
  return { lockers, qualifyingLocks, lifetimeEarnedEth: COMMISSION * FEE_ETH * qualifyingLocks };
}
const claimedFor = (code) => db.prepare("SELECT COALESCE(SUM(amount_eth),0) s FROM claims WHERE LOWER(code)=? AND status IN ('pending','paid')").get(code.toLowerCase()).s;
const dailyPaid = () => db.prepare("SELECT COALESCE(SUM(amount_eth),0) s FROM claims WHERE status='paid' AND paid_at > ?").get(nowSec() - 86400).s;

// hardened hot payout wallet (optional — claims queue as 'pending' if unset/disabled)
const PAYOUTS_ENABLED = process.env.PAYOUTS_ENABLED !== "false";
const PAYOUT_MAX_ETH = Number(process.env.PAYOUT_MAX_ETH || 0.5);
const PAYOUT_DAILY_ETH = Number(process.env.PAYOUT_DAILY_ETH || 1);
let payoutAccount = null, walletClient = null;
try {
  if (process.env.PAYOUT_PRIVATE_KEY) {
    const pk = process.env.PAYOUT_PRIVATE_KEY.startsWith("0x") ? process.env.PAYOUT_PRIVATE_KEY : "0x" + process.env.PAYOUT_PRIVATE_KEY;
    payoutAccount = privateKeyToAccount(pk);
    walletClient = createWalletClient({ account: payoutAccount, chain: CHAIN, transport: http(cfg.rpc) });
    console.log("[hoodlock] payout wallet ready:", payoutAccount.address);
  } else {
    console.log("[hoodlock] no PAYOUT_PRIVATE_KEY — claims will queue as pending");
  }
} catch (e) { console.error("[hoodlock] payout wallet init failed:", e?.message || e); }

// public affiliate sessions (separate namespace from admin — NEVER grants admin)
const affSessions = new Map(); // token -> { address, exp }
function affWallet(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = affSessions.get(t);
  if (!s || s.exp < Date.now()) { if (s) affSessions.delete(t); return null; }
  return s.address;
}

// tiny per-IP rate limiter
const rlMap = new Map();
function limited(req, res, max, windowMs = 60_000) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?";
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; rlMap.set(ip, e); }
  if (++e.count > max) { res.status(429).json({ error: "rate limited" }); return true; }
  return false;
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

/* affiliate redirect: /r/<code> → count a click, hand off to the app with ?ref */
app.get("/r/:code", (req, res) => {
  const code = req.params.code;
  if (db && REF_RE.test(code) && !limited(req, res, 120)) {
    try { db.prepare("UPDATE affiliates SET clicks = clicks + 1 WHERE LOWER(code) = LOWER(?)").run(code); } catch { /* */ }
  }
  res.redirect(302, "/app/locks?ref=" + encodeURIComponent(code));
});

/* first-touch attribution — open (analytics only, immutable once set) */
app.post("/api/ref/visit", (req, res) => {
  if (!db) return res.json({ ok: false });
  if (limited(req, res, 30)) return;
  const wallet = String(req.body?.wallet || "").toLowerCase();
  const ref = String(req.body?.ref || "");
  if (!isAddress(wallet) || !REF_RE.test(ref)) return res.status(400).json({ ok: false });
  const row = db.prepare("SELECT code FROM affiliates WHERE LOWER(code) = LOWER(?)").get(ref);
  if (!row) return res.json({ ok: false });
  try { db.prepare("INSERT OR IGNORE INTO attributions (wallet, code, ts) VALUES (?,?,?)").run(wallet, row.code, nowSec()); } catch { /* */ }
  res.json({ ok: true });
});

/* track a wallet connecting to the platform (open — the owner's own analytics) */
app.post("/api/track/connect", (req, res) => {
  if (!db) return res.json({ ok: false });
  const wallet = String(req.body?.wallet || "").toLowerCase();
  if (!isAddress(wallet)) return res.status(400).json({ ok: false });
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(`INSERT INTO connections (wallet, first_ts, last_ts, hits) VALUES (?,?,?,1)
      ON CONFLICT(wallet) DO UPDATE SET last_ts = ?, hits = hits + 1`).run(wallet, now, now, now);
  } catch { /* */ }
  res.json({ ok: true });
});

/* admin session: verify a signed message recovers to the admin wallet */
app.post("/api/admin/session", async (req, res) => {
  try {
    const { address, ts, signature } = req.body || {};
    if (String(address).toLowerCase() !== ADMIN) return res.status(403).json({ error: "not admin" });
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return res.status(400).json({ error: "stale" });
    const ok = await verifyMessage({ address: getAddress(address), message: `HoodLock admin ${ts}`, signature });
    if (!ok) return res.status(403).json({ error: "bad signature" });
    const token = newToken();
    sessions.set(token, Date.now() + 30 * 60_000);
    res.json({ token, exp: Date.now() + 30 * 60_000 });
  } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
});

/* platform stats not derivable purely on-chain (wallet connections, clicks) */
app.get("/api/admin/stats", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const now = Math.floor(Date.now() / 1000);
    const connectedWallets = db.prepare("SELECT COUNT(*) n FROM connections").get().n;
    const connected7d = db.prepare("SELECT COUNT(*) n FROM connections WHERE last_ts > ?").get(now - 7 * 86400).n;
    const totalClicks = db.prepare("SELECT COALESCE(SUM(clicks),0) n FROM affiliates").get().n;
    const attributed = db.prepare("SELECT COUNT(*) n FROM attributions").get().n;
    res.json({ connectedWallets, connected7d, totalClicks, attributed });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* list affiliates with computed stats — requires a valid admin session token */
app.get("/api/admin/affiliates", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const affs = db.prepare("SELECT code, label, clicks FROM affiliates ORDER BY created_at DESC").all();
    const byOwner = await lockCounts().catch(() => new Map());
    const out = affs.map((a) => {
      const wallets = db.prepare("SELECT wallet FROM attributions WHERE code = ?").all(a.code).map((r) => r.wallet);
      let lockers = 0, locks = 0;
      for (const w of wallets) { const c = byOwner.get(w) || 0; if (c > 0) { lockers++; locks += c; } }
      return { code: a.code, label: a.label || "", clicks: a.clicks, signups: wallets.length, lockers, locks, revenueEth: locks * FEE_ETH };
    });
    res.json({ affiliates: out });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* create an affiliate link — requires a valid admin session token */
app.post("/api/admin/affiliates", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  const label = String(req.body?.label || "").slice(0, 80);
  let code = "";
  for (let i = 0; i < 6; i++) code += "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)];
  try {
    db.prepare("INSERT INTO affiliates (code, label, clicks, created_at) VALUES (?,?,0,?)").run(code, label, Math.floor(Date.now() / 1000));
    res.json({ ok: true, code });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* ---------- public affiliate program endpoints ---------- */
// wallet session: one signature → 30-min wallet-scoped token (NEVER admin)
app.post("/api/aff/session", async (req, res) => {
  if (limited(req, res, 20)) return;
  try {
    const { address, ts, signature } = req.body || {};
    if (!isAddress(address)) return res.status(400).json({ error: "bad address" });
    if (Math.abs(nowSec() - Number(ts)) > 300) return res.status(400).json({ error: "stale" });
    const ok = await verifyMessage({ address: getAddress(address), message: `HoodLock affiliate ${ts}`, signature });
    if (!ok) return res.status(403).json({ error: "bad signature" });
    const token = newToken();
    affSessions.set(token, { address: address.toLowerCase(), exp: Date.now() + 30 * 60_000 });
    res.json({ token, exp: Date.now() + 30 * 60_000 });
  } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
});

app.get("/api/aff/available", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const code = normCode(req.query.code);
  if (!codeValid(code)) return res.json({ available: false, reason: "invalid" });
  const taken = db.prepare("SELECT 1 FROM affiliates WHERE LOWER(code) = ?").get(code);
  res.json({ available: !taken, reason: taken ? "taken" : "ok" });
});

app.post("/api/aff/create", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const wallet = affWallet(req);
  if (!wallet) return res.status(401).json({ error: "unauthorized" });
  const code = normCode(req.body?.code);
  if (!codeValid(code)) return res.status(400).json({ error: "invalid code" });
  if (db.prepare("SELECT code FROM affiliates WHERE owner_wallet = ?").get(wallet)) return res.status(400).json({ error: "you already have a link" });
  if (db.prepare("SELECT 1 FROM affiliates WHERE LOWER(code) = ?").get(code)) return res.status(409).json({ error: "code taken" });
  try {
    db.prepare("INSERT INTO affiliates (code, label, clicks, created_at, owner_wallet) VALUES (?,?,0,?,?)").run(code, "", nowSec(), wallet);
    res.json({ ok: true, code });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.get("/api/aff/me", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const wallet = affWallet(req);
  if (!wallet) return res.status(401).json({ error: "unauthorized" });
  const aff = db.prepare("SELECT code, clicks, created_at FROM affiliates WHERE owner_wallet = ?").get(wallet);
  if (!aff) return res.json({ hasCode: false });
  const attrs = db.prepare("SELECT wallet, ts FROM attributions WHERE LOWER(code) = ?").all(aff.code.toLowerCase());
  const { lockers, qualifyingLocks, lifetimeEarnedEth } = await affiliateEarnings(aff.code, wallet).catch(() => ({ lockers: 0, qualifyingLocks: 0, lifetimeEarnedEth: 0 }));
  const claimed = claimedFor(aff.code);
  const claimable = Math.max(0, lifetimeEarnedEth - claimed);
  const claims = db.prepare("SELECT amount_eth, status, tx_hash, requested_at, paid_at FROM claims WHERE LOWER(code) = ? ORDER BY id DESC LIMIT 20").all(aff.code.toLowerCase());
  res.json({
    hasCode: true, code: aff.code, clicks: aff.clicks,
    signups: attrs.length, lockers, qualifyingLocks,
    lifetimeEarnedEth, claimedEth: claimed, claimableEth: claimable,
    ethUsd: await ethUsd(), minClaimUsd: 10, commission: COMMISSION, feeEth: FEE_ETH,
    attributions: attrs.map((a) => ({ wallet: a.wallet, ts: a.ts })), claims,
  });
});

app.post("/api/aff/claim", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (limited(req, res, 10)) return;
  const wallet = affWallet(req);
  if (!wallet) return res.status(401).json({ error: "unauthorized" });
  const aff = db.prepare("SELECT code, owner_wallet FROM affiliates WHERE owner_wallet = ?").get(wallet);
  if (!aff) return res.status(404).json({ error: "no affiliate link" });
  const price = await ethUsd();
  const { lifetimeEarnedEth } = await affiliateEarnings(aff.code, wallet).catch(() => ({ lifetimeEarnedEth: 0 }));
  // atomic reserve: claimable = earned − (pending+paid); insert one pending claim
  const reserve = db.transaction(() => {
    const claimed = claimedFor(aff.code);
    const claimable = Math.max(0, lifetimeEarnedEth - claimed);
    if (claimable <= 0) return { error: "nothing to claim" };
    if (price > 0 && claimable * price < 10) return { error: "below $10 minimum", claimableUsd: claimable * price };
    const info = db.prepare("INSERT INTO claims (code, owner_wallet, amount_eth, status, requested_at) VALUES (?,?,?,'pending',?)").run(aff.code, aff.owner_wallet, claimable, nowSec());
    return { id: Number(info.lastInsertRowid), amount: claimable };
  });
  const r = reserve();
  if (r.error) return res.status(400).json(r);

  const autoOk = PAYOUTS_ENABLED && walletClient && r.amount <= PAYOUT_MAX_ETH && (dailyPaid() + r.amount) <= PAYOUT_DAILY_ETH;
  if (!autoOk) return res.json({ ok: true, status: "pending", amount: r.amount });
  try {
    const hash = await walletClient.sendTransaction({ to: getAddress(aff.owner_wallet), value: parseEther(r.amount.toFixed(18)) });
    await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    db.prepare("UPDATE claims SET status='paid', tx_hash=?, paid_at=? WHERE id=?").run(hash, nowSec(), r.id);
    res.json({ ok: true, status: "paid", amount: r.amount, tx: hash });
  } catch (e) {
    db.prepare("UPDATE claims SET status='failed' WHERE id=?").run(r.id);   // failed frees the amount for retry
    res.status(500).json({ error: "payout failed — queued for manual review", status: "failed" });
  }
});

/* admin: review + manually pay claims */
app.get("/api/admin/claims", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  const claims = db.prepare("SELECT id, code, owner_wallet, amount_eth, status, tx_hash, requested_at, paid_at FROM claims ORDER BY id DESC LIMIT 100").all();
  const publicAffiliates = db.prepare("SELECT code, owner_wallet, clicks, created_at FROM affiliates WHERE owner_wallet IS NOT NULL ORDER BY created_at DESC").all();
  res.json({ claims, publicAffiliates });
});
app.post("/api/admin/claims/pay", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  const { id, tx_hash } = req.body || {};
  db.prepare("UPDATE claims SET status='paid', tx_hash=?, paid_at=? WHERE id=? AND status IN ('pending','failed')").run(String(tx_hash || "").slice(0, 80), nowSec(), Number(id));
  res.json({ ok: true });
});

/* admin: every public affiliate with full stats (earnings, claimed, etc.) */
app.get("/api/admin/public-affiliates", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const affs = db.prepare("SELECT code, owner_wallet, clicks, created_at FROM affiliates WHERE owner_wallet IS NOT NULL ORDER BY created_at DESC").all();
    const out = [];
    let totalUnclaimedEth = 0, totalEarnedEth = 0, totalClaimedEth = 0;
    for (const a of affs) {
      const signups = db.prepare("SELECT COUNT(*) n FROM attributions WHERE LOWER(code)=?").get(a.code.toLowerCase()).n;
      const { lockers, qualifyingLocks, lifetimeEarnedEth } = await affiliateEarnings(a.code, a.owner_wallet).catch(() => ({ lockers: 0, qualifyingLocks: 0, lifetimeEarnedEth: 0 }));
      const claimed = claimedFor(a.code);
      const claimable = Math.max(0, lifetimeEarnedEth - claimed);
      totalUnclaimedEth += claimable; totalEarnedEth += lifetimeEarnedEth; totalClaimedEth += claimed;
      out.push({ code: a.code, owner: a.owner_wallet, clicks: a.clicks, signups, lockers, locks: qualifyingLocks,
        earnedEth: lifetimeEarnedEth, claimedEth: claimed, claimableEth: claimable, createdAt: a.created_at });
    }
    let payoutWallet = null, payoutBalanceEth = 0;
    if (payoutAccount) {
      payoutWallet = payoutAccount.address;
      try { payoutBalanceEth = Number(await pub.getBalance({ address: payoutAccount.address })) / 1e18; } catch { /* */ }
    }
    res.json({ affiliates: out, ethUsd: await ethUsd(),
      summary: { totalEarnedEth, totalClaimedEth, totalUnclaimedEth, payoutWallet, payoutBalanceEth } });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* ---------- static site with the same rewrites as serve.json ---------- */
const send = (res, file) => res.sendFile(join(PUBLIC, file));
app.get("/", (_req, res) => send(res, "index.html"));
app.get("/app", (_req, res) => send(res, "app.html"));
app.get("/app/*", (_req, res) => send(res, "app.html"));
app.get("/blog", (_req, res) => send(res, "blog/index.html"));
app.get("/blog/:slug", (req, res) => {
  const f = join(PUBLIC, "blog", req.params.slug + ".html");
  return existsSync(f) ? res.sendFile(f) : send(res, "blog/index.html");
});
app.use(express.static(PUBLIC, { extensions: ["html"] }));
app.use((_req, res) => send(res, "index.html"));

app.listen(PORT, () => console.log(`[hoodlock] listening on ${PORT}`));
