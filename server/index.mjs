/* HoodLock server — serves the static site AND powers affiliate tracking.
 * The static site is served no matter what; if the DB or chain layer fails to
 * init, only the /api and /r routes degrade — the app stays up. */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, verifyMessage, isAddress, parseEther, encodeFunctionData } from "viem";
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
// lock(token, amount, unlockTime) — for the developer lock-intent (prepared tx)
const LOCK_ABI = [{ type: "function", name: "lock", stateMutability: "payable", inputs: [
  { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "unlockTime", type: "uint256" } ], outputs: [{ type: "uint256" }] }];

// burns and vesting count toward affiliate/developer commission too
const BURNER = cfg.burner && isAddress(cfg.burner) ? getAddress(cfg.burner) : null;
const VESTING = cfg.vesting && isAddress(cfg.vesting) ? getAddress(cfg.vesting) : null;
const BURNED_EVENT = { type: "event", name: "Burned", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "burner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false } ] };
const VESTING_CREATED_EVENT = { type: "event", name: "VestingCreated", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "token", type: "address", indexed: true },
  { name: "beneficiary", type: "address", indexed: true }, { name: "creator", type: "address", indexed: false },
  { name: "total", type: "uint256", indexed: false }, { name: "start", type: "uint64", indexed: false },
  { name: "cliff", type: "uint64", indexed: false }, { name: "end", type: "uint64", indexed: false } ] };

