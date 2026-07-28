/* HoodLock app — the super-app UI wired straight to the RobinhoodLocker
   contract on Robinhood Chain (4663). No backend: every number on screen is a
   contract read or an event log. Wallet layer: EIP-6963 injected providers +
   WalletConnect for Robinhood Wallet mobile. */
import {
  createPublicClient, http, fallback, custom, defineChain, getAddress, isAddress,
  parseUnits, formatUnits, encodeFunctionData, numberToHex, keccak256, toHex, type Hex,
} from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";
import BURNER_ABI from "./burner-abi.json";
import VESTING_ABI from "./vesting-abi.json";
import { amountValueUsd, computeTvl, fmtUsd, tokenPriceUsd, tokenDepthCapUsd } from "./tvl";

/* ---------- chain + clients ----------
   Robinhood's public RPC is free but rate-limited, so a read-heavy session can
   intermittently get "HTTP request failed". We (a) retry with backoff + a longer
   timeout, and (b) allow a dedicated RPC (VITE_RPC_URL) or extra endpoints
   (config.rpcs[]) to be tried first via a fallback transport. */
const RPC_URLS: string[] = [
  (import.meta as any).env?.VITE_RPC_URL,
  ...(Array.isArray((cfg as any).rpcs) ? (cfg as any).rpcs : []),
  cfg.rpc,
].filter((u, i, a) => typeof u === "string" && u && a.indexOf(u) === i);
// Modest per-endpoint retry (transient blips) — NOT aggressive, since hammering a
// rate-limited RPC makes it worse. Real reliability comes from a dedicated RPC via
// VITE_RPC_URL, tried first here; the public endpoint is the last-resort fallback.
const rpcTransport = fallback(
  RPC_URLS.map((u) => http(u, { timeout: 15_000, retryCount: 2, retryDelay: 400 })),
  { retryCount: 0 },
);
const CHAIN = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  // Multicall3 is deployed at the canonical address on this chain, which lets
  // viem fold a screen's worth of reads into one eth_call — Explore alone was
  // making ~115 separate round-trips to a rate-limited public RPC.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const pub = createPublicClient({
  chain: CHAIN,
  transport: rpcTransport,
  // 16ms collects reads issued across a few microtask ticks (a row's token
  // metadata, its price, its icon) without adding latency you can perceive.
  batch: { multicall: { wait: 16 } },
});
const LOCKER = getAddress(cfg.locker) as `0x${string}`;
// The burner is optional — without config.burner the whole burn UI stays hidden.
const BURNER = (cfg as any).burner && isAddress((cfg as any).burner) ? (getAddress((cfg as any).burner) as `0x${string}`) : null;
// Vesting contract (admin card only for now — full vesting UI comes separately).
const VESTING = (cfg as any).vesting && isAddress((cfg as any).vesting) ? (getAddress((cfg as any).vesting) as `0x${string}`) : null;
const VESTING_ADMIN_ABI = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "acceptAdmin", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const EXP = cfg.explorer;

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/* ---------- tiny DOM helpers ---------- */
const $ = (id: string) => document.getElementById(id)!;
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const fmt = (v: bigint, d: number) => { const s = formatUnits(v, d); return s.replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m)); };
const fmtNum = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 4 });
// Balance display: 2 decimals for normal amounts, more only when the balance is tiny (dust would show as 0).
const fmtBal = (v: bigint, d: number) => { const n = Number(formatUnits(v, d)); return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 }); };
function escape(s: string) { return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!)); }
function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) { let t: any; return (...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function remainingLabel(secLeft: number): string {
  if (secLeft <= 0) return "0m";
  const d = secLeft / 86400;
  if (d >= 1) return `${d.toFixed(d < 2 ? 1 : 0)}d`;
  const h = Math.floor(secLeft / 3600), m = Math.floor((secLeft % 3600) / 60);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}
const dateLabel = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeUTC = (sec: number) => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
function relTime(sec: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000) - sec);
  if (s < 60) return `${s}S`;
  if (s < 3600) return `${Math.floor(s / 60)}M`;
  if (s < 86400) return `${Math.floor(s / 3600)}H`;
  return `${Math.floor(s / 86400)}D`;
}
/* ---------- token-logotyper (DEXScreener, gratis + CORS-öppet) ---------- */
const logoInflight = new Map<string, Promise<string | null>>();
function tokenLogo(addr: string): Promise<string | null> {
  const k = addr.toLowerCase();
  try {
    const hit = localStorage.getItem(`hl_logo2_${k}`);
    if (hit !== null) return Promise.resolve(hit === "none" ? null : hit);
  } catch { /* */ }
  if (!logoInflight.has(k)) {
    logoInflight.set(k, (async () => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${k}`);
        const j: any = await r.json();
        // A pair's info.imageUrl belongs to its BASE token. Only use it when the
        // queried token IS the base — otherwise quote tokens like WETH inherit
        // whatever memecoin happens to be first in their pair list.
        const url = (j.pairs || [])
          .filter((p: any) => p?.baseToken?.address?.toLowerCase() === k)
          .map((p: any) => p?.info?.imageUrl)
          .find(Boolean) || null;
        try { localStorage.setItem(`hl_logo2_${k}`, url ?? "none"); } catch { /* */ }
        return url;
      } catch { return null; }
    })());
  }
  return logoInflight.get(k)!;
}
/** token-ico-span: officiell logga om den finns, annars bokstavsavatar (och
 *  bokstäverna ligger kvar bakom — trasig bild avslöjar dem via onerror). */
/* Token pages exist only for tokens that cleared the gate, so the app asks
   which ones before linking — an internal link to a noindex page helps nobody,
   and bouncing every visitor through a redirect helps less. */
let tokenPageSlugs: Record<string, string> | null = null;
let tokenPagesPromise: Promise<void> | null = null;
function loadTokenPages(): Promise<void> {
  if (!tokenPagesPromise) {
    tokenPagesPromise = fetch("/api/token-pages")
      .then((r) => (r.ok ? r.json() : { tokens: {} }))
      .then((d) => { tokenPageSlugs = d.tokens || {}; })
      .catch(() => { tokenPageSlugs = {}; });
  }
  return tokenPagesPromise;
}
/** A quiet line under a proof card pointing at the token's own page. Only
    rendered when that page exists — a link to nothing helps nobody. */
function tokenPageLine(addr: string, symbol: string): string {
  const slug = tokenPageSlugs?.[String(addr).toLowerCase()];
  if (!slug) return "";
  return `<div class="p-tokline">Holders, supply and every HoodLock record for `
    + `<a href="/token/${slug}">$${escape(symbol)}</a></div>`;
}

async function tokenIcoHTML(addr: string, symbol: string): Promise<string> {
  const letters = escape(symbol.slice(0, 2).toUpperCase());
  const logo = await tokenLogo(addr);
  const img = logo ? `<img src="${escape(logo)}" alt="" loading="lazy" onerror="this.remove()" />` : "";
  return `<span class="token-ico" style="background:${tokenColor(addr)}">${letters}${img}</span>`;
}

// deterministic token avatar color (greens family, brand-consistent)
function tokenColor(addr: string): string {
  let h = 0; for (const ch of addr.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [140, 148, 156, 132, 164, 124]; const hue = hues[h % hues.length];
  const light = 42 + (h >> 3) % 20;
  return `linear-gradient(135deg, hsl(${hue} 85% ${light + 14}%), hsl(${hue} 80% ${Math.max(26, light - 8)}%))`;
}
let toastTimer: any;
function notify(msg: string) {
  $("toastMsg").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2800);
}
// (sidebar "Contract on Blockscout" link removed — multiple contracts now; proof pages link each one)

/* Proof-page back links navigate in-app instead of full-reloading (the reload
   flashed the dashboard view before JS re-routed — read as a glitch). */
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a.p-back") as HTMLAnchorElement | null;
  if (!a) return;
  const path = a.getAttribute("href") || "/app";
  const view = path.match(/^\/app\/([a-z]+)/)?.[1] || "dashboard";
  e.preventDefault();
  history.pushState(null, "", path === "/app" ? "/app/dashboard" : path);
  go(view, false);
});

/* ---------- view routing ---------- */
const TITLES: Record<string, string> = { dashboard: "DASHBOARD", locks: "TOKEN LOCKS", explore: "EXPLORE / VERIFY", proof: "LOCK PROOF", vesting: "VESTING", airdrops: "AIRDROPS", streams: "STREAMS", affiliate: "AFFILIATE", developers: "DEVELOPERS", admin: "ADMIN CONSOLE" };
const ADMIN_WALLET = "0x79c1230cab12d53d040f5fe1f5279e1a481ccea2";
function go(view: string, writeHistory = true) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${view}`).classList.add("active");
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $("viewTitle").textContent = TITLES[view] || view.toUpperCase();
  if (view !== "proof" && writeHistory) { history.replaceState(null, "", "/app/" + view); }
  if (view === "explore" && !exploreLoaded) { loadTokenPages(); loadExplore(); }
  if (view === "locks") renderMine();
  if (view === "vesting") loadVestingView();
  if (view === "admin") loadAdmin();
  if (view === "affiliate") loadAffiliatePage();
  if (view === "developers") loadDevelopersPage();
}
document.querySelectorAll<HTMLElement>(".nav-item").forEach((n) => n.addEventListener("click", () => { go(n.dataset.view!); closeSidebar(); }));

/* ---------- mobilmeny (drawer) ---------- */
function closeSidebar() {
  document.querySelector(".sidebar")?.classList.remove("open");
  $("sbBackdrop").classList.remove("show");
}
$("menuBtn").addEventListener("click", () => {
  const open = document.querySelector(".sidebar")!.classList.toggle("open");
  $("sbBackdrop").classList.toggle("show", open);
});
$("sbBackdrop").addEventListener("click", closeSidebar);
// Dashboard cards are real <a href> so they're crawlable and open in a new tab
// on middle/ctrl-click — but a plain left-click routes in-app instead of
// reloading the whole shell.
document.querySelectorAll<HTMLElement>("[data-goto]").forEach((b) => b.addEventListener("click", (e) => {
  const me = e as MouseEvent;
  if (b.tagName === "A" && (me.metaKey || me.ctrlKey || me.shiftKey || me.button !== 0)) return;
  e.preventDefault();
  history.pushState(null, "", "/app/" + b.dataset.goto!);
  go(b.dataset.goto!, false);
}));

/* ---------- wallet (EIP-6963 + WalletConnect) ---------- */
type Eip1193 = { request(a: { method: string; params?: any[] }): Promise<any>; };
const announced = new Map<string, { info: { name: string; rdns?: string }; provider: Eip1193 }>();
window.addEventListener("eip6963:announceProvider", (e: any) => { const d = e.detail; if (d?.info?.rdns) announced.set(d.info.rdns, d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));

let provider: Eip1193 | null = null;
let wcProvider: any = null;
let account = "";

const RH_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCA0OCA0OCc+PHJlY3Qgd2lkdGg9JzQ4JyBoZWlnaHQ9JzQ4JyByeD0nMTEnIGZpbGw9JyMwMEM4MDUnLz48cGF0aCBkPSdNMzQgMTIgQzIyIDE1IDE2LjUgMjQuNSAxNS40IDM1LjYgQzE1LjMgMzYuOCAxNi45IDM3LjMgMTcuNSAzNi4yIEMxOS4xIDMzLjQgMjEuMiAzMS40IDI0LjEgMzAuMyBMMjAuNCAyOS45IEMyNCAyOC43IDI3LjEgMjYuMyAyOS4yIDIyLjcgTDI1LjUgMjIuNSBDMjguNCAyMCAzMC45IDE2LjYgMzQgMTIgWicgZmlsbD0nI2ZmZmZmZicvPjxwYXRoIGQ9J00xNy4yIDM1LjggTDMxLjggMTUuMicgc3Ryb2tlPScjMDBDODA1JyBzdHJva2Utd2lkdGg9JzEuNScgc3Ryb2tlLWxpbmVjYXA9J3JvdW5kJy8+PC9zdmc+";
const WC_PROJECT_ID = (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID || "";

function prettyName(n: string) { return /robinhood/i.test(n) ? "Robinhood Wallet" : /^rabby/i.test(n) ? "Rabby" : n; }
function injectedProviders(): { name: string; icon?: string; provider: Eip1193 }[] {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const out: { name: string; icon?: string; provider: Eip1193 }[] = [];
  const seen = new Set<string>();
  for (const d of announced.values()) {
    const name = prettyName(d.info.name);
    if (seen.has(name.toLowerCase())) continue;
    out.push({ name, icon: (d.info as any).icon, provider: d.provider }); seen.add(name.toLowerCase());
  }
  const eth = (window as any).ethereum;
  if (eth && !out.length) out.push({ name: eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "Injected Wallet", provider: eth });
  return out;
}
type Choice = { name: string; icon?: string; installed: boolean; connect: () => Promise<void> };
const WC_ICON = "data:image/svg+xml;base64," + btoa(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' rx='11' fill='#3B99FC'/><path d='M15 21.5c5-4.8 13-4.8 18 0l.7.7c.25.24.25.63 0 .87l-2.2 2.1a.33.33 0 01-.45 0l-.95-.9c-3.5-3.36-9.2-3.36-12.7 0l-1 .97a.33.33 0 01-.46 0l-2.2-2.1a.6.6 0 010-.88l.75-.73zm22.3 4.1l1.95 1.9c.25.24.25.63 0 .87l-8.8 8.5a.66.66 0 01-.92 0l-6.25-6a.17.17 0 00-.23 0l-6.24 6a.66.66 0 01-.92 0l-8.8-8.5a.6.6 0 010-.88l1.95-1.88a.66.66 0 01.92 0l6.24 6.02c.07.06.17.06.23 0l6.25-6.02a.66.66 0 01.92 0l6.24 6.02c.07.06.17.06.23 0l6.25-6.02a.66.66 0 01.92 0z' fill='#fff'/></svg>`);
const CURATED: { name: string; keys: string[]; url: string; icon?: string }[] = [
  { name: "MetaMask", keys: ["metamask"], url: "https://metamask.io/download" },
  { name: "Phantom", keys: ["phantom"], url: "https://phantom.com/download" },
  { name: "Rabby", keys: ["rabby"], url: "https://rabby.io/" },
  { name: "Trust Wallet", keys: ["trust"], url: "https://trustwallet.com/download" },
];
const IS_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
function walletChoices(): Choice[] {
  const inj = injectedProviders();
  // ALLT som är installerat/injicerat visas (desktop-extensions eller walletens egen in-app-browser)
  const choices: Choice[] = inj.map((p) => ({ name: p.name, icon: p.icon, installed: true, connect: () => connectInjected(p.provider) }));
  if (IS_MOBILE) {
    // Mobil: appar kan inte injicera i Safari/Chrome — anslut via WalletConnect,
    // som öppnar/deep-linkar den wallet användaren väljer (Phantom, MetaMask …).
    choices.push({ name: "Robinhood Wallet", icon: RH_ICON, installed: true, connect: connectWC });
    choices.push({ name: "Phantom, MetaMask & other wallets", icon: WC_ICON, installed: true, connect: connectWC });
    return choices;
  }
  // Desktop: kuraterade favoriter som saknas får installationslänk
  const have = (keys: string[]) => inj.some((p) => keys.some((k) => p.name.toLowerCase().includes(k)));
  for (const cw of CURATED) {
    if (have(cw.keys)) continue;
    choices.push({ name: cw.name, icon: cw.icon, installed: false, connect: async () => { window.open(cw.url, "_blank", "noopener"); throw new Error(`${cw.name} isn't installed — opening its download page.`); } });
  }
  choices.push({ name: "Robinhood Wallet (mobile)", icon: RH_ICON, installed: true, connect: connectWC });
  choices.push({ name: "WalletConnect · 500+ wallets", icon: WC_ICON, installed: true, connect: connectWC });
  return choices;
}
async function ensureChain(p: Eip1193) {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN.id) }] }); }
  catch (e: any) { if (e?.code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: numberToHex(CHAIN.id), chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [cfg.rpc] }] }); }
}
async function connectInjected(p: Eip1193) {
  const accs: string[] = await p.request({ method: "eth_requestAccounts" });
  provider = p; account = getAddress(accs[0]); await ensureChain(p);
  try { localStorage.setItem("hl_conn", "injected"); } catch { /* */ }
  attachProviderEvents(p); onConnected();
}
async function connectWC() {
  if (!WC_PROJECT_ID) throw new Error("Mobile sign-in isn't enabled yet — a WalletConnect project id is needed.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  // optionalChains (inte chains): annars NEKAR wallets som inte redan känner
  // till Robinhood Chain hela sessionen. Vi lägger till/byter kedja efteråt.
  const wp = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: [CHAIN.id, 1],
    showQrModal: true,
    rpcMap: { [CHAIN.id]: cfg.rpc },
    qrModalOptions: {
      // wallets som KAN lägga till egna EVM-kedjor — Phantom/Keplr kan inte
      // köra Robinhood Chain alls (fast kedjelista) och rekommenderas inte.
      explorerRecommendedWalletIds: [
        "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask
        "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust
        "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369", // Rainbow
        "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby
        "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393", // Phantom (Robinhood Chain integrated)
      ],
    },
  } as any);
  await wp.connect();
  const accs: string[] = await wp.request({ method: "eth_accounts" });
  provider = wp as unknown as Eip1193; wcProvider = wp; account = getAddress(accs[0]);
  try { await ensureChain(wp as unknown as Eip1193); } catch { /* vissa wallets sköter kedjebyte i appen */ }
  try { localStorage.setItem("hl_conn", "wc"); } catch { /* */ }
  attachProviderEvents(provider); onConnected();
}
function onConnected(silent = false) {
  if (!silent) closeWalletModal();
  try { localStorage.setItem("hl_acct", account.toLowerCase()); } catch { /* */ }
  ($("connectBtn") as HTMLButtonElement).innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#03130a;box-shadow:0 0 5px rgba(3,19,10,.6)"></span><span class="wallet">${short(account)}</span>`;
  ($("lockBtn") as HTMLButtonElement).disabled = false;
  walletToks = null; walletToksFor = "";
  refreshToken(); renderMine(); updateSummary(); loadWalletTokens();
  syncAdminNav(); attributeRef();
  if ($("view-vesting").classList.contains("active")) { vRefreshToken(); renderVestMine(); updateVSummary(); }
  if ($("view-affiliate").classList.contains("active")) loadAffiliatePage();
  if ($("view-developers").classList.contains("active")) loadDevelopersPage();
  fetch("/api/track/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: account }) }).catch(() => { /* analytics only */ });
  if (!silent) notify(`Wallet connected — ${short(account)}`);
}
// keep the app in sync if the wallet switches account or disconnects in-wallet
function attachProviderEvents(p: Eip1193) {
  try {
    (p as any).on?.("accountsChanged", (accs: string[]) => {
      if (!accs || !accs.length) return disconnect();
      provider = p; account = getAddress(accs[0]); onConnected(true);   // keep provider in sync with account
    });
    (p as any).on?.("disconnect", () => disconnect());
  } catch { /* */ }
}
// silently restore the session on page load (no wallet prompt)
async function restoreConnection() {
  let conn = ""; try { conn = localStorage.getItem("hl_conn") || ""; } catch { /* */ }
  if (!conn) return;
  if (conn === "wc") {
    if (!WC_PROJECT_ID) return;
    try {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const wp: any = await EthereumProvider.init({ projectId: WC_PROJECT_ID, optionalChains: [CHAIN.id, 1], showQrModal: false, rpcMap: { [CHAIN.id]: cfg.rpc } } as any);
      const accs: string[] = wp.accounts || [];
      if (wp.session && accs.length) {
        provider = wp; wcProvider = wp; account = getAddress(accs[0]);
        attachProviderEvents(provider); onConnected(true);
      }
    } catch { /* */ }
    return;
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 300));
  let stored = ""; try { stored = (localStorage.getItem("hl_acct") || "").toLowerCase(); } catch { /* */ }
  const cands: Eip1193[] = [...announced.values()].map((d) => d.provider);
  const eth = (window as any).ethereum; if (eth) cands.push(eth);
  for (const p of cands) {
    try {
      const accs: string[] = await p.request({ method: "eth_accounts" });   // silent — no prompt
      if (!accs || !accs.length) continue;
      const lc = accs.map((a) => a.toLowerCase());
      if (stored && !lc.includes(stored)) continue;
      provider = p; account = getAddress(stored && lc.includes(stored) ? accs[lc.indexOf(stored)] : accs[0]);
      attachProviderEvents(p); onConnected(true);
      return;
    } catch { /* try next */ }
  }
}
function disconnect() {
  try { wcProvider?.disconnect?.(); } catch { /* */ }
  provider = null; wcProvider = null; account = "";
  ($("connectBtn") as HTMLButtonElement).textContent = "Connect Wallet";
  ($("lockBtn") as HTMLButtonElement).disabled = false;
  $("balHint").textContent = "";
  document.getElementById("yourLocksSub")?.replaceChildren("CONNECT WALLET TO MANAGE");
  renderMine(); updateSummary(); closeWalletModal(); syncAdminNav();
  try { localStorage.removeItem("hl_afftok"); localStorage.removeItem("hl_affexp"); localStorage.removeItem("hl_conn"); localStorage.removeItem("hl_acct"); } catch { /* */ }
  if ($("view-affiliate").classList.contains("active")) loadAffiliatePage();
  if ($("view-developers").classList.contains("active")) loadDevelopersPage();
}
function openWalletModal() {
  $("walletModal").classList.add("show");
  const choicesBox = $("walletChoices"), connBox = $("walletConnected"), title = $("walletModalTitle");
  if (account) {
    title.textContent = "Wallet"; choicesBox.style.display = "none"; connBox.style.display = "";
    connBox.innerHTML = `<div class="wconn-addr">${account}</div><div class="wconn-acts">
      <a class="btn btn-line" href="${EXP}/address/${account}" target="_blank" rel="noopener">View on explorer</a>
      <button id="disconnectBtn" class="btn btn-danger">Disconnect</button></div>`;
    $("disconnectBtn").addEventListener("click", disconnect);
    return;
  }
  title.textContent = "Connect a wallet"; connBox.style.display = "none"; choicesBox.style.display = "";
  const choices = walletChoices();
  const tip = IS_MOBILE && !injectedProviders().length
    ? `<div class="m-sub" style="margin-top:10px">Pick an option above — your wallet app opens automatically. Tip: you can also browse hoodlock.tech inside your wallet's built-in browser.</div>`
    : "";
  choicesBox.innerHTML = choices.map((c, i) => `<div class="wchoice" data-i="${i}">
    ${c.icon ? `<img src="${c.icon}" alt="">` : `<span class="ic">${escape(c.name[0])}</span>`}
    <span>${escape(c.name)}</span><span class="badge2">${c.installed ? "" : "NOT DETECTED"}</span></div>`).join("") + tip;
  choicesBox.querySelectorAll<HTMLElement>(".wchoice").forEach((el) => el.addEventListener("click", async () => {
    const c = choices[Number(el.dataset.i)];
    const b = el.querySelector(".badge2")!; b.textContent = "CONNECTING…";
    try { await c.connect(); } catch (e: any) { alert(e?.shortMessage || e?.message || "Connect failed"); openWalletModal(); }
  }));
}
function closeWalletModal() { $("walletModal").classList.remove("show"); }
$("connectBtn").addEventListener("click", openWalletModal);
$("walletModalClose").addEventListener("click", closeWalletModal);
$("walletModal").addEventListener("click", (e) => { if (e.target === $("walletModal")) closeWalletModal(); });

