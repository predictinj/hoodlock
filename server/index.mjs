/* HoodLock server — serves the static site AND powers affiliate tracking.
 * The static site is served no matter what; if the DB or chain layer fails to
 * init, only the /api and /r routes degrade — the app stays up. */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, fallback, defineChain, getAddress, verifyMessage, isAddress, parseEther, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { makeLogReader, byTopic, addrArg, addrParam } from "./logs.mjs";
import { makeOgRenderer, fontsReady } from "./og.mjs";
import { tokenData, withRecords, renderTokenPage } from "./token.mjs";
import { renderChecker, KINDS } from "./checker.mjs";
import { renderLegal, LEGAL_PAGES } from "./legal.mjs";
import { renderAirdropIndex, renderAirdropPage, renderAirdropChecker } from "./airdrop-pages.mjs";
import {
  initAirdropTables, saveList, getList, proofFor, pruneUnbound,
  makeAirdropIndex, eligibleFor, MAX_LIST,
  T_AIRDROP_CREATED,
} from "./airdrop.mjs";
import { makeTokenIndex } from "./tokenindex.mjs";
import { selectTokens } from "./gate.mjs";
import { previousPayout, nextPayout, firstPayout } from "../shared/revenue-schedule.mjs";
import { initRevenueAuto } from "./revenue-auto.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const cfg = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));

const ADMIN = (process.env.ADMIN_WALLET || "0x79c1230cab12d53d040f5fe1f5279e1a481ccea2").toLowerCase();
const PORT = process.env.PORT || 8080;
const REF_RE = /^[A-Za-z0-9_-]{3,32}$/;

/* ---------- chain ---------- */
/* The public Robinhood RPC is rate-limited by design. The server reads chain
   state on every proof-page crawl, sitemap build and affiliate calculation, so
   a dropped call here shows up as a generic <title> for Googlebot or a missing
   commission. RPC_URL (a dedicated endpoint) is tried first when set, with the
   public endpoint as last-resort fallback and a short retry on each. */
const RPC_URLS = [process.env.RPC_URL, ...(Array.isArray(cfg.rpcs) ? cfg.rpcs : []), cfg.rpc]
  .filter((u) => typeof u === "string" && /^https?:\/\//.test(u))
  .filter((u, i, a) => a.indexOf(u) === i);
const CHAIN = defineChain({ id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPC_URLS } },
  // Canonical Multicall3 — lets viem fold proof-page and sitemap reads into
  // one eth_call instead of one round-trip per contract read.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } });
const rpcTransport = fallback(
  // A dead dedicated endpoint must fail fast, not sit on a long timeout while
  // a crawler waits — short timeout and one retry, then straight to the next.
  RPC_URLS.map((u, i) => http(u, i < RPC_URLS.length - 1
    ? { timeout: 4_000, retryCount: 1, retryDelay: 250 }
    : { timeout: 12_000, retryCount: 2, retryDelay: 400 })),
  { rank: false },
);
const pub = createPublicClient({ chain: CHAIN, transport: rpcTransport, batch: { multicall: { wait: 16 } } });
console.log(`[hoodlock] rpc: ${RPC_URLS.length} endpoint(s)${process.env.RPC_URL ? " (dedicated first)" : " (public only)"}`);
const LOCKER = getAddress(cfg.locker);
const LOCKED_EVENT = { type: "event", name: "Locked", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
  { name: "unlockTime", type: "uint256", indexed: false } ] };
const FEE_ABI = [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
// lock(token, amount, unlockTime) — for the developer lock-intent (prepared tx)
const LOCK_ABI = [{ type: "function", name: "lock", stateMutability: "payable", inputs: [
  { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "unlockTime", type: "uint256" } ], outputs: [{ type: "uint256" }] }];
const BURN_WRITE_ABI = [{ type: "function", name: "burn", stateMutability: "payable", inputs: [
  { name: "token", type: "address" }, { name: "amount", type: "uint256" } ], outputs: [{ type: "uint256" }] }];
const VEST_WRITE_ABI = [{ type: "function", name: "create", stateMutability: "payable", inputs: [
  { name: "token", type: "address" }, { name: "beneficiary", type: "address" }, { name: "amount", type: "uint256" },
  { name: "start", type: "uint64" }, { name: "cliff", type: "uint64" }, { name: "end", type: "uint64" } ], outputs: [{ type: "uint256" }] }];

// burns and vesting count toward affiliate/developer commission too
const BURNER = cfg.burner && isAddress(cfg.burner) ? getAddress(cfg.burner) : null;
const VESTING = cfg.vesting && isAddress(cfg.vesting) ? getAddress(cfg.vesting) : null;
const AIRDROP = cfg.airdrop && isAddress(cfg.airdrop) ? getAddress(cfg.airdrop) : null;
const ERC20_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];
const AIRDROP_READ_ABI = [
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "totalAirdrops", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const BURNED_EVENT = { type: "event", name: "Burned", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "burner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false } ] };
const VESTING_CREATED_EVENT = { type: "event", name: "VestingCreated", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "token", type: "address", indexed: true },
  { name: "beneficiary", type: "address", indexed: true }, { name: "creator", type: "address", indexed: false },
  { name: "total", type: "uint256", indexed: false }, { name: "start", type: "uint64", indexed: false },
  { name: "cliff", type: "uint64", indexed: false }, { name: "end", type: "uint64", indexed: false } ] };

/* Event topics. The chain caps eth_getLogs at 2000 blocks, so logs come from
   Blockscout (one call, carries timestamps and decodes non-indexed params)
   with chunked RPC as fallback — see logs.mjs. */
const T_LOCKED = keccak256(toHex("Locked(uint256,address,address,uint256,uint256)"));
const T_BURNED = keccak256(toHex("Burned(uint256,address,address,uint256)"));
const T_VESTING_CREATED = keccak256(toHex("VestingCreated(uint256,address,address,address,uint256,uint64,uint64,uint64)"));
const readLogs = makeLogReader({ pub, explorer: cfg.explorer, ttlMs: 60_000,
  deployBlocks: cfg.deployBlocks || {},
  log: (m) => console.log("[hoodlock]", m) });
const ogPng = makeOgRenderer({ log: (m) => console.log("[hoodlock]", m) });
/* One index for every token page, rebuilt from logs rather than scanned per
   token — the cost of the hundredth page is the same as the first. */
const tokenIndex = makeTokenIndex({ readLogs, LOCKER, BURNER, VESTING,
  log: (m) => console.log("[hoodlock]", m) });
const airdropIndex = makeAirdropIndex({ readLogs, AIRDROP, getDb: () => db,
  log: (m) => console.log("[hoodlock]", m) });

/** Every fee-bearing action with its payer and timestamp: [{wallet, ts, fee, kind}] */
async function feeActions() {
  const out = [];
  const pull = async (addr, topic, kind, fee, pick) => {
    if (!addr) return;
    try {
      for (const l of byTopic(await readLogs(addr), topic)) {
        const w = pick(l);
        if (w) out.push({ wallet: w.toLowerCase(), ts: l.timestamp ?? 0, fee, kind });
      }
    } catch { /* one contract failing must not zero the others */ }
  };
  // Locked(id, owner, token, …) — owner indexed at topics[2]
  await pull(LOCKER, T_LOCKED, "lock", FEE_ETH, (l) => addrArg(l, 2));
  // Burned(id, burner, token, …) — burner indexed at topics[2]
  await pull(BURNER, T_BURNED, "burn", BURN_FEE_ETH, (l) => addrArg(l, 2));
  // VestingCreated(id, token, beneficiary, creator, …) — creator is the payer
  // but is NOT indexed, so it comes from the decoded params (first data word).
  await pull(VESTING, T_VESTING_CREATED, "vest", VEST_FEE_ETH, (l) => addrParam(l, "creator", 0));
  // AirdropCreated(id, token indexed, creator indexed, …) — creator at topics[3]
  await pull(AIRDROP, T_AIRDROP_CREATED, "airdrop", AIRDROP_FEE_ETH, (l) => addrArg(l, 3));
  return out;
}