let FEE_ETH = 0.005; // sane default; refreshed from chain at boot
let FEE_WEI = 5000000000000000n; // 0.005 ETH default
let BURN_FEE_ETH = 0.005, VEST_FEE_ETH = 0.005;
pub.readContract({ address: LOCKER, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { FEE_WEI = BigInt(f); FEE_ETH = Number(f) / 1e18; })
  .catch(() => { /* keep default */ });
if (BURNER) pub.readContract({ address: BURNER, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { BURN_FEE_ETH = Number(f) / 1e18; }).catch(() => { /* keep default */ });
if (VESTING) pub.readContract({ address: VESTING, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { VEST_FEE_ETH = Number(f) / 1e18; }).catch(() => { /* keep default */ });

// paying wallet -> number of fee-bearing actions (locks + burns + vesting), cached 60s
let lockCache = { at: 0, byOwner: new Map() };
async function lockCounts() {
  if (Date.now() - lockCache.at < 60_000) return lockCache.byOwner;
  const byOwner = new Map();
  const add = (addr) => { const o = String(addr).toLowerCase(); byOwner.set(o, (byOwner.get(o) || 0) + 1); };
  const [locks, burns, vests] = await Promise.all([
    pub.getLogs({ address: LOCKER, event: LOCKED_EVENT, fromBlock: 0n, toBlock: "latest" }),
    BURNER ? pub.getLogs({ address: BURNER, event: BURNED_EVENT, fromBlock: 0n, toBlock: "latest" }).catch(() => []) : [],
    VESTING ? pub.getLogs({ address: VESTING, event: VESTING_CREATED_EVENT, fromBlock: 0n, toBlock: "latest" }).catch(() => []) : [],
  ]);
  for (const lg of locks) add(lg.args.owner);
  for (const lg of burns) add(lg.args.burner);
  for (const lg of vests) add(lg.args.creator);
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
  // per-affiliate commission rate (NULL = platform default). Admin can raise it (e.g. 0.30 -> 0.50).
  if (!cols.includes("commission")) db.exec("ALTER TABLE affiliates ADD COLUMN commission REAL");
  // developer program: kind='developer' rows earn 50% and carry a public api_key (pk_…)
  if (!cols.includes("kind")) db.exec("ALTER TABLE affiliates ADD COLUMN kind TEXT");
  if (!cols.includes("api_key")) db.exec("ALTER TABLE affiliates ADD COLUMN api_key TEXT");
  console.log("[hoodlock] db ready at", dir);
} catch (e) {
  console.error("[hoodlock] DB unavailable — affiliate features disabled, site still serves:", e?.message || e);
}

/* ---------- admin auth (wallet signature) ---------- */
const sessions = new Map(); // token -> exp (ms)
function newToken() { return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
// single-use signatures: a captured session signature can't be replayed within its
// 300s validity window (defence against phishing-assisted token minting).
const usedSigs = new Map(); // signature -> exp (ms)
function consumeSig(sig) {
  const now = Date.now();
  for (const [s, exp] of usedSigs) if (exp < now) usedSigs.delete(s);
  if (usedSigs.has(sig)) return false;
  usedSigs.set(sig, now + 6 * 60_000);
  return true;
}
function validToken(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { if (exp) sessions.delete(t); return false; }
  return true;
}

/* ---------- public affiliate program ---------- */
const nowSec = () => Math.floor(Date.now() / 1000);
const COMMISSION = 0.30;
const DEV_COMMISSION = 0.50;  // developer program default
const CODE_RE = /^[a-z0-9_-]{3,20}$/;
const RESERVED = new Set(["hoodlock", "admin", "app", "api", "r", "blog", "official", "support", "www", "help", "docs", "test", "dev", "developers", "embed"]);
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
// per-wallet fee-bearing actions {ts, feeEth} across locks + burns + vesting,
// cached 60s — commission is fee-weighted since the products charge different fees
let lockRecCache = { at: 0, byOwner: new Map() };
async function actionRecords() {
  if (Date.now() - lockRecCache.at < 60_000) return lockRecCache.byOwner;
  const byOwner = new Map();
  const add = async (addr, lg, fee, kind) => {
    const w = String(addr).toLowerCase();
    const ts = await blockTsOf(lg.blockNumber);
    if (!byOwner.has(w)) byOwner.set(w, []);
    byOwner.get(w).push({ ts, fee, kind });
  };
  const [locks, burns, vests] = await Promise.all([
    pub.getLogs({ address: LOCKER, event: LOCKED_EVENT, fromBlock: 0n, toBlock: "latest" }),
    BURNER ? pub.getLogs({ address: BURNER, event: BURNED_EVENT, fromBlock: 0n, toBlock: "latest" }).catch(() => []) : [],
    VESTING ? pub.getLogs({ address: VESTING, event: VESTING_CREATED_EVENT, fromBlock: 0n, toBlock: "latest" }).catch(() => []) : [],
  ]);
  for (const lg of locks) await add(lg.args.owner, lg, FEE_ETH, "lock");
  for (const lg of burns) await add(lg.args.burner, lg, BURN_FEE_ETH, "burn");
  for (const lg of vests) await add(lg.args.creator, lg, VEST_FEE_ETH, "vest");
  lockRecCache = { at: Date.now(), byOwner };
  return byOwner;
}

// effective commission for a code: per-affiliate override, else the platform default
function commissionFor(code) {
  const row = db.prepare("SELECT commission FROM affiliates WHERE LOWER(code) = ?").get(code.toLowerCase());
  const r = row && row.commission != null ? Number(row.commission) : COMMISSION;
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : COMMISSION;
}

// rate × Σ(fee) over locks + burns + vesting by attributed wallets, AFTER attribution (excl. self).
// JSON field names (lockers/qualifyingLocks) kept for dashboard compatibility — they now
// mean "referred users with ≥1 action" and "qualifying actions".
async function affiliateEarnings(code, ownerWallet) {
  const records = await actionRecords();
  const attrs = db.prepare("SELECT wallet, ts FROM attributions WHERE LOWER(code) = ?").all(code.toLowerCase());
  let lockers = 0, qualifyingLocks = 0, earnedFees = 0;
  const by = { lock: 0, burn: 0, vest: 0 };
  for (const a of attrs) {
    const w = a.wallet.toLowerCase();
    if (w === ownerWallet.toLowerCase()) continue;   // block same-wallet self-referral
    const q = (records.get(w) || []).filter((r) => r.ts > a.ts);
    if (q.length > 0) {
      lockers++; qualifyingLocks += q.length;
      earnedFees += q.reduce((s, r) => s + r.fee, 0);
      for (const r of q) by[r.kind] = (by[r.kind] || 0) + 1;
    }
  }
  const rate = commissionFor(code);
  return { lockers, qualifyingLocks, rate, lifetimeEarnedEth: rate * earnedFees,
    locksCount: by.lock, burnsCount: by.burn, vestsCount: by.vest };
}
// A claim reserves its amount while pending, paid, OR sent-but-unconfirmed. The last
// state is critical: if a payout tx broadcasts but we lose the receipt, the ETH may
// have left the wallet, so it must stay reserved (never auto-freed) — only 'failed'
// (which we set ONLY when no tx was broadcast) frees the amount for a safe retry.
const claimedFor = (code) => db.prepare("SELECT COALESCE(SUM(amount_eth),0) s FROM claims WHERE LOWER(code)=? AND status IN ('pending','paid','sent_unconfirmed')").get(code.toLowerCase()).s;
// ETH that has actually left (or may have left) the payout wallet in the last 24h
const dailyOut = () => db.prepare("SELECT COALESCE(SUM(amount_eth),0) s FROM claims WHERE status IN ('paid','sent_unconfirmed') AND paid_at > ?").get(nowSec() - 86400).s;

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

// Serialize all payouts through one chain so two concurrent claims can never grab the
// same nonce (which would drop/replace a tx and surface as a lost-receipt double-pay risk).
let payoutChain = Promise.resolve();
function enqueuePayout(fn) {
  const run = payoutChain.then(fn, fn);
  payoutChain = run.then(() => {}, () => {}); // keep the chain alive regardless of outcome
  return run;
}

// public affiliate sessions (separate namespace from admin — NEVER grants admin)
const affSessions = new Map(); // token -> { address, exp }
function affWallet(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = affSessions.get(t);
  if (!s || s.exp < Date.now()) { if (s) affSessions.delete(t); return null; }
  return s.address;
}

// tiny per-IP rate limiter. Uses req.ip, which — with a fixed `trust proxy`
// hop count — is the real client address and NOT a spoofable X-Forwarded-For entry.
const rlMap = new Map();
function limited(req, res, max, windowMs = 60_000) {
  const ip = req.ip || "?";
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; rlMap.set(ip, e); }
  if (++e.count > max) { res.status(429).json({ error: "rate limited" }); return true; }
  return false;
}
// evict expired limiter buckets so a flood of distinct IPs can't grow the map unbounded
setInterval(() => { const now = Date.now(); for (const [ip, e] of rlMap) if (e.reset < now) rlMap.delete(ip); }, 5 * 60_000).unref?.();

const app = express();
// Railway terminates TLS at one proxy hop in front of us; trust exactly that hop so
// req.ip is the real client (trust:true would let clients forge X-Forwarded-For).
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: "16kb" }));
// security headers: block framing (clickjacking on the wallet-sign prompt), sniffing, referrer leakage.
// EXCEPTION: the developer embed (/embed, /embed.js, /embed-*) is MEANT to be framed by
// partner sites, so it must not send frame-blocking headers.
const EMBEDDABLE = (p) => p === "/embed" || p === "/embed.js" || p.startsWith("/embed?") || p.startsWith("/embed/") || p.startsWith("/assets/embed");
app.use((req, res, next) => {
  if (!EMBEDDABLE(req.path)) {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* affiliate link: /r/<code> → count a click, then serve an OG-tagged interstitial that
 * redirects to the app. Serving real HTML (not a bare 302) means social crawlers that
 * DON'T follow redirects still read the share image/title for the affiliate link. */
app.get("/r/:code", (req, res) => {
  const code = req.params.code;
  const valid = REF_RE.test(code);
  if (db && valid) {
    if (limited(req, res, 120)) return; // 429 already sent — don't also respond below
    try { db.prepare("UPDATE affiliates SET clicks = clicks + 1 WHERE LOWER(code) = LOWER(?)").run(code); } catch { /* */ }
  }
  const dest = "/app/locks" + (valid ? "?ref=" + encodeURIComponent(code) : ""); // built only from a validated code
  const destAttr = dest.replace(/"/g, "&quot;");
  res.set("Cache-Control", "no-store").status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HoodLock</title>
<meta property="og:site_name" content="HoodLock">
<meta property="og:type" content="website">
<meta property="og:title" content="HoodLock — trustless liquidity & token locks">
<meta property="og:description" content="Lock LP or tokens on Robinhood Chain and share a verifiable on-chain proof.">
<meta property="og:image" content="https://hoodlock.tech/hoodlockshare.jpg">
<meta property="og:image:width" content="1600"><meta property="og:image:height" content="900">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://hoodlock.tech/hoodlockshare.jpg">
<meta http-equiv="refresh" content="0;url=${destAttr}">
<link rel="canonical" href="https://hoodlock.tech${destAttr}">
</head><body><script>location.replace(${JSON.stringify(dest)})</script>
<a href="${destAttr}">Continue to HoodLock →</a></body></html>`);
});

/* first-touch attribution — open (no signature), immutable once set.
 * Anti-abuse (no signature required, so we bound what an attacker can attribute):
 *  - first-touch: a wallet maps to at most one code, ever;
 *  - a wallet that ALREADY has on-chain locks can't be attributed (only post-attribution
 *    locks would earn anyway, and this is the spray target);
 *  - a wallet that connected to the platform earlier than a short grace window can't be
 *    newly attributed — this blocks spraying referral credit onto established/returning
 *    wallets (the profitable version of the attack). A genuinely-referred user connects
 *    for the first time in the same session, so their first_ts is ~now and they pass.
 * Residual (documented): an attacker can still attribute brand-new addresses they control,
 * but self-referral via fresh wallets nets a loss (they pay the full fee to recover ≤ it). */
const ATTR_GRACE_SEC = Number(process.env.ATTR_GRACE_SEC || 900); // 15 min
// Shared fresh-wallet first-touch attribution, used by both referral links (/api/ref/visit)
// and the developer program (/api/dev/attribute). `code` must already exist in affiliates.
async function attributeWallet(code, wallet) {
  wallet = String(wallet || "").toLowerCase();
  if (!isAddress(wallet)) return { ok: false, reason: "bad-wallet" };
  const row = db.prepare("SELECT code FROM affiliates WHERE LOWER(code) = LOWER(?)").get(code);
  if (!row) return { ok: false, reason: "unknown-code" };
  if (db.prepare("SELECT 1 FROM attributions WHERE wallet = ?").get(wallet)) return { ok: false, reason: "already-attributed" };
  const conn = db.prepare("SELECT first_ts FROM connections WHERE wallet = ?").get(wallet);
  if (conn && conn.first_ts < nowSec() - ATTR_GRACE_SEC) return { ok: false, reason: "established-wallet" };
  try { const recs = await lockRecords(); if ((recs.get(wallet) || []).length > 0) return { ok: false, reason: "already-locked" }; } catch { /* chain read failed → allow */ }
  try { db.prepare("INSERT OR IGNORE INTO attributions (wallet, code, ts) VALUES (?,?,?)").run(wallet, row.code, nowSec()); } catch { /* */ }
  return { ok: true };
}
app.post("/api/ref/visit", async (req, res) => {
  if (!db) return res.json({ ok: false });
  if (limited(req, res, 30)) return;
  const wallet = String(req.body?.wallet || "").toLowerCase();
  const ref = String(req.body?.ref || "");
  if (!isAddress(wallet) || !REF_RE.test(ref)) return res.status(400).json({ ok: false });
  res.json(await attributeWallet(ref, wallet));
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
    if (!signature || !consumeSig(String(signature))) return res.status(400).json({ error: "signature already used" });
    const ok = await verifyMessage({ address: getAddress(address), message: `HoodLock admin ${ts}`, signature });
    if (!ok) return res.status(403).json({ error: "bad signature" });
    const token = newToken();
    sessions.set(token, Date.now() + 30 * 60_000);
    res.json({ token, exp: Date.now() + 30 * 60_000 });
  } catch (e) { console.error("[hoodlock] admin session error:", e?.message || e); res.status(400).json({ error: "bad request" }); }
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
  } catch (e) { console.error("[hoodlock] server error:", e?.message || e); res.status(500).json({ error: "server error" }); }
});

/* list affiliates with computed stats — requires a valid admin session token */
app.get("/api/admin/affiliates", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const affs = db.prepare("SELECT code, label, clicks FROM affiliates ORDER BY created_at DESC").all();
    const records = await actionRecords().catch(() => new Map());
    const out = affs.map((a) => {
      const attrs = db.prepare("SELECT wallet, ts FROM attributions WHERE code = ?").all(a.code);
      let lockers = 0, locks = 0, revenueEth = 0;
      const by = { lock: 0, burn: 0, vest: 0 };
      for (const at of attrs) {
        const q = (records.get(String(at.wallet).toLowerCase()) || []).filter((r) => r.ts > at.ts);
        if (q.length > 0) {
          lockers++; locks += q.length;
          for (const r of q) { by[r.kind] = (by[r.kind] || 0) + 1; revenueEth += r.fee; }
        }
      }
      return { code: a.code, label: a.label || "", clicks: a.clicks, signups: attrs.length, lockers, locks,
        locksCount: by.lock, burnsCount: by.burn, vestsCount: by.vest, commission: commissionFor(a.code), revenueEth };
    });
    res.json({ affiliates: out });
  } catch (e) { console.error("[hoodlock] server error:", e?.message || e); res.status(500).json({ error: "server error" }); }
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
  } catch (e) { console.error("[hoodlock] server error:", e?.message || e); res.status(500).json({ error: "server error" }); }
});

/* ---------- public affiliate program endpoints ---------- */
// wallet session: one signature → 30-min wallet-scoped token (NEVER admin)
app.post("/api/aff/session", async (req, res) => {
  if (limited(req, res, 20)) return;
  try {
    const { address, ts, signature } = req.body || {};
    if (!isAddress(address)) return res.status(400).json({ error: "bad address" });
    if (Math.abs(nowSec() - Number(ts)) > 300) return res.status(400).json({ error: "stale" });
    if (!signature || !consumeSig(String(signature))) return res.status(400).json({ error: "signature already used" });
    const ok = await verifyMessage({ address: getAddress(address), message: `HoodLock affiliate ${ts}`, signature });
    if (!ok) return res.status(403).json({ error: "bad signature" });
    const token = newToken();
    affSessions.set(token, { address: address.toLowerCase(), exp: Date.now() + 30 * 60_000 });
    res.json({ token, exp: Date.now() + 30 * 60_000 });
  } catch (e) { console.error("[hoodlock] aff session error:", e?.message || e); res.status(400).json({ error: "bad request" }); }
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
  } catch (e) { console.error("[hoodlock] server error:", e?.message || e); res.status(500).json({ error: "server error" }); }
});

app.get("/api/aff/me", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const wallet = affWallet(req);
  if (!wallet) return res.status(401).json({ error: "unauthorized" });
  const aff = db.prepare("SELECT code, clicks, created_at, kind, api_key FROM affiliates WHERE owner_wallet = ?").get(wallet);
  if (!aff) return res.json({ hasCode: false });
  const attrs = db.prepare("SELECT wallet, ts FROM attributions WHERE LOWER(code) = ?").all(aff.code.toLowerCase());
  const rate = commissionFor(aff.code); // pure DB read — must NOT depend on the chain fetch below
  const { lockers, qualifyingLocks, lifetimeEarnedEth, locksCount, burnsCount, vestsCount } = await affiliateEarnings(aff.code, wallet).catch(() => ({ lockers: 0, qualifyingLocks: 0, lifetimeEarnedEth: 0, locksCount: 0, burnsCount: 0, vestsCount: 0 }));
  const claimed = claimedFor(aff.code);
  const claimable = Math.max(0, lifetimeEarnedEth - claimed);
  const claims = db.prepare("SELECT amount_eth, status, tx_hash, requested_at, paid_at FROM claims WHERE LOWER(code) = ? ORDER BY id DESC LIMIT 20").all(aff.code.toLowerCase());
  res.json({
    hasCode: true, code: aff.code, clicks: aff.clicks,
    kind: aff.kind || "affiliate", apiKey: aff.api_key || null,
    signups: attrs.length, lockers, qualifyingLocks, locksCount, burnsCount, vestsCount,
    lifetimeEarnedEth, claimedEth: claimed, claimableEth: claimable,
    ethUsd: await ethUsd(), minClaimUsd: 10, commission: rate, feeEth: FEE_ETH,
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
    // quantise to 1e-9 ETH (gwei) so float dust never accumulates in the ledger
    const claimable = Math.max(0, Math.floor((lifetimeEarnedEth - claimed) * 1e9) / 1e9);
    if (claimable <= 0) return { error: "nothing to claim" };
    if (price > 0 && claimable * price < 10) return { error: "below $10 minimum", claimableUsd: claimable * price };
    const info = db.prepare("INSERT INTO claims (code, owner_wallet, amount_eth, status, requested_at) VALUES (?,?,?,'pending',?)").run(aff.code, aff.owner_wallet, claimable, nowSec());
    return { id: Number(info.lastInsertRowid), amount: claimable };
  });
  const r = reserve();
  if (r.error) return res.status(400).json(r);

  if (!(PAYOUTS_ENABLED && walletClient) || r.amount > PAYOUT_MAX_ETH) {
    return res.json({ ok: true, status: "pending", amount: r.amount }); // queued for manual pay
  }
  // Everything money-moving runs single-file through the payout queue: the daily cap is
  // re-checked here (not before the queue) so concurrent claims can't each pass a stale cap,
  // and nonces are assigned one at a time.
  const result = await enqueuePayout(async () => {
    if (dailyOut() + r.amount > PAYOUT_DAILY_ETH) {
      return { status: "pending", amount: r.amount }; // over daily cap → leave reserved, pay manually
    }
    let hash = null;
    try {
      hash = await walletClient.sendTransaction({ to: getAddress(aff.owner_wallet), value: parseEther(r.amount.toFixed(18)) });
    } catch (e) {
      // send threw BEFORE broadcasting a tx → no ETH left the wallet → safe to free for retry
      db.prepare("UPDATE claims SET status='failed' WHERE id=?").run(r.id);
      console.error("[hoodlock] payout send failed (pre-broadcast):", e?.message || e);
      return { status: "failed" };
    }
    // We have a tx hash → ETH is (being) sent. From here we must NEVER free the reserve,
    // even if we lose the receipt, or a retry would double-pay.
    db.prepare("UPDATE claims SET status='sent_unconfirmed', tx_hash=?, paid_at=? WHERE id=?").run(hash, nowSec(), r.id);
    try {
      await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      db.prepare("UPDATE claims SET status='paid' WHERE id=?").run(r.id);
      return { status: "paid", amount: r.amount, tx: hash };
    } catch {
      // broadcast but receipt unknown — stays 'sent_unconfirmed' (reserved) for manual reconcile
      console.error("[hoodlock] payout receipt unconfirmed for claim", r.id, "tx", hash);
      return { status: "sent_unconfirmed", amount: r.amount, tx: hash };
    }
  });
  if (result.status === "failed") return res.status(500).json({ error: "payout failed — queued for manual review", status: "failed" });
  if (result.status === "sent_unconfirmed") return res.json({ ok: true, status: "processing", amount: r.amount, tx: result.tx });
  res.json({ ok: true, ...result });
});

/* ---------- developer program ----------
 * A developer is an affiliate row with kind='developer', a 50% commission, and a PUBLIC
 * api_key (pk_…) embedded in partner sites. The key only ATTRIBUTES locks to its owner —
 * it can never move money (claims need the owner's wallet signature) or reach admin. */
const CODE_RE_DEV = /^[a-z0-9_-]{3,20}$/;
const devByKey = (key) => db.prepare("SELECT code, owner_wallet FROM affiliates WHERE api_key = ? AND kind = 'developer'").get(String(key || ""));

/* register the signed-in wallet as a developer (mint api_key, set 50% commission) */
app.post("/api/dev/register", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const wallet = affWallet(req);
  if (!wallet) return res.status(401).json({ error: "unauthorized" });
  const code = normCode(req.body?.code);
  if (!codeValid(code) || !CODE_RE_DEV.test(code)) return res.status(400).json({ error: "invalid code" });
  if (db.prepare("SELECT code FROM affiliates WHERE owner_wallet = ?").get(wallet)) return res.status(400).json({ error: "this wallet already has a link or developer account" });
  if (db.prepare("SELECT 1 FROM affiliates WHERE LOWER(code) = ?").get(code)) return res.status(409).json({ error: "code taken" });
  const apiKey = "pk_" + newToken();
  try {
    db.prepare("INSERT INTO affiliates (code, label, clicks, created_at, owner_wallet, kind, commission, api_key) VALUES (?,?,0,?,?,?,?,?)")
      .run(code, "", nowSec(), wallet, "developer", DEV_COMMISSION, apiKey);
    res.json({ ok: true, code, apiKey, commission: DEV_COMMISSION });
  } catch (e) { console.error("[hoodlock] dev register error:", e?.message || e); res.status(500).json({ error: "server error" }); }
});

/* public config for a key — lets partners build their own UI */
app.get("/api/dev/config", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const dev = devByKey(req.query.key);
  if (!dev) return res.status(404).json({ error: "unknown key" });
  res.json({ chainId: cfg.chainId, locker: LOCKER, feeWei: FEE_WEI.toString(), feeEth: FEE_ETH, commission: commissionFor(dev.code), code: dev.code });
});

/* attribute a connecting wallet to the developer (fresh-wallet first-touch, shared guards) */
app.post("/api/dev/attribute", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (limited(req, res, 30)) return;
  const dev = devByKey(req.body?.key);
  if (!dev) return res.status(404).json({ ok: false, reason: "unknown-key" });
  res.json(await attributeWallet(dev.code, req.body?.wallet));
});

/* prepared lock tx for partners who submit via the user's wallet themselves */
app.post("/api/dev/lock-intent", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (limited(req, res, 60)) return;
  const dev = devByKey(req.body?.key);
  if (!dev) return res.status(404).json({ error: "unknown key" });
  const { token } = req.body || {};
  if (!isAddress(String(token || ""))) return res.status(400).json({ error: "bad token address" });
  let amount, unlockTime;
  try { amount = BigInt(req.body.amount); unlockTime = BigInt(req.body.unlockTime); }
  catch { return res.status(400).json({ error: "amount and unlockTime must be integer strings (wei / unix seconds)" }); }
  if (amount <= 0n) return res.status(400).json({ error: "amount must be > 0" });
  if (unlockTime <= BigInt(nowSec())) return res.status(400).json({ error: "unlockTime must be in the future" });
  const data = encodeFunctionData({ abi: LOCK_ABI, functionName: "lock", args: [getAddress(token), amount, unlockTime] });
  res.json({ to: LOCKER, data, value: FEE_WEI.toString(), chainId: cfg.chainId, note: "Submit from the user's wallet, then POST /api/dev/attribute with their address." });
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
  const hash = String(tx_hash || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ error: "tx_hash must be a 0x… 66-char hash" });
  db.prepare("UPDATE claims SET status='paid', tx_hash=?, paid_at=? WHERE id=? AND status IN ('pending','failed','sent_unconfirmed')").run(hash, nowSec(), Number(id));
  res.json({ ok: true });
});

/* admin: every public affiliate with full stats (earnings, claimed, etc.) */
app.get("/api/admin/public-affiliates", async (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const affs = db.prepare("SELECT code, owner_wallet, clicks, created_at, kind, api_key FROM affiliates WHERE owner_wallet IS NOT NULL ORDER BY created_at DESC").all();
    const out = [];
    let totalUnclaimedEth = 0, totalEarnedEth = 0, totalClaimedEth = 0;
    for (const a of affs) {
      const signups = db.prepare("SELECT COUNT(*) n FROM attributions WHERE LOWER(code)=?").get(a.code.toLowerCase()).n;
      const rate = commissionFor(a.code); // pure DB read — resilient to chain-fetch failures
      const { lockers, qualifyingLocks, lifetimeEarnedEth, locksCount, burnsCount, vestsCount } = await affiliateEarnings(a.code, a.owner_wallet).catch(() => ({ lockers: 0, qualifyingLocks: 0, lifetimeEarnedEth: 0, locksCount: 0, burnsCount: 0, vestsCount: 0 }));
      const claimed = claimedFor(a.code);
      const claimable = Math.max(0, lifetimeEarnedEth - claimed);
      totalUnclaimedEth += claimable; totalEarnedEth += lifetimeEarnedEth; totalClaimedEth += claimed;
      out.push({ code: a.code, owner: a.owner_wallet, clicks: a.clicks, signups, lockers, locks: qualifyingLocks, locksCount, burnsCount, vestsCount,
        kind: a.kind || "affiliate", apiKey: a.api_key || null,
        commission: rate, earnedEth: lifetimeEarnedEth, claimedEth: claimed, claimableEth: claimable, createdAt: a.created_at });
    }
    let payoutWallet = null, payoutBalanceEth = 0;
    if (payoutAccount) {
      payoutWallet = payoutAccount.address;
      try { payoutBalanceEth = Number(await pub.getBalance({ address: payoutAccount.address })) / 1e18; } catch { /* */ }
    }
    res.json({ affiliates: out, ethUsd: await ethUsd(), defaultCommission: COMMISSION,
      summary: { totalEarnedEth, totalClaimedEth, totalUnclaimedEth, payoutWallet, payoutBalanceEth } });
  } catch (e) { console.error("[hoodlock] server error:", e?.message || e); res.status(500).json({ error: "server error" }); }
});

/* admin: set a specific affiliate's commission rate (e.g. 0.30 -> 0.50) */
app.post("/api/admin/aff-commission", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  const { code } = req.body || {};
  let rate = Number((req.body || {}).rate);
  if (!code || typeof code !== "string") return res.status(400).json({ error: "code required" });
  if (!Number.isFinite(rate)) return res.status(400).json({ error: "rate required" });
  if (rate > 1) rate = rate / 100;                 // accept 50 as 0.50
  if (rate < 0 || rate > 1) return res.status(400).json({ error: "rate must be 0–100%" });
  const aff = db.prepare("SELECT code FROM affiliates WHERE LOWER(code)=? AND owner_wallet IS NOT NULL").get(code.toLowerCase());
  if (!aff) return res.status(404).json({ error: "affiliate not found" });
  // null it back to the platform default when set to exactly the default
  db.prepare("UPDATE affiliates SET commission=? WHERE LOWER(code)=?").run(rate === COMMISSION ? null : rate, code.toLowerCase());
  res.json({ ok: true, code: aff.code, commission: rate });
});

/* ---------- proof-page SEO: server-rendered <head> per lock/burn/vesting ----------
 * Proof pages are the highest-intent surface we have ("is $TOKEN liquidity
 * locked?"), but they are SPA routes — every one of them shipped the same
 * generic title with no content, so Google saw N duplicates. Here we read the
 * schedule/lock/burn from chain and inject a unique title, description,
 * canonical and JSON-LD before serving app.html. The SPA still renders as
 * before; this only fills the head for crawlers and link unfurls. */
const LOCKER_READ_ABI = [
  { type: "function", name: "locks", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "unlockTime", type: "uint256" }, { name: "withdrawn", type: "bool" }] },
  { type: "function", name: "totalLocks", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const BURNER_READ_ABI = [
  { type: "function", name: "getBurn", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ components: [{ name: "burner", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "timestamp", type: "uint256" }], type: "tuple" }] },
  { type: "function", name: "totalBurns", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const VESTING_READ_ABI = [
  { type: "function", name: "getSchedule", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ components: [{ name: "creator", type: "address" }, { name: "start", type: "uint64" }, { name: "beneficiary", type: "address" }, { name: "cliff", type: "uint64" }, { name: "token", type: "address" }, { name: "end", type: "uint64" }, { name: "total", type: "uint128" }, { name: "claimed", type: "uint128" }], type: "tuple" }] },
  { type: "function", name: "totalSchedules", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const ERC20_READ_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const fmtAmt = (v, d) => {
  const n = Number(v) / 10 ** Number(d);
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 0 : 6 });
};
const dayLabel = (sec) => new Date(Number(sec) * 1000).toISOString().slice(0, 10);

const tokMetaCache = new Map();
async function tokenMeta(addr) {
  const k = String(addr).toLowerCase();
  if (tokMetaCache.has(k)) return tokMetaCache.get(k);
  const [symbol, decimals, supply] = await Promise.all([
    pub.readContract({ address: addr, abi: ERC20_READ_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
    pub.readContract({ address: addr, abi: ERC20_READ_ABI, functionName: "decimals" }).catch(() => 18),
    pub.readContract({ address: addr, abi: ERC20_READ_ABI, functionName: "totalSupply" }).catch(() => 0n),
  ]);
  const m = { symbol: String(symbol), decimals: Number(decimals), supply };
  tokMetaCache.set(k, m);
  return m;
}

const proofCache = new Map(); // "kind:id" -> { at, meta }
async function proofMeta(kind, id) {
  const key = `${kind}:${id}`;
  const hit = proofCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.meta;
  let meta = null;
  try {
    if (kind === "lock") {
      const [, token, amount, unlockTime, withdrawn] = await pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "locks", args: [BigInt(id)] });
      if (!amount) return null;
      const t = await tokenMeta(token);
      const pct = t.supply > 0n ? (Number((amount * 10000n) / t.supply) / 100).toFixed(2) : null;
      const amt = fmtAmt(amount, t.decimals);
      const until = dayLabel(unlockTime);
      meta = {
        title: `${amt} $${t.symbol} locked until ${until} — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol}${pct ? ` (${pct}% of supply)` : ""} is ${withdrawn ? "was locked" : "locked"} in a time-locked contract on Robinhood Chain until ${until}. Verify the lock yourself on-chain — HoodLock lock #${id}.`,
        canonical: `https://hoodlock.tech/proof/lock/${id}`,
        heading: `${amt} $${t.symbol} locked`,
      };
    } else if (kind === "burn" && BURNER) {
      const b = await pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "getBurn", args: [BigInt(id)] });
      if (!b || !b.amount) return null;
      const t = await tokenMeta(b.token);
      const pct = t.supply > 0n ? (Number((b.amount * 10000n) / t.supply) / 100).toFixed(2) : null;
      const amt = fmtAmt(b.amount, t.decimals);
      meta = {
        title: `${amt} $${t.symbol} burned forever — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol}${pct ? ` (${pct}% of supply)` : ""} was permanently burned on Robinhood Chain on ${dayLabel(b.timestamp)}. The tokens went to the dead address and can never be recovered — HoodLock burn #${id}.`,
        canonical: `https://hoodlock.tech/proof/burn/${id}`,
        heading: `${amt} $${t.symbol} burned forever`,
      };
    } else if (kind === "vesting" && VESTING) {
      const v = await pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "getSchedule", args: [BigInt(id)] });
      if (!v || !v.total) return null;
      const t = await tokenMeta(v.token);
      const amt = fmtAmt(v.total, t.decimals);
      const end = dayLabel(v.end);
      const hasCliff = Number(v.cliff) > Number(v.start);
      meta = {
        title: `${amt} $${t.symbol} vesting until ${end} — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol} is vesting on Robinhood Chain${hasCliff ? ` with a cliff on ${dayLabel(v.cliff)}` : ""}, fully released ${end}. Irrevocable and verifiable on-chain — HoodLock vesting #${id}.`,
        canonical: `https://hoodlock.tech/proof/vesting/${id}`,
        heading: `${amt} $${t.symbol} vesting`,
      };
    }
  } catch { meta = null; }
  proofCache.set(key, { at: Date.now(), meta });
  return meta;
}