async function send(to: `0x${string}`, data: Hex, value = 0n): Promise<string> {
  return await provider!.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: numberToHex(value) as any }] });
}
// personal_sign that recovers a provider if the reference was lost (e.g. after a
// stale accountsChanged event) so sign-in never dies on a null provider.
async function walletSign(message: string): Promise<string> {
  let p = provider;
  if (!p && account) {
    const cands: Eip1193[] = [...announced.values()].map((d) => d.provider);
    const eth = (window as any).ethereum; if (eth) cands.push(eth);
    for (const c of cands) {
      try {
        const accs: string[] = await c.request({ method: "eth_accounts" });
        if (accs?.some((a) => a.toLowerCase() === account.toLowerCase())) { provider = c; p = c; break; }
      } catch { /* try next */ }
    }
  }
  if (!p) throw new Error("Wallet not connected — please reconnect and try again.");
  return await p.request({ method: "personal_sign", params: [message, account] }) as string;
}
async function waitTx(hash: string) { return pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 120000, retryCount: 12, retryDelay: 2000 }); }
// Turn raw viem/wallet errors into something a user can act on.
function friendlyErr(e: any): string {
  const m = String(e?.shortMessage || e?.details || e?.message || "");
  if (e?.code === 4001 || /user rejected|user denied|rejected the request/i.test(m)) return "Transaction rejected in wallet.";
  if (/HTTP request failed|fetch failed|Failed to fetch|timed out|timeout|network error|load failed/i.test(m))
    return "Couldn't reach Robinhood Chain — the network may be busy. Please try again in a moment.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH for the fee + gas.";
  return m || "Something went wrong. Please try again.";
}

/* ---------- fee (live from contract) ---------- */
let lockFee = 0n, burnFee = 0n;
function renderFee() {
  // avgiftsraden är borttagen ur UI:t — avgifterna används fortfarande i tx:erna
  const el = document.getElementById("sFee");
  if (el) { const fee = burnMode ? burnFee : lockFee; el.textContent = fee > 0n ? `${formatUnits(fee, 18)} ETH` : "free"; }
}
let vestingFee = 0n;
async function loadFee() {
  try { lockFee = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ }
  if (BURNER) { try { burnFee = await pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ } }
  if (VESTING) { try { vestingFee = await pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ } }
  renderFee();
  if (document.getElementById("vsFee")) updateVSummary(); // vesting summary shows n × fee
}
loadFee();

/* ---------- burn mode (the FOREVER · BURN chip flips the lock form into a burn form) ---------- */
let burnMode = false;
function setBurnMode(on: boolean) {
  burnMode = on;
  $("burnChip").classList.toggle("on", on);
  $("unlockInputWrap").style.display = on ? "none" : "";
  $("unlockLabel").textContent = on ? "Duration" : "Unlock date";
  $("locksH1").innerHTML = on ? `Burn <span class="serif" style="color:#ff6b6b">forever.</span>` : `Create a <span class="serif">lock.</span>`;
  $("locksLede").textContent = on
    ? "Send tokens to the dead address and get shareable on-chain proof of the burn."
    : "Lock any Robinhood token or LP until a date you choose. Extend-only — never shortenable.";
  $("lockNote").style.display = on ? "" : "none";
  $("lockNoteText").innerHTML = `<b style="color:#ff8a8a">Irreversible.</b> Burned tokens go straight to the dead address and can never be recovered — by anyone. The burn gets a public proof page you can share.`;
  $("kDate").textContent = on ? "Destination" : "Unlocks";
  $("kDuration").textContent = "Duration";
  if (on) document.querySelectorAll("#lockPresets .chip-dur:not(#burnChip)").forEach((x) => x.classList.remove("on"));
  renderFee();
  updateSummary();
}

/* ---------- token field ---------- */
let tokenMeta: { addr: `0x${string}`; symbol: string; decimals: number; bal: bigint } | null = null;
async function refreshToken() {
  tokenMeta = null; $("tokenInfo").textContent = ""; $("balHint").textContent = "";
  $("maxBtn").style.display = "none";
  const raw = ($("tokenAddr") as HTMLInputElement).value.trim();
  updateSummary();
  if (!isAddress(raw)) return;
  const addr = getAddress(raw) as `0x${string}`;
  try {
    const [symbol, decimals, supply] = await Promise.all([
      pub.readContract({ address: addr, abi: ERC20, functionName: "symbol" }).catch(() => "TOKEN"),
      pub.readContract({ address: addr, abi: ERC20, functionName: "decimals" }).catch(() => 18),
      pub.readContract({ address: addr, abi: ERC20, functionName: "totalSupply" }).catch(() => 0n) as Promise<bigint>,
    ]);
    let bal = 0n;
    if (account) bal = await pub.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [account as `0x${string}`] }) as bigint;
    tokenMeta = { addr, symbol: String(symbol), decimals: Number(decimals), bal };
    $("tokenInfo").innerHTML = `<span style="color:var(--neon)">✓</span> <b>$${escape(String(symbol))}</b> · ${decimals} decimals`;
    if (account) {
      const sym = escape(String(symbol));
      const pctStr = supply > 0n
        ? (Number((bal * 10n ** 10n) / supply) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 })
        : null;
      const pctPart = bal > 0n && pctStr !== null ? ` · <b>${pctStr}%</b> of supply` : "";
      $("balHint").innerHTML = `You hold <b>${fmtBal(bal, Number(decimals))}</b> $${sym}${pctPart}`;
      $("maxBtn").style.display = bal > 0n ? "" : "none";
    }
    updateSummary();
  } catch { $("tokenInfo").innerHTML = `<span class="badv">Couldn't read this token on Robinhood Chain.</span>`; }
}
$("tokenAddr").addEventListener("input", debounce(refreshToken, 400));
$("maxBtn").addEventListener("click", () => {
  if (!tokenMeta) return;
  ($("amount") as HTMLInputElement).value = fmt(tokenMeta.bal, tokenMeta.decimals);
  updateSummary();
});

/* ---------- wallet token dropdown (Blockscout indexes the balances) ---------- */
type WalletTok = { addr: string; symbol: string; name: string; decimals: number; balance: bigint };
let walletToks: WalletTok[] | null = null;
let walletToksFor = "";
async function loadWalletTokens(): Promise<WalletTok[]> {
  if (!account) return [];
  if (walletToks && walletToksFor === account) return walletToks;
  try {
    const r = await fetch(`${EXP}/api/v2/addresses/${account}/tokens?type=ERC-20`);
    const j: any = await r.json();
    walletToks = (j.items || [])
      .map((it: any) => {
        const t = it.token || {};
        return {
          addr: String(t.address || t.address_hash || ""),
          symbol: String(t.symbol || "TOKEN"),
          name: String(t.name || ""),
          decimals: Number(t.decimals ?? 18),
          balance: BigInt(it.value || "0"),
        };
      })
      .filter((t: WalletTok) => isAddress(t.addr) && t.balance > 0n);
    walletToksFor = account;
  } catch { walletToks = []; }
  return walletToks ?? [];
}
/** Generic wallet-token dropdown — used by both the lock form and the vesting form. */
async function renderTokenDropdown(inputId: string, ddId: string, onPick: () => void) {
  const dd = $(ddId);
  if (!account) { dd.classList.remove("show"); return; }
  const q = ($(inputId) as HTMLInputElement).value.trim().toLowerCase();
  dd.innerHTML = `<div class="td-note">Loading your tokens… <span class="spin"></span></div>`;
  dd.classList.add("show");
  const toks = await loadWalletTokens();
  const hits = toks.filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.addr.toLowerCase().startsWith(q));
  if (!hits.length) {
    if (q) { dd.classList.remove("show"); return; }   // fri inmatning — stör inte
    dd.innerHTML = `<div class="td-note">No tokens found in this wallet on Robinhood Chain — paste a contract address instead.</div>`;
    return;
  }
  dd.innerHTML = (await Promise.all(hits.slice(0, 30).map(async (t, i) => `
    <div class="td-item" data-i="${i}">
      ${await tokenIcoHTML(t.addr, t.symbol)}
      <div><div class="n">$${escape(t.symbol)}</div><div class="a">${short(t.addr)}</div></div>
      <span class="bal">${fmtNum(t.balance, t.decimals)}</span>
    </div>`))).join("");
  dd.querySelectorAll<HTMLElement>(".td-item").forEach((el) => el.addEventListener("mousedown", (e) => {
    e.preventDefault();   // hinner före inputens blur
    const t = hits[Number(el.dataset.i)];
    ($(inputId) as HTMLInputElement).value = t.addr;
    dd.classList.remove("show");
    onPick();
  }));
}
function wireTokenDropdown(inputId: string, ddId: string, onPick: () => void) {
  const render = () => renderTokenDropdown(inputId, ddId, onPick);
  $(inputId).addEventListener("focus", render);
  $(inputId).addEventListener("input", debounce(render, 250));
  $(inputId).addEventListener("blur", () => setTimeout(() => $(ddId).classList.remove("show"), 150));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $(ddId).classList.remove("show"); });
}
wireTokenDropdown("tokenAddr", "tokDd", () => refreshToken());

/* ---------- live lock summary ---------- */
function updateSummary() {
  const amtStr = ($("amount") as HTMLInputElement).value.trim();
  const dt = ($("unlockDate") as HTMLInputElement).value;
  $("sToken").textContent = tokenMeta ? `$${tokenMeta.symbol}` : "—";
  $("sAmount").textContent = amtStr ? Number(amtStr).toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—";
  const btn = $("lockBtn") as HTMLButtonElement;
  if (burnMode) {
    $("sDate").innerHTML = `<span class="mono" style="font-size:11px">0x…dEaD</span>`;
    $("sDuration").innerHTML = `<span style="color:#ff6b6b">FOREVER</span>`;
    if (!account) { btn.textContent = "Connect wallet to burn"; btn.disabled = false; return; }
    const readyB = !!tokenMeta && Number(amtStr) > 0;
    btn.textContent = readyB ? "🔥 Burn tokens forever" : "Fill in the details";
    btn.disabled = !readyB;
    return;
  }
  if (dt) {
    const d = new Date(dt);
    $("sDate").textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const days = (d.getTime() - Date.now()) / 864e5;
    $("sDuration").textContent = days > 0 ? (days >= 1 ? `${Math.round(days)} days` : `${Math.max(1, Math.round(days * 24))} hours`) : "—";
  } else { $("sDate").textContent = "—"; $("sDuration").textContent = "—"; }
  if (!account) { btn.textContent = "Connect wallet to lock"; btn.disabled = false; return; }
  const ready = !!tokenMeta && Number(amtStr) > 0 && !!dt;
  btn.textContent = ready ? "Lock tokens" : "Fill in the details";
  btn.disabled = !ready;
}
$("amount").addEventListener("input", updateSummary);
$("unlockDate").addEventListener("change", updateSummary);

/* ---------- duration preset chips (lock + extend) ---------- */
function toLocalInput(d: Date) { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
document.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest(".chip-dur") as HTMLElement | null;
  if (!chip || !chip.dataset.days) return;
  const days = Number(chip.dataset.days);
  const group = chip.parentElement as HTMLElement | null;
  group?.querySelectorAll(".chip-dur").forEach((x) => x.classList.remove("on"));
  chip.classList.add("on");
  if (group?.id === "lockPresets") {
    if (burnMode) setBurnMode(false);   // picking a duration always leaves burn mode
    ($("unlockDate") as HTMLInputElement).value = toLocalInput(new Date(Date.now() + days * 86400000));
    updateSummary();
  } else if (group?.id === "extendPresets") {
    ($("extendDate") as HTMLInputElement).value = toLocalInput(new Date((extendBase + days * 86400) * 1000));
  }
});

/* ---------- burn chip wiring ---------- */
if (!BURNER) ($("burnChip") as HTMLElement).style.display = "none";
$("burnChip").addEventListener("click", () => setBurnMode(!burnMode));

/* ---------- BURN (approve → burn) ---------- */
async function doBurn(amount: bigint, amtStr: string, msg: HTMLElement) {
  if (!BURNER) throw new Error("Burning isn't enabled yet.");
  const t = tokenMeta!;
  const ok = window.confirm(`⚠️ You are about to burn ${amtStr} ${t.symbol} FOREVER.\n\nThe tokens go straight to the dead address and can NEVER be recovered. Continue?`);
  if (!ok) { updateSummary(); return; }
  const btn = $("lockBtn") as HTMLButtonElement; btn.disabled = true;
  const allow = await pub.readContract({ address: t.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, BURNER] }) as bigint;
  if (allow < amount) {
    msg.textContent = "Approving… confirm in wallet";
    const ah = await send(t.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [BURNER, amount] }));
    msg.innerHTML = `Approving… <span class="spin"></span>`; await waitTx(ah);
  }
  msg.textContent = "Burning… confirm in wallet";
  const bh = await send(BURNER, encodeFunctionData({ abi: BURNER_ABI as any, functionName: "burn", args: [t.addr, amount] }), burnFee);
  msg.innerHTML = `Burning… <span class="spin"></span>`;
  await waitTx(bh);
  // our newest burn is the last id in burnsByBurner — that's the shareable proof
  let proof = "";
  try {
    const ids = await pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByBurner", args: [account as `0x${string}`] }) as bigint[];
    if (ids.length) proof = ` · <a href="/proof/burn/${Number(ids[ids.length - 1])}">Open the burn proof</a>`;
  } catch { /* proof link is optional */ }
  msg.className = "msg ok";
  msg.innerHTML = `🔥 Burned forever! <a href="${EXP}/tx/${bh}" target="_blank" rel="noopener">view tx</a>${proof}`;
  btn.disabled = false;
  ($("amount") as HTMLInputElement).value = "";
  burnedLogsPromise = null;   // refresh so the new burn's tx link resolves
  renderMine();
}

/* ---------- LOCK (approve → lock) ---------- */
$("lockBtn").addEventListener("click", async () => {
  const msg = $("lockMsg"); msg.className = "msg";
  try {
    if (!account) return openWalletModal();
    if (!tokenMeta) throw new Error("Enter a valid token address.");
    const amtStr = ($("amount") as HTMLInputElement).value.trim();
    const amount = parseUnits(amtStr || "0", tokenMeta.decimals);
    if (amount <= 0n) throw new Error("Enter an amount.");
    if (amount > tokenMeta.bal) throw new Error("Amount exceeds your balance.");
    if (burnMode) { await doBurn(amount, amtStr, msg); return; }
    const dt = ($("unlockDate") as HTMLInputElement).value;
    if (!dt) throw new Error("Pick an unlock date.");
    const unlockTime = BigInt(Math.floor(new Date(dt).getTime() / 1000));
    if (unlockTime <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Unlock date must be in the future.");

    const btn = $("lockBtn") as HTMLButtonElement; btn.disabled = true;
    const allow = await pub.readContract({ address: tokenMeta.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, LOCKER] }) as bigint;
    if (allow < amount) {
      msg.textContent = "Approving… confirm in wallet"; msg.className = "msg";
      const ah = await send(tokenMeta.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [LOCKER, amount] }));
      msg.innerHTML = `Approving… <span class="spin"></span>`; await waitTx(ah);
    }
    msg.textContent = "Locking… confirm in wallet";
    const lh = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "lock", args: [tokenMeta.addr, amount, unlockTime] }), lockFee);
    msg.innerHTML = `Locking… <span class="spin"></span>`;
    try {
      await waitTx(lh);
      msg.className = "msg ok";
      msg.innerHTML = `🔒 Locked! <a href="${EXP}/tx/${lh}" target="_blank" rel="noopener">view tx</a> — see it under <b>My locks</b> and share the proof.`;
      ($("amount") as HTMLInputElement).value = "";
    } catch {
      // The lock tx was submitted; we just couldn't confirm the receipt (RPC blip).
      // Don't present it as a failure — it very likely landed.
      msg.className = "msg";
      msg.innerHTML = `Transaction submitted — <a href="${EXP}/tx/${lh}" target="_blank" rel="noopener">view tx</a>. It should appear under <b>My locks</b> shortly.`;
    }
    btn.disabled = false;
    invalidateEvents();      // refresh events so the new lock's tx + stats resolve
    renderMine(); exploreLoaded = false;
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); ($("lockBtn") as HTMLButtonElement).disabled = false; }
});

/* ---------- lock reads + event cache ---------- */
type LockRow = { id: number; owner: string; token: string; amount: bigint; unlockTime: number; withdrawn: boolean };
async function readLock(id: number): Promise<LockRow> {
  const l: any = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "getLock", args: [BigInt(id)] });
  return { id, owner: getAddress(l.owner), token: getAddress(l.token), amount: l.amount as bigint, unlockTime: Number(l.unlockTime), withdrawn: l.withdrawn };
}
const LOCKED_EVENT = { type: "event", name: "Locked", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
  { name: "unlockTime", type: "uint256", indexed: false } ] } as const;