let FEE_ETH = 0.005; // sane default; refreshed from chain at boot
let FEE_WEI = 5000000000000000n; // 0.005 ETH default
let BURN_FEE_ETH = 0.005, VEST_FEE_ETH = 0.005;
// The airdrop price is quote(recipients), not a flat fee(), so there is no
// single number to default to. It starts at 0 because the product launched
// free, and a non-zero guess would credit affiliates commission on money that
// was never paid. Refreshed from the contract below.
//
// Known limit: this is the one-wallet quote, so commission on a large airdrop
// is weighted low once a per-wallet fee is switched on. Revisit before the
// owner sets one, by reading the fee actually paid per AirdropCreated event.
let AIRDROP_FEE_ETH = 0;
pub.readContract({ address: LOCKER, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { FEE_WEI = BigInt(f); FEE_ETH = Number(f) / 1e18; })
  .catch(() => { /* keep default */ });
if (BURNER) pub.readContract({ address: BURNER, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { BURN_FEE_ETH = Number(f) / 1e18; }).catch(() => { /* keep default */ });
if (VESTING) pub.readContract({ address: VESTING, abi: FEE_ABI, functionName: "fee" })
  .then((f) => { VEST_FEE_ETH = Number(f) / 1e18; }).catch(() => { /* keep default */ });
if (AIRDROP) pub.readContract({ address: AIRDROP, abi: AIRDROP_READ_ABI, functionName: "quote", args: [1] })
  .then((f) => { AIRDROP_FEE_ETH = Number(f) / 1e18; }).catch(() => { /* keep 0 */ });

// paying wallet -> number of fee-bearing actions (locks + burns + vesting), cached 60s
let lockCache = { at: 0, byOwner: new Map() };
async function lockCounts() {
  if (Date.now() - lockCache.at < 60_000) return lockCache.byOwner;
  const byOwner = new Map();
  for (const a of await feeActions()) byOwner.set(a.wallet, (byOwner.get(a.wallet) || 0) + 1);
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
    /* Tokens that earned a page. Kept rather than recomputed, because the
       explorer's token list is unstable between calls and a page dropping out
       of the sitemap costs far more than carrying a quiet one. */
    CREATE TABLE IF NOT EXISTS token_pages (
      address TEXT PRIMARY KEY, symbol TEXT, slug TEXT,
      first_seen INTEGER, last_pass INTEGER, last_check INTEGER,
      misses INTEGER DEFAULT 0, liquidity REAL, volume24 REAL, holders INTEGER);
  `);
  initAirdropTables(db);
  /* An unbound list is one nobody ever created an airdrop for. Without this
     sweep, an open upload endpoint is a slow way to fill the volume. */
  setInterval(() => { try { pruneUnbound(db); } catch { /* not fatal */ } }, 6 * 3600_000).unref?.();

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

// blockTsOf() removed: Blockscout returns block_timestamp with every log, so
// the per-log getBlock round-trip it existed for is gone.
// per-wallet fee-bearing actions {ts, fee, kind}, cached 60s. Commission is
// fee-weighted because the three products can price differently.
let lockRecCache = { at: 0, byOwner: new Map() };
async function actionRecords() {
  if (Date.now() - lockRecCache.at < 60_000) return lockRecCache.byOwner;
  const byOwner = new Map();
  for (const a of await feeActions()) {
    if (!byOwner.has(a.wallet)) byOwner.set(a.wallet, []);
    byOwner.get(a.wallet).push({ ts: a.ts, fee: a.fee, kind: a.kind });
  }
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
    walletClient = createWalletClient({ account: payoutAccount, chain: CHAIN, transport: rpcTransport });
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
/* 16 kB is right for every endpoint here except one. A recipient list is
   megabytes, and a route-scoped parser cannot help if the global one has
   already rejected the stream, so the global parser steps aside for that single
   path rather than the limit being raised for all fourteen POST routes. */
const smallJson = express.json({ limit: "16kb" });
const BIG_BODY = new Set(["/api/airdrop/list"]);
app.use((req, res, next) => (BIG_BODY.has(req.path) ? next() : smallJson(req, res, next)));
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
  // Only over HTTPS — sending HSTS on a plain-HTTP response is ignored, and on
  // local dev it would pin localhost to https in the browser for a year.
  if (req.secure || req.get("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // No page here uses a camera, mic or location; deny them explicitly.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
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
<!-- One URL per affiliate code, all showing the same interstitial. Indexed,
     that is unbounded duplicate content competing with the real pages. follow
     is kept so the link through to the app still counts. -->
<meta name="robots" content="noindex,follow">
<title>HoodLock</title>
<meta property="og:site_name" content="HoodLock">
<meta property="og:type" content="website">
<meta property="og:title" content="HoodLock — trustless liquidity & token locks">
<meta property="og:description" content="Token locks, burns and vesting on Robinhood Chain, each with a verifiable on-chain proof.">
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
  try { const recs = await actionRecords(); if ((recs.get(wallet) || []).length > 0) return { ok: false, reason: "already-locked" }; } catch { /* chain read failed → allow */ }
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
/* The developer key is public by design — it is meant to sit in a partner's
   frontend — so these endpoints have to be callable from their origin. The
   docs tell integrators to call /api/dev/attribute when a user connects, and
   without this the browser blocks exactly that. */
/* JSON can't carry a meta tag, so the header does it. Nothing links to these
   as content, but Google will index a URL it can fetch. */
app.use("/api", (_req, res, next) => {
  res.set("X-Robots-Tag", "noindex");
  next();
});

app.use("/api/dev", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/api/dev/config", (req, res) => {
  if (!db) return res.status(503).json({ error: "db unavailable" });
  const dev = devByKey(req.query.key);
  if (!dev) return res.status(404).json({ error: "unknown key" });
  // All three products, not just the locker — a partner building their own UI
  // for burns or vesting had no way to find those addresses.
  res.json({
    chainId: cfg.chainId,
    rpc: cfg.rpc,
    explorer: cfg.explorer,
    locker: LOCKER,
    burner: BURNER,
    vesting: VESTING,
    feeWei: FEE_WEI.toString(), feeEth: FEE_ETH,   // lock fee, kept for compatibility
    airdrop: AIRDROP,
    /* The airdrop fee is not one number: it scales with declared recipients and
       is clamped by the contract. Callers should ask quote(n) rather than
       assume, so what is published here is the shape and the one-wallet case. */
    airdropFee: AIRDROP ? { perWalletQuoteAt1Eth: AIRDROP_FEE_ETH, quote: "call quote(uint32 recipients) on the airdrop contract" } : null,
    fees: {
      lock: FEE_WEI.toString(),
      burn: BURNER ? String(BigInt(Math.round(BURN_FEE_ETH * 1e18))) : null,
      vesting: VESTING ? String(BigInt(Math.round(VEST_FEE_ETH * 1e18))) : null,
    },
    feesEth: { lock: FEE_ETH, burn: BURNER ? BURN_FEE_ETH : null, vesting: VESTING ? VEST_FEE_ETH : null },
    commission: commissionFor(dev.code),
    code: dev.code,
  });
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

/* Shared front half of every intent: a valid key, a token, and an amount. */
function intentBase(req, res) {
  if (!db) { res.status(503).json({ error: "db unavailable" }); return null; }
  if (limited(req, res, 60)) return null;
  const dev = devByKey(req.body?.key);
  if (!dev) { res.status(404).json({ error: "unknown key" }); return null; }
  const token = String(req.body?.token || "");
  if (!isAddress(token)) { res.status(400).json({ error: "bad token address" }); return null; }
  let amount;
  try { amount = BigInt(req.body.amount); }
  catch { res.status(400).json({ error: "amount must be an integer string in the token's smallest unit" }); return null; }
  if (amount <= 0n) { res.status(400).json({ error: "amount must be > 0" }); return null; }
  return { token: getAddress(token), amount };
}
const APPROVE_NOTE = "Approve the token for `to` first, then submit this from the user's wallet and POST /api/dev/attribute with their address.";

/* prepared burn tx */
app.post("/api/dev/burn-intent", (req, res) => {
  if (!BURNER) return res.status(404).json({ error: "burning is not available on this chain" });
  const base = intentBase(req, res);
  if (!base) return;
  const data = encodeFunctionData({ abi: BURN_WRITE_ABI, functionName: "burn", args: [base.token, base.amount] });
  res.json({ to: BURNER, data, value: String(BigInt(Math.round(BURN_FEE_ETH * 1e18))),
    chainId: cfg.chainId, note: APPROVE_NOTE });
});

/* prepared vesting tx. The contract's own rules are checked here so a doomed
   transaction never reaches the user's wallet for signing. */
app.post("/api/dev/vesting-intent", (req, res) => {
  if (!VESTING) return res.status(404).json({ error: "vesting is not available on this chain" });
  const base = intentBase(req, res);
  if (!base) return;
  const beneficiary = String(req.body?.beneficiary || "");
  if (!isAddress(beneficiary)) return res.status(400).json({ error: "bad beneficiary address" });
  let start, cliff, end;
  try {
    start = BigInt(req.body.start ?? nowSec());
    end = BigInt(req.body.end);
    cliff = BigInt(req.body.cliff ?? start);
  } catch { return res.status(400).json({ error: "start, cliff and end must be unix seconds" }); }
  if (end <= start) return res.status(400).json({ error: "end must be after start" });
  if (end - start < 86400n) return res.status(400).json({ error: "vesting must run for at least 24 hours" });
  if (cliff < start || cliff > end) return res.status(400).json({ error: "cliff must fall between start and end" });
  const data = encodeFunctionData({ abi: VEST_WRITE_ABI, functionName: "create",
    args: [base.token, getAddress(beneficiary), base.amount, start, cliff, end] });
  res.json({ to: VESTING, data, value: String(BigInt(Math.round(VEST_FEE_ETH * 1e18))),
    chainId: cfg.chainId, note: `${APPROVE_NOTE} Schedules are irrevocable once created.` });
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
  // Every Uniswap v2 pair token is called "UNI-V2", so a proof page for an LP
  // lock would read "$UNI-V2" and say nothing about which pool it covers.
  let sym = String(symbol);
  if (/^(UNI-V2|SLP)$/i.test(sym)) sym = (await pairLabel(addr)) || sym;
  const m = { symbol: sym, decimals: Number(decimals), supply };
  tokMetaCache.set(k, m);
  return m;
}

const PAIR_READ_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
/** "WETH/HOODIE LP" for a v2 pair, null for anything else. */
async function pairLabel(addr) {
  try {
    const [t0, t1] = await Promise.all([
      pub.readContract({ address: addr, abi: PAIR_READ_ABI, functionName: "token0" }),
      pub.readContract({ address: addr, abi: PAIR_READ_ABI, functionName: "token1" }),
    ]);
    const [s0, s1] = await Promise.all([
      pub.readContract({ address: t0, abi: ERC20_READ_ABI, functionName: "symbol" }).catch(() => null),
      pub.readContract({ address: t1, abi: ERC20_READ_ABI, functionName: "symbol" }).catch(() => null),
    ]);
    return s0 && s1 ? `${s0}/${s1} LP` : null;
  } catch { return null; }
}

const proofCache = new Map(); // "kind:id" -> { at, meta }
/* A record that genuinely doesn't exist, as distinct from a read that failed.
   Only the first may 404 — 404ing a real proof page because the RPC blipped
   would tell Google to drop a page that exists. */
/* ---------- cached raw record reads ----------
 *
 * The public Robinhood RPC rate-limits per IP, and every visitor's browser
 * reads records directly from it. When a visitor's IP runs dry the app falls
 * back to this endpoint: one server-side read, cached a minute, shared by
 * everyone. Discipline that matters here: 404 is a VERIFIED absence (the id
 * is beyond the contract's own counter), a failed read is 503 — a rate limit
 * must never masquerade as "this lock does not exist". */
const recordCache = new Map();
app.get("/api/record/:kind/:id", async (req, res) => {
  const { kind, id } = req.params;
  if (!["lock", "burn", "vesting"].includes(kind) || !/^\d{1,9}$/.test(id)) return res.status(400).json({ error: "bad request" });
  const key = `${kind}:${id}`;
  const hit = recordCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) {
    res.set("Cache-Control", "public, max-age=30");
    return hit.notFound ? res.status(404).json({ error: "no such record" }) : res.json(hit.body);
  }
  try {
    let body = null, notFound = false;
    const n = BigInt(id);
    if (kind === "lock") {
      const total = await pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "totalLocks" });
      if (n >= total) notFound = true;
      else {
        const [owner, token, amount, unlockTime, withdrawn] = await pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "locks", args: [n] });
        body = { owner, token, amount: amount.toString(), unlockTime: Number(unlockTime), withdrawn };
      }
    } else if (kind === "burn") {
      if (!BURNER) notFound = true;
      else {
        const total = await pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "totalBurns" });
        if (n >= total) notFound = true;
        else {
          const b = await pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "getBurn", args: [n] });
          body = { burner: b.burner, token: b.token, amount: b.amount.toString(), timestamp: Number(b.timestamp) };
        }
      }
    } else {
      if (!VESTING) notFound = true;
      else {
        const total = await pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "totalSchedules" });
        if (n >= total) notFound = true;
        else {
          const v = await pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "getSchedule", args: [n] });
          body = { creator: v.creator, beneficiary: v.beneficiary, token: v.token, total: v.total.toString(),
            claimed: v.claimed.toString(), start: Number(v.start), cliff: Number(v.cliff), end: Number(v.end) };
        }
      }
    }
    if (recordCache.size > 5000) recordCache.clear();   // tiny records; crude eviction is fine
    recordCache.set(key, { at: Date.now(), notFound, body });
    res.set("Cache-Control", "public, max-age=30");
    return notFound ? res.status(404).json({ error: "no such record" }) : res.json(body);
  } catch {
    return res.status(503).json({ error: "chain unreachable" });
  }
});

/* ---------- lock-based revenue eligibility ----------
 *
 * Owner rule (2026-08-03): revenue share belongs to wallets that LOCK $LOCK
 * with a chosen duration of 7 days or more. Share follows locked amount.
 * This endpoint is the canonical snapshot: the page reads it to show
 * eligibility, and whoever funds the weekly drop should build the recipient
 * list from it, so what the site promises and what gets paid can never
 * diverge. Qualification is verified per lock: still active, at least 7 days
 * between the lock's creation (from its Locked event) and its unlock time,
 * and team locks are excluded (owner decision: the team does not dilute or
 * earn from the holder pool). A lock whose creation time cannot be verified
 * is left out rather than guessed in. */
const REV_LOCK_TOKEN = getAddress("0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94");
const REV_VAULT = cfg.buybackVault && isAddress(cfg.buybackVault) ? getAddress(cfg.buybackVault) : null;
const REV_MANAGER = cfg.roundManager && isAddress(cfg.roundManager) ? getAddress(cfg.roundManager) : null;
const REV_VAULT_ABI = [
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "threshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "canExecute", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "readyAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
];
const REV_MANAGER_ABI = [
  { type: "function", name: "undistributed", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "roundCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
/** Live buyback-vault state for the page and the widget. Null when the reads
 *  fail — the UI shows unavailable rather than a made-up meter. */
async function vaultStatus() {
  if (!REV_VAULT || !REV_MANAGER) return null;
  try {
    const [pending, threshold, canExec, readyAt, undistributed, roundCount] = await Promise.all([
      pub.readContract({ address: REV_VAULT, abi: REV_VAULT_ABI, functionName: "pending" }),
      pub.readContract({ address: REV_VAULT, abi: REV_VAULT_ABI, functionName: "threshold" }),
      pub.readContract({ address: REV_VAULT, abi: REV_VAULT_ABI, functionName: "canExecute" }),
      pub.readContract({ address: REV_VAULT, abi: REV_VAULT_ABI, functionName: "readyAt" }),
      pub.readContract({ address: REV_MANAGER, abi: REV_MANAGER_ABI, functionName: "undistributed" }),
      pub.readContract({ address: REV_MANAGER, abi: REV_MANAGER_ABI, functionName: "roundCount" }),
    ]);
    return {
      address: REV_VAULT, roundManager: REV_MANAGER,
      pendingEth: Number(pending) / 1e18, thresholdEth: Number(threshold) / 1e18,
      canExecute: canExec, readyAt: Number(readyAt),
      undistributedLock: undistributed.toString(), rounds: Number(roundCount),
    };
  } catch { return null; }
}
const REV_MIN_LOCK_SEC = 7 * 86_400;
const REV_LOCKS_BY_TOKEN_ABI = [{ type: "function", name: "locksByToken", stateMutability: "view",
  inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] }];
let revSnapCache = { at: 0, body: null };
async function revenueSnapshot() {
  if (Date.now() - revSnapCache.at < 60_000 && revSnapCache.body) return revSnapCache.body;
  const ids = await pub.readContract({ address: LOCKER, abi: REV_LOCKS_BY_TOKEN_ABI, functionName: "locksByToken", args: [REV_LOCK_TOKEN] });
  const logs = byTopic(await readLogs(String(LOCKER).toLowerCase()), T_LOCKED);
  const tsById = new Map();
  for (const l of logs) tsById.set(Number(BigInt(l.topics[1])), l.timestamp ?? null);
  const now = Math.floor(Date.now() / 1000);
  const per = new Map();
  const qualified = [];
  for (const id of ids) {
    const [owner, token, amount, unlockTime, withdrawn] = await pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "locks", args: [id] });
    if (withdrawn || Number(unlockTime) <= now) continue;
    if (token.toLowerCase() !== REV_LOCK_TOKEN.toLowerCase()) continue;
    if (owner.toLowerCase() === ADMIN) continue;
    let created = tsById.get(Number(id));
    if (created == null) {
      const lg = logs.find((l) => Number(BigInt(l.topics[1])) === Number(id));
      if (lg?.block) created = Number((await pub.getBlock({ blockNumber: BigInt(lg.block) })).timestamp);
    }
    if (created == null) continue;
    const duration = Number(unlockTime) - created;
    if (duration < REV_MIN_LOCK_SEC) continue;
    const w = owner.toLowerCase();
    per.set(w, (per.get(w) ?? 0n) + amount);
    qualified.push({ id: Number(id), owner: w, amount: amount.toString(), unlockTime: Number(unlockTime), durationDays: Math.floor(duration / 86_400) });
  }
  const total = [...per.values()].reduce((s, v) => s + v, 0n);
  const body = {
    rule: { token: REV_LOCK_TOKEN, minLockDays: 7, basis: "locked amount; active locks with a chosen duration of 7 days or more; team locks excluded" },
    at: now,
    totalQualified: total.toString(),
    holders: [...per.entries()].map(([wallet, amount]) => ({ wallet, amount: amount.toString() }))
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)),
    locks: qualified,
  };
  revSnapCache = { at: Date.now(), body };
  return body;
}
app.get("/api/revenue/snapshot", async (req, res) => {
  if (limited(req, res, 30)) return;
  try {
    res.set("Cache-Control", "public, max-age=60");
    return res.json(await revenueSnapshot());
  } catch {
    return res.status(503).json({ error: "chain unreachable" });
  }
});

/* Token pricing for rate-limited visitors: the same Uniswap-v3 WETH-pool spot
 * math the client runs (web/src/tvl.ts), computed once here and cached, so a
 * browser whose IP the public RPC has cut off can still price TVL. `pool:
 * null` is a VERIFIED no-WETH-pool answer; a failed lookup is 503. */
const PRICE_FACTORY = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
const PRICE_WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const PRICE_FEES = [10000, 3000, 500, 100];
const PRICE_FACTORY_ABI = [{ type: "function", name: "getPool", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }];
const PRICE_POOL_ABI = [{ type: "function", name: "slot0", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }];
const PRICE_BAL_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const priceCache = new Map();
app.get("/api/price/:token", async (req, res) => {
  const raw = String(req.params.token || "");
  if (!isAddress(raw)) return res.status(400).json({ error: "bad token" });
  const token = getAddress(raw);
  const key = token.toLowerCase();
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) { res.set("Cache-Control", "public, max-age=120"); return res.json(hit.body); }
  try {
    const pools = await Promise.all(PRICE_FEES.map((fee) =>
      pub.readContract({ address: PRICE_FACTORY, abi: PRICE_FACTORY_ABI, functionName: "getPool", args: [token, PRICE_WETH, fee] })));
    const candidates = pools.filter((p) => p && p !== "0x0000000000000000000000000000000000000000");
    let pool = null, depthWeth = 0;
    for (const p of candidates) {
      const bal = await pub.readContract({ address: PRICE_WETH, abi: PRICE_BAL_ABI, functionName: "balanceOf", args: [p] });
      if (bal > 0n) { pool = p; depthWeth = Number(bal) / 1e18; break; }
    }
    // symbol + decimals ride along so throttled clients can label tokens too
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "symbol" }).then(String).catch(() => null),
      pub.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "decimals" }).then(Number).catch(() => 18),
    ]);
    let body;
    if (!pool) body = { pool: null, symbol, decimals, ethUsd: await ethUsd() };
    else {
      const slot0 = await pub.readContract({ address: pool, abi: PRICE_POOL_ABI, functionName: "slot0" });
      const sqrtP = Number(slot0[0]);
      const pRaw = (sqrtP / 2 ** 96) ** 2;
      const wethIsToken0 = PRICE_WETH.toLowerCase() < token.toLowerCase();
      const wethPerToken = wethIsToken0 ? (1 / pRaw) * 10 ** (decimals - 18) : pRaw * 10 ** (decimals - 18);
      body = { pool, wethPerToken, depthWeth, symbol, decimals, ethUsd: await ethUsd() };
    }
    if (priceCache.size > 5000) priceCache.clear();
    priceCache.set(key, { at: Date.now(), body });
    res.set("Cache-Control", "public, max-age=120");
    return res.json(body);
  } catch {
    return res.status(503).json({ error: "chain unreachable" });
  }
});

const NOT_FOUND = Symbol("not-found");

async function proofMeta(kind, id) {
  const key = `${kind}:${id}`;
  const hit = proofCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.meta;
  let meta = null;
  try {
    if (kind === "lock") {
      const [, token, amount, unlockTime, withdrawn] = await pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "locks", args: [BigInt(id)] });
      if (!amount) { proofCache.set(key, { at: Date.now(), meta: NOT_FOUND }); return NOT_FOUND; }
      const t = await tokenMeta(token);
      const pct = t.supply > 0n ? (Number((amount * 10000n) / t.supply) / 100).toFixed(2) : null;
      const amt = fmtAmt(amount, t.decimals);
      const until = dayLabel(unlockTime);
      meta = {
        title: `${amt} $${t.symbol} locked until ${until} — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol}${pct ? ` (${pct}% of supply)` : ""} is ${withdrawn ? "was locked" : "locked"} in a time-locked contract on Robinhood Chain until ${until}. Verify the lock yourself on-chain — HoodLock lock #${id}.`,
        canonical: `https://hoodlock.tech/proof/lock/${id}`,
        heading: `${amt} $${t.symbol} locked`,
        // structured fields for the share card, which lays them out itself
        card: { kind: "lock", symbol: t.symbol, amount: amt, pct,
          line2: withdrawn ? `Was locked until ${until}` : `Locked until ${until}`,
          status: withdrawn ? "WITHDRAWN" : "LOCKED" },
      };
    } else if (kind === "burn" && BURNER) {
      const b = await pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "getBurn", args: [BigInt(id)] });
      if (!b || !b.amount) { proofCache.set(key, { at: Date.now(), meta: NOT_FOUND }); return NOT_FOUND; }
      const t = await tokenMeta(b.token);
      const pct = t.supply > 0n ? (Number((b.amount * 10000n) / t.supply) / 100).toFixed(2) : null;
      const amt = fmtAmt(b.amount, t.decimals);
      meta = {
        title: `${amt} $${t.symbol} burned forever — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol}${pct ? ` (${pct}% of supply)` : ""} was permanently burned on Robinhood Chain on ${dayLabel(b.timestamp)}. The tokens went to the dead address and can never be recovered — HoodLock burn #${id}.`,
        canonical: `https://hoodlock.tech/proof/burn/${id}`,
        heading: `${amt} $${t.symbol} burned forever`,
        card: { kind: "burn", symbol: t.symbol, amount: amt, pct,
          line2: `Burned forever on ${dayLabel(b.timestamp)}`, status: "IRREVERSIBLE" },
      };
    } else if (kind === "vesting" && VESTING) {
      const v = await pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "getSchedule", args: [BigInt(id)] });
      if (!v || !v.total) { proofCache.set(key, { at: Date.now(), meta: NOT_FOUND }); return NOT_FOUND; }
      const t = await tokenMeta(v.token);
      const amt = fmtAmt(v.total, t.decimals);
      const end = dayLabel(v.end);
      const hasCliff = Number(v.cliff) > Number(v.start);
      meta = {
        title: `${amt} $${t.symbol} vesting until ${end} — on-chain proof | HoodLock`,
        desc: `${amt} $${t.symbol} is vesting on Robinhood Chain${hasCliff ? ` with a cliff on ${dayLabel(v.cliff)}` : ""}, fully released ${end}. Irrevocable and verifiable on-chain — HoodLock vesting #${id}.`,
        canonical: `https://hoodlock.tech/proof/vesting/${id}`,
        heading: `${amt} $${t.symbol} vesting`,
        card: { kind: "vesting", symbol: t.symbol, amount: amt, pct: null,
          line2: `Vesting until ${end}`,
          status: hasCliff ? `CLIFF ${dayLabel(v.cliff)}` : "IRREVOCABLE" },
      };
    }
  } catch { meta = null; }
  proofCache.set(key, { at: Date.now(), meta });
  return meta;
}