/** Serve app.html with the proof page's own head tags patched in. */
function sendProof(res, meta) {
  let html = readFileSync(join(PUBLIC, "app.html"), "utf8");
  const jsonld = {
    "@context": "https://schema.org", "@type": "WebPage",
    name: meta.title, description: meta.desc, url: meta.canonical,
    isPartOf: { "@type": "WebSite", name: "HoodLock", url: "https://hoodlock.tech/" },
  };
  const head = `
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.desc)}" />
<link rel="canonical" href="${esc(meta.canonical)}" />
<meta property="og:title" content="${esc(meta.title)}" />
<meta property="og:description" content="${esc(meta.desc)}" />
<meta property="og:url" content="${esc(meta.canonical)}" />
<meta name="twitter:title" content="${esc(meta.title)}" />
<meta name="twitter:description" content="${esc(meta.desc)}" />
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<noscript><h1>${esc(meta.heading)}</h1><p>${esc(meta.desc)}</p></noscript>`;
  // drop the generic title/description/og-title/og-description, then inject ours
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<meta name="description"[^>]*>/, "")
    .replace(/<meta property="og:title"[^>]*>/, "")
    .replace(/<meta property="og:description"[^>]*>/, "")
    .replace(/<meta property="og:url"[^>]*>/, "")
    .replace(/<meta name="twitter:title"[^>]*>/, "")
    .replace(/<meta name="twitter:description"[^>]*>/, "")
    .replace("</head>", head + "\n</head>");
  res.type("html").send(html);
}