const EXTENDED_EVENT = { type: "event", name: "Extended", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "newUnlockTime", type: "uint256", indexed: false } ] } as const;
const WITHDRAWN_EVENT = { type: "event", name: "Withdrawn", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "amount", type: "uint256", indexed: false } ] } as const;
// MUST match the deployed contract exactly — the real Burned event has NO timestamp
// (that lives in the getBurn struct). A mismatched signature makes viem compute the
// wrong topic0 and getLogs returns nothing → the tx is never found.
const BURNED_EVENT = { type: "event", name: "Burned", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "burner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false } ] } as const;


/* ---------- event logs via Blockscout (the chain caps getLogs at 2000 blocks) ----------
   The RPC now rejects any getLogs spanning more than 2000 blocks, and the chain
   is ~21M blocks deep, so the fromBlock:0 queries this app was built on always
   fail. Blockscout is an indexer with no such limit and returns block_timestamp
   with each log, which also removes the per-log getBlock round-trip. */
type BsLog = { topics: string[]; data: string; block: number; tx: string; ts: number };
const bsCache = new Map<string, Promise<BsLog[]>>();
function bsLogs(address: string): Promise<BsLog[]> {
  const key = address.toLowerCase();
  if (!bsCache.has(key)) {
    bsCache.set(key, (async () => {
      // Our own server keeps these logs warm in a 60s cache; Blockscout itself
      // takes 4–14s. Go via the server first and only fall back to the
      // explorer if it's unreachable (or the app is served from elsewhere).
      try {
        const r = await fetch(`/api/logs/${key}`);
        if (r.ok) {
          const j: any = await r.json();
          if (Array.isArray(j.logs)) return j.logs as BsLog[];
        }
      } catch { /* fall through to the explorer */ }
      try {
        const r = await fetch(`${EXP}/api/v2/addresses/${key}/logs`);
        if (!r.ok) throw new Error(String(r.status));
        const j: any = await r.json();
        return (j.items || []).map((it: any) => ({
          topics: it.topics || [],
          data: it.data ?? "0x",
          block: Number(it.block_number),
          tx: it.transaction_hash || it.tx_hash,
          ts: it.block_timestamp ? Math.floor(new Date(it.block_timestamp).getTime() / 1000) : 0,
        }));
      } catch { bsCache.delete(key); return []; }   // let the next call retry
    })());
  }
  return bsCache.get(key)!;
}
/** Logs of one event type, with the id from topics[1] (all three events index id first). */
async function eventLogs(address: string, topic0: string): Promise<(BsLog & { id: number })[]> {
  const all = await bsLogs(address);
  return all
    .filter((l) => (l.topics[0] || "").toLowerCase() === topic0.toLowerCase())
    .map((l) => ({ ...l, id: Number(BigInt(l.topics[1] || "0x0")) }));
}
const TOPIC_LOCKED = keccak256(toHex("Locked(uint256,address,address,uint256,uint256)"));
const TOPIC_BURNED = keccak256(toHex("Burned(uint256,address,address,uint256)"));
const TOPIC_VESTING_CREATED = keccak256(toHex("VestingCreated(uint256,address,address,address,uint256,uint64,uint64,uint64)"));

/* burns: id → tx via Burned-eventet */
type BurnedLog = { id: number; tx: string };
let burnedLogsPromise: Promise<BurnedLog[]> | null = null;
function loadBurnedLogs(): Promise<BurnedLog[]> {
  if (!burnedLogsPromise) {
    burnedLogsPromise = (async () => {
      if (!BURNER) return [];
      try {
        return (await eventLogs(BURNER, TOPIC_BURNED)).map((l) => ({ id: l.id, tx: l.tx }));
      } catch { burnedLogsPromise = null; return []; }
    })();
  }
  return burnedLogsPromise;
}
// Resolve a burn's tx hash reliably. The hash only exists in the Burned event, so a
// flaky RPC read must NOT hide the confirm button. Strategy: permanent cache → shared
// logs → targeted, retried lookup filtered to this one indexed id (cheap + robust).
// Returns null ONLY if the burn genuinely has no event (then the button is hidden).
const burnTxCache = new Map<number, string>();
async function txForBurn(id: number): Promise<string | null> {
  if (burnTxCache.has(id)) return burnTxCache.get(id)!;
  if (!BURNER) return null;
  try {
    const logs = await loadBurnedLogs();
    const hit = logs.find((l) => l.id === id);
    if (hit) { burnTxCache.set(id, hit.tx); return hit.tx; }
  } catch { /* fall through to the targeted lookup */ }
  for (let a = 0; a < 3; a++) {
    try {
      bsCache.delete(BURNER.toLowerCase());          // force a fresh read
      const hit = (await eventLogs(BURNER, TOPIC_BURNED)).find((l) => l.id === id);
      if (hit) { burnTxCache.set(id, hit.tx); return hit.tx; }
      return null; // read succeeded, no such burn → genuinely none
    } catch { await new Promise((r) => setTimeout(r, 500 * (a + 1))); }
  }
  return null;
}

type BurnRow = { id: number; burner: string; token: string; amount: bigint; timestamp: number };
async function readBurn(id: number): Promise<BurnRow> {
  const b: any = await pub.readContract({ address: BURNER!, abi: BURNER_ABI as any, functionName: "getBurn", args: [BigInt(id)] });
  return { id, burner: getAddress(b.burner), token: getAddress(b.token), amount: b.amount as bigint, timestamp: Number(b.timestamp) };
}
// the dead address the burner sends tokens to (read once from the contract)
let deadAddrCache: string | null = null;
async function deadAddress(): Promise<string> {
  if (deadAddrCache) return deadAddrCache;
  try { deadAddrCache = getAddress(await pub.readContract({ address: BURNER!, abi: BURNER_ABI as any, functionName: "DEAD" }) as string); }
  catch { deadAddrCache = "0x000000000000000000000000000000000000dEaD"; }
  return deadAddrCache;
}
// % of a token's total supply that a given amount represents (for lock/burn proofs)
async function supplyPct(token: string, amount: bigint): Promise<string> {
  try {
    const supply = await pub.readContract({ address: token as `0x${string}`, abi: ERC20, functionName: "totalSupply" }) as bigint;
    if (supply > 0n) return (Number((amount * 10n ** 10n) / supply) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "% of total supply";
  } catch { /* optional */ }
  return "";
}

// One atomic promise per event type — concurrent renders await the SAME fetch.
type LockedLog = { id: number; owner: string; token: string; amount: bigint; unlockTime: number; tx: string; block: bigint; ts: number };
let lockedLogsPromise: Promise<LockedLog[]> | null = null;
function loadLockedLogs(): Promise<LockedLog[]> {
  if (!lockedLogsPromise) {
    lockedLogsPromise = (async () => {
      try {
        // Locked(id indexed, owner indexed, token indexed, amount, unlockTime)
        return (await eventLogs(LOCKER, TOPIC_LOCKED)).map((l) => ({
          id: l.id,
          owner: getAddress("0x" + (l.topics[2] || "").slice(-40)),
          token: getAddress("0x" + (l.topics[3] || "").slice(-40)),
          amount: BigInt("0x" + (l.data.slice(2, 66) || "0")),
          unlockTime: Number(BigInt("0x" + (l.data.slice(66, 130) || "0"))),
          tx: l.tx, block: BigInt(l.block), ts: l.ts,
        })).sort((a, b) => (a.block < b.block ? -1 : 1));
      } catch { lockedLogsPromise = null; return []; }
    })();
  }
  return lockedLogsPromise;
}
function invalidateEvents() { lockedLogsPromise = null; burnedLogsPromise = null; bsCache.clear(); blockTsCache.clear(); }
// Same reliability contract as txForBurn: never hide the confirm button on a flaky read.
const lockTxCache = new Map<number, string>();
async function txForLock(id: number): Promise<string | null> {
  if (lockTxCache.has(id)) return lockTxCache.get(id)!;
  try {
    const logs = await loadLockedLogs();
    const hit = logs.find((l) => l.id === id);
    if (hit) { lockTxCache.set(id, hit.tx); return hit.tx; }
  } catch { /* fall through to the targeted lookup */ }
  for (let a = 0; a < 3; a++) {
    try {
      bsCache.delete(LOCKER.toLowerCase());          // force a fresh read
      const hit = (await eventLogs(LOCKER, TOPIC_LOCKED)).find((l) => l.id === id);
      if (hit) { lockTxCache.set(id, hit.tx); return hit.tx; }
      return null;
    } catch { await new Promise((r) => setTimeout(r, 500 * (a + 1))); }
  }
  return null;
}
async function lockedAtBlock(id: number): Promise<bigint | null> {
  const logs = await loadLockedLogs();
  const hit = logs.find((l) => l.id === id);
  return hit ? hit.block : null;
}
/** When a lock was created. Comes with the log now, so no extra round-trip. */
/* A lock's creation time never changes, so persist it. The Blockscout log read
   it otherwise depends on takes ~3s, and Explore had to wait on that before it
   could sort a single row — now only locks it has never seen do. */
let lockTsMemo: Record<string, number> | null = null;
function lockTsStore(): Record<string, number> {
  if (!lockTsMemo) {
    try { lockTsMemo = JSON.parse(localStorage.getItem("hl_lockts") || "{}"); } catch { lockTsMemo = {}; }
  }
  return lockTsMemo!;
}
async function lockedAtTs(id: number): Promise<number | null> {
  const store = lockTsStore();
  if (store[id]) return store[id];
  const hit = (await loadLockedLogs()).find((l) => l.id === id);
  const ts = hit?.ts || (hit ? await blockTs(hit.block) : null);  // pre-Blockscout logs carry ts 0
  if (ts) {
    store[id] = ts;
    try { localStorage.setItem("hl_lockts", JSON.stringify(store)); } catch { /* quota — memory cache still helps */ }
  }
  return ts;
}
// block → timestamp cache
const blockTsCache = new Map<string, number>();
async function blockTs(bn: bigint): Promise<number | null> {
  const k = bn.toString();
  if (blockTsCache.has(k)) return blockTsCache.get(k)!;
  try {
    const b = await pub.getBlock({ blockNumber: bn });
    const ts = Number(b.timestamp);
    blockTsCache.set(k, ts); return ts;
  } catch { return null; }
}
const metaCache = new Map<string, { symbol: string; decimals: number }>();
/* metaCache fylls först efter läsningen, så en tabell med samma token på flera
   rader startade ett uppslag per rad. Dela det pågående i stället. */
const metaInflight = new Map<string, Promise<{ symbol: string; decimals: number }>>();
function tokMeta(addr: string) {
  const cached = metaCache.get(addr);
  if (cached) return Promise.resolve(cached);
  const running = metaInflight.get(addr);
  if (running) return running;
  const p = readTokMeta(addr).finally(() => metaInflight.delete(addr));
  metaInflight.set(addr, p);
  return p;
}
/* Every Uniswap v2 pair token is called "UNI-V2", so an LP lock displayed as
   "$UNI-V2" tells a holder nothing about which pool was locked. Resolving the
   two sides turns it into something readable. */
const PAIR_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
async function pairLabel(addr: string): Promise<string | null> {
  try {
    const [t0, t1] = await Promise.all([
      pub.readContract({ address: addr as `0x${string}`, abi: PAIR_ABI, functionName: "token0" }),
      pub.readContract({ address: addr as `0x${string}`, abi: PAIR_ABI, functionName: "token1" }),
    ]);
    const [s0, s1] = await Promise.all([
      pub.readContract({ address: t0 as `0x${string}`, abi: ERC20, functionName: "symbol" }).catch(() => null),
      pub.readContract({ address: t1 as `0x${string}`, abi: ERC20, functionName: "symbol" }).catch(() => null),
    ]);
    return s0 && s1 ? `${s0}/${s1} LP` : null;
  } catch { return null; }   // not a pair, which is the common case
}

async function readTokMeta(addr: string) {
  try {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "symbol" }),
      pub.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "decimals" }),
    ]);
    let sym = String(symbol);
    if (/^UNI-V2$/i.test(sym) || /^SLP$/i.test(sym)) sym = (await pairLabel(addr)) || sym;
    const m = { symbol: sym, decimals: Number(decimals) };
    metaCache.set(addr, m); // cache VERIFIED reads only
    return m;
  } catch {
    // Transient RPC failure (the public Robinhood RPC rate-limits) — show the
    // fallback for this render but do NOT cache it, so the next render retries
    // instead of the token being stuck as "$TOKEN" for the whole session.
    return { symbol: "TOKEN", decimals: 18 };
  }
}

/* ---------- per-token USD-pris (cache för tabellrader) ---------- */
const priceCache = new Map<string, Promise<number | null>>();
function priceUsdFor(token: string, decimals: number): Promise<number | null> {
  const k = token.toLowerCase();
  if (!priceCache.has(k)) priceCache.set(k, tokenPriceUsd(pub as any, token as `0x${string}`, decimals).catch(() => null));
  return priceCache.get(k)!;
}

/* ---------- table rendering ---------- */
async function lockRowHTML(l: LockRow, mine: boolean, variant: "mine" | "explore" = "mine"): Promise<string> {
  const m = await tokMeta(l.token);
  const now = Math.floor(Date.now() / 1000);
  const unlocked = now >= l.unlockTime;
  // progress toward unlock, from the Locked event's block timestamp
  let pct = unlocked ? 100 : 50;
  if (!unlocked) {
    const t0 = await lockedAtTs(l.id);
    if (t0 !== null && l.unlockTime > t0) pct = Math.min(99, Math.max(1, Math.round(((now - t0) / (l.unlockTime - t0)) * 100)));
  }
  const status = l.withdrawn
    ? `<span class="status withdrawn"><i></i>WITHDRAWN</span>`
    : unlocked
      ? `<span class="status unlockable"><i></i>UNLOCKED</span>`
      : `<span class="status locked"><i></i>LOCKED · ${remainingLabel(l.unlockTime - now).toUpperCase()}</span>`;
  const acts: string[] = [];
  if (mine && !l.withdrawn && unlocked) acts.push(`<button class="btn btn-neon btn-sm" data-withdraw="${l.id}">Withdraw</button>`);
  if (mine && !l.withdrawn) acts.push(`<button class="btn btn-line btn-sm" data-extend="${l.id}">Extend</button>`);
  acts.push(`<button class="btn btn-line btn-sm" data-share="${l.id}">Share</button>`);
  const sym = escape(m.symbol);
  if (variant === "explore") {
    const v = l.withdrawn ? null : await amountValueUsd(pub as any, l.token as `0x${string}`, l.amount, m.decimals).catch(() => null);
    const tvl = v !== null && v > 0 ? fmtUsd(v) : "—";
    return `<tr data-proof="${l.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(l.token, m.symbol)}
      <div><div class="n">$${sym} <span class="tag">#${l.id}</span></div><div class="a">${short(l.token)}</div></div></div></td>
    <td>${fmtNum(l.amount, m.decimals)}</td>
    <td>${dateLabel(l.unlockTime)}</td>
    <td>${tvl}</td>
    <td>${status}</td>
    <td><div class="row-actions">${acts.join("")}</div></td></tr>`;
  }
  return `<tr data-proof="${l.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(l.token, m.symbol)}
      <div><div class="n">$${sym} <span class="tag">#${l.id}</span></div><div class="a">${short(l.token)}</div></div></div></td>
    <td>${fmtNum(l.amount, m.decimals)}</td>
    <td class="addr">${short(l.owner)}</td>
    <td>${dateLabel(l.unlockTime)}</td>
    <td><div class="prog"><div class="pb"><div class="pf" style="width:${l.withdrawn ? 100 : pct}%"></div></div>
      <div class="pl"><span>${l.withdrawn ? 100 : pct}%</span><span>${unlocked ? "UNLOCKED" : "LOCKED"}</span></div></div></td>
    <td>${status}</td>
    <td><div class="row-actions">${acts.join("")}</div></td></tr>`;
}
const TABLE_HEAD = `<thead><tr><th>Token</th><th>Amount</th><th>Owner</th><th>Unlocks</th><th>Progress</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>`;
const TABLE_HEAD_EXPLORE = `<thead><tr><th>Token</th><th>Amount</th><th>Unlocks</th><th>TVL</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>`;
async function renderTable(box: HTMLElement, rows: LockRow[], mine: boolean, emptyBig: string, emptySmall: string, variant: "mine" | "explore" = "mine") {
  if (!rows.length) { box.innerHTML = `<div class="empty"><div class="big">${emptyBig}</div><div class="small">${emptySmall}</div></div>`; return; }
  const html = (await Promise.all(rows.map((r) => lockRowHTML(r, mine, variant)))).join("");
  box.innerHTML = `<table>${variant === "explore" ? TABLE_HEAD_EXPLORE : TABLE_HEAD}<tbody>${html}</tbody></table>`;
  wireActions(box);
}
function wireActions(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>("[data-proof]").forEach((tr) => tr.addEventListener("click", () => showLockProof(Number(tr.dataset.proof))));
  container.querySelectorAll<HTMLButtonElement>("[data-withdraw]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); withdraw(Number(b.dataset.withdraw)); }));
  container.querySelectorAll<HTMLButtonElement>("[data-extend]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); extend(Number(b.dataset.extend)); }));
  container.querySelectorAll<HTMLButtonElement>("[data-share]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const url = `${location.origin}/proof/lock/${b.dataset.share}`;
    try { await navigator.clipboard.writeText(url); notify("Proof link copied — share it anywhere"); }
    catch { prompt("Copy this proof link:", url); }
  }));
  container.querySelectorAll<HTMLElement>("[data-proofburn]").forEach((tr) => tr.addEventListener("click", () => showBurnProof(Number(tr.dataset.proofburn))));
  container.querySelectorAll<HTMLButtonElement>("[data-shareburn]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const url = `${location.origin}/proof/burn/${b.dataset.shareburn}`;
    try { await navigator.clipboard.writeText(url); notify("Burn proof link copied — share it anywhere"); }
    catch { prompt("Copy this proof link:", url); }
  }));
}

/* ---------- burn rows ---------- */
async function burnRowHTML(b: BurnRow, variant: "mine" | "explore" = "mine"): Promise<string> {
  const m2 = await tokMeta(b.token);
  const sym = escape(m2.symbol);
  if (variant === "explore") {
    const v = await amountValueUsd(pub as any, b.token as `0x${string}`, b.amount, m2.decimals).catch(() => null);
    const tvl = v !== null && v > 0 ? fmtUsd(v) : "—";
    return `<tr data-proofburn="${b.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(b.token, m2.symbol)}
      <div><div class="n">$${sym} <span class="tag" style="color:#ff8a8a;background:rgba(255,107,107,.08);border-color:rgba(255,107,107,.25)">BURN #${b.id}</span></div><div class="a">${short(b.token)}</div></div></div></td>
    <td>${fmtNum(b.amount, m2.decimals)}</td>
    <td>${dateLabel(b.timestamp)}</td>
    <td>${tvl}</td>
    <td><span class="status burned"><i></i>BURNED FOREVER</span></td>
    <td><div class="row-actions"><button class="btn btn-line btn-sm" data-shareburn="${b.id}">Share</button></div></td></tr>`;
  }
  return `<tr data-proofburn="${b.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(b.token, m2.symbol)}
      <div><div class="n">$${sym} <span class="tag" style="color:#ff8a8a;background:rgba(255,107,107,.08);border-color:rgba(255,107,107,.25)">BURN #${b.id}</span></div><div class="a">${short(b.token)}</div></div></div></td>
    <td>${fmtNum(b.amount, m2.decimals)}</td>
    <td class="addr">${short(b.burner)}</td>
    <td>${dateLabel(b.timestamp)}</td>
    <td><div class="prog"><div class="pb"><div class="pf" style="width:100%;background:linear-gradient(90deg,#c73a32,#ff6b6b)"></div></div>
      <div class="pl"><span>100%</span><span>BURNED</span></div></div></td>
    <td><span class="status burned"><i></i>BURNED FOREVER</span></td>
    <td><div class="row-actions"><button class="btn btn-line btn-sm" data-shareburn="${b.id}">Share</button></div></td></tr>`;
}
async function burnsTableHTML(burns: BurnRow[], heading: string, variant: "mine" | "explore" = "mine"): Promise<string> {
  if (!burns.length) return "";
  const rows = (await Promise.all(burns.map((b) => burnRowHTML(b, variant)))).join("");
  return `<div style="font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#ff8a8a;margin:20px 0 4px">${heading}</div>
    <table>${variant === "explore" ? TABLE_HEAD_EXPLORE : TABLE_HEAD}<tbody>${rows}</tbody></table>`;
}

/* ---------- my locks ---------- */
async function renderMine() {
  // yourLocksBox lived on the old stats dashboard — filter so only real boxes are touched
  const boxes = [document.getElementById("yourLocksBox"), document.getElementById("myLocksBox")]
    .filter((b): b is HTMLElement => !!b);
  if (!account) {
    boxes.forEach((b) => b.innerHTML = `<div class="empty"><div class="big">No wallet connected</div><div class="small">Connect your wallet to see and manage your locks.</div></div>`);
    return;
  }
  boxes.forEach((b) => b.innerHTML = `<div class="empty"><div class="small">Loading your locks… <span class="spin"></span></div></div>`);
  try {
    const [ids, burnIds] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByOwner", args: [account as `0x${string}`] }) as Promise<bigint[]>,
      BURNER
        ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByBurner", args: [account as `0x${string}`] }) as Promise<bigint[]>).catch(() => [] as bigint[])
        : Promise.resolve([] as bigint[]),
    ]);
    document.getElementById("yourLocksSub")?.replaceChildren(`${ids.length} LOCK${ids.length === 1 ? "" : "S"}${burnIds.length ? ` · ${burnIds.length} BURN${burnIds.length === 1 ? "" : "S"}` : ""} · ${short(account).toUpperCase()}`);
    const rows = (await Promise.all(ids.map((i) => readLock(Number(i))))).reverse();
    const burns = (await Promise.all(burnIds.map((i) => readBurn(Number(i))))).reverse();
    const burnsHTML = await burnsTableHTML(burns, "My burns — destroyed forever");
    for (const b of boxes) {
      if (!rows.length && !burns.length) {
        b.innerHTML = `<div class="empty"><div class="big">No locks yet</div><div class="small">Create your first lock — it takes under a minute.</div></div>`;
        continue;
      }
      const lockHTML = rows.length ? `<table>${TABLE_HEAD}<tbody>${(await Promise.all(rows.map((r) => lockRowHTML(r, true)))).join("")}</tbody></table>` : "";
      b.innerHTML = lockHTML + burnsHTML;
      wireActions(b);
    }
  } catch {
    boxes.forEach((b) => b.innerHTML = `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">Check your connection and try again.</div></div>`);
  }
}

/* ---------- withdraw / extend ---------- */
async function withdraw(id: number) {
  try {
    const h = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "withdraw", args: [BigInt(id)] }));
    notify("Withdrawing — confirm in wallet, then wait for the tx…");
    await waitTx(h);
    notify("Withdrawn ✓"); renderMine(); exploreLoaded = false;
  } catch (e: any) { alert(e?.shortMessage || e?.message || "Withdraw failed"); }
}
let extendId = -1, extendBase = 0;
async function extend(id: number) {
  const l = await readLock(id);
  const nowSec = Math.floor(Date.now() / 1000);
  extendId = id; extendBase = Math.max(l.unlockTime, nowSec);
  const when = dateTimeUTC(l.unlockTime);
  $("extendCurrent").innerHTML = nowSec >= l.unlockTime
    ? `Lock <b>#${id}</b> unlocked on <b>${when}</b>. Pick a future date to re-lock it instead of withdrawing.`
    : `Lock <b>#${id}</b> currently unlocks <b>${when}</b>. Pick a later date — a lock can only be extended, never shortened.`;
  ($("extendDate") as HTMLInputElement).value = toLocalInput(new Date((extendBase + 30 * 86400) * 1000));
  ($("extendDate") as HTMLInputElement).min = toLocalInput(new Date((extendBase + 60) * 1000));
  const msg = $("extendMsg"); msg.textContent = ""; msg.className = "msg";
  document.querySelectorAll("#extendPresets .chip-dur").forEach((c) => c.classList.remove("on"));
  $("extendModal").classList.add("show");
}
$("extendClose").addEventListener("click", () => $("extendModal").classList.remove("show"));
$("extendCancel").addEventListener("click", () => $("extendModal").classList.remove("show"));
$("extendModal").addEventListener("click", (e) => { if (e.target === $("extendModal")) $("extendModal").classList.remove("show"); });
$("extendConfirm").addEventListener("click", async () => {
  const msg = $("extendMsg"); msg.className = "msg";
  const dt = ($("extendDate") as HTMLInputElement).value;
  if (!dt) { msg.className = "msg bad"; msg.textContent = "Pick a date."; return; }
  const t = Math.floor(new Date(dt).getTime() / 1000);
  if (t <= extendBase) { msg.className = "msg bad"; msg.textContent = "Must be later than the current unlock time."; return; }
  const btn = $("extendConfirm") as HTMLButtonElement;
  try {
    btn.disabled = true; msg.textContent = "Confirm in wallet…";
    const h = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "extend", args: [BigInt(extendId), BigInt(t)] }));
    msg.innerHTML = `Extending… <span class="spin"></span>`; await waitTx(h);
    $("extendModal").classList.remove("show");
    notify("Lock extended ✓"); renderMine(); exploreLoaded = false;
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = e?.shortMessage || e?.message || "Extend failed"; }
  finally { btn.disabled = false; }
});