/**
 * Serve app.html with page-specific head tags patched in, replacing the
 * generic ones. Without this every /app/* view shipped the same title and no
 * canonical, so Google saw five near-identical pages and picked one itself.
 */
function sendHead(res, meta) {
  let html = readFileSync(join(PUBLIC, "app.html"), "utf8");
  const blocks = (meta.jsonld || []).map(
    (j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`,
  ).join("\n");
  const head = `
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.desc)}" />
<link rel="canonical" href="${esc(meta.canonical)}" />
${meta.noindex ? '<meta name="robots" content="noindex,nofollow" />' : ""}
<meta property="og:title" content="${esc(meta.title)}" />
<meta property="og:description" content="${esc(meta.desc)}" />
<meta property="og:url" content="${esc(meta.canonical)}" />
<meta name="twitter:title" content="${esc(meta.title)}" />
<meta name="twitter:description" content="${esc(meta.desc)}" />
${meta.image ? `<meta property="og:image" content="${esc(meta.image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(meta.heading || meta.title)}" />
<meta name="twitter:image" content="${esc(meta.image)}" />
<meta name="twitter:card" content="summary_large_image" />` : ""}
${blocks}
${meta.heading ? `<noscript><h1>${esc(meta.heading)}</h1><p>${esc(meta.desc)}</p></noscript>` : ""}`;
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<meta name="description"[^>]*>/, "")
    .replace(/<link rel="canonical"[^>]*>/, "")
    .replace(/<meta property="og:title"[^>]*>/, "")
    .replace(/<meta property="og:description"[^>]*>/, "")
    .replace(/<meta property="og:url"[^>]*>/, "")
    .replace(/<meta name="twitter:title"[^>]*>/, "")
    .replace(/<meta name="twitter:description"[^>]*>/, "");
  if (meta.image) {
    // every image tag, not just og:image — the shell also declares 1600x900
    // dimensions, and a crawler reading those before ours gets the wrong size
    html = html
      .replace(/<meta property="og:image(:[a-z]+)?"[^>]*>/g, "")
      .replace(/<meta name="twitter:image"[^>]*>/g, "")
      .replace(/<meta name="twitter:card"[^>]*>/g, "");
  }
  html = html
    .replace("</head>", head + "\n</head>");
  res.type("html").set("Cache-Control", HTML_CACHE).send(html);
}

/** Proof pages: one WebPage record describing that specific lock/burn/vest. */
function sendProof(res, meta) {
  const m = /\/proof\/(lock|burn|vesting)\/(\d+)$/.exec(meta.canonical || "");
  return sendHead(res, {
    ...meta,
    image: m && meta.card ? `https://hoodlock.tech/og/${m[1]}/${m[2]}.png` : undefined,
    jsonld: [{
      "@context": "https://schema.org", "@type": "WebPage",
      name: meta.title, description: meta.desc, url: meta.canonical,
      isPartOf: { "@type": "WebSite", name: "HoodLock", url: "https://hoodlock.tech/" },
    }],
  });
}