/* ---------- static site with the same rewrites as serve.json ---------- */
const send = (res, file) => res.sendFile(join(PUBLIC, file));
app.get("/", (_req, res) => send(res, "index.html"));
/* Clean proof URLs. The legacy ?lock=/?burn=/?vesting= links are already out
   in the wild (shared by projects, embedded by partners), so they 301 here
   rather than break — one canonical URL per proof, permanently. */
app.get("/proof/:kind/:id", async (req, res) => {
  const { kind, id } = req.params;
  if (!["lock", "burn", "vesting"].includes(kind) || !/^\d{1,9}$/.test(id)) return send(res, "app.html");
  const meta = await proofMeta(kind, Number(id)).catch(() => null);
  return meta ? sendProof(res, meta) : send(res, "app.html");
});
app.get("/app", (req, res) => {
  for (const kind of ["lock", "burn", "vesting"]) {
    const raw = req.query[kind];
    if (typeof raw === "string" && /^\d{1,9}$/.test(raw)) {
      return res.redirect(301, `/proof/${kind}/${raw}`);
    }
  }
  send(res, "app.html");
});
app.get("/app/*", (_req, res) => send(res, "app.html"));
/* Dynamic sitemap: the static pages plus every proof page that exists on
   chain, so new locks/burns/vesting become indexable without a redeploy.
   Falls back to the static file if the chain is unreachable. */