/* ---------- explore ---------- */
let exploreLoaded = false;
// Merge locks + burns into ONE explore table, newest first (burns show exactly like
// locks — same columns, sorted by creation time alongside them).
async function buildExploreRows(lockRows: LockRow[], burnRows: BurnRow[], limit = 25): Promise<string> {
  const lockItems = await Promise.all(lockRows.map(async (l) => {
    const ts = (await lockedAtTs(l.id)) ?? 0;
    return { ts, render: () => lockRowHTML(l, false, "explore") };
  }));
  const burnItems = burnRows.map((b) => ({ ts: b.timestamp, render: () => burnRowHTML(b, "explore") }));
  const items = [...lockItems, ...burnItems].sort((a, b) => b.ts - a.ts).slice(0, limit);
  return (await Promise.all(items.map((it) => it.render()))).join("");
}
async function loadExplore() {
  const box = $("exploreBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading latest activity… <span class="spin"></span></div></div>`;
  // Lock timestamps come from Blockscout and that call alone takes ~3s, so
  // start it now rather than partway through building the rows.
  loadLockedLogs().catch(() => []);
  try {
    const [totalLocks, totalBurns, totalVests] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }).then(Number),
      BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "totalBurns" }).then(Number).catch(() => 0)) : Promise.resolve(0),
      VESTING ? (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "totalSchedules" }).then(Number).catch(() => 0)) : Promise.resolve(0),
    ]);
    if (!totalLocks && !totalBurns && !totalVests) { box.innerHTML = `<div class="empty"><div class="big">Nothing yet</div><div class="small">Be the first to lock, burn or vest on Robinhood Chain.</div></div>`; exploreLoaded = true; return; }
    const lockIds: number[] = []; for (let i = totalLocks - 1; i >= 0 && lockIds.length < 25; i--) lockIds.push(i);
    const burnIds: number[] = []; for (let i = totalBurns - 1; i >= 0 && burnIds.length < 25; i--) burnIds.push(i);
    const vestIds: number[] = []; for (let i = totalVests - 1; i >= 0 && vestIds.length < 25; i--) vestIds.push(i);
    const [lockRows, burnRows, vestRows] = await Promise.all([
      Promise.all(lockIds.map(readLock)),
      Promise.all(burnIds.map(readBurn)),
      Promise.all(vestIds.map((i) => readVest(i).catch(() => null))),
    ]);
    const vests = vestRows.filter((v): v is VestRow => !!v);
    // One table, one look: vesting rows share the explore columns with locks/burns.
    // Both halves read token metadata and prices, so build them together —
    // waiting for the vesting rows first doubled the time to first render.
    const [vestRowsHTML, lockBurnHTML] = await Promise.all([
      Promise.all(vests.map(vestExploreRowHTML)).then((r) => r.join("")),
      buildExploreRows(lockRows, burnRows),
    ]);
    box.innerHTML = `<table>${TABLE_HEAD_EXPLORE}<tbody>${vestRowsHTML}${lockBurnHTML}</tbody></table>`;
    wireActions(box); wireVestActions(box);
    exploreLoaded = true;
  } catch {
    box.innerHTML = `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">Check your connection and try again.</div></div>`;
  }
}
async function runSearch() {
  const box = $("exploreBox");
  const raw = ($("searchAddr") as HTMLInputElement).value.trim();
  if (!raw) return loadExplore();
  if (!isAddress(raw)) { box.innerHTML = `<div class="empty"><div class="big">Not an address</div><div class="small">Paste a token / LP contract or a wallet address (0x…).</div></div>`; return; }
  box.innerHTML = `<div class="empty"><div class="small">Searching… <span class="spin"></span></div></div>`;
  try {
    const addr = getAddress(raw);
    // a search matches locks OF this token, locks BY this wallet — and burns for both
    const [byToken, byOwner, burnsTok, burnsBy] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByToken", args: [addr] }) as Promise<bigint[]>,
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByOwner", args: [addr] }) as Promise<bigint[]>,
      BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByToken", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]) : Promise.resolve([] as bigint[]),
      BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByBurner", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]) : Promise.resolve([] as bigint[]),
    ]);
    // …and vesting schedules for the token, the recipient, or the creator
    const [vestTok, vestBen, vestCre] = VESTING
      ? await Promise.all([
          (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByToken", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]),
          (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByBeneficiary", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]),
          (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByCreator", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]),
        ])
      : [[], [], []] as bigint[][];
    const ids = [...new Set([...byToken, ...byOwner].map(Number))];
    const burnIds = [...new Set([...burnsTok, ...burnsBy].map(Number))];
    const vestIds = [...new Set([...vestTok, ...vestBen, ...vestCre].map(Number))];
    if (!ids.length && !burnIds.length && !vestIds.length) { box.innerHTML = `<div class="empty"><div class="big">No locks found</div><div class="small">Nothing locked, burned or vesting for this token or wallet yet.</div></div>`; return; }
    const rows = await Promise.all(ids.map(readLock));
    const burns = await Promise.all(burnIds.map(readBurn));
    const merged = await buildExploreRows(rows, burns, 100);
    let vestRowsHTML = "";
    if (vestIds.length) {
      const vrows = (await Promise.all(vestIds.map((i) => readVest(i).catch(() => null)))).filter((v): v is VestRow => !!v).reverse();
      vestRowsHTML = (await Promise.all(vrows.slice(0, 50).map(vestExploreRowHTML))).join("");
    }
    const combined = vestRowsHTML + (merged || "");
    box.innerHTML = combined ? `<table>${TABLE_HEAD_EXPLORE}<tbody>${combined}</tbody></table>` : `<div class="empty"><div class="big">No locks found</div><div class="small"></div></div>`;
    wireActions(box); wireVestActions(box);
  } catch {
    box.innerHTML = `<div class="empty"><div class="big">Search failed</div><div class="small">Couldn't reach Robinhood Chain — try again.</div></div>`;
  }
}
$("searchBtn").addEventListener("click", runSearch);
$("searchAddr").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runSearch(); });

/* ---------- shareable proof (/proof/lock/<id>) — works without a wallet ---------- */
async function showLockProof(id: number, push = true) {
  loadTokenPages();
  go("proof");
  if (push) history.pushState(null, "", `/proof/lock/${id}`);
  else history.replaceState(null, "", `/proof/lock/${id}`);
  const box = $("proofBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading lock #${id}… <span class="spin"></span></div></div>`;
  let l: LockRow;
  try { l = await readLock(id); } catch { box.innerHTML = `<div class="empty"><div class="big">Lock #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`; return; }
  const m = await tokMeta(l.token);
  const tx = await txForLock(id);
  const now = Math.floor(Date.now() / 1000);
  const unlocked = now >= l.unlockTime;
  const statusHTML = l.withdrawn
    ? `<span class="status withdrawn"><i></i>WITHDRAWN</span>`
    : unlocked ? `<span class="status unlockable"><i></i>UNLOCKED</span>`
    : `<span class="status locked"><i></i>LOCKED · ${remainingLabel(l.unlockTime - now).toUpperCase()} LEFT</span>`;
  const pct = await supplyPct(l.token, l.amount);
  box.innerHTML = `
    <div class="proof-card">
      <span class="stamp">✓ ON-CHAIN PROOF</span>
      <div class="proof-amt">${fmtNum(l.amount, m.decimals)} $${escape(m.symbol)}</div>
      <div class="proof-sub">HOODLOCK · LOCK #${id} · ROBINHOOD CHAIN 4663</div>
      <div class="p-row"><span class="k">Status</span><span class="v">${statusHTML}</span></div>
      ${pct ? `<div class="p-row"><span class="k">Share of supply</span><span class="v g">${pct} locked</span></div>` : ""}
      <div class="p-row"><span class="k">Token</span><span class="v mono">${l.token}</span></div>
      <div class="p-row"><span class="k">Owner</span><span class="v mono">${l.owner}</span></div>
      <div class="p-row"><span class="k">Unlocks</span><span class="v">${dateTimeUTC(l.unlockTime)}</span></div>
      <div class="p-row"><span class="k">Guarantee</span><span class="v g">extend-only · owner-only withdrawal</span></div>
      <div class="p-acts">
        ${tx ? `<a class="btn btn-neon" href="${EXP}/tx/${tx}" target="_blank" rel="noopener">✔ Confirm the lock transaction on Blockscout</a>` : ""}
        <a class="btn btn-line" href="${EXP}/address/${LOCKER}?tab=contract" target="_blank" rel="noopener">Read the verified locker contract</a>
        <button class="btn btn-line" id="proofCopy">Copy proof link</button>
      </div>
    </div>
    ${tokenPageLine(l.token, m.symbol)}
    <a class="p-back" href="/app">← Open HoodLock</a>`;
  $("proofCopy").addEventListener("click", async () => {
    const url = `${location.origin}/proof/lock/${id}`;
    try { await navigator.clipboard.writeText(url); notify("Proof link copied"); } catch { prompt("Copy this proof link:", url); }
  });
}

/* ---------- shareable burn proof (/proof/burn/<id>) — works without a wallet ---------- */
async function showBurnProof(id: number, push = true) {
  loadTokenPages();
  go("proof");
  $("viewTitle").textContent = "BURN PROOF";
  if (push) history.pushState(null, "", `/proof/burn/${id}`);
  else history.replaceState(null, "", `/proof/burn/${id}`);
  const box = $("proofBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading burn #${id}… <span class="spin"></span></div></div>`;
  let b: BurnRow;
  try {
    b = await readBurn(id);
    if (!b.timestamp) throw new Error("empty");   // getBurn returns zeros for unknown ids
  } catch { box.innerHTML = `<div class="empty"><div class="big">Burn #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`; return; }
  const m2 = await tokMeta(b.token);
  const tx = await txForBurn(id);
  const pct = await supplyPct(b.token, b.amount);
  box.innerHTML = `
    <div class="proof-card">
      <span class="stamp burn">🔥 BURNED FOREVER</span>
      <div class="proof-amt">${fmtNum(b.amount, m2.decimals)} $${escape(m2.symbol)}</div>
      <div class="proof-sub">HOODLOCK · BURN #${id} · ROBINHOOD CHAIN 4663</div>
      <div class="p-row"><span class="k">Status</span><span class="v"><span class="status burned"><i></i>BURNED FOREVER</span></span></div>
      ${pct ? `<div class="p-row"><span class="k">Share of supply</span><span class="v" style="color:#ff8a8a">${pct}</span></div>` : ""}
      <div class="p-row"><span class="k">Token</span><span class="v mono">${b.token}</span></div>
      <div class="p-row"><span class="k">Burned by</span><span class="v mono">${b.burner}</span></div>
      <div class="p-row"><span class="k">Burned at</span><span class="v">${dateTimeUTC(b.timestamp)}</span></div>
      <div class="p-row"><span class="k">Guarantee</span><span class="v" style="color:#ff6b6b">burned forever</span></div>
      <div class="p-acts">
        ${tx ? `<a class="btn btn-neon" href="${EXP}/tx/${tx}" target="_blank" rel="noopener">✔ Confirm the burn transaction on Blockscout</a>` : ""}
        <a class="btn btn-line" href="${EXP}/address/${BURNER}?tab=contract" target="_blank" rel="noopener">Read the verified burner contract</a>
        <button class="btn btn-line" id="proofCopy">Copy proof link</button>
      </div>
    </div>
    ${tokenPageLine(b.token, m2.symbol)}
    <a class="p-back" href="/app">← Open HoodLock</a>`;
  $("proofCopy").addEventListener("click", async () => {
    const url = `${location.origin}/proof/burn/${id}`;
    try { await navigator.clipboard.writeText(url); notify("Burn proof link copied"); } catch { prompt("Copy this proof link:", url); }
  });
}

/* dashboard is now a product launcher (see #view-dashboard) — the stats,
   chart and activity feed that lived here were removed with it. */

/* ---------- TVL (klientside, djup-kapad — se tvl.ts) ---------- */
// loadTvl() removed with the stats dashboard — the admin console computes
// its own TVL directly via computeTvl().

/* ---------- bakåt/framåt i historiken ---------- */
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  const lock = q.get("lock"), burn = q.get("burn");
  if (lock && /^\d+$/.test(lock)) { showLockProof(Number(lock), false); return; }
  if (burn && /^\d+$/.test(burn) && BURNER) { showBurnProof(Number(burn), false); return; }
  const v = location.pathname.match(/^\/app\/([a-z]+)/)?.[1];
  go(v && TITLES[v] ? v : "dashboard", false);
});