/* Blockscout's logs endpoint answers in anywhere from 4 to 14 seconds, and the
   app can't sort a single row without it. We already read and cache the same
   logs here, so serve them from that cache instead of making every visitor
   wait on the explorer. Restricted to our own contracts — this is a cache, not
   an open proxy. */
/* Record ids for one address, derived from events rather than from the
 * contracts' own index arrays.
 *
 * The arrays (`locksByOwner`, `burnsByToken`, `schedulesByBeneficiary`, …) only
 * ever grow and have no paginated getter. Anyone can append to another address's
 * array for the price of a 1-wei record, and the client then issued one eth_call
 * per id — so a few thousand junk entries were enough to make a real user's
 * dashboard or a real token's page unusable, permanently.
 *
 * Events carry the same information, are already cached here, and can be capped.
 * `schedulesByCreator` has no indexed creator (it is a data word), so that one is
 * decoded rather than read from topics.
 */
const IDS_CAP = 250;
const idArg = (l) => { try { return Number(BigInt(l.topics?.[1] || "0x0")); } catch { return null; } };

app.get("/api/ids", async (req, res) => {
  const who = String(req.query.address || "").toLowerCase();
  if (!isAddress(who)) return res.status(400).json({ error: "bad address" });

  // Newest first, then capped — a capped oldest-first list would hide live records.
  const pick = (logs, match) => {
    const out = [];
    for (let i = logs.length - 1; i >= 0 && out.length < IDS_CAP; i--) {
      if (match(logs[i])) { const id = idArg(logs[i]); if (id !== null) out.push(id); }
    }
    return out;
  };
  const eq = (a) => a && a.toLowerCase() === who;

  try {
    const [lockLogs, burnLogs, vestLogs] = await Promise.all([
      readLogs(String(LOCKER).toLowerCase()).catch(() => []),
      BURNER ? readLogs(String(BURNER).toLowerCase()).catch(() => []) : [],
      VESTING ? readLogs(String(VESTING).toLowerCase()).catch(() => []) : [],
    ]);
    const locked = byTopic(lockLogs, T_LOCKED);
    const burned = byTopic(burnLogs, T_BURNED);
    const vested = byTopic(vestLogs, T_VESTING_CREATED);

    res.set("Cache-Control", "public, max-age=30");
    res.json({
      cap: IDS_CAP,
      locks: { owner: pick(locked, (l) => eq(addrArg(l, 2))), token: pick(locked, (l) => eq(addrArg(l, 3))) },
      burns: { burner: pick(burned, (l) => eq(addrArg(l, 2))), token: pick(burned, (l) => eq(addrArg(l, 3))) },
      // VestingCreated indexes (id, token, beneficiary); creator is the first data word.
      vests: {
        token: pick(vested, (l) => eq(addrArg(l, 2))),
        beneficiary: pick(vested, (l) => eq(addrArg(l, 3))),
        creator: pick(vested, (l) => eq(addrParam(l, "creator", 0))),
      },
    });
  } catch {
    res.status(503).json({ error: "index unavailable" });
  }
});

app.get("/api/logs/:address", async (req, res) => {
  const want = String(req.params.address || "").toLowerCase();
  const allowed = [LOCKER, BURNER, VESTING].filter(Boolean).map((a) => String(a).toLowerCase());
  if (!allowed.includes(want)) return res.status(404).json({ error: "unknown contract" });
  try {
    const logs = await readLogs(want);
    res.set("Cache-Control", "public, max-age=30");
    res.json({
      logs: logs.map((l) => ({
        topics: l.topics, data: l.data,
        block: Number(l.blockNumber), tx: l.transactionHash, ts: l.timestamp || 0,
      })),
    });
  } catch { res.status(502).json({ error: "logs unavailable" }); }
});

/* Share card for a proof page. Rendered from the same chain data the page
   shows, cached in memory, and immutable per (kind,id) — the numbers on a
   lock don't change, so crawlers and X can cache it hard. */
/* Share card for a token page, built from the same data the page shows. */
app.get("/og/token/:address.png", async (req, res) => {
  const addr = String(req.params.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(404).end();
  try {
    const hit = tokenCache.get(addr);
    if (!hit) return res.status(404).end();   // only cards for pages we've built
    const d = withRecords(hit.meta, await tokenIndex.get(addr));
    const locked = d.activeLocks.length;
    const png = ogPng(`token:${addr}:${locked}`, {
      kind: "token",
      symbol: d.symbol,
      amount: "",
      line2: locked
        ? `${locked} active HoodLock lock${locked > 1 ? "s" : ""}`
        : "No HoodLock lock found",
      pct: null,
      stats: [
        `${Number(d.holders).toLocaleString("en-US")} HOLDERS`,
        d.topWalletsPct != null ? `TOP 10 WALLETS ${d.topWalletsPct}%` : null,
        d.recs.vesting.length ? `${d.recs.vesting.length} VESTING` : null,
        d.recs.burns.length ? `${d.recs.burns.length} BURNS` : null,
      ].filter(Boolean).join("   ·   "),
    });
    if (!png) return res.status(503).end();
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=1800");
    return res.end(png);
  } catch { return res.status(404).end(); }
});

app.get("/og/:kind/:id.png", async (req, res) => {
  const { kind, id } = req.params;
  if (!["lock", "burn", "vesting"].includes(kind) || !/^\d{1,9}$/.test(id)) {
    return res.status(404).end();
  }
  const meta = await Promise.race([
    proofMeta(kind, Number(id)).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 8_000)),
  ]);
  if (!meta || meta === NOT_FOUND || !meta.card) return res.status(404).end();
  const png = ogPng(`${kind}:${id}`, meta.card);
  if (!png) return res.status(503).end();
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  return res.end(png);
});

/* ---------- which tokens get a page ---------- */

const slugFor = (symbol, address) =>
  `${String(symbol || "token").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "token"}-${address.slice(0, 8)}`;

/** Addresses currently published, read from the store rather than recomputed. */
function publishedTokens() {
  if (!db) return [];
  try {
    return db.prepare("SELECT address, symbol, slug, last_pass FROM token_pages WHERE misses < 3").all();
  } catch { return []; }
}
function isPublished(address) {
  if (!db) return null;
  try { return db.prepare("SELECT slug, misses FROM token_pages WHERE address = ?").get(String(address).toLowerCase()) || null; }
  catch { return null; }
}

/**
 * Run the gate and record the outcome. A token that qualifies is kept even if
 * a later run can't see it — the explorer's list swings between calls, and
 * dropping a page out of the sitemap costs more than carrying a quiet one.
 * Three consecutive misses is a real decline, not a flaky response.
 */
