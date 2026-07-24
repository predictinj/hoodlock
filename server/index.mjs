/* HoodLock server — serves the static site AND powers affiliate tracking.
 * The static site is served no matter what; if the DB or chain layer fails to
 * init, only the /api and /r routes degrade — the app stays up. */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, http, defineChain, getAddress, verifyMessage, isAddress } from "viem";

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
  `);
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

const app = express();
app.use(express.json({ limit: "16kb" }));

/* affiliate redirect: /r/<code> → count a click, hand off to the app with ?ref */
app.get("/r/:code", (req, res) => {
  const code = req.params.code;
  if (db && REF_RE.test(code)) {
    try { db.prepare("UPDATE affiliates SET clicks = clicks + 1 WHERE code = ?").run(code); } catch { /* */ }
  }
  res.redirect(302, "/app/locks?ref=" + encodeURIComponent(code));
});

/* first-touch attribution — open (analytics only, immutable once set) */
app.post("/api/ref/visit", (req, res) => {
  if (!db) return res.json({ ok: false });
  const wallet = String(req.body?.wallet || "").toLowerCase();
  const ref = String(req.body?.ref || "");
  if (!isAddress(wallet) || !REF_RE.test(ref)) return res.status(400).json({ ok: false });
  const known = db.prepare("SELECT 1 FROM affiliates WHERE code = ?").get(ref);
  if (!known) return res.json({ ok: false });
  try { db.prepare("INSERT OR IGNORE INTO attributions (wallet, code, ts) VALUES (?,?,?)").run(wallet, ref, Math.floor(Date.now() / 1000)); } catch { /* */ }
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