/* ================= PUBLIC AFFILIATE PROGRAM ================= */
function cachedAffToken(): string | null {
  try { const t = localStorage.getItem("hl_afftok"), e = Number(localStorage.getItem("hl_affexp")); return t && e > Date.now() + 5000 ? t : null; } catch { return null; }
}
// Authed affiliate/developer call that self-heals if the server session is gone
// (e.g. after a server restart wiped the in-memory session map): on 401 it clears the
// stale token, re-signs once, and retries — so users never see a dead "unauthorized".
async function affFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = cachedAffToken(); if (!token) token = await affSignIn();
  const withAuth = (t: string): RequestInit => ({ ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + t } });
  let r = await fetch(url, withAuth(token));
  if (r.status === 401) {
    try { localStorage.removeItem("hl_afftok"); localStorage.removeItem("hl_affexp"); } catch { /* */ }
    token = await affSignIn();
    r = await fetch(url, withAuth(token));
  }
  return r;
}
async function affSignIn(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await walletSign(`HoodLock affiliate ${ts}`);
  const r = await fetch("/api/aff/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account, ts, signature }) });
  if (!r.ok) throw new Error(await r.text());
  const { token, exp } = await r.json();
  try { localStorage.setItem("hl_afftok", token); localStorage.setItem("hl_affexp", String(exp)); } catch { /* */ }
  return token;
}
async function loadAffiliatePage() {
  const box = $("affBody");
  // default the hero rate to 30% for pre-dashboard states; the dashboard overrides with the real rate
  const heroRate = $("affHeroRate"); if (heroRate) heroRate.textContent = "30%";
  if (!account) {
    box.innerHTML = `<div class="card"><div class="empty"><div class="big">Connect your wallet</div><div class="small">Connect to create your referral link and track earnings.</div><button class="btn btn-neon btn-sm" id="affConnect" style="margin-top:12px">Connect Wallet</button></div></div>`;
    document.getElementById("affConnect")?.addEventListener("click", openWalletModal);
    return;
  }
  const token = cachedAffToken();
  if (!token) {
    box.innerHTML = `<div class="card"><div class="empty"><div class="big">Your affiliate dashboard</div><div class="small">Sign a message to open your dashboard. No transaction, it just proves this wallet is yours.</div><button class="btn btn-neon btn-sm" id="affSign" style="margin-top:12px">Sign in</button></div></div>`;
    document.getElementById("affSign")?.addEventListener("click", async () => { try { await affSignIn(); loadAffiliatePage(); } catch (e: any) { alert("Sign-in failed: " + (e?.message || e)); } });
    return;
  }
  box.innerHTML = `<div class="card"><div class="empty"><div class="small">Loading your dashboard… <span class="spin"></span></div></div></div>`;
  let me: any;
  try {
    const r = await fetch("/api/aff/me", { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { try { localStorage.removeItem("hl_afftok"); } catch { /* */ } return loadAffiliatePage(); }
    me = await r.json();
  } catch { box.innerHTML = `<div class="card"><div class="empty"><div class="small">Couldn't reach the affiliate service.</div></div></div>`; return; }
  if (!me.hasCode) return renderAffCreate();
  renderAffDashboard(me);
}
function renderAffCreate() {
  const box = $("affBody");
  box.innerHTML = `<div class="card">
    <div class="card-head"><div><h3>Create your affiliate link</h3><div class="sub">EARN 30% OF EVERY REFERRED LOCK FEE</div></div></div>
    <p class="hintline">Pick a code for your link, 3–20 characters</p>
    <div class="explore-bar">
      <div class="input-wrap"><span style="position:absolute;left:14px;color:var(--ink-3);font-family:var(--mono);font-size:12px;pointer-events:none">hoodlock.tech/r/</span><input type="text" id="affCode" placeholder="yourname" spellcheck="false" style="padding-left:150px" maxlength="20" /></div>
      <button class="btn btn-neon" id="affCreateBtn" style="padding:11px 22px" disabled>Create link</button>
    </div>
    <div class="hintline" id="affCodeHint"></div>
  </div>`;
  const input = $("affCode") as HTMLInputElement, btn = $("affCreateBtn") as HTMLButtonElement, hint = $("affCodeHint");
  const check = debounce(async () => {
    const code = input.value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,20}$/.test(code)) { hint.innerHTML = code ? `<span class="badv">Use 3–20 letters, numbers, - or _.</span>` : ""; btn.disabled = true; return; }
    try {
      const r = await (await fetch("/api/aff/available?code=" + encodeURIComponent(code))).json();
      hint.innerHTML = r.available ? `<span style="color:var(--neon)">✓ hoodlock.tech/r/${escape(code)} is available</span>` : `<span class="badv">${r.reason === "invalid" ? "That code isn't allowed." : "Already taken — try another."}</span>`;
      btn.disabled = !r.available;
    } catch { hint.textContent = ""; }
  }, 300);
  input.addEventListener("input", check);
  btn.addEventListener("click", async () => {
    const code = input.value.trim().toLowerCase();
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const r = await affFetch("/api/aff/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      notify("Affiliate link created"); loadAffiliatePage();
    } catch (e: any) { alert("Couldn't create: " + (e?.message || e)); btn.disabled = false; btn.textContent = "Create link"; }
  });
}
async function affLocksTable(me: any): Promise<string> {
  const attrMap = new Map<string, number>(me.attributions.map((a: any) => [a.wallet.toLowerCase(), a.ts]));
  const self = account.toLowerCase();
  const cut = me.commission * me.feeEth;
  const logs = await loadLockedLogs();
  const cand = logs.filter((l) => attrMap.has(l.owner.toLowerCase()) && l.owner.toLowerCase() !== self);
  const rows: string[] = [];
  for (const l of cand) {
    const ts = l.ts || await blockTs(l.block);
    if (ts === null || ts <= (attrMap.get(l.owner.toLowerCase()) as number)) continue;
    const mt = await tokMeta(l.token);
    rows.push(`<tr><td><div class="tk-cell">${await tokenIcoHTML(l.token, mt.symbol)}<div><div class="n">$${escape(mt.symbol)} <span class="tag">#${l.id}</span></div><div class="a">${short(l.owner)}</div></div></div></td>
      <td>${fmtNum(l.amount, mt.decimals)}</td><td>${dateLabel(ts)}</td><td>${me.feeEth} ETH</td>
      <td style="text-align:right;color:var(--neon)">+${cut.toFixed(4)} ETH</td></tr>`);
  }
  return rows.length
    ? `<table><thead><tr><th>Token</th><th>Amount</th><th>Locked</th><th>Fee</th><th style="text-align:right">Your ${Math.round((me.commission || 0) * 100)}%</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
    : `<div class="empty"><div class="small">No referred activity yet — share your link to start earning.</div></div>`;
}
async function renderAffDashboard(me: any) {
  const box = $("affBody");
  const heroRate = $("affHeroRate"); if (heroRate) heroRate.textContent = `${Math.round((me.commission || 0) * 100)}%`;
  const claimableUsd = me.claimableEth * (me.ethUsd || 0);
  const canClaim = me.ethUsd > 0 && claimableUsd >= me.minClaimUsd;
  const link = `${location.origin}/r/${me.code}`;
  const stTag = (s: string) => s === "paid" ? "unlockable" : s === "failed" ? "withdrawn" : "locked";
  box.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="card-head"><div><h3>Your link</h3><div class="sub">SHARE IT ANYWHERE</div></div></div>
      <div class="explore-bar"><div class="input-wrap"><input type="text" readonly value="${escape(link)}" /></div>
        <button class="btn btn-neon" id="affCopy" style="padding:11px 22px">Copy</button></div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Lifetime earnings</div><div class="v g">${me.lifetimeEarnedEth.toFixed(4)} ETH</div><div class="d">${me.ethUsd > 0 ? fmtUsd(me.lifetimeEarnedEth * me.ethUsd) : `${Math.round((me.commission || 0) * 100)}% of referred fees`}</div></div>
      <div class="tile"><div class="k">Claimable now</div><div class="v">${me.claimableEth.toFixed(4)} ETH</div><div class="d">${me.ethUsd > 0 ? fmtUsd(claimableUsd) : ""} · min $${me.minClaimUsd}</div></div>
      <div class="tile"><div class="k">Clicks</div><div class="v">${me.clicks.toLocaleString("en-US")}</div><div class="d">link visits</div></div>
      <div class="tile"><div class="k">Referred activity</div><div class="v">${me.qualifyingLocks.toLocaleString("en-US")}</div><div class="d">${(me.locksCount || 0)} locks · ${(me.burnsCount || 0)} burns · ${(me.vestsCount || 0)} vesting</div></div>
      <div class="tile"><div class="k">Commission rate</div><div class="v g">${Math.round((me.commission || 0) * 100)}%</div><div class="d">${(me.commission || 0) > 0.3 ? "boosted rate" : "your share per lock"}</div></div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-head"><div><h3>Claim earnings</h3><div class="sub">PAID IN ETH TO ${short(account).toUpperCase()}</div></div>
        <button class="btn btn-neon" id="affClaimBtn" ${canClaim ? "" : "disabled"}>Claim ${me.claimableEth.toFixed(4)} ETH</button></div>
      <div class="hintline" id="affClaimMsg">${canClaim ? "" : (me.claimableEth > 0 ? `You can claim once your balance reaches $${me.minClaimUsd}.` : "Earn from referred activity to unlock claiming.")}</div>
      ${me.claims && me.claims.length ? `<div class="tbl-scroll" style="margin-top:10px"><table><thead><tr><th>Amount</th><th>Status</th><th>Date</th><th style="text-align:right">Tx</th></tr></thead><tbody>${me.claims.map((c: any) => `<tr><td>${c.amount_eth.toFixed(4)} ETH</td><td><span class="status ${stTag(c.status)}"><i></i>${(c.status === "sent_unconfirmed" ? "processing" : c.status).toUpperCase()}</span></td><td>${dateLabel(c.paid_at || c.requested_at)}</td><td style="text-align:right">${/^0x[0-9a-fA-F]{64}$/.test(c.tx_hash || "") ? `<a href="${EXP}/tx/${encodeURIComponent(c.tx_hash)}" target="_blank" rel="noopener">view</a>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Referred locks</h3><div class="sub">LOCKS YOU EARNED FROM</div></div></div>
      <div class="tbl-scroll" id="affLocksBox"><div class="empty"><div class="small">Loading… <span class="spin"></span></div></div></div>
    </div>`;
  $("affCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(link); notify("Link copied — share it anywhere"); } catch { prompt("Copy your link:", link); } });
  if (canClaim) document.getElementById("affClaimBtn")?.addEventListener("click", () => claimEarnings(me));
  $("affLocksBox").innerHTML = await affLocksTable(me);
}
async function claimEarnings(me: any) {
  const btn = $("affClaimBtn") as HTMLButtonElement, msg = $("affClaimMsg");
  btn.disabled = true; btn.textContent = "Claiming…";
  try {
    const r = await affFetch("/api/aff/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "claim failed");
    if (d.status === "paid") { msg.innerHTML = `<span style="color:var(--neon)">Paid ${d.amount.toFixed(4)} ETH — <a href="${EXP}/tx/${d.tx}" target="_blank" rel="noopener">view tx</a></span>`; notify("Paid 🎉"); }
    else { msg.innerHTML = `<span style="color:var(--amber)">Claim received (${d.amount.toFixed(4)} ETH) — queued for payout, you'll receive it shortly.</span>`; notify("Claim queued"); }
    setTimeout(loadAffiliatePage, 2500);
  } catch (e: any) { msg.innerHTML = `<span class="badv">${escape(e?.message || String(e))}</span>`; btn.disabled = false; btn.textContent = `Claim ${me.claimableEth.toFixed(4)} ETH`; }
}

/* ---------- developers (embed + API, 50% revenue share) ---------- */
/* One script tag, one button per product. A launchpad wants all three at
   launch — lock the LP, burn a slice, vest the team — so the mode rides on
   the button rather than needing three integrations. */
function devSnippet(apiKey: string): string {
  const s = `<script src="${location.origin}/embed.js" data-key="${apiKey}"></scr` + `ipt>`;
  return `${s}\n\n` +
    `<!-- Add only the products you want. Each button works on its own. -->\n\n` +
    `<!-- Lock is the default mode, so this is the whole integration: -->\n` +
    `<button data-hoodlock>Lock tokens</button>\n\n` +
    `<!-- Pass a token address to pre-fill it and stop the user changing it.\n` +
    `     Insert it from your own data — it is different on every page: -->\n` +
    `<button data-hoodlock data-token="\${token.address}">Lock \${token.symbol}</button>\n\n` +
    `<button data-hoodlock data-mode="burn" data-token="\${token.address}">Burn tokens</button>\n\n` +
    `<button data-hoodlock data-mode="vesting" data-token="\${token.address}"\n` +
    `        data-beneficiary="\${teamWallet}">Create vesting</button>`;
}
async function loadDevelopersPage() {
  const box = $("devBody");
  if (!account) {
    box.innerHTML = `<div class="card"><div class="empty"><div class="big">Connect your wallet</div><div class="small">Connect to create your developer key and track earnings.</div><button class="btn btn-neon btn-sm" id="devConnect" style="margin-top:12px">Connect Wallet</button></div></div>`;
    document.getElementById("devConnect")?.addEventListener("click", openWalletModal);
    return;
  }
  const token = cachedAffToken();
  if (!token) {
    box.innerHTML = `<div class="card"><div class="empty"><div class="big">Your developer dashboard</div><div class="small">Sign a message to open your dashboard. No transaction, it just proves this wallet is yours.</div><button class="btn btn-neon btn-sm" id="devSign" style="margin-top:12px">Sign in</button></div></div>`;
    document.getElementById("devSign")?.addEventListener("click", async () => { try { await affSignIn(); loadDevelopersPage(); } catch (e: any) { alert("Sign-in failed: " + (e?.message || e)); } });
    return;
  }
  box.innerHTML = `<div class="card"><div class="empty"><div class="small">Loading your dashboard… <span class="spin"></span></div></div></div>`;
  let me: any;
  try {
    const r = await fetch("/api/aff/me", { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { try { localStorage.removeItem("hl_afftok"); } catch { /* */ } return loadDevelopersPage(); }
    me = await r.json();
  } catch { box.innerHTML = `<div class="card"><div class="empty"><div class="small">Couldn't reach the developer service.</div></div></div>`; return; }
  if (me.hasCode && me.kind === "developer") return renderDevDashboard(me);
  if (me.hasCode) { box.innerHTML = `<div class="card"><div class="empty"><div class="big">This wallet is an affiliate</div><div class="small">Wallet ${short(account)} is registered as an affiliate (<b>${escape(me.code)}</b>). Developer accounts use a separate wallet — connect another wallet to register as a developer.</div></div></div>`; return; }
  renderDevRegister();
}
function renderDevRegister() {
  const box = $("devBody");
  box.innerHTML = `<div class="card">
    <div class="card-head"><div><h3>Become a HoodLock Partner</h3><div class="sub">EARN 50% OF EVERY LOCK, BURN AND VESTING FEE YOUR APP GENERATES</div></div></div>
    <p class="hintline">Pick a developer handle. You'll get a public API key and an embed snippet covering locks, burns and vesting.</p>
    <div class="explore-bar">
      <div class="input-wrap"><input type="text" id="devCode" placeholder="your-app" spellcheck="false" maxlength="20" /></div>
      <button class="btn btn-neon" id="devCreateBtn" style="padding:11px 22px" disabled>Create developer key</button>
    </div>
    <div class="hintline" id="devCodeHint"></div>
  </div>`;
  const input = $("devCode") as HTMLInputElement, btn = $("devCreateBtn") as HTMLButtonElement, hint = $("devCodeHint");
  const check = debounce(async () => {
    const code = input.value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,20}$/.test(code)) { hint.innerHTML = code ? `<span class="badv">Use 3–20 letters, numbers, - or _.</span>` : ""; btn.disabled = true; return; }
    try {
      const r = await (await fetch("/api/aff/available?code=" + encodeURIComponent(code))).json();
      hint.innerHTML = r.available ? `<span style="color:var(--neon)">✓ ${escape(code)} is available</span>` : `<span class="badv">${r.reason === "invalid" ? "That handle isn't allowed." : "Already taken — try another."}</span>`;
      btn.disabled = !r.available;
    } catch { hint.textContent = ""; }
  }, 300);
  input.addEventListener("input", check);
  btn.addEventListener("click", async () => {
    const code = input.value.trim().toLowerCase();
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const r = await affFetch("/api/dev/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      notify("Developer key created"); loadDevelopersPage();
    } catch (e: any) { alert("Couldn't register: " + (e?.message || e)); btn.disabled = false; btn.textContent = "Create developer key"; }
  });
}
async function renderDevDashboard(me: any) {
  const box = $("devBody");
  const usd = (e: number) => me.ethUsd > 0 ? fmtUsd(e * me.ethUsd) : `${e.toFixed(4)} ETH`;
  const claimableUsd = me.claimableEth * (me.ethUsd || 0);
  const canClaim = me.ethUsd > 0 && claimableUsd >= me.minClaimUsd;
  const snippet = devSnippet(me.apiKey);
  box.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="card-head"><div><h3>Your API key</h3><div class="sub">PUBLIC KEY — SAFE TO EMBED IN YOUR FRONTEND</div></div></div>
      <div class="explore-bar"><div class="input-wrap"><input type="text" readonly value="${escape(me.apiKey)}" /></div>
        <button class="btn btn-neon" id="devKeyCopy" style="padding:11px 22px">Copy</button></div>
      <div class="hintline">This key only credits locks, burns and vesting to you. It cannot move funds or access admin — payouts require your wallet signature.</div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Lifetime earnings</div><div class="v g">${me.lifetimeEarnedEth.toFixed(4)} ETH</div><div class="d">${me.ethUsd > 0 ? fmtUsd(me.lifetimeEarnedEth * me.ethUsd) : "50% of generated fees"}</div></div>
      <div class="tile"><div class="k">Claimable now</div><div class="v">${me.claimableEth.toFixed(4)} ETH</div><div class="d">${me.ethUsd > 0 ? fmtUsd(claimableUsd) : ""} · min $${me.minClaimUsd}</div></div>
      <div class="tile"><div class="k">Actions generated</div><div class="v">${me.qualifyingLocks.toLocaleString("en-US")}</div><div class="d">from ${me.lockers.toLocaleString("en-US")} users</div></div>
      <div class="tile"><div class="k">Commission rate</div><div class="v g">${Math.round((me.commission || 0) * 100)}%</div><div class="d">your share per lock</div></div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-head"><div><h3>Claim earnings</h3><div class="sub">PAID IN ETH TO ${short(account).toUpperCase()}</div></div>
        <button class="btn btn-neon" id="affClaimBtn" ${canClaim ? "" : "disabled"}>Claim ${me.claimableEth.toFixed(4)} ETH</button></div>
      <div class="hintline" id="affClaimMsg">${canClaim ? "" : (me.claimableEth > 0 ? `You can claim once your balance reaches $${me.minClaimUsd}.` : "Earn from locks your app generates to unlock claiming.")}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Integration docs</h3><div class="sub">EMBED · JS API · REST</div></div></div>
      <div class="dev-docs">
        <h4>1 · Embed button (recommended)</h4>
        <p>Include the script once, then add a button with <code>data-hoodlock</code> for each product you want to offer. <code>data-mode</code> picks between <code>lock</code> (the default), <code>burn</code> and <code>vesting</code>; clicking opens that flow in a modal on your page.</p><p class="hintline">Every attribute except <code>data-hoodlock</code> is optional, and the buttons are independent — a lock-only integration is one button with no attributes at all. You earn on whichever products you add.</p><table class="dev-attrs"><thead><tr><th>Attribute</th><th>Required</th><th>What it does</th></tr></thead><tbody><tr><td><code>data-hoodlock</code></td><td>yes</td><td>Marks the button. Nothing else is needed for a lock.</td></tr><tr><td><code>data-mode</code></td><td>no</td><td><code>lock</code> (default), <code>burn</code> or <code>vesting</code>.</td></tr><tr><td><code>data-token</code></td><td>no</td><td>Contract address of the token. Pre-fills the field and makes it read-only, so the user can't pick a different token. Leave it out and they choose from their own wallet.</td></tr><tr><td><code>data-beneficiary</code></td><td>no</td><td>Vesting only. Pre-fills who receives the tokens; the user can still edit it.</td></tr><tr><td><code>data-unlock</code></td><td>no</td><td>Lock only. Pre-fills the unlock date, as a Unix timestamp in seconds.</td></tr></tbody></table><p class="hintline">Values like <code>\${token.address}</code> above are placeholders — insert them from your own data at render time, since they differ per page. They are not literal strings to paste.</p>
        <pre class="code-block" id="devSnippet">${escape(snippet)}</pre>
        <h4>2 · JavaScript API</h4>
        <p>Open programmatically and react to results:</p>
        <pre class="code-block">// lock (default)
HoodLock.open({ token: "0x…", unlockTime: 1790000000 });

// burn
HoodLock.open({ mode: "burn", token: "0x…" });

// vesting
HoodLock.open({ mode: "vesting", token: "0x…", beneficiary: "0x…" });

// one handler for every product…
HoodLock.on("done", ({ type, txHash, id }) =&gt; {
  console.log(type, id, txHash);   // "locked" | "burned" | "vested"
});

// …or listen per product
HoodLock.on("locked", ({ txHash, id }) =&gt; console.log("Locked!", id, txHash));</pre>
        <h4>3 · REST API (build your own UI)</h4>
        <p><code>GET /api/dev/config?key=${escape(me.apiKey)}</code> → chain id, RPC, explorer, all three contract addresses, the fee for each product, and your commission. These endpoints send CORS headers, so they work from your own frontend as well as your server.<br>
        Each intent returns a prepared <code>{ to, data, value, chainId }</code> transaction to submit from the user's wallet. Approve the token for <code>to</code> first.<br><code>POST /api/dev/lock-intent</code> <code>{ key, token, amount, unlockTime }</code><br><code>POST /api/dev/burn-intent</code> <code>{ key, token, amount }</code><br><code>POST /api/dev/vesting-intent</code> <code>{ key, token, beneficiary, amount, end }</code> — optional <code>start</code> (defaults to now) and <code>cliff</code> (defaults to start). The contract's own rules are checked here, so a schedule that would revert never reaches a signature prompt.<br>
        <code>POST /api/dev/attribute</code> <code>{ key, wallet }</code> → credit the connecting wallet to you (call it when the user connects).</p>
        <h4>4 · Network and contracts</h4>
        <p>Everything runs on <b>Robinhood Chain</b>, chain id <code>${CHAIN.id}</code>. The embed asks the
        user's wallet to switch, and adds the network if they don't have it — you don't need to handle that.</p>
        <table class="dev-attrs"><thead><tr><th>Contract</th><th>Address</th></tr></thead><tbody>
          <tr><td>Locker</td><td><a href="${EXP}/address/${LOCKER}?tab=contract" target="_blank" rel="noopener"><code>${LOCKER}</code></a></td></tr>
          ${BURNER ? `<tr><td>Burner</td><td><a href="${EXP}/address/${BURNER}?tab=contract" target="_blank" rel="noopener"><code>${BURNER}</code></a></td></tr>` : ""}
          ${VESTING ? `<tr><td>Vesting</td><td><a href="${EXP}/address/${VESTING}?tab=contract" target="_blank" rel="noopener"><code>${VESTING}</code></a></td></tr>` : ""}
        </tbody></table>
        <p class="hintline">All three are verified on Blockscout, and none of them gives us access to locked
        funds — read the withdrawal function yourself before you send anyone to them.</p>

        <h4>How you get paid</h4>
        <p>You earn <b>${Math.round((me.commission || 0) * 100)}%</b> of the ${me.feeEth} ETH fee on every lock created by a wallet you brought in. Only genuinely new wallets count (first-touch), and only locks made after they're attributed. Claim to your wallet here once your balance reaches $${me.minClaimUsd}.</p>
      </div>
    </div>`;
  ($("devKeyCopy") as HTMLButtonElement).addEventListener("click", async () => { try { await navigator.clipboard.writeText(me.apiKey); notify("API key copied"); } catch { prompt("Copy your API key:", me.apiKey); } });
  ($("affClaimBtn") as HTMLButtonElement).addEventListener("click", () => claimDev(me));
}
async function claimDev(me: any) {
  const btn = $("affClaimBtn") as HTMLButtonElement, msg = $("affClaimMsg");
  btn.disabled = true; btn.textContent = "Claiming…";
  try {
    const r = await affFetch("/api/aff/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "claim failed");
    if (d.status === "paid") { msg.innerHTML = `<span style="color:var(--neon)">Paid ${d.amount.toFixed(4)} ETH — <a href="${EXP}/tx/${d.tx}" target="_blank" rel="noopener">view tx</a></span>`; notify("Paid 🎉"); }
    else { msg.innerHTML = `<span style="color:var(--amber)">Claim received (${d.amount.toFixed(4)} ETH) — queued for payout, you'll receive it shortly.</span>`; notify("Claim queued"); }
    setTimeout(loadDevelopersPage, 2500);
  } catch (e: any) { msg.innerHTML = `<span class="badv">${escape(e?.message || String(e))}</span>`; btn.disabled = false; btn.textContent = `Claim ${me.claimableEth.toFixed(4)} ETH`; }
}

/* admin: every public affiliate, sortable */
let adAffData: any[] = [], adAffEthUsd = 0;
const adAffSort = { key: "earnedEth", dir: -1 };
async function loadAdminPublicAffiliates() {
  const box = $("adAffBox");
  const token = cachedToken();
  if (!token) { box.innerHTML = `<div class="empty"><div class="small">Sign in to view.</div></div>`; return; }
  try {
    const r = await fetch("/api/admin/public-affiliates", { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    adAffData = d.affiliates || []; adAffEthUsd = d.ethUsd || 0;
    const sm = d.summary || {};
    const usd = (e: number) => adAffEthUsd > 0 ? fmtUsd(e * adAffEthUsd) : `${e.toFixed(4)} ETH`;
    $("adPayerBal").textContent = sm.payoutWallet ? usd(sm.payoutBalanceEth) : "not set";
    $("adPayerSub").textContent = sm.payoutWallet ? `${(sm.payoutBalanceEth || 0).toFixed(4)} ETH · ${short(sm.payoutWallet)}` : "no payout wallet configured";
    $("adUnclaimed").textContent = usd(sm.totalUnclaimedEth || 0);
    renderAdAffTable();
  } catch { box.innerHTML = `<div class="empty"><div class="small">Couldn't load affiliates.</div></div>`; }
}
function renderAdAffTable() {
  const box = $("adAffBox");
  if (!adAffData.length) { box.innerHTML = `<div class="empty"><div class="small">No public affiliates yet.</div></div>`; return; }
  const money = (e: number) => adAffEthUsd > 0 ? fmtUsd(e * adAffEthUsd) : `${e.toFixed(4)} ETH`;
  const cols = [
    { k: "code", label: "Code", num: false }, { k: "owner", label: "Owner", num: false },
    { k: "clicks", label: "Clicks", num: true }, { k: "signups", label: "Signups", num: true },
    { k: "locksCount", label: "Locks", num: true }, { k: "burnsCount", label: "Burns", num: true },
    { k: "vestsCount", label: "Vesting", num: true },
    { k: "commission", label: "Rate", num: true },
    { k: "earnedEth", label: "Earned", num: true }, { k: "claimedEth", label: "Claimed", num: true },
    { k: "claimableEth", label: "Unclaimed", num: true },
  ];
  const sorted = [...adAffData].sort((a, b) => {
    const k = adAffSort.key, av = a[k], bv = b[k];
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * adAffSort.dir;
  });
  const arrow = (k: string) => adAffSort.key === k ? (adAffSort.dir === 1 ? " ▲" : " ▼") : "";
  const head = cols.map((c) => `<th data-sort="${c.k}" style="cursor:pointer${c.num ? ";text-align:right" : ""}">${c.label}${arrow(c.k)}</th>`).join("");
  const body = sorted.map((a) => `<tr>
    <td><b>${escape(a.code)}</b></td><td class="addr">${short(a.owner)}</td>
    <td style="text-align:right">${a.clicks.toLocaleString("en-US")}</td>
    <td style="text-align:right">${a.signups.toLocaleString("en-US")}</td>
    <td style="text-align:right">${(a.locksCount || 0).toLocaleString("en-US")}</td>
    <td style="text-align:right">${(a.burnsCount || 0).toLocaleString("en-US")}</td>
    <td style="text-align:right">${(a.vestsCount || 0).toLocaleString("en-US")}</td>
    <td style="text-align:right"><a href="#" data-editrate="${escape(a.code)}" data-rate="${a.commission}" title="Click to change commission" style="color:var(--fg);border-bottom:1px dashed var(--muted)">${Math.round((a.commission || 0) * 100)}%</a></td>
    <td style="text-align:right;color:var(--neon)">${money(a.earnedEth)}</td>
    <td style="text-align:right">${money(a.claimedEth)}</td>
    <td style="text-align:right">${money(a.claimableEth)}</td></tr>`).join("");
  box.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  box.querySelectorAll<HTMLElement>("[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort!;
    if (adAffSort.key === k) adAffSort.dir *= -1; else { adAffSort.key = k; adAffSort.dir = -1; }
    renderAdAffTable();
  }));
  box.querySelectorAll<HTMLElement>("[data-editrate]").forEach((el) => el.addEventListener("click", (e) => {
    e.preventDefault();
    editCommission(el.dataset.editrate!, Number(el.dataset.rate));
  }));
}
async function editCommission(code: string, current: number) {
  const token = cachedToken();
  if (!token) return;
  const input = window.prompt(`Commission for "${code}" (%). Default is 30.`, String(Math.round((current || 0) * 100)));
  if (input == null) return;
  const pct = Number(input.trim().replace("%", ""));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) { notify("Enter a percentage between 0 and 100."); return; }
  try {
    const r = await fetch("/api/admin/aff-commission", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ code, rate: pct / 100 }),
    });
    if (!r.ok) throw new Error(String(r.status));
    notify(`Commission for ${code} set to ${pct}%.`);
    loadAdminPublicAffiliates();
  } catch { notify("Couldn't update commission."); }
}

/* admin: affiliate payout claims */
async function loadAdminClaims() {
  const box = $("adClaimsBox");
  const token = cachedToken();
  if (!token) { box.innerHTML = `<div class="empty"><div class="small">Sign in to view claims.</div></div>`; return; }
  try {
    const r = await fetch("/api/admin/claims", { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const claims = (d.claims || []) as any[];
    if (!claims.length) { box.innerHTML = `<div class="empty"><div class="small">No affiliate claims yet.</div></div>`; return; }
    const stTag = (s: string) => s === "paid" ? "unlockable" : s === "failed" ? "withdrawn" : "locked";
    box.innerHTML = `<table><thead><tr><th>Affiliate</th><th>Code</th><th>Amount</th><th>Status</th><th>Requested</th><th style="text-align:right">Action</th></tr></thead><tbody>${
      claims.map((c) => `<tr><td class="addr">${short(c.owner_wallet)}</td><td>${escape(c.code)}</td><td>${c.amount_eth.toFixed(4)} ETH</td>
        <td><span class="status ${stTag(c.status)}"><i></i>${(c.status === "sent_unconfirmed" ? "processing" : c.status).toUpperCase()}</span></td><td>${dateLabel(c.requested_at)}</td>
        <td style="text-align:right">${/^0x[0-9a-fA-F]{64}$/.test(c.tx_hash || "") ? `<a href="${EXP}/tx/${encodeURIComponent(c.tx_hash)}" target="_blank" rel="noopener">tx</a> ` : ""}${c.status === "paid" ? (/^0x[0-9a-fA-F]{64}$/.test(c.tx_hash || "") ? "" : "—") : `<button class="btn btn-line btn-sm" data-pay="${c.id}" data-wallet="${c.owner_wallet}" data-amt="${c.amount_eth}">Mark paid</button>`}</td></tr>`).join("")
    }</tbody></table>`;
    box.querySelectorAll<HTMLButtonElement>("[data-pay]").forEach((b) => b.addEventListener("click", async () => {
      const tx = prompt(`Send ${b.dataset.amt} ETH to ${b.dataset.wallet}, then paste the tx hash:`);
      if (!tx) return;
      try {
        const t = cachedToken();
        await fetch("/api/admin/claims/pay", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ id: Number(b.dataset.pay), tx_hash: tx }) });
        notify("Marked paid"); loadAdminClaims();
      } catch (e: any) { alert("Failed: " + (e?.message || e)); }
    }));
  } catch { box.innerHTML = `<div class="empty"><div class="small">Couldn't load claims.</div></div>`; }
}