async function refreshTokenPages() {
  if (!db) return { pass: 0, total: 0 };
  const own = await tokenIndex.tokens();
  const rows = await selectTokens({ explorer: cfg.explorer, ownTokens: own, log: (m) => console.log("[hoodlock] gate:", m) });
  const now = Math.floor(Date.now() / 1000);
  const up = db.prepare(`INSERT INTO token_pages (address, symbol, slug, first_seen, last_pass, last_check, misses, liquidity, volume24, holders)
    VALUES (@address, @symbol, @slug, @now, @now, @now, 0, @liquidity, @volume24, @holders)
    ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(excluded.symbol, symbol), slug=COALESCE(excluded.slug, slug),
      last_pass=@now, last_check=@now, misses=0, liquidity=@liquidity, volume24=@volume24, holders=@holders`);
  const miss = db.prepare("UPDATE token_pages SET last_check=?, misses=misses+1 WHERE address=?");
  let pass = 0;
  for (const r of rows) {
    if (r.pass) {
      pass++;
      // A slug without the ticker ranks for nothing, so when DexScreener had
      // no pair to read the symbol from, ask the explorer before falling back.
      if (!r.symbol) {
        try {
          const t = await (await fetch(`${cfg.explorer}/api/v2/tokens/${r.address}`,
            { headers: { "User-Agent": "Mozilla/5.0 (compatible; HoodLock/1.0)" } })).json();
          if (t?.symbol) r.symbol = t.symbol;
        } catch { /* keep the generic slug */ }
      }
      up.run({ address: r.address, symbol: r.symbol || null, slug: slugFor(r.symbol, r.address),
        now, liquidity: r.liquidityUsd || 0, volume24: r.volume24 || 0, holders: r.holders ?? null });
    } else if (isPublished(r.address)) {
      miss.run(now, r.address);
    }
  }
  const live = publishedTokens().length;
  console.log(`[hoodlock] gate: ${pass} qualified this run · ${live} pages published`);
  return { pass, total: rows.length, live };
}

/**
 * Fetch each published page once so the first visitor never pays the
 * explorer's latency. Paced and retried: at 400ms the first run only got about
 * half of them, because Blockscout starts refusing rather than slowing down.
 */
async function warmTokenPages({ pauseMs = 900, rounds = 2 } = {}) {
  const list = publishedTokens();
  let todo = list.map((t) => t.address);
  for (let round = 1; round <= rounds && todo.length; round++) {
    const failed = [];
    for (const addr of todo) {
      if (tokenCache.has(addr) && Date.now() - tokenCache.get(addr).at < 60 * 60_000) continue;
      try {
        const recs = await tokenIndex.get(addr);
        const d = await tokenData({ address: addr, explorer: cfg.explorer, recs });
        if (d) tokenCache.set(addr, { at: Date.now(), meta: d });
        else failed.push(addr);
      } catch { failed.push(addr); }
      await new Promise((r) => setTimeout(r, pauseMs));
    }
    const warm = list.filter((t) => tokenCache.has(t.address)).length;
    console.log(`[hoodlock] token pages warm after round ${round}: ${warm}/${list.length}`);
    if (!failed.length) break;
    todo = failed;
    pauseMs = Math.round(pauseMs * 1.8); // back off rather than hammer
  }
}

/* The published slugs, so the app can link straight to a token page instead of
   bouncing every visitor through a redirect. Small, public, cached hard. */
let tokenListCache = { at: 0, body: null };
app.get("/api/token-pages", (_req, res) => {
  if (Date.now() - tokenListCache.at < 5 * 60_000 && tokenListCache.body) {
    return res.type("json").send(tokenListCache.body);
  }
  const rows = publishedTokens();
  const body = JSON.stringify({ tokens: Object.fromEntries(rows.map((t) => [t.address, t.slug])) });
  tokenListCache = { at: Date.now(), body };
  res.set("Cache-Control", "public, max-age=300");
  res.type("json").send(body);
});

/* Token pages. Indexable only once the gate has passed the token; everything
   else resolves but carries noindex. */
const tokenCache = new Map();  // address -> { at, meta } — explorer/DEX data only
app.get("/token/:slug", async (req, res) => {
  const slug = String(req.params.slug || "");
  // Published pages use a short, readable slug, so resolve those from the
  // store first; a full address still works for direct links and anything the
  // gate hasn't seen.
  const known = db ? (() => {
    try { return db.prepare("SELECT address, slug FROM token_pages WHERE slug = ?").get(slug) || null; }
    catch { return null; }
  })() : null;
  const m = /(0x[0-9a-fA-F]{40})$/.exec(slug);
  if (!known && !m) return next404(res);
  const addr = (known ? known.address : m[1]).toLowerCase();
  try {
    // Records come from the shared index and are always current to within its
    // refresh; only the explorer and DEX metadata is cached per token.
    const recs = await tokenIndex.get(addr);
    const hit = tokenCache.get(addr);
    let d;
    if (hit && Date.now() - hit.at < 60 * 60_000) {
      d = withRecords(hit.meta, recs);
    } else {
      d = await tokenData({ address: addr, explorer: cfg.explorer, recs });
      if (!d) return next404(res);
      tokenCache.set(addr, { at: Date.now(), meta: d });
    }
    // Only tokens that cleared the gate are indexable. Anything else still
    // resolves, so direct links and future bot replies work, but stays out of
    // Google — the whole point of the gate is that most tokens must not be
    // published.
    const pub_ = isPublished(addr);
    const canonicalSlug = pub_?.slug || slug;
    if (pub_ && canonicalSlug !== slug) return res.redirect(301, `/token/${canonicalSlug}`);
    // A handful of neighbours by liquidity, so the pages form a graph Google
    // can crawl rather than 128 unconnected leaves.
    d.related = relatedTokens(addr);
    res.set("Cache-Control", "public, max-age=30");
    return res.type("html").send(renderTokenPage(d, {
      slug: canonicalSlug, noindex: !pub_ || pub_.misses >= 3,
    }));
  } catch (e) {
    console.log("[hoodlock] token page failed:", e?.message || e);
    return next404(res);
  }
});


/* ---------- $LOCK revenue share ----------
 *
 * The week's accrued holder pool: every fee-bearing action since the last
 * drop boundary, minus the affiliate commission those same actions earned,
 * times the 50% holder share. Boundaries come from the shared schedule so
 * this window agrees with the countdown to the second. Before the first
 * drop (Aug 8) the window opens one week earlier, when the program went
 * live: fees from before Saturday Aug 1 21:30 Stockholm never enter drop #1.
 *
 * Actions whose log has no timestamp (ts 0) fall out of every window. That
 * under-counts the pool and never over-counts it, which is the right way to
 * be wrong about money. */
/** The holder pool for fee actions in [sinceSec, untilSec): total fees minus
 * the affiliate commission those same actions earned, halved. Shared by the
 * public endpoint (until = now) and the weekly automation (until = the frozen
 * drop deadline). Commission mirrors affiliateEarnings, across every code:
 * post-attribution actions of each referred wallet, self-referral excluded,
 * at the code's effective rate. */
async function poolBetween(sinceSec, untilSec) {
  const actions = (await feeActions()).filter((a) => a.ts >= sinceSec && a.ts < untilSec);
  const feesByKind = {};
  let fees = 0;
  for (const a of actions) {
    fees += a.fee;
    const k = feesByKind[a.kind] || (feesByKind[a.kind] = { count: 0, fees: 0 });
    k.count += 1; k.fees += a.fee;
  }
  let commission = 0;
  if (db) {
    const records = await actionRecords();
    const owners = new Map(db.prepare("SELECT code, owner_wallet FROM affiliates").all()
      .map((r) => [r.code.toLowerCase(), (r.owner_wallet || "").toLowerCase()]));
    const rates = new Map();
    for (const at of db.prepare("SELECT wallet, code, ts FROM attributions").all()) {
      const code = String(at.code || "").toLowerCase();
      const w = String(at.wallet || "").toLowerCase();
      if (w === owners.get(code)) continue;
      const q = (records.get(w) || []).filter((r) => r.ts > at.ts && r.ts >= sinceSec && r.ts < untilSec);
      if (!q.length) continue;
      if (!rates.has(code)) rates.set(code, commissionFor(code));
      commission += rates.get(code) * q.reduce((s, r) => s + r.fee, 0);
    }
  }
  const pool = Math.max(0, fees - commission) * 0.5;
  return { pool, fees, feesByKind, affiliateCommission: commission };
}

let poolCache = { at: 0, body: null };
app.get("/api/revenue/pool", async (req, res) => {
  if (limited(req, res, 60)) return;
  res.set("Cache-Control", "public, max-age=60");
  if (Date.now() - poolCache.at < 60_000 && poolCache.body) return res.json(poolCache.body);
  try {
    const now = Date.now();
    const sinceSec = Math.floor((previousPayout(now) ?? firstPayout() - 7 * 86_400_000) / 1000);
    const b = await poolBetween(sinceSec, Math.floor(now / 1000) + 1);
    const body = {
      since: sinceSec,
      next: Math.floor(nextPayout(now) / 1000),
      fees: b.fees, feesByKind: b.feesByKind, affiliateCommission: b.affiliateCommission, pool: b.pool,
      ethUsd: await ethUsd(),
      // The threshold model's live state: drops fire from the buyback vault,
      // not from a calendar. The page and the widget read this.
      vault: await vaultStatus(),
      // Read by the admin console's fee-routing card. Addresses only.
      automation: revenueAuto ? { opsWallet: revenueAuto.opsWallet(), splitter: revenueAuto.splitter() } : null,
    };
    poolCache = { at: Date.now(), body };
    return res.json(body);
  } catch {
    return res.status(500).json({ error: "pool unavailable" });
  }
});

/* The weekly buyback + drop robot. It does nothing without an ops key and an
 * explicit REVENUE_DROP_ENABLED=true; every cap lives in env. */
const revenueAuto = AIRDROP ? initRevenueAuto({
  pub, chain: CHAIN, transport: rpcTransport,
  getDb: () => db, saveList,
  poolBetween: async (s, u) => (await poolBetween(s, u)).pool,
  airdrop: AIRDROP, locker: LOCKER, vesting: VESTING, burner: BURNER,
  teamWallet: ADMIN,
  log: (m) => console.log("[hoodlock]", m),
}) : null;

/* Widget/status contract: 'complete' only ever from a finished run. */
app.get("/api/revenue/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json(revenueAuto ? revenueAuto.status() : { state: "unknown" });
});
/* Owner visibility: the current week's full plan, computed live, nothing
 * broadcast. Admin session required. */