let sitemapCache = { at: 0, xml: "" };
app.get("/sitemap.xml", async (_req, res) => {
  if (Date.now() - sitemapCache.at < 15 * 60_000 && sitemapCache.xml) {
    return res.type("application/xml").send(sitemapCache.xml);
  }
  try {
    const [nLocks, nBurns, nVests] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "totalLocks" }).then(Number).catch(() => 0),
      BURNER ? pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "totalBurns" }).then(Number).catch(() => 0) : 0,
      VESTING ? pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "totalSchedules" }).then(Number).catch(() => 0) : 0,
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const statics = [
      ["/", "daily", "1.0"], ["/app/locks", "weekly", "0.9"], ["/app/vesting", "weekly", "0.9"],
      ["/app/explore", "daily", "0.8"], ["/app/affiliate", "monthly", "0.7"], ["/app/developers", "monthly", "0.7"],
      ["/app", "weekly", "0.6"], ["/blog", "weekly", "0.7"],
      ["/blog/how-to-lock-liquidity-on-robinhood-chain", "monthly", "0.6"],
      ["/blog/what-is-a-liquidity-lock", "monthly", "0.6"],
      ["/blog/how-to-burn-tokens-on-robinhood-chain", "monthly", "0.6"],
      ["/blog/token-locks-vs-vesting-vs-burning", "monthly", "0.6"],
    ];
    const parts = statics.map(([p, cf, pr]) =>
      `  <url><loc>https://hoodlock.tech${p}</loc><lastmod>${today}</lastmod><changefreq>${cf}</changefreq><priority>${pr}</priority></url>`);
    const proof = (kind, n, pr) => {
      for (let i = 0; i < n; i++) {
        parts.push(`  <url><loc>https://hoodlock.tech/proof/${kind}/${i}</loc><changefreq>weekly</changefreq><priority>${pr}</priority></url>`);
      }
    };
    proof("lock", nLocks, "0.8");
    proof("burn", nBurns, "0.8");
    proof("vesting", nVests, "0.8");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.join("\n")}\n</urlset>\n`;
    sitemapCache = { at: Date.now(), xml };
    res.type("application/xml").send(xml);
  } catch {
    send(res, "sitemap.xml"); // static fallback — never 5xx on a crawler
  }
});
app.get("/embed", (_req, res) => send(res, "embed.html")); // framable (headers exempted above)
app.get("/blog", (_req, res) => send(res, "blog/index.html"));
app.get("/blog/:slug", (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return send(res, "blog/index.html"); // no path traversal, only clean slugs
  const f = join(PUBLIC, "blog", slug + ".html");
  return existsSync(f) ? res.sendFile(f) : send(res, "blog/index.html");
});
app.use(express.static(PUBLIC, { extensions: ["html"] }));
app.use((_req, res) => send(res, "index.html"));

app.listen(PORT, () => console.log(`[hoodlock] listening on ${PORT}`));