/* ---------- ADMIN CONSOLE (gated to the collector wallet) ---------- */
const isAdmin = () => account.toLowerCase() === ADMIN_WALLET;
function syncAdminNav() {
  $("adminNav").style.display = isAdmin() ? "" : "none";
  if (!isAdmin() && location.pathname.startsWith("/app/admin")) go("dashboard");
  if ($("view-admin").classList.contains("active")) loadAdmin();
}
// first-touch referral: if arrived via /r/<code>, tell the backend which wallet connected
/* admin products table — same range selector as the chart (1D/7D/30D/lifetime) */
type ProdItem = { ts: number; wallet: string; active: boolean };
let prodData: { locks: ProdItem[]; burns: ProdItem[]; vests: ProdItem[]; lockTs: Map<string, number>; fees: { lock: number; burn: number; vest: number }; ethUsd: number } | null = null;
let prodRange = 0; // days; 0 = lifetime
function renderProducts() {
  const box = document.getElementById("adProdBox"); if (!box || !prodData) return;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = prodRange > 0 ? now - prodRange * 86400 : 0;
  const inRange = (i: ProdItem) => prodRange === 0 || i.ts >= cutoff;
  const sub = document.getElementById("adProdSub");
  if (sub) sub.textContent = prodRange === 0 ? "REVENUE · USERS · ACTIVITY — LIFETIME" : `REVENUE · USERS · ACTIVITY — LAST ${prodRange} DAY${prodRange === 1 ? "" : "S"}`;

  const L = prodData.locks.filter(inRange), B = prodData.burns.filter(inRange), V = prodData.vests.filter(inRange);
  const u = (xs: ProdItem[]) => new Set(xs.map((x) => x.wallet)).size;
  const all = new Set([...L, ...B, ...V].map((x) => x.wallet)).size;
  const revL = L.length * prodData.fees.lock, revB = B.length * prodData.fees.burn, revV = V.length * prodData.fees.vest;
  const usd = prodData.ethUsd;
  const rev = (n: number) => `${n.toFixed(4)} ETH${usd > 0 ? ` <span style="color:var(--ink-3);font-size:11px">≈ ${fmtUsd(n * usd)}</span>` : ""}`;
  // "Active" is a point-in-time count, so it always reflects now regardless of range
  const activeLocks = prodData.locks.filter((x) => x.active).length;
  const activeVest = prodData.vests.filter((x) => x.active).length;
  box.innerHTML = `<table style="table-layout:fixed;width:100%"><thead><tr>
      <th style="width:22%">Product</th><th style="width:14%">Count</th><th style="width:26%">Revenue</th><th style="width:20%">Unique users</th><th style="width:18%">Active now</th></tr></thead><tbody>
    <tr><td><b>Token Locks</b></td><td>${L.length}</td><td>${rev(revL)}</td><td>${u(L)}</td><td>${activeLocks} locked</td></tr>
    <tr><td><b>Burns</b></td><td>${B.length}</td><td>${rev(revB)}</td><td>${u(B)}</td><td>—</td></tr>
    <tr><td><b>Vesting</b></td><td>${V.length}</td><td>${rev(revV)}</td><td>${u(V)}</td><td>${activeVest} vesting</td></tr>
    <tr style="border-top:1px solid var(--line-2)"><td><b style="color:var(--neon)">TOTAL</b></td><td><b>${L.length + B.length + V.length}</b></td><td><b>${rev(revL + revB + revV)}</b></td><td><b>${all}</b></td><td>—</td></tr>
    </tbody></table>`;
}
document.querySelectorAll<HTMLElement>("#adProdRange .chip-dur").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll("#adProdRange .chip-dur").forEach((x) => x.classList.remove("on"));
  c.classList.add("on");
  prodRange = Number(c.dataset.range);
  renderProducts();
}));

/* admin activity chart — stacked bars (locks/burns/vesting) with a range
   selector (1D hourly · 7D · 30D · lifetime) and a hover tooltip per bar */
let adminActsCache: { ts: number; kind: string; fee?: number }[] = [];
let adminEthUsd = 0;
let adminChartNow = 0;
let adminChartRange = 30; // days; 0 = lifetime; 1 = last 24h in hourly buckets
function drawAdminChart(acts: { ts: number; kind: string; fee?: number }[], now: number, ethUsd = 0) {
  adminActsCache = acts; adminChartNow = now; adminEthUsd = ethUsd;
  renderAdminChart();
}
function renderAdminChart() {
  const svg = document.getElementById("adChart"); if (!svg) return;
  const acts = adminActsCache, now = adminChartNow || Math.floor(Date.now() / 1000);
  const W = 640, H = 170, L = 30, R = 6, T = 12, B = 22;
  const COLORS: Record<string, string> = { LOCK: "var(--neon,#00e05a)", BURN: "#ff6b6b", VESTING: "#f5b731" };

  // bucket size + count per range
  let bucketSec: number, count: number, startTs: number, subLabel: string;
  if (adminChartRange === 1) {
    bucketSec = 3600; count = 24; startTs = (Math.floor(now / 3600) - 23) * 3600; subLabel = "ACTIONS PER HOUR · LAST 24H";
  } else if (adminChartRange === 0) {
    const first = acts.length ? Math.min(...acts.map((a) => a.ts)) : now;
    const days = Math.max(7, Math.floor((now - first) / 86400) + 1);
    if (days > 90) { bucketSec = 7 * 86400; count = Math.ceil(days / 7); subLabel = "ACTIONS PER WEEK · LIFETIME"; }
    else { bucketSec = 86400; count = days; subLabel = "ACTIONS PER DAY · LIFETIME"; }
    startTs = (Math.floor(now / bucketSec) - (count - 1)) * bucketSec;
  } else {
    bucketSec = 86400; count = adminChartRange; startTs = (Math.floor(now / 86400) - (count - 1)) * 86400;
    subLabel = `ACTIONS PER DAY · LAST ${count} DAYS`;
  }
  const sub = document.getElementById("adChartSub"); if (sub) sub.textContent = subLabel;

  const buckets = Array.from({ length: count }, () => ({ LOCK: 0, BURN: 0, VESTING: 0 } as Record<string, number>));
  const revenue = Array.from({ length: count }, () => 0);
  for (const a of acts) {
    const i = Math.floor((a.ts - startTs) / bucketSec);
    if (i >= 0 && i < count) { buckets[i][a.kind] = (buckets[i][a.kind] || 0) + 1; revenue[i] += a.fee ?? 0; }
  }
  const max = Math.max(1, ...buckets.map((b) => b.LOCK + b.BURN + b.VESTING));
  const bw = (W - L - R) / count;
  const y = (n: number) => H - B - (n / max) * (H - T - B);
  const lbl = (i: number) => {
    const dte = new Date((startTs + i * bucketSec) * 1000);
    if (bucketSec === 3600) return `${String(dte.getUTCHours()).padStart(2, "0")}:00`;
    return `${dte.getUTCDate()}/${dte.getUTCMonth() + 1}`;
  };
  let bars = "", overlays = "";
  buckets.forEach((b, i) => {
    let acc = 0;
    const x = L + i * bw + 1;
    for (const kind of ["LOCK", "BURN", "VESTING"]) {
      const n = b[kind]; if (!n) continue;
      const y1 = y(acc + n), y0b = y(acc);
      bars += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(1, y0b - y1).toFixed(1)}" fill="${COLORS[kind]}" rx="1"/>`;
      acc += n;
    }
    // full-height invisible hover target per bucket
    overlays += `<rect class="ad-hov" data-i="${i}" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}" fill="transparent"/>`;
  });
  svg.innerHTML = `
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--ink-3,#59695e)" stroke-width=".5" opacity=".5"/>
    <text x="${L - 5}" y="${y(max) + 3}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)" text-anchor="end">${max}</text>
    <text x="${L - 5}" y="${H - B + 3}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)" text-anchor="end">0</text>
    ${bars}
    <text x="${L}" y="${H - 8}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)" text-anchor="start">${lbl(0)}</text>
    <text x="${W - R}" y="${H - 8}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)" text-anchor="end">${lbl(count - 1)}</text>
    ${overlays}`;

  // hover tooltip
  const tip = document.getElementById("adChartTip");
  const wrap = svg.parentElement;
  if (tip && wrap) {
    svg.querySelectorAll<SVGRectElement>(".ad-hov").forEach((r) => {
      r.addEventListener("mousemove", (e) => {
        const i = Number(r.dataset.i); const b = buckets[i];
        const total = b.LOCK + b.BURN + b.VESTING;
        const dte = new Date((startTs + i * bucketSec) * 1000);
        const head = bucketSec === 3600
          ? `${lbl(i)}–${String((dte.getUTCHours() + 1) % 24).padStart(2, "0")}:00 UTC`
          : bucketSec > 86400 ? `week of ${lbl(i)}` : dte.toISOString().slice(0, 10);
        const rev = revenue[i];
        const revUsd = adminEthUsd > 0 ? ` <span style="color:var(--ink-3)">≈ ${fmtUsd(rev * adminEthUsd)}</span>` : "";
        tip.innerHTML = `<b>${head}</b><br>
          <span style="color:var(--neon)">■</span> Locks: ${b.LOCK}<br>
          <span style="color:#ff6b6b">■</span> Burns: ${b.BURN}<br>
          <span style="color:#f5b731">■</span> Vesting: ${b.VESTING}<br>
          <b>Total: ${total}</b><br>
          <span style="color:var(--neon)">Earnings: ${rev.toFixed(4)} ETH</span>${revUsd}`;
        const wr = wrap.getBoundingClientRect();
        let tx = e.clientX - wr.left + 14;
        tip.style.display = "block";
        const tw = tip.offsetWidth;
        if (tx + tw > wr.width - 4) tx = e.clientX - wr.left - tw - 14;
        tip.style.left = `${Math.max(0, tx)}px`;
        tip.style.top = `${Math.max(0, e.clientY - wr.top - 20)}px`;
        r.setAttribute("fill", "rgba(255,255,255,.05)");
      });
      r.addEventListener("mouseleave", () => { tip.style.display = "none"; r.setAttribute("fill", "transparent"); });
    });
  }
}
// range chips (exist only on the admin page markup)
document.querySelectorAll<HTMLElement>("#adChartRange .chip-dur").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll("#adChartRange .chip-dur").forEach((x) => x.classList.remove("on"));
  c.classList.add("on");
  adminChartRange = Number(c.dataset.range);
  renderAdminChart();
}));

function attributeRef() {
  let ref = "";
  try { ref = localStorage.getItem("hl_ref") || ""; } catch { /* */ }
  if (!ref || !account) return;
  fetch("/api/ref/visit", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: account, ref }) }).catch(() => { /* analytics only */ });
}

async function loadAdmin() {
  if (!isAdmin()) {
    $("adminBody").style.display = "none";
    $("adminGate").innerHTML = `<div class="card"><div class="empty"><div class="big">Admin access only</div><div class="small">Connect the HoodLock collector wallet to view this console.${account ? "" : " No wallet connected."}</div></div></div>`;
    return;
  }
  // Hard gate: nothing in the console renders until the admin wallet has signed
  // in (server-verified session). No wallet-forced DOM can reveal the panel.
  if (!cachedToken()) {
    $("adminBody").style.display = "none";
    $("adminGate").innerHTML = `<div class="card"><div class="empty"><div class="big">Admin sign-in required</div><div class="small">Sign a message with the collector wallet to open the console.</div><button class="btn btn-neon btn-sm" id="adSignIn" style="margin-top:12px">Sign in as admin</button></div></div>`;
    const b = document.getElementById("adSignIn");
    if (b) b.addEventListener("click", async () => {
      try { await adminSignIn(); loadAdmin(); } catch (e: any) { alert("Sign-in failed: " + (e?.message || e)); }
    });
    return;
  }
  $("adminGate").innerHTML = "";
  $("adminBody").style.display = "";

  // Nothing below depends on these, so start them now and let them land on
  // their own — the console used to sit blank until the slowest read returned.
  loadAffiliates();
  loadAdminClaims();
  loadAdminPublicAffiliates();
  const logsP = loadLockedLogs().catch(() => [] as Awaited<ReturnType<typeof loadLockedLogs>>);
  fetch("/api/admin/stats", { headers: { Authorization: "Bearer " + cachedToken() } })
    .then((r) => (r.ok ? r.json() : null))
    .then((st: any) => {
      if (!st) return;
      $("adConnected").textContent = Number(st.connectedWallets || 0).toLocaleString("en-US");
      $("adConnectedSub").textContent = `${Number(st.connected7d || 0).toLocaleString("en-US")} in last 7 days`;
      $("adClicks").textContent = Number(st.totalClicks || 0).toLocaleString("en-US");
      $("adClicksSub").textContent = `${Number(st.attributed || 0).toLocaleString("en-US")} attributed signups`;
    })
    .catch(() => { /* leave placeholders */ });

  try {
    const [total, burnTotal, vestTotal] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }).then(Number),
      BURNER ? pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "totalBurns" }).then(Number).catch(() => 0) : Promise.resolve(0),
      VESTING ? pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "totalSchedules" }).then(Number).catch(() => 0) : Promise.resolve(0),
    ]);
    const feeEth = Number(formatUnits(lockFee, 18)) || 0;
    const burnFeeEth = Number(formatUnits(burnFee, 18)) || 0;
    const vestFeeEth = Number(formatUnits(vestingFee, 18)) || 0;
    const ethUsd = Number((typeof localStorage !== "undefined" && localStorage.getItem("hl_ethusd")) || 0);
    const now = Math.floor(Date.now() / 1000);

    // pull everything once — per-product stats, chart and recent activity all reuse these
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
    const [rows, burnRows, vestRows] = await Promise.all([
      Promise.all(ids(total).map((i) => readLock(i).catch(() => null))).then((a) => a.filter((r): r is LockRow => !!r)),
      Promise.all(ids(burnTotal).map((i) => readBurn(i).catch(() => null))).then((a) => a.filter((b): b is BurnRow => !!b)),
      Promise.all(ids(vestTotal).map((i) => readVest(i).catch(() => null))).then((a) => a.filter((v): v is VestRow => !!v)),
    ]);
    const vestTs = new Map<number, number>();
    await Promise.all(vestRows.map(async (v) => { const inf = await vestCreationInfo(v.id).catch(() => null); if (inf) vestTs.set(v.id, inf.ts); }));

    // KPI cards need only the rows above, so paint them before the log reads.
    const revEth0 = rows.length * feeEth + burnRows.length * burnFeeEth + vestRows.length * vestFeeEth;
    const allUsers0 = new Set([
      ...rows.map((r) => r.owner.toLowerCase()),
      ...burnRows.map((b) => b.burner.toLowerCase()),
      ...vestRows.map((v) => v.creator.toLowerCase()),
    ]);
    $("adRevenue").textContent = revEth0.toFixed(4) + " ETH";
    $("adRevenueSub").textContent = ethUsd > 0 ? `≈ ${fmtUsd(revEth0 * ethUsd)} · at current fees` : "at current fees";
    $("adActions").textContent = (rows.length + burnRows.length + vestRows.length).toLocaleString("en-US");
    $("adUsers").textContent = allUsers0.size.toLocaleString("en-US");

    // TVL prices every distinct token, so let it fill in on its own.
    computeTvl(pub as any, [
      ...rows.map((l) => ({ token: l.token, amount: l.amount, withdrawn: l.withdrawn })),
      ...burnRows.map((b) => ({ token: b.token, amount: b.amount, withdrawn: false })),
      ...vestRows.filter((v) => v.total > v.claimed).map((v) => ({ token: v.token, amount: v.total - v.claimed, withdrawn: false })),
    ] as any)
      .then((tvl) => { $("adTvl").textContent = tvl.ethUsd > 0 ? fmtUsd(tvl.usd) : `${tvl.eth.toFixed(3)} ETH`; })
      .catch(() => { $("adTvl").textContent = "—"; });

    // ── per-product breakdown + TOTAL (range-filterable) ──
    prodData = {
      locks: rows.map((r) => ({ ts: 0, wallet: r.owner.toLowerCase(), active: !r.withdrawn && r.unlockTime > now })),
      burns: burnRows.map((b) => ({ ts: b.timestamp, wallet: b.burner.toLowerCase(), active: false })),
      vests: vestRows.map((v) => ({ ts: vestTs.get(v.id) || 0, wallet: v.creator.toLowerCase(), active: v.claimed < v.total })),
      lockTs: new Map<string, number>(),
      fees: { lock: feeEth, burn: burnFeeEth, vest: vestFeeEth },
      ethUsd,
    };
    // lock timestamps come from the Locked logs (same source the chart uses)
    const lockLogs = await logsP;
    prodData.locks = lockLogs.map((l) => ({
      ts: l.ts || 0,
      wallet: l.owner.toLowerCase(),
      active: rows.some((r) => r.id === l.id && !r.withdrawn && r.unlockTime > now),
    }));
    renderProducts();

    // ── accrued vesting fees + withdraw (collector-gated on-chain) ──
    if (VESTING) {
      try {
        const accrued = await pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "accruedFees" }) as bigint;
        const box = $("adVestFees");
        if (accrued > 0n) {
          box.style.display = "flex";
          $("adVestFeesAmt").textContent = `${formatUnits(accrued, 18)} ETH`;
          ($("adVestWithdraw") as HTMLButtonElement).onclick = async () => {
            const m3 = $("adVestFeesMsg"); m3.className = "msg";
            try {
              m3.textContent = "Confirm in wallet…";
              const h = await send(VESTING!, encodeFunctionData({ abi: VESTING_ABI as any, functionName: "withdrawFees" }));
              m3.innerHTML = `Withdrawing… <span class="spin"></span>`;
              await waitTx(h);
              m3.className = "msg ok"; m3.textContent = "Withdrawn ✓";
              loadAdmin();
            } catch (e: any) { m3.className = "msg bad"; m3.textContent = friendlyErr(e); }
          };
        } else box.style.display = "none";
      } catch { /* leave hidden */ }
    }

    // ── recent activity: locks + burns + vesting interleaved, newest first ──
    type Act = { wallet: string; token: string; ts: number; kind: string; color: string; fee: number };
    const acts: Act[] = [];
    for (const l of lockLogs) { if (l.ts) acts.push({ wallet: l.owner, token: l.token, ts: l.ts, kind: "LOCK", color: "var(--neon)", fee: feeEth }); }
    burnRows.forEach((b) => acts.push({ wallet: b.burner, token: b.token, ts: b.timestamp, kind: "BURN", color: "#ff6b6b", fee: burnFeeEth }));
    vestRows.forEach((v) => { const ts = vestTs.get(v.id); if (ts) acts.push({ wallet: v.creator, token: v.token, ts, kind: "VESTING", color: "#f5b731", fee: vestFeeEth }); });
    acts.sort((a, b) => b.ts - a.ts);
    const recent = acts.slice(0, 15);
    const body = (await Promise.all(recent.map(async (a) => {
      const m2 = await tokMeta(a.token);
      return `<tr><td class="addr">${short(a.wallet)}</td>
        <td><span style="font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:${a.color}">${a.kind}</span></td>
        <td>$${escape(m2.symbol)}</td><td>${dateLabel(a.ts)}</td>
        <td style="text-align:right"><a class="btn btn-line btn-sm" href="${EXP}/address/${a.wallet}" target="_blank" rel="noopener">Explorer</a></td></tr>`;
    }))).join("");
    $("adUsersBox").innerHTML = recent.length
      ? `<table><thead><tr><th>Wallet</th><th>Action</th><th>Token</th><th>When</th><th></th></tr></thead><tbody>${body}</tbody></table>`
      : `<div class="empty"><div class="small">No activity yet.</div></div>`;

    // ── activity chart: stacked daily bars, last 30 days ──
    drawAdminChart(acts, now, ethUsd);
  } catch {
    $("adRevenue").textContent = "—";
  }
}

/* ---------- affiliates (needs the backend; degrades to a notice) ---------- */
function cachedToken(): string | null {
  try {
    const t = localStorage.getItem("hl_admtok"), e = Number(localStorage.getItem("hl_admexp"));
    return t && e > Date.now() + 5000 ? t : null;
  } catch { return null; }
}
async function adminSignIn(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await walletSign(`HoodLock admin ${ts}`);
  const r = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account, ts, signature }) });
  if (!r.ok) throw new Error(await r.text());
  const { token, exp } = await r.json();
  try { localStorage.setItem("hl_admtok", token); localStorage.setItem("hl_admexp", String(exp)); } catch { /* */ }
  return token;
}
async function loadAffiliates() {
  const box = $("afBox");
  const token = cachedToken();
  if (!token) {
    box.innerHTML = `<div class="empty"><div class="small">Affiliate data is protected.</div><button class="btn btn-neon btn-sm" id="afUnlock" style="margin-top:10px">Sign in to view</button></div>`;
    const u = document.getElementById("afUnlock");
    if (u) u.addEventListener("click", async () => {
      try { await adminSignIn(); loadAffiliates(); } catch (e: any) { alert("Sign-in failed: " + (e?.message || e)); }
    });
    return;
  }
  try {
    const r = await fetch("/api/admin/affiliates", { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { try { localStorage.removeItem("hl_admtok"); } catch { /* */ } return loadAffiliates(); }
    if (!r.ok) throw new Error(String(r.status));
    const data: any = await r.json();
    const rows = (data.affiliates || []) as { code: string; label: string; clicks: number; signups: number; lockers: number; locks: number; locksCount?: number; burnsCount?: number; vestsCount?: number; commission: number; revenueEth: number }[];
    if (!rows.length) { box.innerHTML = `<div class="empty"><div class="small">No affiliate links yet — create your first above.</div></div>`; return; }
    box.innerHTML = `<table><thead><tr><th>Campaign</th><th>Link</th><th>Clicks</th><th>Signups</th><th>Locks</th><th>Burns</th><th>Vesting</th><th style="text-align:right">Commission</th><th style="text-align:right">Revenue</th></tr></thead><tbody>${
      rows.map((a) => `<tr>
        <td><b>${escape(a.label || a.code)}</b></td>
        <td><a href="/r/${escape(a.code)}" target="_blank" rel="noopener" class="mono" style="font-size:11px">hoodlock.tech/r/${escape(a.code)}</a>
          <button class="btn btn-line btn-sm" style="margin-left:6px" data-copyref="${escape(a.code)}">Copy</button></td>
        <td>${a.clicks.toLocaleString("en-US")}</td>
        <td>${a.signups.toLocaleString("en-US")}</td>
        <td>${(a.locksCount || 0).toLocaleString("en-US")}</td>
        <td>${(a.burnsCount || 0).toLocaleString("en-US")}</td>
        <td>${(a.vestsCount || 0).toLocaleString("en-US")}</td>
        <td style="text-align:right">${Math.round((a.commission || 0) * 100)}%</td>
        <td style="text-align:right">${a.revenueEth.toFixed(4)} ETH</td></tr>`).join("")
    }</tbody></table>`;
    box.querySelectorAll<HTMLButtonElement>("[data-copyref]").forEach((b) => b.addEventListener("click", async () => {
      const url = `${location.origin}/r/${b.dataset.copyref}`;
      try { await navigator.clipboard.writeText(url); notify("Affiliate link copied"); } catch { prompt("Copy this link:", url); }
    }));
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Affiliate tracking isn't reachable right now.</div></div>`;
  }
}
$("afCreate").addEventListener("click", async () => {
  if (!isAdmin()) return;
  const label = ($("afLabel") as HTMLInputElement).value.trim();
  const btn = $("afCreate") as HTMLButtonElement;
  btn.disabled = true;
  try {
    let token = cachedToken();
    if (!token) { btn.textContent = "Signing…"; token = await adminSignIn(); }
    btn.textContent = "Creating…";
    const r = await fetch("/api/admin/affiliates", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ label }) });
    if (!r.ok) throw new Error(await r.text());
    ($("afLabel") as HTMLInputElement).value = "";
    notify("Affiliate link created");
    loadAffiliates();
  } catch (e: any) { alert("Couldn't create link: " + (e?.message || e)); }
  finally { btn.disabled = false; btn.textContent = "Create link"; }
});