app.get("/api/admin/revenue/preview", async (req, res) => {
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  if (!revenueAuto) return res.status(503).json({ error: "automation not configured" });
  try { return res.json(await revenueAuto.preview()); }
  catch (e) { return res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
});
/* Manual retry of the current window (idempotent; respects all caps). */
app.post("/api/admin/revenue/run", async (req, res) => {
  if (!validToken(req)) return res.status(401).json({ error: "unauthorized" });
  if (!revenueAuto) return res.status(503).json({ error: "automation not configured" });
  void revenueAuto.tick();
  return res.json({ ok: true, note: "run started; watch /api/admin/revenue/preview lastRun" });
});


/* ---------- airdrops ----------
 *
 * The list upload needs its own body parser. The global one is 16 kB, which is
 * right for every other endpoint here and far too small for a recipient list: a
 * 50,000-entry list is about 4.4 MB. Raising the global limit would widen the
 * DoS surface of thirteen other endpoints to fix one, so the larger parser is
 * mounted on this route alone, and rate limited, which the rest of the POST
 * surface still is not.
 */
if (AIRDROP) {
  const listParser = express.json({ limit: "12mb" });

  app.post("/api/airdrop/list", (req, res, next) => (limited(req, res, 12) ? undefined : listParser(req, res, next)), (req, res) => {
    if (!db) return res.status(503).json({ error: "storage unavailable" });
    try {
      const { root, count, total } = saveList(db, req.body?.entries);
      // The uploader tells us what root they expect. Recomputing it and
      // comparing is what means neither side has to be trusted: a mismatch is
      // a client bug or an attempt, and either way the list is not stored under
      // a root it does not hash to.
      const claimed = String(req.body?.root || "").toLowerCase();
      if (claimed && claimed !== root.toLowerCase()) {
        return res.status(400).json({ error: "root does not match the list", computed: root });
      }
      return res.json({ ok: true, root, count, total: total.toString() });
    } catch (e) {
      return res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/airdrop/:id/proof", async (req, res) => {
    if (limited(req, res, 120)) return;
    const a = await airdropIndex.get(req.params.id);
    if (!a) return res.status(404).json({ error: "no such airdrop" });
    if (!db) return res.status(503).json({ error: "storage unavailable" });
    const hit = proofFor(db, a.root, String(req.query.address || ""));
    if (!hit) return res.status(404).json({ error: "not on this list" });
    res.set("Cache-Control", "public, max-age=300");
    return res.json(hit);
  });

  /* The whole list, downloadable.
   *
   * This is what stops a non-custodial contract having a custodial dependency.
   * Without it nobody could rebuild a proof if this server disappeared, and the
   * tokens would be stranded behind our uptime. */
  app.get("/api/airdrop/:id/list.json", async (req, res) => {
    const a = await airdropIndex.get(req.params.id);
    if (!a || !db) return res.status(404).json({ error: "no such airdrop" });
    const list = getList(db, a.root);
    if (!list) return res.status(404).json({ error: "list not published" });
    res.set("Cache-Control", "public, max-age=3600");
    return res.json({
      airdropId: a.id, token: a.token, merkleRoot: a.root, count: list.count, total: list.total.toString(),
      note: "Rebuild any proof from this with shared/merkle.mjs. Leaves are keccak256(keccak256(abi.encode(index, account, amount))), pairs sorted.",
      entries: list.entries.map((e, index) => ({ index, address: e.address, amount: e.amount.toString() })),
    });
  });

  app.get("/api/airdrop/eligible", async (req, res) => {
    if (limited(req, res, 60)) return;
    const who = String(req.query.address || "");
    if (!isAddress(who)) return res.status(400).json({ error: "bad address" });
    if (!db) return res.status(503).json({ error: "storage unavailable" });
    try {
      const out = await eligibleFor({ index: airdropIndex, db, pub, AIRDROP, ABI: AIRDROP_READ_ABI, address: who,
        log: (m) => console.log("[hoodlock]", m) });
      /* Never cached. This answer changes the instant the wallet claims, and a
         30-second cache meant the browser re-served the pre-claim answer to the
         page that had just claimed. The row came back with a live button, the
         wallet simulated it, and the user was told "already claimed" for a
         claim that had in fact succeeded. The eligibility check already reads
         isClaimed from the chain, so the only stale layer was this header. */
      res.set("Cache-Control", "no-store");
      return res.json({ address: getAddress(who), claimable: out });
    } catch (e) {
      return res.status(500).json({ error: "lookup failed" });
    }
  });

  /* Every airdrop, for the public index and the admin activity feed. */
  app.get("/api/airdrops", async (req, res) => {
    /* `fresh=1` is what the app asks for straight after funding or sweeping,
       when the creator is looking at the screen waiting for their own airdrop
       to appear. It costs a chain read, so it is rate limited and never
       cached; every other caller gets the ordinary cached view. */
    const fresh = req.query.fresh === "1";
    if (fresh && limited(req, res, 10)) return;
    if (fresh) await airdropIndex.warm(true).catch(() => { /* fall back to cache */ });
    const all = [...(await airdropIndex.all()).values()].sort((a, b) => b.id - a.id);
    res.set("Cache-Control", fresh ? "no-store" : "public, max-age=30");
    return res.json({ count: all.length, airdrops: all.map(({ claimers, ...a }) => ({
      ...a, total: a.total.toString(), claimed: a.claimed.toString(),
      swept: a.swept.toString(), remaining: a.remaining.toString(),
      listPublished: !!(db && getList(db, a.root)),
    })) });
  });

  /* One wallet's two sides of the product: what it sent and what it took.
   *
   * Both come out of the index that was already built from the same logs, so
   * this costs no chain read at all. Never cached, because it changes the
   * moment the wallet claims or sweeps and a stale answer here is what put a
   * live Claim button in front of somebody who had already claimed. */
  app.get("/api/airdrop/history", async (req, res) => {
    if (limited(req, res, 60)) return;
    const who = String(req.query.address || "");
    if (!isAddress(who)) return res.status(400).json({ error: "bad address" });
    const lower = who.toLowerCase();
    if (String(req.query.fresh) === "1") {
      await airdropIndex.warm(true).catch(() => { /* fall back to cache */ });
    }
    const all = [...(await airdropIndex.all()).values()];

    const sent = all
      .filter((a) => a.creator === lower)
      .sort((a, b) => b.id - a.id)
      .map(({ claimers, ...a }) => ({
        ...a, total: a.total.toString(), claimed: a.claimed.toString(),
        swept: a.swept.toString(), remaining: a.remaining.toString(),
      }));

    const claimed = all
      .flatMap((a) => a.claimers
        .filter((c) => c.address === lower)
        .map((c) => ({ id: a.id, token: a.token, creator: a.creator,
          amount: c.amount.toString(), ts: c.ts, tx: c.tx })))
      .sort((a, b) => b.ts - a.ts || b.id - a.id);

    res.set("Cache-Control", "no-store");
    return res.json({ address: getAddress(who), sent, claimed });
  });
}


/* Public airdrop pages. Server rendered so they are indexable and readable
   without a wallet; claiming needs the wallet, so that deep-links into the app. */
if (AIRDROP) {
  /* Token symbol and decimals for a set of addresses, cached the same way the
     token pages cache them, so a page with twenty airdrops is twenty map reads
     rather than forty contract calls. */
  const metaCache = new Map();
  async function tokenMetaFor(addresses) {
    const out = {};
    await Promise.all([...new Set(addresses)].map(async (t) => {
      if (metaCache.has(t)) { out[t] = metaCache.get(t); return; }
      try {
        const [symbol, decimals] = await Promise.all([
          pub.readContract({ address: getAddress(t), abi: ERC20_META, functionName: "symbol" }),
          pub.readContract({ address: getAddress(t), abi: ERC20_META, functionName: "decimals" }),
        ]);
        const m = { symbol, decimals: Number(decimals) };
        metaCache.set(t, m); out[t] = m;
      } catch { out[t] = { symbol: "???", decimals: 18 }; }
    }));
    return out;
  }

  app.get("/airdrops", async (_req, res) => {
    const all = [...(await airdropIndex.all()).values()].sort((a, b) => b.id - a.id);
    const meta = await tokenMetaFor(all.map((a) => a.token));
    res.set("Cache-Control", "public, max-age=60");
    return res.type("html").send(renderAirdropIndex({ airdrops: all, meta, feeEth: AIRDROP_FEE_ETH }));
  });

  app.get("/airdrop-checker", async (req, res) => {
    const raw = String(req.query.a || "").trim();
    const ok = /^0x[0-9a-fA-F]{40}$/.test(raw);
    res.set("Cache-Control", raw ? "public, max-age=30" : HTML_CACHE);
    if (!raw) return res.type("html").send(renderAirdropChecker({ query: "", bad: false, results: null, meta: {}, feeEth: AIRDROP_FEE_ETH }));
    if (!ok) return res.type("html").send(renderAirdropChecker({ query: raw, bad: true, results: null, meta: {}, feeEth: AIRDROP_FEE_ETH }));
    try {
      const results = await eligibleFor({ index: airdropIndex, db, pub, AIRDROP, ABI: AIRDROP_READ_ABI,
        address: raw, log: (m) => console.log("[hoodlock]", m) });
      const meta = await tokenMetaFor(results.map((r) => r.token));
      return res.type("html").send(renderAirdropChecker({ query: raw, bad: false, results, meta, feeEth: AIRDROP_FEE_ETH }));
    } catch {
      return res.type("html").send(renderAirdropChecker({ query: raw, bad: false, results: [], meta: {}, feeEth: AIRDROP_FEE_ETH }));
    }
  });

  app.get("/airdrop/:id", async (req, res) => {
    const a = await airdropIndex.get(String(req.params.id).replace(/[^0-9]/g, ""));
    if (!a) return next404(res);
    const meta = await tokenMetaFor([a.token]);
    const list = db ? getList(db, a.root) : null;

    const raw = String(req.query.a || "").trim();
    const query = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : "";
    let hit = null;
    if (query && db) {
      const p = proofFor(db, a.root, query);
      if (p) {
        let claimed = false;
        try {
          claimed = await pub.readContract({ address: AIRDROP, abi: AIRDROP_READ_ABI,
            functionName: "isClaimed", args: [BigInt(a.id), BigInt(p.index)] });
        } catch { /* shown as unclaimed; the transaction is the real check */ }
        hit = { ...p, claimed };
      }
    }
    res.set("Cache-Control", query ? "public, max-age=30" : "public, max-age=60");
    return res.type("html").send(renderAirdropPage({ a, m: meta[a.token], list, query, hit, feeEth: AIRDROP_FEE_ETH }));
  });
}

/* Terms and privacy. Static content, so they get the plain HTML cache header
   the rest of the site's pages use. */
for (const which of LEGAL_PAGES) {
  app.get(`/${which}`, (_req, res) => {
    res.set("Cache-Control", HTML_CACHE);
    res.type("html").send(renderLegal(which, { site: SITE }));
  });
}

/* The three checker pages. One handler, three routes: what differs between them
 * lives in checker.mjs, so they cannot drift apart.
 *
 * The lookup is the same one the token pages use — the shared event index for
 * the records, the token cache for symbol and decimals — so a search costs a Map
 * read plus, at worst, one metadata fetch.
 */
for (const [kind, k] of Object.entries(KINDS)) {
  app.get(`/${k.path}`, async (req, res) => {
    const raw = String(req.query.a || "").trim();
    // Fees are read from the contracts at boot, so the CTA can never quote a
    // number the chain has moved on from.
    const feeEth = kind === "burn" ? BURN_FEE_ETH : kind === "vesting" ? VEST_FEE_ETH : FEE_ETH;
    const m = /^(0x[0-9a-fA-F]{40})$/.exec(raw);
    res.set("Cache-Control", raw ? "public, max-age=30" : HTML_CACHE);

    if (!raw) return res.type("html").send(renderChecker({ kind, feeEth, site: SITE }));
    if (!m) return res.type("html").send(renderChecker({ kind, q: raw, bad: true, feeEth, site: SITE }));

    const addr = m[1].toLowerCase();
    try {
      const recs = await tokenIndex.get(addr);
      const hit = tokenCache.get(addr);
      let d;
      if (hit && Date.now() - hit.at < 60 * 60_000) d = hit.meta;
      else {
        d = await tokenData({ address: addr, explorer: cfg.explorer, recs });
        if (d) tokenCache.set(addr, { at: Date.now(), meta: d });
      }
      // An address with records but no readable metadata is still worth
      // answering — the records are the point, so fall back to the address.
      const token = d
        ? { address: addr, name: d.name, symbol: d.symbol, decimals: d.decimals }
        : (recs.locks.length || recs.burns.length || recs.vesting.length)
          ? { address: addr, name: "Unknown token", symbol: "???", decimals: 18 }
          : null;
      return res.type("html").send(renderChecker({ kind, q: raw, token, recs, feeEth, site: SITE }));
    } catch (e) {
      console.log("[hoodlock] checker failed:", e?.message || e);
      return res.type("html").send(renderChecker({ kind, q: raw, feeEth, site: SITE }));
    }
  });
}

/** Nearest published tokens by liquidity — a stable, non-arbitrary ordering. */
function relatedTokens(address, n = 6) {
  if (!db) return [];
  try {
    return db.prepare(`SELECT symbol, slug FROM token_pages
      WHERE misses < 3 AND address != ? AND symbol IS NOT NULL
      ORDER BY ABS(liquidity - COALESCE((SELECT liquidity FROM token_pages WHERE address = ?), 0))
      LIMIT ?`).all(address, address, n);
  } catch { return []; }
}

function next404(res) { res.status(404); return send(res, "404.html"); }

/* ---------- static site with the same rewrites as serve.json ---------- */
/* HTML must be revalidated on every view. It names the hashed asset bundle, and
   those are served immutable for a year — so an HTML response a browser is free
   to reuse pins that browser to whatever build it first saw, permanently. With
   no Cache-Control at all browsers fall back to heuristic caching, which mobile
   Safari/Chrome apply aggressively; that is how a phone kept serving a build
   from before vesting existed while desktop had long since moved on.
   "no-cache" still allows the cache — it just forces revalidation, and the ETag
   turns that into a 304. */
const HTML_CACHE = "no-cache";
const send = (res, file) => res.set("Cache-Control", HTML_CACHE).sendFile(join(PUBLIC, file));
app.get("/", (_req, res) => send(res, "index.html"));
/* Clean proof URLs. The legacy ?lock=/?burn=/?vesting= links are already out
   in the wild (shared by projects, embedded by partners), so they 301 here
   rather than break — one canonical URL per proof, permanently. */
app.get("/proof/:kind/:id", async (req, res) => {
  const { kind, id } = req.params;
  /* Locks #0 and #1 are launch-day $TESTT test locks the owner retired from
     the public site. Old links still land somewhere useful. */
  if (kind === "lock" && (id === "0" || id === "1")) return res.redirect(302, "/app/explore");
  if (!["lock", "burn", "vesting"].includes(kind) || !/^\d{1,9}$/.test(id)) return send(res, "app.html");
  // Serve the plain shell rather than keeping a crawler waiting: a generic
  // title costs a little SEO, a timeout reads as a 5xx and costs the crawl.
  const meta = await Promise.race([
    proofMeta(kind, Number(id)).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 6_000)),
  ]);
  // No such lock/burn/schedule → a real 404. A failed or slow read → still the
  // app shell with a 200, because the page may well exist.
  if (meta === NOT_FOUND) { res.status(404); return send(res, "404.html"); }
  return meta ? sendProof(res, meta) : send(res, "app.html");
});
app.get("/app", (req, res) => {
  for (const kind of ["lock", "burn", "vesting"]) {
    const raw = req.query[kind];
    if (typeof raw === "string" && /^\d{1,9}$/.test(raw)) {
      return res.redirect(301, `/proof/${kind}/${raw}`);
    }
  }
  sendHead(res, { ...VIEW_META[""], canonical: `${SITE}/app` });
});
/* Per-view head tags. Each product view is its own landing page in search, so
   it needs its own title, description and canonical — they all shipped the
   same generic set before, which is what duplicate-content filtering eats. */
const SITE = "https://hoodlock.tech";
const VIEW_META = {
  "": {
    title: "HoodLock — lock, burn & vest tokens on Robinhood Chain",
    desc: "Lock liquidity, burn supply and vest team tokens on Robinhood Chain. Every action is on-chain and gets a shareable proof link.",
    heading: "HoodLock",
  },
  locks: {
    title: "Lock liquidity & team tokens on Robinhood Chain | HoodLock",
    desc: "Lock team and treasury tokens on Robinhood Chain for any period. The contract cannot release them early — holders get a public proof link to verify it themselves.",
    heading: "Token locks",
  },
  vesting: {
    title: "Token vesting on Robinhood Chain — irrevocable schedules | HoodLock",
    desc: "Create linear vesting schedules for teams, advisors and investors on Robinhood Chain. Irrevocable once created, with an optional cliff and a public proof link.",
    heading: "Token vesting",
  },
  explore: {
    title: "Explore locked & vesting tokens on Robinhood Chain | HoodLock",
    desc: "Browse every token lock, burn and vesting schedule on Robinhood Chain. Check what a project has actually locked before you buy.",
    heading: "Explore locks",
  },
  airdrops: {
    title: "Fund an airdrop on Robinhood Chain | HoodLock",
    desc: "Fund an airdrop once and let recipients take their own share. No tokens are pushed to wallets that never asked for them. Free while the fee is switched off.",
    heading: "Airdrops",
  },
  developers: {
    title: "Developer docs & contract addresses | HoodLock",
    desc: "Contract addresses, ABIs and integration notes for the HoodLock locker, burner and vesting contracts on Robinhood Chain.",
    heading: "Developers",
  },
  affiliate: {
    title: "HoodLock affiliate program — earn on every lock, burn & vest",
    desc: "Earn a commission on the fee from every lock, burn and vesting schedule created through your referral link. Paid in ETH on Robinhood Chain.",
    heading: "Affiliate program",
  },
  revenue: {
    title: "$LOCK revenue share: 50% of HoodLock fees, paid weekly | HoodLock",
    desc: "Lock $LOCK for 7 days or more and receive half of HoodLock's platform fee revenue, split by locked amount. Drops fire automatically whenever the pool reaches 0.02 ETH, paid as claimable rounds on Robinhood Chain.",
    heading: "$LOCK revenue share",
  },
};
/* Views with nothing to rank: the wallet-gated console, the two unshipped
   products, and the in-app proof view that /proof/:kind/:id already covers. */
const NOINDEX_VIEWS = { admin: "Admin console", streams: "Streams", proof: "Proof", fixlocker: "Locker admin handover" };
app.get("/app/*", (req, res) => {
  const view = String(req.path).replace(/^\/app\/?/, "").replace(/\/+$/, "").toLowerCase();
  if (NOINDEX_VIEWS[view]) {
    return sendHead(res, {
      title: `${NOINDEX_VIEWS[view]} — HoodLock`, desc: "HoodLock on Robinhood Chain.",
      canonical: `${SITE}/app/${view}`, noindex: true,
    });
  }
  // The router rewrites /app to /app/dashboard, so both are the same page —
  // point them at one canonical rather than letting Google pick.
  if (view === "dashboard") return sendHead(res, { ...VIEW_META[""], canonical: `${SITE}/app` });
  const m = VIEW_META[view];
  // Unknown /app/* paths still render the app (the router falls back to the
  // launcher), so canonicalise them there instead of leaving a soft 404.
  if (!m) return sendHead(res, { ...VIEW_META[""], canonical: `${SITE}/app`, noindex: true });
  return sendHead(res, { ...m, canonical: `${SITE}/app/${view}` });
});
/* Dynamic sitemap: the static pages plus every proof page that exists on
   chain, so new locks/burns/vesting become indexable without a redeploy.
   Falls back to the static file if the chain is unreachable. */