/* ═══════════════════ VESTING (RobinhoodVesting) ═══════════════════ */
type VestRow = { id: number; creator: string; beneficiary: string; token: string; total: bigint; claimed: bigint; start: number; cliff: number; end: number };

async function readVest(id: number): Promise<VestRow> {
  const s: any = await pub.readContract({ address: VESTING!, abi: VESTING_ABI as any, functionName: "getSchedule", args: [BigInt(id)] });
  return { id, creator: getAddress(s.creator), beneficiary: getAddress(s.beneficiary), token: getAddress(s.token),
    total: s.total as bigint, claimed: s.claimed as bigint, start: Number(s.start), cliff: Number(s.cliff), end: Number(s.end) };
}
/** Linear curve — mirrors the contract exactly (cliff-gated, exact sweep at end). */
function vestedAt(v: { total: bigint; start: number; cliff: number; end: number }, t: number): bigint {
  if (t < v.cliff) return 0n;
  if (t >= v.end) return v.total;
  return (v.total * BigInt(t - v.start)) / BigInt(v.end - v.start);
}
const VESTING_CREATED_EVENT = { type: "event", name: "VestingCreated", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "token", type: "address", indexed: true },
  { name: "beneficiary", type: "address", indexed: true }, { name: "creator", type: "address", indexed: false },
  { name: "total", type: "uint256", indexed: false }, { name: "start", type: "uint64", indexed: false },
  { name: "cliff", type: "uint64", indexed: false }, { name: "end", type: "uint64", indexed: false } ] } as const;
const vestTxCache = new Map<number, { tx: string; ts: number }>();
async function vestCreationInfo(id: number): Promise<{ tx: string; ts: number } | null> {
  if (vestTxCache.has(id)) return vestTxCache.get(id)!;
  for (let a = 0; a < 4; a++) {
    try {
      const hit = (await eventLogs(VESTING!, TOPIC_VESTING_CREATED)).find((l) => l.id === id);
      if (!hit) return null;
      const info = { tx: hit.tx, ts: hit.ts };
      vestTxCache.set(id, info); return info;
    } catch { await new Promise((r) => setTimeout(r, 500 * (a + 1))); }
  }
  return null;
}

/* ---------- create form state ---------- */
let vTokenMeta: { addr: `0x${string}`; symbol: string; decimals: number; bal: bigint } | null = null;
async function vRefreshToken() {
  vTokenMeta = null; $("vTokenInfo").textContent = ""; $("vBalHint").textContent = "";
  const raw = ($("vTokenAddr") as HTMLInputElement).value.trim();
  updateVSummary();
  if (!isAddress(raw)) return;
  const addr = getAddress(raw) as `0x${string}`;
  try {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: addr, abi: ERC20, functionName: "symbol" }).catch(() => "TOKEN"),
      pub.readContract({ address: addr, abi: ERC20, functionName: "decimals" }).catch(() => 18),
    ]);
    let bal = 0n;
    if (account) bal = await pub.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [account as `0x${string}`] }) as bigint;
    vTokenMeta = { addr, symbol: String(symbol), decimals: Number(decimals), bal };
    $("vTokenInfo").innerHTML = `<span style="color:var(--neon)">✓</span> <b>$${escape(String(symbol))}</b> · ${decimals} decimals`;
    if (account) $("vBalHint").innerHTML = `You hold <b>${fmtBal(bal, Number(decimals))}</b> $${escape(String(symbol))}`;
    updateVSummary();
  } catch { $("vTokenInfo").innerHTML = `<span class="badv">Couldn't read this token on Robinhood Chain.</span>`; }
}

function vRowHTML(addr = "", amt = "") {
  return `<div class="input-wrap v-row" style="display:flex;gap:8px;margin-bottom:6px">
    <input type="text" class="vRowAddr" placeholder="0x… recipient" value="${escape(addr)}" spellcheck="false" style="flex:1" />
    <input type="number" class="vRowAmt" placeholder="amount" value="${escape(amt)}" inputmode="decimal" min="0" style="width:130px" />
    <button type="button" class="max-btn vRowDel" style="position:static">✕</button>
  </div>`;
}
function vAddRow(addr = "", amt = "") { $("vRows").insertAdjacentHTML("beforeend", vRowHTML(addr, amt)); wireVRows(); updateVSummary(); }
/** The ✕ does nothing on the last remaining row — hide it until there are 2+. */
function syncVRowDels() {
  const rows = document.querySelectorAll<HTMLElement>("#vRows .v-row");
  rows.forEach((r) => {
    const b = r.querySelector<HTMLElement>(".vRowDel");
    if (b) b.style.display = rows.length > 1 ? "" : "none";
  });
}
function wireVRows() {
  document.querySelectorAll<HTMLElement>("#vRows .vRowDel").forEach((b) => { b.onclick = () => { if (document.querySelectorAll("#vRows .v-row").length > 1) { b.closest(".v-row")!.remove(); syncVRowDels(); updateVSummary(); } }; });
  document.querySelectorAll<HTMLInputElement>("#vRows input").forEach((i) => { i.oninput = debounce(updateVSummary, 300); });
  syncVRowDels();
}
function vReadRows(): { addr: `0x${string}`; amt: string }[] {
  const out: { addr: `0x${string}`; amt: string }[] = [];
  document.querySelectorAll<HTMLElement>("#vRows .v-row").forEach((r) => {
    const a = (r.querySelector(".vRowAddr") as HTMLInputElement).value.trim();
    const m = (r.querySelector(".vRowAmt") as HTMLInputElement).value.trim();
    if (isAddress(a) && Number(m) > 0) out.push({ addr: getAddress(a) as `0x${string}`, amt: m });
  });
  return out;
}
function vApplyCsv() {
  const lines = ($("vCsv") as HTMLTextAreaElement).value.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const rows: { a: string; m: string }[] = [];
  for (const l of lines) {
    const parts = l.split(/[,;\t]+/).map((p) => p.trim());
    if (parts.length >= 2 && isAddress(parts[0]) && Number(parts[1]) > 0) rows.push({ a: parts[0], m: parts[1] });
  }
  if (!rows.length) { notify("No valid rows — expected: address, amount"); return; }
  $("vRows").innerHTML = "";
  rows.slice(0, 200).forEach((r) => $("vRows").insertAdjacentHTML("beforeend", vRowHTML(r.a, r.m)));
  wireVRows(); updateVSummary();
  notify(`${Math.min(rows.length, 200)} recipient${rows.length === 1 ? "" : "s"} loaded from CSV`);
}

const localDT = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
function vDates(): { start: number; cliff: number; end: number } | null {
  const s = ($("vStart") as HTMLInputElement).value, c = ($("vCliff") as HTMLInputElement).value, e = ($("vEnd") as HTMLInputElement).value;
  if (!s || !e) return null;
  const start = Math.floor(new Date(s).getTime() / 1000);
  const end = Math.floor(new Date(e).getTime() / 1000);
  const cliff = c ? Math.floor(new Date(c).getTime() / 1000) : start;
  return { start, cliff, end };
}

const shortDate = (sec: number) => {
  const dte = new Date(sec * 1000);
  return `${dte.getUTCDate()} ${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][dte.getUTCMonth()]} '${String(dte.getUTCFullYear()).slice(2)}`;
};
function drawVCurve() {
  const svg = document.getElementById("vCurve"); if (!svg) return;
  const d = vDates();
  const now = Math.floor(Date.now() / 1000);
  // Layout: left gutter for 0%/100%, bottom gutter for the date labels.
  const W = 300, H = 116, L = 34, R = 10, T = 16, B = 24;
  const MUT = "var(--ink-3,#59695e)", NEON = "var(--neon,#00e05a)";
  const y0 = H - B, y100 = T;
  const frame = `
    <line x1="${L}" y1="${y100}" x2="${W - R}" y2="${y100}" stroke="${MUT}" stroke-width=".5" opacity=".35" stroke-dasharray="2 3"/>
    <line x1="${L}" y1="${y0}" x2="${W - R}" y2="${y0}" stroke="${MUT}" stroke-width=".5" opacity=".6"/>
    <text x="${L - 4}" y="${y100 + 3}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="end">100%</text>
    <text x="${L - 4}" y="${y0 + 3}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="end">0%</text>`;

  if (!d || d.end <= d.start || d.cliff < d.start || d.cliff > d.end) {
    // No (valid) dates yet — dimmed example so the user sees the shape they're
    // configuring; it switches to their real schedule once dates are set.
    const cx = L + 0.3 * (W - L - R);
    const cy = y0 - 0.3 * (y0 - y100);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `${frame}
      <path d="M ${L},${y0} L ${cx},${y0} L ${cx},${cy} L ${W - R},${y100}"
            fill="none" stroke="${NEON}" stroke-width="2" stroke-linejoin="round" stroke-dasharray="5 4" opacity=".35"/>
      <text x="${cx}" y="${H - 12}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="middle" opacity=".7">CLIFF</text>
      <text x="${L}" y="${H - 2}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="start" opacity=".7">START</text>
      <text x="${W - R}" y="${H - 2}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="end" opacity=".7">FULLY VESTED</text>
      <text x="${(L + W - R) / 2}" y="${T - 6}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="middle" letter-spacing="2">EXAMPLE — PICK YOUR DATES</text>`;
    return;
  }

  // If the start is in the future the x-domain begins at TODAY, so the wait
  // before vesting begins is visible as a flat zero segment instead of the
  // TODAY marker silently disappearing.
  const futureStart = d.start > now;
  const domStart = Math.min(now, d.start);
  const x = (t: number) => L + ((t - domStart) / (d.end - domStart)) * (W - L - R);
  const y = (frac: number) => y0 - frac * (y0 - y100);
  const cliffFrac = (d.cliff - d.start) / (d.end - d.start);
  const hasCliff = d.cliff > d.start;
  const line = `M ${x(domStart)},${y(0)} L ${x(d.cliff)},${y(0)} L ${x(d.cliff)},${y(cliffFrac)} L ${x(d.end)},${y(1)}`;
  const area = `${line} L ${x(d.end)},${y0} L ${x(domStart)},${y0} Z`;
  const nowX = now >= domStart && now < d.end ? x(now) : null;
  // keep the two bottom date labels from colliding when the cliff sits near an edge
  const cliffX = x(d.cliff);
  const showCliffDate = hasCliff && cliffX > L + 72 && cliffX < W - R - 72;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `${frame}
    <path d="${area}" fill="${NEON}" opacity=".07"/>
    <path d="${line}" fill="none" stroke="${NEON}" stroke-width="2" stroke-linejoin="round"/>
    ${hasCliff ? (() => {
      // Collision-proof cliff label: clamp inside the plot, flip the anchor at
      // the edges, drop below the dot near the top, and when cliff == end the
      // endpoint's own labels already tell the whole story — skip it entirely.
      if (cliffFrac >= 0.999) return `
      <line x1="${cliffX}" y1="${y(cliffFrac)}" x2="${cliffX}" y2="${y0}" stroke="${NEON}" stroke-width=".75" opacity=".45" stroke-dasharray="2 3"/>`;
      const lx = Math.max(L + 4, Math.min(cliffX, W - R - 4));
      const anchor = cliffX > W - R - 96 ? "end" : cliffX < L + 60 ? "start" : "middle";
      const nearTop = y(cliffFrac) < T + 18;
      const ly = nearTop ? y(cliffFrac) + 14 : y(cliffFrac) - 6;
      return `
      <line x1="${cliffX}" y1="${y(cliffFrac)}" x2="${cliffX}" y2="${y0}" stroke="${NEON}" stroke-width=".75" opacity=".45" stroke-dasharray="2 3"/>
      <circle cx="${cliffX}" cy="${y(cliffFrac)}" r="3" fill="${NEON}"/>
      <text x="${lx}" y="${ly}" font-family="var(--mono)" font-size="8" fill="${NEON}" text-anchor="${anchor}">CLIFF · ${(cliffFrac * 100).toFixed(0)}% UNLOCKS</text>
      ${showCliffDate ? `<text x="${cliffX}" y="${H - 2}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="middle">${shortDate(d.cliff)}</text>` : ""}`;
    })() : ""}
    <circle cx="${x(d.end)}" cy="${y(1)}" r="3" fill="${NEON}"/>
    <text x="${W - R}" y="${T - 6}" font-family="var(--mono)" font-size="8" fill="${NEON}" text-anchor="end">ALL TOKENS FREE</text>
    ${(() => {
      // STARTS labels sit under the actual start point (clamped so they never
      // run into the FULLY VESTED labels on the right).
      const sx = Math.min(Math.max(x(d.start), L), W - R - 116);
      const label = futureStart ? `STARTS IN ${remainingLabel(d.start - now).toUpperCase()}` : "STARTS";
      return `
      ${futureStart ? `
      <line x1="${x(d.start)}" y1="${y100}" x2="${x(d.start)}" y2="${y0}" stroke="#f5b731" stroke-width="1" stroke-dasharray="3 3"/>
      <circle cx="${x(d.start)}" cy="${y0}" r="3" fill="#f5b731"/>` : ""}
      <text x="${sx}" y="${H - 12}" font-family="var(--mono)" font-size="8" fill="${futureStart ? "#f5b731" : MUT}" text-anchor="start">${label}</text>
      <text x="${sx}" y="${H - 2}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="start">${shortDate(d.start)}</text>`;
    })()}
    <text x="${W - R}" y="${H - 12}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="end">FULLY VESTED</text>
    <text x="${W - R}" y="${H - 2}" font-family="var(--mono)" font-size="8" fill="${MUT}" text-anchor="end">${shortDate(d.end)}</text>
    ${nowX !== null && !futureStart ? `<line x1="${nowX}" y1="${y100}" x2="${nowX}" y2="${y0}" stroke="#f5b731" stroke-width="1" stroke-dasharray="3 3"/><text x="${Math.max(nowX, L + 2)}" y="${T - 6}" font-family="var(--mono)" font-size="8" fill="#f5b731" text-anchor="${nowX < L + 40 ? "start" : "middle"}">TODAY</text>` : ""}`;
}

function updateVSummary() {
  const rows = vReadRows();
  const d = vDates();
  const now = Math.floor(Date.now() / 1000);
  $("vsToken").textContent = vTokenMeta ? `$${vTokenMeta.symbol}` : "—";
  $("vsCount").textContent = rows.length ? String(rows.length) : "—";
  const totalNum = rows.reduce((s, r) => s + Number(r.amt), 0);
  $("vsTotal").textContent = rows.length && vTokenMeta ? `${totalNum.toLocaleString("en-US", { maximumFractionDigits: 4 })} $${vTokenMeta.symbol}` : "—";
  // Show the user's LOCAL time first (it matches what they typed in the
  // pickers), with UTC in parentheses — displaying UTC alone read as a bug
  // ("I entered 03:06, it shows 02:06").
  const dtLocalUtc = (sec: number) => {
    const dd = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const local = `${dd.getFullYear()}-${p(dd.getMonth() + 1)}-${p(dd.getDate())} ${p(dd.getHours())}:${p(dd.getMinutes())}`;
    const utcFull = dateTimeUTC(sec); // "YYYY-MM-DD HH:MM UTC"
    const sameDay = utcFull.slice(0, 10) === local.slice(0, 10);
    return `${local} (${sameDay ? utcFull.slice(11) : utcFull})`;
  };
  $("vsCliff").textContent = d ? (d.cliff > d.start ? dtLocalUtc(d.cliff) : "no cliff") : "—";
  $("vsEnd").textContent = d ? dtLocalUtc(d.end) : "—";
  // F-6: surface how much of the schedule is already liquid at creation time.
  // Audit fixes: (1) sub-0.1% reads as 0% — datetime-local is minute-precision,
  // so a NOW-click always leaves a few seconds of "elapsed" time that used to
  // surface as a confusing "<0.1%". (2) A backdated start with a FUTURE cliff
  // is claimable-0 at creation but dumps the whole accrued chunk the moment
  // the cliff passes — that jump is now disclosed instead of hidden by the 0%.
  let pre = "0%";
  let warnFrac = 0;
  if (d && d.end > d.start) {
    const fracAt = (t: number) => t < d.cliff ? 0 : Math.max(0, Math.min(1, (t - d.start) / (d.end - d.start)));
    const nowPct = fracAt(now) * 100;
    pre = nowPct < 0.1 ? "0%" : nowPct.toFixed(1) + "%";
    warnFrac = fracAt(now);
    if (now < d.cliff) {
      // nothing claimable yet — but how much unlocks the second the cliff hits?
      const cliffPct = Math.max(0, Math.min(1, (d.cliff - d.start) / (d.end - d.start))) * 100;
      if (cliffPct >= 0.1) { pre = `0% · ${cliffPct.toFixed(1)}% unlocks at cliff`; warnFrac = cliffPct / 100; }
    }
  }
  ($("vsPreVested") as HTMLElement).style.color = warnFrac > 0.5 ? "#f5b731" : "";
  $("vsPreVested").textContent = pre;
  // Live date validation — the same rules create() enforces, surfaced before signing.
  const warn = document.getElementById("vDateWarn");
  if (warn) {
    if (!d) warn.textContent = "";
    else if (d.end <= d.start) warn.textContent = "The fully-vested date must be after the start.";
    else if (d.cliff > d.end) warn.textContent = "The cliff is after the fully-vested date — pick an earlier cliff or a later end.";
    else if (d.end <= now + 24 * 3600) warn.textContent = "The schedule must run at least 24 hours from now.";
    else warn.textContent = "";
  }
  const n = BigInt(Math.max(rows.length, 1));
  $("vsFee").textContent = vestingFee > 0n ? `${formatUnits(vestingFee * n, 18)} ETH` : "free";
  const btn = $("vCreateBtn") as HTMLButtonElement;
  if (!account) btn.textContent = "Connect wallet to vest";
  else btn.textContent = rows.length > 1 ? `Create ${rows.length} vesting schedules` : "Create vesting schedule";
  drawVCurve();
}

/* ---------- create ---------- */
/** Red-ring the offending inputs; the ring clears as soon as the field is edited. */
function ringBad(els: (HTMLElement | null)[]) {
  els.filter((e): e is HTMLElement => !!e).forEach((el) => {
    el.classList.add("ring-bad");
    const clear = () => el.classList.remove("ring-bad");
    el.addEventListener("input", clear, { once: true });
    el.addEventListener("change", clear, { once: true });
  });
}
function clearRings() { document.querySelectorAll(".ring-bad").forEach((el) => el.classList.remove("ring-bad")); }
async function vCreate() {
  const msg = $("vMsg"); msg.className = "msg";
  clearRings();
  try {
    if (!account) return openWalletModal();
    if (!VESTING) throw new Error("Vesting is not configured.");
    if (!vTokenMeta) { ringBad([$("vTokenAddr")]); throw new Error("Enter a valid token address."); }
    const rows = vReadRows();
    if (!rows.length) {
      // ring exactly what's missing on each row
      document.querySelectorAll<HTMLElement>("#vRows .v-row").forEach((r) => {
        const a = r.querySelector<HTMLInputElement>(".vRowAddr")!;
        const m2 = r.querySelector<HTMLInputElement>(".vRowAmt")!;
        if (!isAddress(a.value.trim())) ringBad([a]);
        if (!(Number(m2.value) > 0)) ringBad([m2]);
      });
      throw new Error("Add at least one recipient (address + amount).");
    }
    const d = vDates();
    if (!d) {
      ringBad([($("vStart") as HTMLInputElement).value ? null : $("vStart"), ($("vEnd") as HTMLInputElement).value ? null : $("vEnd")]);
      throw new Error("Pick start and fully-vested dates.");
    }
    if (d.cliff < d.start) { ringBad([$("vCliff")]); throw new Error("The cliff cannot be before the start."); }
    if (d.cliff > d.end) { ringBad([$("vCliff"), $("vEnd")]); throw new Error("The cliff cannot be after the fully-vested date."); }
    if (d.end <= d.start) { ringBad([$("vEnd")]); throw new Error("Fully-vested must be after the start."); }
    if (d.end <= Math.floor(Date.now() / 1000) + 24 * 3600) { ringBad([$("vEnd")]); throw new Error("The schedule must run at least 24 hours from now."); }
    const amounts = rows.map((r) => parseUnits(r.amt, vTokenMeta!.decimals));
    const sum = amounts.reduce((s, a) => s + a, 0n);
    if (sum > vTokenMeta.bal) {
      ringBad([...document.querySelectorAll<HTMLElement>("#vRows .vRowAmt")]);
      throw new Error("Total amount exceeds your balance.");
    }
    const n = BigInt(rows.length);
    const btn = $("vCreateBtn") as HTMLButtonElement; btn.disabled = true;

    const allow = await pub.readContract({ address: vTokenMeta.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, VESTING] }) as bigint;
    if (allow < sum) {
      msg.textContent = "Approving… confirm in wallet";
      const ah = await send(vTokenMeta.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [VESTING, sum] }));
      msg.innerHTML = `Approving… <span class="spin"></span>`; await waitTx(ah);
    }
    msg.textContent = "Creating… confirm in wallet";
    const data = rows.length === 1
      ? encodeFunctionData({ abi: VESTING_ABI as any, functionName: "create", args: [vTokenMeta.addr, rows[0].addr, amounts[0], BigInt(d.start), BigInt(d.cliff), BigInt(d.end)] })
      : encodeFunctionData({ abi: VESTING_ABI as any, functionName: "createMany", args: [vTokenMeta.addr, rows.map((r) => r.addr), amounts, BigInt(d.start), BigInt(d.cliff), BigInt(d.end)] });
    const h = await send(VESTING, data, vestingFee * n);
    msg.innerHTML = `Creating… <span class="spin"></span>`;
    try {
      await waitTx(h);
      msg.className = "msg ok";
      msg.innerHTML = `Vesting created! <a href="${EXP}/tx/${h}" target="_blank" rel="noopener">view tx</a>. Every schedule has a shareable proof under <b>Created by you</b>.`;
    } catch {
      msg.className = "msg";
      msg.innerHTML = `Transaction submitted — <a href="${EXP}/tx/${h}" target="_blank" rel="noopener">view tx</a>. Schedules should appear below shortly.`;
    }
    btn.disabled = false;
    renderVestMine();
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); ($("vCreateBtn") as HTMLButtonElement).disabled = false; }
}

/* ---------- my schedules ---------- */
// Fixed column widths so "Vesting to you" and "Created by you" align exactly —
// auto layout sized them differently (three action buttons vs one).
const VEST_HEAD = `<thead><tr><th style="width:20%">Token</th><th style="width:10%">Total</th><th style="width:10%">Vested</th><th style="width:10%">Claimed</th><th style="width:11%">Claimable</th><th style="width:14%">Fully vested</th><th style="width:25%;text-align:right">Actions</th></tr></thead>`;
const VEST_TABLE_OPEN = `<table style="table-layout:fixed;width:100%">`;
/** Vesting row shaped exactly like an explore lock row: Token | Amount | Unlocks(→vested %) | TVL(unclaimed) | Status | Actions. */
async function vestExploreRowHTML(v: VestRow): Promise<string> {
  const m = await tokMeta(v.token);
  const now = Math.floor(Date.now() / 1000);
  const fully = now >= v.end;
  const daysLeft = Math.max(1, Math.ceil((v.end - now) / 86400));
  const status = fully
    ? `<span class="status unlockable"><i></i>FULLY VESTED</span>`
    : `<span class="status locked"><i></i>VESTED · ${daysLeft}D</span>`;
  const claimedPct = v.total > 0n ? Number((v.claimed * 1000n) / v.total) / 10 : 0;
  const unclaimed = v.total - v.claimed;
  const usd = unclaimed > 0n ? await amountValueUsd(pub as any, v.token as `0x${string}`, unclaimed, m.decimals).catch(() => null) : null;
  const tvl = usd !== null && usd > 0 ? fmtUsd(usd) : "—";
  return `<tr data-proofvest="${v.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(v.token, m.symbol)}
      <div><div class="n">$${escape(m.symbol)} <span class="tag">VESTING #${v.id}</span></div><div class="a">${short(v.token)}</div></div></div></td>
    <td>${fmtNum(v.total, m.decimals)}</td>
    <td>${v.claimed >= v.total ? "100%" : claimedPct.toFixed(1) + "%"} claimed</td>
    <td>${tvl}</td>
    <td>${status}</td>
    <td><div class="row-actions"><button class="btn btn-line btn-sm" data-vproof="${v.id}">Proof</button></div></td></tr>`;
}
async function vestRowHTML(v: VestRow, role: "recipient" | "creator"): Promise<string> {
  const m = await tokMeta(v.token);
  const now = Math.floor(Date.now() / 1000);
  const vested = vestedAt(v, now);
  const claimable = vested - v.claimed;
  const pct = v.total > 0n ? Number((vested * 1000n) / v.total) / 10 : 0;
  const done = v.claimed >= v.total;
  const acts = role === "recipient"
    ? `${claimable > 0n ? `<button class="btn btn-neon btn-sm" data-vclaim="${v.id}">Claim</button>` : ""}
       <button class="btn btn-line btn-sm" data-vmove="${v.id}">Move</button>
       <button class="btn btn-line btn-sm" data-vproof="${v.id}">Proof</button>`
    : `<button class="btn btn-line btn-sm" data-vproof="${v.id}">Proof</button>`;
  return `<tr>
    <td><b>$${escape(m.symbol)}</b><div class="mono" style="font-size:10px;color:var(--ink-3)">#${v.id} · ${short(role === "recipient" ? v.creator : v.beneficiary)}</div></td>
    <td>${fmtNum(v.total, m.decimals)}</td>
    <td>${done ? "100%" : pct.toFixed(1) + "%"}<div style="height:3px;background:var(--line);border-radius:2px;margin-top:4px;max-width:80px"><div style="height:100%;width:${Math.min(100, pct)}%;background:var(--neon,#00e05a);border-radius:2px"></div></div></td>
    <td>${v.claimed > 0n ? fmtNum(v.claimed, m.decimals) : `<span style="color:var(--ink-3)">0</span>`}</td>
    <td>${claimable > 0n ? `<b style="color:var(--neon)">${fmtNum(claimable, m.decimals)}</b>` : now < v.cliff ? `<span style="color:var(--ink-3)">cliff ${dateTimeUTC(v.cliff).slice(0, 10)}</span>` : "0"}</td>
    <td>${dateTimeUTC(v.end).slice(0, 16)}</td>
    <td style="text-align:right;white-space:nowrap">${acts}</td>
  </tr>`;
}
async function renderVestMine() {
  const mineBox = document.getElementById("vMineBox"), createdBox = document.getElementById("vCreatedBox");
  if (!mineBox || !createdBox || !VESTING) return;
  if (!account) {
    mineBox.innerHTML = `<div class="empty"><div class="small">Connect your wallet to see and claim your vesting.</div></div>`;
    createdBox.innerHTML = `<div class="empty"><div class="small">Connect your wallet to see schedules you created.</div></div>`;
    return;
  }
  try {
    const [benIds, creIds] = await Promise.all([
      pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByBeneficiary", args: [account as `0x${string}`] }) as Promise<bigint[]>,
      pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByCreator", args: [account as `0x${string}`] }) as Promise<bigint[]>,
    ]);
    const uniq = (xs: bigint[]) => [...new Set(xs.map(Number))];
    const mineRows = (await Promise.all(uniq(benIds).map((i) => readVest(i).catch(() => null))))
      .filter((v): v is VestRow => !!v && v.beneficiary.toLowerCase() === account.toLowerCase()) // F-5: skip stale ids after Move
      .reverse();
    const createdRows = (await Promise.all(uniq(creIds).map((i) => readVest(i).catch(() => null))))
      .filter((v): v is VestRow => !!v).reverse();
    mineBox.innerHTML = mineRows.length
      ? `${VEST_TABLE_OPEN}${VEST_HEAD}<tbody>${(await Promise.all(mineRows.map((v) => vestRowHTML(v, "recipient")))).join("")}</tbody></table>`
      : `<div class="empty"><div class="big">Nothing vesting to you yet</div><div class="small">When a project vests tokens to this wallet, they appear here.</div></div>`;
    createdBox.innerHTML = createdRows.length
      ? `${VEST_TABLE_OPEN}${VEST_HEAD}<tbody>${(await Promise.all(createdRows.map((v) => vestRowHTML(v, "creator")))).join("")}</tbody></table>`
      : `<div class="empty"><div class="small">No schedules created by this wallet yet.</div></div>`;
    wireVestActions(mineBox); wireVestActions(createdBox);
  } catch {
    mineBox.innerHTML = `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">Check your connection and try again.</div></div>`;
  }
}
function wireVestActions(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-vclaim]").forEach((b) => b.addEventListener("click", async () => {
    try {
      (b as HTMLButtonElement).setAttribute("disabled", "");
      const h = await send(VESTING!, encodeFunctionData({ abi: VESTING_ABI as any, functionName: "claim", args: [BigInt(b.dataset.vclaim!)] }));
      notify("Claiming — confirm in wallet, then wait for the tx…");
      await waitTx(h); notify("Claimed ✓"); renderVestMine();
    } catch (e: any) { alert(friendlyErr(e)); b.removeAttribute("disabled"); }
  }));
  root.querySelectorAll<HTMLElement>("[data-vmove]").forEach((b) => b.addEventListener("click", () => openVMoveModal(Number(b.dataset.vmove))));
  root.querySelectorAll<HTMLElement>("[data-vproof]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();   // the row handles this too; don't open it twice
    showVestingProof(Number(b.dataset.vproof));
  }));
  // Vesting rows in Explore looked clickable — the shared row style sets a
  // pointer cursor — but only the small Proof button did anything, so a click
  // anywhere else silently did nothing.
  root.querySelectorAll<HTMLElement>("[data-proofvest]").forEach((tr) =>
    tr.addEventListener("click", () => showVestingProof(Number(tr.dataset.proofvest))));
}