let sitemapCache = { at: 0, xml: "" };
app.get("/sitemap.xml", async (_req, res) => {
  if (Date.now() - sitemapCache.at < 15 * 60_000 && sitemapCache.xml) {
    return res.type("application/xml").send(sitemapCache.xml);
  }
  try {
    // Same deadline discipline as the proof pages: if the chain is slow, ship
    // the static sitemap rather than making a crawler wait.
    const counts = await Promise.race([
      Promise.all([
        pub.readContract({ address: LOCKER, abi: LOCKER_READ_ABI, functionName: "totalLocks" }).then(Number).catch(() => 0),
        BURNER ? pub.readContract({ address: BURNER, abi: BURNER_READ_ABI, functionName: "totalBurns" }).then(Number).catch(() => 0) : 0,
        VESTING ? pub.readContract({ address: VESTING, abi: VESTING_READ_ABI, functionName: "totalSchedules" }).then(Number).catch(() => 0) : 0,
      ]),
      new Promise((r) => setTimeout(() => r(null), 8_000)),
    ]);
    if (!counts) return send(res, "sitemap.xml");
    const [nLocks, nBurns, nVests] = counts;
    const today = new Date().toISOString().slice(0, 10);
    const statics = [
      ["/", "daily", "1.0"], ["/app/locks", "weekly", "0.9"], ["/app/vesting", "weekly", "0.9"],
      ["/app/revenue", "weekly", "0.8"],
      ["/app/explore", "daily", "0.8"], ["/app/affiliate", "monthly", "0.7"], ["/app/developers", "monthly", "0.7"],
      ["/app", "weekly", "0.6"], ["/blog", "weekly", "0.7"],
      // The three checkers answer the questions people actually type, so they
      // rank alongside the homepage rather than below the articles about them.
      ["/airdrops", "daily", "0.8"], ["/airdrop-checker", "weekly", "0.9"],
      ["/terms", "yearly", "0.3"], ["/privacy", "yearly", "0.3"],
      ["/lock-checker", "weekly", "0.9"], ["/burn-checker", "weekly", "0.8"],
      ["/vesting-checker", "weekly", "0.8"],
      ["/blog/how-to-lock-liquidity-on-robinhood-chain", "monthly", "0.6"],
      ["/blog/what-is-a-liquidity-lock", "monthly", "0.6"],
      ["/blog/how-to-burn-tokens-on-robinhood-chain", "monthly", "0.6"],
      ["/blog/token-locks-vs-vesting-vs-burning", "monthly", "0.6"],
      ["/blog/how-to-check-if-liquidity-is-locked", "monthly", "0.7"],
      ["/blog/rug-pull-red-flags-checklist", "monthly", "0.7"],
      ["/blog/how-to-airdrop-tokens-on-robinhood-chain", "monthly", "0.7"],
      ["/blog/how-to-set-up-token-vesting", "monthly", "0.7"],
      ["/blog/what-is-a-vesting-cliff", "monthly", "0.6"],
      ["/blog/how-long-should-you-lock-liquidity", "monthly", "0.6"],
      ["/blog/how-to-check-if-liquidity-is-burned", "monthly", "0.7"],
      ["/blog/how-to-read-token-holder-distribution", "monthly", "0.7"],
      ["/blog/what-is-a-honeypot-token", "monthly", "0.7"],
      ["/blog/how-to-verify-a-token-contract-on-blockscout", "monthly", "0.7"],
      ["/blog/what-happens-when-a-token-lock-expires", "monthly", "0.7"],
      ["/blog/token-launch-checklist-robinhood-chain", "monthly", "0.7"],
      ["/blog/team-token-allocation-benchmarks", "monthly", "0.7"],
      ["/blog/how-to-prove-your-project-wont-rug", "monthly", "0.7"],
      ["/blog/locking-treasury-and-ecosystem-funds", "monthly", "0.7"],
      ["/blog/how-to-choose-a-token-locker", "monthly", "0.7"],
      ["/blog/what-are-lp-tokens", "monthly", "0.6"],
      ["/blog/burning-vs-locking-liquidity", "monthly", "0.6"],
      ["/blog/circulating-vs-total-supply", "monthly", "0.6"],
      ["/blog/custodial-vs-non-custodial-locking", "monthly", "0.6"],
      ["/blog/what-is-a-token-unlock-schedule", "monthly", "0.6"],
      ["/blog/lock-dev-tokens-after-a-pons-launch", "monthly", "0.8"],
      ["/blog/lock-creator-tokens-after-a-fendex-launch", "monthly", "0.6"],
      // Per-launchpad pages. Priority tracks how much of the launchpad's own
      // model leaves something for us to lock — Hood Launcher's Classic route
      // hands the creator withdrawable LP, which is the strongest case on chain.
      ["/blog/lock-lp-tokens-from-a-hood-launcher-classic-launch", "monthly", "0.8"],
      ["/blog/lock-tokens-launched-on-hood-fun", "monthly", "0.7"],
      ["/blog/lock-tokens-launched-on-robinfun", "monthly", "0.7"],
      ["/blog/lock-tokens-launched-on-robinlaunch", "monthly", "0.7"],
      ["/blog/vesting-alongside-a-bankr-launch", "monthly", "0.7"],
      ["/blog/lock-tokens-launched-on-lemon-fun", "monthly", "0.6"],
      ["/blog/lock-tokens-launched-on-openfair", "monthly", "0.6"],
      ["/blog/lock-tokens-launched-on-metalaunch", "monthly", "0.6"],
      ["/blog/lock-tokens-launched-on-arrowpad", "monthly", "0.6"],
  // Documentation. Generated by web/docs-src/build.mjs — run `npm run docs:build`
      // and paste .sitemap-triples.txt here when pages are added.
      ["/docs/api", "monthly", "0.6"],
      ["/docs/connect-wallet", "monthly", "0.6"],
      ["/docs/contracts", "monthly", "0.7"],
      ["/docs/embed", "monthly", "0.6"],
      ["/docs/faq", "monthly", "0.8"],
      ["/docs/fees", "monthly", "0.6"],
      ["/docs/how-to-burn-tokens", "monthly", "0.6"],
      ["/docs/how-to-create-vesting", "monthly", "0.6"],
      ["/docs/how-to-extend-a-lock", "monthly", "0.6"],
      ["/docs/how-to-lock-liquidity", "monthly", "0.8"],
      ["/docs/how-to-lock-tokens", "monthly", "0.8"],
      ["/docs/how-to-verify-a-lock", "monthly", "0.6"],
      ["/docs", "monthly", "0.9"],
      ["/docs/learn", "monthly", "0.6"],
      ["/docs/liquidity-locker", "monthly", "0.7"],
      ["/docs/lock-explorer", "monthly", "0.6"],
      ["/docs/network", "monthly", "0.6"],
      ["/docs/airdrops", "monthly", "0.7"],
      ["/docs/proof-of-lock", "monthly", "0.6"],
      ["/docs/quickstart", "monthly", "0.6"],
      ["/docs/security", "monthly", "0.7"],
      ["/docs/token-burning", "monthly", "0.6"],
      ["/docs/token-locker", "monthly", "0.7"],
      ["/docs/token-vesting", "monthly", "0.7"],
      ["/docs/troubleshooting", "monthly", "0.6"],
      ["/docs/vs/diy-locking", "monthly", "0.6"],
      ["/docs/vs/multi-chain-lockers", "monthly", "0.6"],
      ["/docs/vs/stonkbrokers", "monthly", "0.6"],
      ["/docs/when-a-lock-expires", "monthly", "0.6"],
    ];
    const parts = statics.map(([p, cf, pr]) =>
      `  <url><loc>https://hoodlock.tech${p}</loc><lastmod>${today}</lastmod><changefreq>${cf}</changefreq><priority>${pr}</priority></url>`);
    const proof = (kind, n, pr) => {
      for (let i = 0; i < n; i++) {
        parts.push(`  <url><loc>https://hoodlock.tech/proof/${kind}/${i}</loc><changefreq>weekly</changefreq><priority>${pr}</priority></url>`);
      }
    };
    /* Airdrop pages, listed the same way as proof pages: one per record that
       actually exists on chain, so a new airdrop becomes indexable without a
       redeploy. */
    try {
      for (const a of (await airdropIndex.all()).values()) {
        parts.push(`  <url><loc>https://hoodlock.tech/airdrop/${a.id}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`);
      }
    } catch { /* a slow index must not cost the whole sitemap */ }
    proof("lock", nLocks, "0.8");
    proof("burn", nBurns, "0.8");
    proof("vesting", nVests, "0.8");
    // Token pages that cleared the gate. lastmod tracks the last time the gate
    // saw the token, which is the signal Google uses to decide a recrawl is
    // worth it — that is how a page flipping to "locked" gets picked up.
    for (const t of publishedTokens()) {
      const lm = t.last_pass ? new Date(t.last_pass * 1000).toISOString().slice(0, 10) : today;
      parts.push(`  <url><loc>https://hoodlock.tech/token/${t.slug}</loc><lastmod>${lm}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.join("\n")}\n</urlset>\n`;
    sitemapCache = { at: Date.now(), xml };
    res.type("application/xml").send(xml);
  } catch {
    send(res, "sitemap.xml"); // static fallback — never 5xx on a crawler
  }
});
app.get("/embed", (_req, res) => send(res, "embed.html")); // framable (headers exempted above)
app.get("/blog", (_req, res) => send(res, "blog/index.html"));
/* Same treatment as /blog: without an explicit route, serve-static answers a
   bare /docs with a 301 to /docs/, which costs a round trip and splits the
   canonical. Sub-pages need no route — express.static's `extensions` option
   already resolves /docs/contracts to docs/contracts.html. */
app.get("/docs", (_req, res) => send(res, "docs/index.html"));
/* A trailing slash on a sub-page resolved to nothing and 404'd — /docs/contracts/
   is a URL people and crawlers produce by hand. Redirect to the canonical form
   rather than serving the same page at two addresses. */
app.get(/^\/docs\/(.+)\/$/, (req, res) => res.redirect(301, "/docs/" + req.params[0]));
/* The docs stylesheet and runtime carry a content hash, so a given URL can never
   change and is safe to cache for a year. Without this they fall to the generic
   static handler's max-age=0 and get revalidated on every page of a multi-page
   section. The pattern is strict enough that req.path cannot traverse. */
app.get(/^\/docs\/docs-[A-Za-z0-9_-]{8}\.(?:css|js)$/, (req, res) =>
  res.set("Cache-Control", "public, max-age=31536000, immutable").sendFile(join(PUBLIC, req.path)));
app.get("/blog/:slug", (req, res) => {
  const slug = req.params.slug;
  // A post that isn't there is a 404, not a silent bounce to the index — the
  // index answering 200 for every made-up slug is unbounded duplicate content.
  if (!/^[a-z0-9-]+$/.test(slug)) { res.status(404); return send(res, "404.html"); } // no path traversal
  const f = join(PUBLIC, "blog", slug + ".html");
  if (!existsSync(f)) { res.status(404); return send(res, "404.html"); }
  return res.set("Cache-Control", HTML_CACHE).sendFile(f);
});

/* Unknown API routes fell through to the SPA catch-all and answered 200 with
   HTML, which is confusing for anything expecting JSON. */
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
/* Vite puts a content hash in every /assets name, so those files can never
   change under a given URL — cache them for a year. Everything else (HTML,
   images, the sitemap) keeps revalidating, since those URLs are stable while
   their contents are not. */
app.use("/assets", express.static(join(PUBLIC, "assets"), {
  immutable: true, maxAge: "365d", fallthrough: false,
}));
app.use(express.static(PUBLIC, {
  extensions: ["html"],
  setHeaders: (res, p) => { if (p.endsWith(".html")) res.set("Cache-Control", HTML_CACHE); },
}));

/* Unknown paths used to render the landing page with a 200, which reads to a
   crawler as a real page and to a browser as "this URL exists". Serve the app
   shell so client routing still works, but say 404. */
app.use((_req, res) => {
  res.status(404);
  send(res, "404.html");
});

app.listen(PORT, () => {
  console.log(`[hoodlock] listening on ${PORT}`);
  // A missing font renders every share card as an empty gradient with no error
  // anywhere, so say so loudly at boot rather than finding out on X.
  console.log(fontsReady()
    ? "[hoodlock] share-card fonts loaded"
    : "[hoodlock] WARNING: no share-card fonts — cards will render without text");
  // Pull the logs once at boot so the first visitor after a deploy doesn't pay
  // Blockscout's cold latency. Failures are fine — the cache just stays empty.
  readLogs.warm([LOCKER, BURNER, VESTING])
    .then(() => tokenIndex.warm())
    .then((ix) => console.log(`[hoodlock] log cache warm · token index: ${ix.size} tokens`))
    .then(() => refreshTokenPages())
    .then(() => warmTokenPages())
    .catch((e) => console.log("[hoodlock] startup warm failed:", e?.message || e));

  // Re-run the gate every six hours and re-warm what it kept. Both are paced
  // and neither blocks a request.
  setInterval(() => {
    refreshTokenPages().then(() => warmTokenPages()).catch(() => {});
  }, 6 * 60 * 60_000).unref?.();
});