/* move modal — themed replacement for the old prompt() */
let vMoveId = -1;
async function openVMoveModal(id: number) {
  vMoveId = id;
  ($("vMoveAddr") as HTMLInputElement).value = "";
  const msg = $("vMoveMsg"); msg.textContent = ""; msg.className = "msg";
  $("vMoveCurrent").innerHTML = `Schedule <b>#${id}</b> — loading…`;
  $("vMoveModal").classList.add("show");
  try {
    const v = await readVest(id);
    const m = await tokMeta(v.token);
    $("vMoveCurrent").innerHTML = `Schedule <b>#${id}</b> · <b>${fmtNum(v.total, m.decimals)} $${escape(m.symbol)}</b> currently vesting to <b>${short(v.beneficiary)}</b>. Pick the wallet that should receive it from now on.`;
  } catch { $("vMoveCurrent").innerHTML = `Schedule <b>#${id}</b>`; }
}
function closeVMoveModal() { $("vMoveModal").classList.remove("show"); }
if (document.getElementById("vMoveModal")) {
  $("vMoveClose").addEventListener("click", closeVMoveModal);
  $("vMoveCancel").addEventListener("click", closeVMoveModal);
  $("vMoveModal").addEventListener("click", (e) => { if (e.target === $("vMoveModal")) closeVMoveModal(); });
  $("vMoveConfirm").addEventListener("click", async () => {
    const msg = $("vMoveMsg"); msg.className = "msg";
    const raw = ($("vMoveAddr") as HTMLInputElement).value.trim();
    if (!isAddress(raw)) { msg.className = "msg bad"; msg.textContent = "Enter a valid wallet address (0x…)."; return; }
    const btn = $("vMoveConfirm") as HTMLButtonElement;
    try {
      btn.disabled = true;
      msg.textContent = "Confirm in wallet…";
      const h = await send(VESTING!, encodeFunctionData({ abi: VESTING_ABI as any, functionName: "transferBeneficiary", args: [BigInt(vMoveId), getAddress(raw)] }));
      msg.innerHTML = `Moving… <span class="spin"></span>`;
      await waitTx(h);
      closeVMoveModal();
      notify("Schedule moved ✓");
      renderVestMine();
    } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); }
    finally { btn.disabled = false; }
  });
}

function loadVestingView() {
  if (!VESTING) return;
  if (!document.querySelector("#vRows .v-row")) {
    vAddRow();
    // All three dates stay empty until the user picks them (or taps a preset).
    ($("vStart") as HTMLInputElement).value = "";
    ($("vCliff") as HTMLInputElement).value = "";
    ($("vEnd") as HTMLInputElement).value = "";
    updateVSummary();
  }
  renderVestMine();
}

/* ---------- shareable vesting proof (/proof/vesting/<id>) — works without a wallet ---------- */
async function showVestingProof(id: number, push = true) {
  loadTokenPages();
  go("proof");
  $("viewTitle").textContent = "VESTING PROOF";
  if (push) history.pushState(null, "", `/proof/vesting/${id}`);
  else history.replaceState(null, "", `/proof/vesting/${id}`);
  const box = $("proofBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading vesting #${id}… <span class="spin"></span></div></div>`;
  let v: VestRow;
  try {
    v = await readVest(id);
    if (v.total === 0n) throw new Error("empty");
  } catch { box.innerHTML = `<div class="empty"><div class="big">Vesting #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`; return; }
  const m = await tokMeta(v.token);
  const info = await vestCreationInfo(id);
  const now = Math.floor(Date.now() / 1000);
  const vestedNow = vestedAt(v, now);
  const pctNow = v.total > 0n ? Number((vestedNow * 1000n) / v.total) / 10 : 0;
  // F-6 note: the "Vested at creation" row was removed per owner 2026-07-27.
  // The disclosure lives on through "Vested so far" (current liquid share —
  // for a fresh backdated schedule effectively the same number) and the
  // "Unlocks at cliff" row below.
  const status = v.claimed >= v.total
    ? `<span class="status withdrawn"><i></i>FULLY CLAIMED</span>`
    : now < v.cliff ? `<span class="status locked"><i></i>CLIFF · ${remainingLabel(v.cliff - now).toUpperCase()} LEFT</span>`
    : now >= v.end ? `<span class="status unlockable"><i></i>FULLY VESTED</span>`
    : `<span class="status locked"><i></i>VESTING ACTIVE</span>`;
  // Cliff-jump disclosure (audit): a backdated schedule with a future cliff is
  // 0% claimable now but releases the whole accrued chunk the moment the cliff
  // passes — show that jump so the proof can't understate what unlocks.
  let cliffJumpRow = "";
  if (now < v.cliff && v.end > v.start) {
    const jumpPct = Math.max(0, Math.min(1, (v.cliff - v.start) / (v.end - v.start))) * 100;
    if (jumpPct >= 0.1) cliffJumpRow = `<div class="p-row"><span class="k">Unlocks at cliff</span><span class="v" ${jumpPct > 50 ? 'style="color:#f5b731"' : ""}>${jumpPct.toFixed(1)}% of total ${jumpPct > 50 ? "⚠" : ""}</span></div>`;
  }
  box.innerHTML = `
    <div class="proof-card">
      <span class="stamp">✓ ON-CHAIN VESTING</span>
      <div class="proof-amt">${fmtNum(v.total, m.decimals)} $${escape(m.symbol)}</div>
      <div class="proof-sub">HOODLOCK · VESTING #${id} · ROBINHOOD CHAIN 4663</div>
      <div class="p-row"><span class="k">Status</span><span class="v">${status}</span></div>
      <div class="p-row"><span class="k">Vested so far</span><span class="v g">${fmtNum(vestedNow, m.decimals)} $${escape(m.symbol)} (${pctNow.toFixed(1)}%)</span></div>
      <div class="p-row"><span class="k">Claimed</span><span class="v">${fmtNum(v.claimed, m.decimals)} $${escape(m.symbol)}</span></div>
      ${cliffJumpRow}
      <div class="p-row"><span class="k">Token</span><span class="v mono">${v.token}</span></div>
      <div class="p-row"><span class="k">Recipient</span><span class="v mono">${v.beneficiary}</span></div>
      <div class="p-row"><span class="k">Starts</span><span class="v">${dateTimeUTC(v.start)}</span></div>
      <div class="p-row"><span class="k">Cliff</span><span class="v">${v.cliff > v.start ? dateTimeUTC(v.cliff) : "none"}</span></div>
      <div class="p-row"><span class="k">Fully vested</span><span class="v">${dateTimeUTC(v.end)}</span></div>
      <div class="p-row"><span class="k">Guarantee</span><span class="v g">irrevocable · linear release · recipient-only claims</span></div>
      <div class="p-acts">
        ${info ? `<a class="btn btn-neon" href="${EXP}/tx/${info.tx}" target="_blank" rel="noopener">✔ Confirm the vesting transaction on Blockscout</a>` : ""}
        <a class="btn btn-line" href="${EXP}/address/${VESTING}?tab=contract" target="_blank" rel="noopener">Read the verified vesting contract</a>
        <button class="btn btn-line" id="vProofCopy">Copy proof link</button>
      </div>
    </div>
    ${tokenPageLine(v.token, m.symbol)}
    <a class="p-back" href="/app/vesting">← Open HoodLock Vesting</a>`;
  $("vProofCopy").addEventListener("click", async () => {
    const url = `${location.origin}/proof/vesting/${id}`;
    try { await navigator.clipboard.writeText(url); notify("Proof link copied"); } catch { prompt("Copy this proof link:", url); }
  });
}

/* wire the create form (elements exist only if config.vesting is set) */
if (VESTING && document.getElementById("vCreateBtn")) {
  $("vCreateBtn").addEventListener("click", vCreate);
  $("vAddRow").addEventListener("click", () => vAddRow());
  $("vCsvToggle").addEventListener("click", () => {
    const w = $("vCsvWrap"); const showing = w.style.display !== "none";
    w.style.display = showing ? "none" : "";
    $("vCsvToggle").textContent = showing ? "Paste CSV" : "Apply CSV";
    if (showing) vApplyCsv();
  });
  $("vTokenAddr").addEventListener("input", debounce(vRefreshToken, 400));
  wireTokenDropdown("vTokenAddr", "vTokDd", () => vRefreshToken());
  // Manual edits clear that group's preset highlight — a lit "6M" chip next to
  // a hand-typed date misleads about what will actually be created (#0 post-mortem).
  const CHIP_GROUP: Record<string, string> = { vStart: "vStartPresets", vCliff: "vCliffPresets", vEnd: "vEndPresets" };
  ["vStart", "vCliff", "vEnd"].forEach((id) => {
    const clearChips = () => {
      document.querySelectorAll(`#${CHIP_GROUP[id]} .chip-dur`).forEach((x) => x.classList.remove("on"));
      updateVSummary();
    };
    // both events: "input" for typed segment edits, "change" for the native picker (Safari)
    $(id).addEventListener("input", clearChips);
    $(id).addEventListener("change", clearChips);
  });
  document.querySelectorAll<HTMLElement>("#vStartPresets .chip-dur").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll("#vStartPresets .chip-dur").forEach((x) => x.classList.remove("on")); c.classList.add("on");
    ($("vStart") as HTMLInputElement).value = localDT(new Date(Date.now() + Number(c.dataset.startdays) * 86400_000));
    updateVSummary();
  }));
  // Cliff/end presets are relative to the start — if the user hasn't picked a
  // start yet, fill it with NOW so the choice always yields a valid, drawable
  // schedule instead of silently blanking the curve.
  const ensureStart = (): Date => {
    const el = $("vStart") as HTMLInputElement;
    if (!el.value) {
      el.value = localDT(new Date());
      document.querySelectorAll("#vStartPresets .chip-dur").forEach((x) => x.classList.toggle("on", x.getAttribute("data-startdays") === "0"));
    }
    return new Date(el.value);
  };
  document.querySelectorAll<HTMLElement>("#vCliffPresets .chip-dur").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll("#vCliffPresets .chip-dur").forEach((x) => x.classList.remove("on")); c.classList.add("on");
    const days = Number(c.dataset.cliffdays || 0);
    const base = ensureStart();
    // NEVER silently mutate another field the user may have set by hand
    // (schedule #0 post-mortem) — conflicts surface in the vDateWarn line
    // instead, and create() refuses until they're resolved.
    ($("vCliff") as HTMLInputElement).value = days > 0 ? localDT(new Date(base.getTime() + days * 86400_000)) : "";
    updateVSummary();
  }));
  document.querySelectorAll<HTMLElement>("#vEndPresets .chip-dur").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll("#vEndPresets .chip-dur").forEach((x) => x.classList.remove("on")); c.classList.add("on");
    const base = ensureStart();
    ($("vEnd") as HTMLInputElement).value = localDT(new Date(base.getTime() + Number(c.dataset.enddays) * 86400_000));
    updateVSummary();
  }));
}

/* ---------- boot ---------- */
restoreConnection();
const _refParam = new URLSearchParams(location.search).get("ref");
if (_refParam && /^[A-Za-z0-9_-]{3,32}$/.test(_refParam)) { try { localStorage.setItem("hl_ref", _refParam); } catch { /* */ } }
// Clean proof paths (/proof/<kind>/<id>). The ?lock=/?burn=/?vesting= form is
// still read here as a fallback: the server 301s them, but a bookmark opened
// offline or a client-side link should still resolve.
const _proofPath = location.pathname.match(/^\/proof\/(lock|burn|vesting)\/(\d+)/);
const _lockParam = _proofPath?.[1] === "lock" ? _proofPath[2] : new URLSearchParams(location.search).get("lock");
const _burnParam = _proofPath?.[1] === "burn" ? _proofPath[2] : new URLSearchParams(location.search).get("burn");
const _vestParam = _proofPath?.[1] === "vesting" ? _proofPath[2] : new URLSearchParams(location.search).get("vesting");
const _pathView = location.pathname.match(/^\/app\/([a-z]+)/)?.[1];
if (_lockParam && /^\d+$/.test(_lockParam)) showLockProof(Number(_lockParam), false);
else if (_burnParam && /^\d+$/.test(_burnParam) && BURNER) showBurnProof(Number(_burnParam), false);
else if (_vestParam && /^\d+$/.test(_vestParam) && VESTING) showVestingProof(Number(_vestParam), false);
else if (_pathView && TITLES[_pathView]) go(_pathView);
else if (location.hash && TITLES[location.hash.slice(1)]) go(location.hash.slice(1));   // gamla #-länkar
