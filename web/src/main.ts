/* HoodLock app — the super-app UI wired straight to the RobinhoodLocker
   contract on Robinhood Chain (4663). No backend: every number on screen is a
   contract read or an event log. Wallet layer: EIP-6963 injected providers +
   WalletConnect for Robinhood Wallet mobile. */
import {
  createPublicClient, http, fallback, custom, defineChain, getAddress, isAddress,
  parseUnits, formatUnits, formatEther, encodeFunctionData, numberToHex, keccak256, toHex, type Hex,
} from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";
import BURNER_ABI from "./burner-abi.json";
import VESTING_ABI from "./vesting-abi.json";
import { amountValueUsd, computeTvl, fmtUsd, tokenPriceUsd, tokenDepthCapUsd } from "./tvl";
import { initRevenueDrop } from "./revenue-drop";
import { nextPayout, countdownParts, payoutDateLabel, localTimeLabel } from "./revenue";

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
const TITLES: Record<string, string> = { dashboard: "DASHBOARD", locks: "TOKEN LOCKS", explore: "EXPLORE / VERIFY", proof: "LOCK PROOF", vesting: "VESTING", airdrops: "AIRDROPS", revenue: "$LOCK REVENUE SHARE", fixlocker: "LOCKER HANDOVER", streams: "STREAMS", affiliate: "AFFILIATE", developers: "DEVELOPERS", admin: "ADMIN CONSOLE" };
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
  if (view === "airdrops") loadAirdropView();
  if (view === "revenue") loadRevenueView();
  if (view === "fixlocker") loadFixLocker();
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
  if ($("view-airdrops").classList.contains("active")) loadAirdropView();
  if ($("view-revenue").classList.contains("active")) loadRevenueView();
  if ($("view-fixlocker").classList.contains("active")) loadFixLocker();
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
  if ($("view-airdrops").classList.contains("active")) loadAirdropView();
  if ($("view-revenue").classList.contains("active")) loadRevenueView();
  if ($("view-fixlocker").classList.contains("active")) loadFixLocker();
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
/* Fees start as null, not 0n.
 *
 * They used to default to 0n, and loadFee() swallowed a failed RPC read. A
 * single rate-limited request therefore left the fee at zero, the summary line
 * said "free", and the lock transaction went out with value: 0 — which the
 * contract rejects, because it requires msg.value >= fee. The user saw a
 * confirmed-looking flow fail for no stated reason, and had no way to tell that
 * a read had failed rather than the fee genuinely being zero.
 *
 * null means "we do not know yet". 0n means "we read it and it really is zero".
 * Nothing is ever submitted while the answer is null. */
let lockFee: bigint | null = null, burnFee: bigint | null = null;
function renderFee() {
  // avgiftsraden är borttagen ur UI:t — avgifterna används fortfarande i tx:erna
  const el = document.getElementById("sFee");
  if (el) {
    const fee = burnMode ? burnFee : lockFee;
    el.textContent = fee === null ? "—" : fee > 0n ? `${formatUnits(fee, 18)} ETH` : "free";
  }
}
let vestingFee: bigint | null = null;
async function readFee(addr: `0x${string}`, abi: unknown): Promise<bigint | null> {
  // Two attempts: the public RPC drops the occasional read under load, and a
  // retry costs a few hundred milliseconds against a transaction that would
  // otherwise be guaranteed to revert.
  for (let i = 0; i < 2; i++) {
    try { return await pub.readContract({ address: addr, abi: abi as any, functionName: "fee" }) as bigint; }
    catch { if (i === 0) await new Promise((r) => setTimeout(r, 400)); }
  }
  return null;
}

async function loadFee() {
  lockFee = await readFee(LOCKER, LOCKER_ABI);
  if (BURNER) burnFee = await readFee(BURNER, BURNER_ABI);
  if (VESTING) vestingFee = await readFee(VESTING, VESTING_ABI);
  renderFee();
  if (document.getElementById("vsFee")) updateVSummary(); // vesting summary shows n × fee
}

/**
 * The fee immediately before signing, re-read rather than trusted from page load.
 *
 * The admin can change it, and more importantly the value may never have loaded.
 * Sending a transaction with the wrong value is not a soft failure here: the
 * locker and burner reject anything below the fee, and the vesting contract
 * requires it exactly and refunds nothing.
 */
async function feeNow(addr: `0x${string}`, abi: unknown, label: string): Promise<bigint> {
  const fee = await readFee(addr, abi);
  if (fee === null) {
    throw new Error(`Couldn't read the ${label} fee from the chain — the network is busy. Wait a moment and try again; nothing was sent.`);
  }
  return fee;
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
  const bFee = await feeNow(BURNER, BURNER_ABI, "burn");
    const bh = await send(BURNER, encodeFunctionData({ abi: BURNER_ABI as any, functionName: "burn", args: [t.addr, amount] }), bFee);
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
    const feeWei = await feeNow(LOCKER, LOCKER_ABI, "lock");
      const lh = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "lock", args: [tokenMeta.addr, amount, unlockTime] }), feeWei);
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
/* The public RPC rate-limits per visitor IP. When a direct read fails, the
 * server's cached record endpoint answers instead — and it is the only party
 * allowed to say "not found" (verified against the contract's own counter).
 * A network failure surfaces as an error, never as a missing record. */
class RecordNotFound extends Error {}
async function recordFallback(kind: "lock" | "burn" | "vesting", id: number): Promise<any> {
  const r = await fetch(`/api/record/${kind}/${id}`);
  if (r.status === 404) throw new RecordNotFound(`${kind} ${id}`);
  if (!r.ok) throw new Error("chain unreachable");
  return r.json();
}
async function readLock(id: number): Promise<LockRow> {
  try {
    const l: any = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "getLock", args: [BigInt(id)] });
    return { id, owner: getAddress(l.owner), token: getAddress(l.token), amount: l.amount as bigint, unlockTime: Number(l.unlockTime), withdrawn: l.withdrawn };
  } catch (e) {
    if (e instanceof RecordNotFound) throw e;
    const r = await recordFallback("lock", id);
    return { id, owner: getAddress(r.owner), token: getAddress(r.token), amount: BigInt(r.amount), unlockTime: Number(r.unlockTime), withdrawn: !!r.withdrawn };
  }
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
  try {
    const b: any = await pub.readContract({ address: BURNER!, abi: BURNER_ABI as any, functionName: "getBurn", args: [BigInt(id)] });
    return { id, burner: getAddress(b.burner), token: getAddress(b.token), amount: b.amount as bigint, timestamp: Number(b.timestamp) };
  } catch (e) {
    if (e instanceof RecordNotFound) throw e;
    const r = await recordFallback("burn", id);
    return { id, burner: getAddress(r.burner), token: getAddress(r.token), amount: BigInt(r.amount), timestamp: Number(r.timestamp) };
  }
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
    // Transient RPC failure (the public Robinhood RPC rate-limits) — try the
    // server's cached price endpoint, which carries symbol and decimals for
    // exactly this case. Only a verified answer is cached.
    try {
      const r = await fetch(`/api/price/${addr.toLowerCase()}`);
      if (r.ok) {
        const j: any = await r.json();
        if (j?.symbol) {
          const m = { symbol: String(j.symbol), decimals: Number(j.decimals ?? 18) };
          metaCache.set(addr, m);
          return m;
        }
      }
    } catch { /* placeholder below */ }
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
  if (mine && !l.withdrawn) acts.push(`<button class="btn btn-line btn-sm" data-lkmove="${l.id}">Move</button>`);
  acts.push(`<button class="btn btn-line btn-sm" data-share="${l.id}">Share</button>`);
  const sym = escape(m.symbol);
  if (variant === "explore") {
    const v = l.withdrawn ? null : await amountValueUsd(pub as any, l.token as `0x${string}`, l.amount, m.decimals).catch(() => null);
    const tvl = v !== null && v > 0 ? fmtUsd(v) : "—";
    // Explore mixes locks, burns and vesting in one table, so the tag has to say
    // which product a row is — "#22" alone next to "BURN #4" reads as a lock only
    // if you already know that's the default.
    return `<tr data-proof="${l.id}">
    <td><div class="tk-cell">${await tokenIcoHTML(l.token, m.symbol)}
      <div><div class="n">$${sym} <span class="tag">LOCK #${l.id}</span></div><div class="a">${short(l.token)}</div></div></div></td>
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
/* The colgroup is what stops Explore twitching sideways while it fills.
 *
 * With the default auto layout a table sizes its columns from the content of
 * every row, so each row that swapped in could change the widest cell in a
 * column and force the whole table to re-lay out. Thirty rows arriving at
 * fourteen different moments meant fourteen horizontal jumps. Fixed layout with
 * declared widths decides the geometry once, from these numbers, and never
 * consults the cells again. The percentages are the widths the table settled on
 * naturally, so nothing looks different once loaded. */
const EXPLORE_COLS = `<colgroup><col style="width:30%"><col style="width:17%"><col style="width:14%"><col style="width:10%"><col style="width:18%"><col style="width:11%"></colgroup>`;
const TABLE_HEAD_EXPLORE = `${EXPLORE_COLS}<thead><tr><th>Token</th><th>Amount</th><th>Unlocks</th><th>TVL</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>`;
async function renderTable(box: HTMLElement, rows: LockRow[], mine: boolean, emptyBig: string, emptySmall: string, variant: "mine" | "explore" = "mine") {
  if (!rows.length) { box.innerHTML = `<div class="empty"><div class="big">${emptyBig}</div><div class="small">${emptySmall}</div></div>`; return; }
  const html = (await Promise.all(rows.map((r) => lockRowHTML(r, mine, variant)))).join("");
  box.innerHTML = `<table${variant === "explore" ? ' class="tbl-fixed"' : ""}>${variant === "explore" ? TABLE_HEAD_EXPLORE : TABLE_HEAD}<tbody>${html}</tbody></table>`;
  wireActions(box);
}
function wireActions(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>("[data-proof]").forEach((tr) => tr.addEventListener("click", () => showLockProof(Number(tr.dataset.proof))));
  container.querySelectorAll<HTMLButtonElement>("[data-withdraw]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); withdraw(Number(b.dataset.withdraw)); }));
  container.querySelectorAll<HTMLButtonElement>("[data-extend]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); extend(Number(b.dataset.extend)); }));
  container.querySelectorAll<HTMLButtonElement>("[data-lkmove]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openLockMoveModal(Number(b.dataset.lkmove)); }));
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
    <td><span style="color:#ff8a8a">Never</span></td>
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
    <table${variant === "explore" ? ' class="tbl-fixed"' : ""}>${variant === "explore" ? TABLE_HEAD_EXPLORE : TABLE_HEAD}<tbody>${rows}</tbody></table>`;
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
    const idx = await recordIds(account);
    /* Union with the contract's own per-wallet arrays. Those are safe here
     * because lock() and burn() record msg.sender, so only this wallet can
     * ever have appended to them, and unlike the server's event index they
     * are exact the moment a transaction lands — without this, a lock made
     * seconds ago was missing from "My locks" for as long as the server's
     * log cache and Blockscout lagged. Capped like the server caps its own. */
    const [chainLockIds, chainBurnIds] = await Promise.all([
      (pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByOwner", args: [account as `0x${string}`] }) as Promise<bigint[]>).catch(() => [] as bigint[]),
      BURNER
        ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByBurner", args: [account as `0x${string}`] }) as Promise<bigint[]>).catch(() => [] as bigint[])
        : Promise.resolve([] as bigint[]),
    ]);
    const union = (server: number[], chain: bigint[]) =>
      asBig([...new Set([...server, ...chain.map((x) => Number(x))])].sort((a, b) => a - b).slice(-250)).reverse();
    const ids = union(idx ? idx.locks.owner : [], chainLockIds);
    const burnIds = union(idx ? idx.burns.burner : [], chainBurnIds);
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
/* One list, newest first. Vesting used to be rendered above the sorted rows
   rather than inside them, so a schedule created weeks ago sat above a lock
   from this morning. */
type ExploreItem = { ts: number; known: boolean; id: number; kind: string; render: () => Promise<string> };

/* Locks and vesting schedules get their creation time from the Blockscout event
 * log, and Blockscout indexes a few seconds behind the chain. So the one record
 * whose time we cannot read is, almost always, the one created moments ago.
 *
 * Treating that as time zero — which is what a bare `?? 0` did — sorted the
 * newest lock to the very bottom of a newest-first list. A user who had just
 * locked went looking for their lock at the top and found it last.
 *
 * Ids are assigned sequentially by the contract, so within one product they are
 * an exact record of creation order, and that is what we fall back to. Fill a
 * missing time from the nearest older record we do know, which bounds it
 * correctly against everything below it. Anything with no known record above it
 * is newer than everything we can date, so it gets the current time — which is
 * what it actually is.
 *
 * Burns are unaffected: the burner contract stores the timestamp itself, so that
 * read either succeeds or the whole row fails.
 */
function inferTimes(rows: ExploreItem[], now: number) {
  const asc = [...rows].sort((a, b) => a.id - b.id);
  let last = 0;
  for (const r of asc) {
    if (r.known) last = r.ts;
    else r.ts = last;
  }
  for (let i = asc.length - 1; i >= 0 && !asc[i].known; i--) asc[i].ts = now;
}

/* How many rows Explore shows.
 *
 * This is also the per-product read cap in loadExplore, and the two have to stay
 * equal. Reading fewer of each product than the page displays looks like a
 * harmless saving but is not: if the newest 50 records all happen to be locks, a
 * lower lock cap means those locks are never fetched, and the page quietly fills
 * the gap with older burns instead. The list would still be 50 rows long and
 * still look right, which is why it is worth spending the extra reads. */
const EXPLORE_ROWS = 50;

/* Launch-day test locks (both $TESTT) the owner wants off the public explore
 * listing. Their records still exist on chain; the server redirects their
 * proof pages to /app/explore. */
const HIDDEN_LOCK_IDS = new Set([0, 1]);

async function buildExploreRows(lockRowsIn: LockRow[], burnRows: BurnRow[], vestRows: VestRow[] = [], limit = EXPLORE_ROWS): Promise<string> {
  const lockRows = lockRowsIn.filter((l) => !HIDDEN_LOCK_IDS.has(l.id));
  const [lockItems, vestItems] = await Promise.all([
    Promise.all(lockRows.map(async (l): Promise<ExploreItem> => {
      const ts = await lockedAtTs(l.id).catch(() => null);
      return { ts: ts ?? 0, known: !!ts, id: l.id, kind: "lock", render: () => lockRowHTML(l, false, "explore") };
    })),
    Promise.all(vestRows.map(async (v): Promise<ExploreItem> => {
      const ts = (await vestCreationInfo(v.id).catch(() => null))?.ts;
      return { ts: ts ?? 0, known: !!ts, id: v.id, kind: "vest", render: () => vestExploreRowHTML(v) };
    })),
  ]);
  const burnItems: ExploreItem[] = burnRows.map((b) => ({
    ts: b.timestamp, known: b.timestamp > 0, id: b.id, kind: "burn", render: () => burnRowHTML(b, "explore"),
  }));

  const now = Math.floor(Date.now() / 1000);
  for (const group of [lockItems, burnItems, vestItems]) inferTimes(group, now);

  const items = [...lockItems, ...burnItems, ...vestItems]
    // Ties break on id, but only within one product — a lock id and a burn id
    // are unrelated counters. Across products the sort's stability keeps them
    // in the order they were merged.
    .sort((a, b) => b.ts - a.ts || (a.kind === b.kind ? b.id - a.id : 0))
    .slice(0, limit);
  return (await Promise.all(items.map((it) => it.render()))).join("");
}
/* Record ids for an address, from the server's event index rather than from the
 * contracts' own index arrays.
 *
 * Those arrays only grow and have no paginated getter, and anyone can append to
 * someone else's array for the price of a 1-wei record. Since we then issue one
 * eth_call per id, a few thousand junk entries were enough to permanently break a
 * real wallet's dashboard or a real token's page. The server derives the same ids
 * from cached events and caps them.
 *
 * Falls back to the contract getters if the endpoint is unavailable, so the app
 * still works against a bare RPC.
 */
type IdSets = { locks: { owner: number[]; token: number[] };
                burns: { burner: number[]; token: number[] };
                vests: { token: number[]; beneficiary: number[]; creator: number[] } };
const idsCache = new Map<string, Promise<IdSets | null>>();
function recordIds(address: string): Promise<IdSets | null> {
  const key = address.toLowerCase();
  if (!idsCache.has(key)) {
    idsCache.set(key, fetch(`/api/ids?address=${key}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.locks ? j as IdSets : null))
      .catch(() => null));
  }
  return idsCache.get(key)!;
}
const asBig = (xs: number[]) => xs.map((n) => BigInt(n));

type ExploreRef = { kind: "lock" | "burn" | "vest"; id: number; ts: number; block: number };

/* The newest records across all three products, newest first, resolved without a
 * single eth_call.
 *
 * The event logs already carry both the record id and its block timestamp, and
 * bsLogs caches one Blockscout request per contract, so three cached requests
 * are enough to know the exact global ordering of every record that has ever
 * existed. That is what makes streaming possible: the old code had to read all
 * 150 records before it could sort them, because it derived candidates by
 * counting down from the totals and only learned the times afterwards. Ordering
 * first means we fetch only the rows we are actually going to show.
 *
 * Returns null when the logs are unavailable, so the caller can fall back rather
 * than render an empty page. */
async function exploreOrder(): Promise<ExploreRef[] | null> {
  try {
    const [locks, burns, vests] = await Promise.all([
      eventLogs(LOCKER, TOPIC_LOCKED).catch(() => []),
      BURNER ? eventLogs(BURNER, TOPIC_BURNED).catch(() => []) : Promise.resolve([]),
      VESTING ? eventLogs(VESTING, TOPIC_VESTING_CREATED).catch(() => []) : Promise.resolve([]),
    ]);
    // The locker has had records since launch, so an empty lock list can only
    // mean its log source failed this session. Rendering the survivors would
    // show a page of nothing but burns and vests, in the wrong order and
    // presented as the latest activity — fall back instead.
    if (!locks.length) return null;
    const refs: ExploreRef[] = [
      ...locks.filter((l) => !HIDDEN_LOCK_IDS.has(l.id)).map((l) => ({ kind: "lock" as const, id: l.id, ts: l.ts, block: l.block })),
      ...burns.map((l) => ({ kind: "burn" as const, id: l.id, ts: l.ts, block: l.block })),
      ...vests.map((l) => ({ kind: "vest" as const, id: l.id, ts: l.ts, block: l.block })),
    ];
    // Order by block number, not timestamp: every log carries its block, block
    // order IS chain order, and it cannot lie. Timestamps could be missing
    // whenever a source lagged (ts 0), and the old "no timestamp means it just
    // happened" guess then pinned old records to the top of the page. A block
    // that is genuinely unknown still sorts first — that one really is a
    // record so new its log hasn't settled.
    return refs.sort((a, b) => (b.block || Infinity) - (a.block || Infinity)
      || (a.kind === b.kind ? b.id - a.id : 0));
  } catch { return null; }
}

/** One row's HTML, memoised on the record so a prefetch and the later render
 *  share the same in-flight promise instead of reading the record twice. */
const exploreRowCache = new Map<string, Promise<string>>();
function exploreRowHTML(r: ExploreRef): Promise<string> {
  const key = `${r.kind}:${r.id}`;
  if (!exploreRowCache.has(key)) {
    exploreRowCache.set(key, (async () => {
      try {
        if (r.kind === "lock") return await lockRowHTML(await readLock(r.id), false, "explore");
        if (r.kind === "burn") return await burnRowHTML(await readBurn(r.id), "explore");
        const v = await readVest(r.id);
        return v ? await vestExploreRowHTML(v) : "";
      } catch { return ""; }
    })());
  }
  return exploreRowCache.get(key)!;
}

/* Warm Explore before anyone asks for it.
 *
 * Every part of this page is a read of public data that does not depend on the
 * connected wallet, so there is nothing to wait for. Starting at app boot means
 * the several seconds of Blockscout and RPC latency happen while the visitor is
 * reading the dashboard, and clicking Explore then renders from memory.
 *
 * Deliberately not awaited by its caller and never rejects, so a cold or broken
 * network delays nothing and breaks nothing. */
let explorePrefetch: Promise<ExploreRef[] | null> | null = null;
function prefetchExplore(): Promise<ExploreRef[] | null> {
  if (!explorePrefetch) {
    explorePrefetch = (async () => {
      const order = await exploreOrder();
      // Fire every row read at once and let them settle into the cache. Nothing
      // awaits them here: loadExplore awaits the same promises, so whatever has
      // finished by the time the visitor arrives is already free.
      if (order) for (const r of order.slice(0, EXPLORE_ROWS)) void exploreRowHTML(r).catch(() => "");
      return order;
    })().catch(() => null);
  }
  return explorePrefetch;
}

/* A placeholder at the same height as the row that will replace it.
 *
 * The point is not decoration, it is that the table reaches its final height in
 * one step. Growing the table as rows arrive moves everything below it and
 * moves whatever the visitor was about to click. */
const exploreSkeletonRow = () =>
  `<tr class="row-skel"><td><div class="sk-tok"><span class="sk-av"></span><span><i class="sk-bar" style="width:74px"></i><i class="sk-bar sk-sm" style="width:96px"></i></span></div></td>` +
  `<td><i class="sk-bar" style="width:88px"></i></td>` +
  `<td><i class="sk-bar" style="width:76px"></i></td>` +
  `<td><i class="sk-bar" style="width:44px"></i></td>` +
  `<td><i class="sk-bar" style="width:92px"></i></td>` +
  `<td style="text-align:right"><i class="sk-bar" style="width:56px"></i></td></tr>`;

async function loadExplore() {
  const box = $("exploreBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading latest activity… <span class="spin"></span></div></div>`;
  // Lock timestamps come from Blockscout and that call alone takes ~3s, so
  // start it now rather than partway through building the rows.
  loadLockedLogs().catch(() => []);

  const order = await prefetchExplore();
  if (order) {
    const wanted = order.slice(0, EXPLORE_ROWS);

    // The whole table at its final height, immediately. Everything after this
    // swaps a row for a row, so nothing below the table ever moves again.
    box.innerHTML = `<table class="tbl-fixed">${TABLE_HEAD_EXPLORE}<tbody>${wanted.map(exploreSkeletonRow).join("")}</tbody></table>`;
    const tbody = box.querySelector("tbody")!;
    const slots = [...tbody.children] as HTMLElement[];
    let painted = 0;

    // Every row is fetched at once and fills its own slot the moment it lands.
    // The previous version awaited a batch before starting the next, which made
    // the total wait the sum of the batches rather than the slowest single row,
    // and produced the visible staircase.
    await Promise.all(wanted.map(async (r, i) => {
      const html = await exploreRowHTML(r);
      const slot = slots[i];
      if (!slot.isConnected) return;
      if (!html) { slot.remove(); return; }
      // Wired on a detached container, because wireActions has no already-wired
      // guard and finds [data-proof] with querySelectorAll, which never matches
      // the element it is called on, and data-proof sits on the tr itself.
      const staging = document.createElement("tbody");
      staging.innerHTML = html;
      wireActions(staging); wireVestActions(staging);
      const tr = staging.firstElementChild as HTMLElement | null;
      if (!tr) { slot.remove(); return; }
      tr.classList.add("row-in");
      slot.replaceWith(tr); // replaceWith keeps the position, so nothing reorders
      painted++;
    }));

    if (!painted) {
      // We knew about records from the logs but could not read a single one, so
      // this is a failure, not an empty chain. Saying "nothing yet" here would
      // tell a visitor the product is unused when the truth is the RPC is down.
      box.innerHTML = `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">Check your connection and try again.</div></div>`;
      return;
    }
    exploreLoaded = true;
    return;
  }

  // Fallback: no event logs, so candidates have to come from the totals and the
  // whole set has to be read before it can be ordered.
  try {
    const [totalLocks, totalBurns, totalVests] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }).then(Number),
      BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "totalBurns" }).then(Number).catch(() => 0)) : Promise.resolve(0),
      VESTING ? (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "totalSchedules" }).then(Number).catch(() => 0)) : Promise.resolve(0),
    ]);
    if (!totalLocks && !totalBurns && !totalVests) { box.innerHTML = `<div class="empty"><div class="big">Nothing yet</div><div class="small">Be the first to lock, burn or vest on Robinhood Chain.</div></div>`; exploreLoaded = true; return; }
    const lockIds: number[] = []; for (let i = totalLocks - 1; i >= 0 && lockIds.length < EXPLORE_ROWS; i--) lockIds.push(i);
    const burnIds: number[] = []; for (let i = totalBurns - 1; i >= 0 && burnIds.length < EXPLORE_ROWS; i--) burnIds.push(i);
    const vestIds: number[] = []; for (let i = totalVests - 1; i >= 0 && vestIds.length < EXPLORE_ROWS; i--) vestIds.push(i);
    const [lockRows, burnRows, vestRows] = await Promise.all([
      Promise.all(lockIds.map(readLock)),
      Promise.all(burnIds.map(readBurn)),
      Promise.all(vestIds.map((i) => readVest(i).catch(() => null))),
    ]);
    const vests = vestRows.filter((v): v is VestRow => !!v);
    // One table, one look: vesting rows share the explore columns with locks/burns.
    // Both halves read token metadata and prices, so build them together —
    // waiting for the vesting rows first doubled the time to first render.
    const rowsHTML = await buildExploreRows(lockRows, burnRows, vests);
    box.innerHTML = `<table class="tbl-fixed">${TABLE_HEAD_EXPLORE}<tbody>${rowsHTML}</tbody></table>`;
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
    const idx = await recordIds(addr);
    const [byToken, byOwner, burnsTok, burnsBy] = idx
      ? [asBig(idx.locks.token), asBig(idx.locks.owner), asBig(idx.burns.token), asBig(idx.burns.burner)]
      : await Promise.all([
        pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByToken", args: [addr] }) as Promise<bigint[]>,
        pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByOwner", args: [addr] }) as Promise<bigint[]>,
        BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByToken", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]) : Promise.resolve([] as bigint[]),
        BURNER ? (pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "burnsByBurner", args: [addr] }) as Promise<bigint[]>).catch(() => [] as bigint[]) : Promise.resolve([] as bigint[]),
      ]);
    // …and vesting schedules for the token, the recipient, or the creator
    const [vestTok, vestBen, vestCre] = idx
      ? [asBig(idx.vests.token), asBig(idx.vests.beneficiary), asBig(idx.vests.creator)]
      : VESTING
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
      const [rows, burns, vrows] = await Promise.all([
        Promise.all(ids.map(readLock)),
        Promise.all(burnIds.map(readBurn)),
        Promise.all(vestIds.map((i) => readVest(i).catch(() => null)))
          .then((a) => a.filter((v): v is VestRow => !!v)),
      ]);
      // Search results are one list too — same ordering rule as Explore.
      const combined = await buildExploreRows(rows, burns, vrows, 100);
    box.innerHTML = combined ? `<table class="tbl-fixed">${TABLE_HEAD_EXPLORE}<tbody>${combined}</tbody></table>` : `<div class="empty"><div class="big">No locks found</div><div class="small"></div></div>`;
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
  try { l = await readLock(id); } catch (e) { box.innerHTML = e instanceof RecordNotFound
      ? `<div class="empty"><div class="big">Lock #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`
      : `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">The network is busy right now. Nothing is wrong with this lock.</div><button class="btn btn-line btn-sm" style="margin-top:12px" data-proofretry="lock:${id}">Try again</button></div>`; return; }
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
  } catch (e) { box.innerHTML = e instanceof RecordNotFound
      ? `<div class="empty"><div class="big">Burn #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`
      : `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">The network is busy right now. Nothing is wrong with this burn.</div><button class="btn btn-line btn-sm" style="margin-top:12px" data-proofretry="burn:${id}">Try again</button></div>`; return; }
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
      <div class="tile"><div class="k">Commission rate</div><div class="v g">${Math.round((me.commission || 0) * 100)}%</div><div class="d">${(me.commission || 0) > 0.3 ? "boosted rate" : "your share"}</div></div>
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
      <div class="tile"><div class="k">Commission rate</div><div class="v g">${Math.round((me.commission || 0) * 100)}%</div><div class="d">your share</div></div>
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
        <p>Include the script once, then add a button with <code>data-hoodlock</code> for each product you want to offer. <code>data-mode</code> picks between <code>lock</code> (the default), <code>burn</code> and <code>vesting</code>; clicking opens that flow in a modal on your page.</p><p class="hintline">Every attribute except <code>data-hoodlock</code> is optional, and the buttons are independent — a lock-only integration is one button with no attributes at all. You earn on whichever products you add.</p><table class="dev-attrs"><thead><tr><th>Attribute</th><th>Required</th><th>What it does</th></tr></thead><tbody><tr><td><code>data-hoodlock</code></td><td>yes</td><td>Marks the button. Nothing else is needed for a lock.</td></tr><tr><td><code>data-mode</code></td><td>no</td><td><code>lock</code> (default), <code>burn</code> or <code>vesting</code>.</td></tr><tr><td><code>data-token</code></td><td>no</td><td>Contract address of the token. Pre-fills the field and makes it read-only, so the user can't pick a different token. Leave it out and they choose from their own wallet.</td></tr><tr><td><code>data-beneficiary</code></td><td>no</td><td>Vesting only. Pre-fills who receives the tokens; the user can still edit it.</td></tr><tr><td><code>data-unlock</code></td><td>no</td><td>Lock only. Pre-fills the unlock date, as a Unix timestamp in seconds.</td></tr><tr><td><code>data-attribution</code></td><td>no</td><td>On the <code>&lt;script&gt;</code> tag, not the button. Set it to <code>off</code> to leave out the "Secured by HoodLock" line.</td></tr></tbody></table><p class="hintline">The embed adds one small line — <b>Secured by HoodLock</b> — under the first button on the page, inheriting your text colour. It is a plain link, which is the only part of the integration a search engine can see; turn it off with <code>data-attribution="off"</code> if it doesn't suit your page.</p><p class="hintline">Values like <code>\${token.address}</code> above are placeholders — insert them from your own data at render time, since they differ per page. They are not literal strings to paste.</p>
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
        <h4>4 · SDK (npm / Node)</h4>
        <p>Server-side or build-step integrations use <code>@hoodlock/sdk</code>: airdrop creation and claims, the same Merkle code our server runs (your roots always match our claim pages), plus the attribution and lock-intent calls from this program. No keys are held by the SDK; every write returns calldata for your own signer.</p>
        <pre class="code-block">import { HoodLock } from "@hoodlock/sdk";

const hl = new HoodLock({ apiKey: "pk_…" });
const list = hl.buildList("0xabc… 100\n0xdef… 250");
const tx = await hl.createAirdropTx({ token, list, deadlineDays: 30 });
// sign tx.approve, then tx.create — or hl.sendAirdrop() with a viem walletClient</pre>
        <p class="hintline">Source and full README: <a href="https://github.com/predictinj/hoodlock/tree/main/sdk" target="_blank" rel="noopener" style="color:var(--neon)">github.com/predictinj/hoodlock → sdk/</a></p>
        <h4>5 · Network and contracts</h4>
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
// Airdrop fees are quote(recipients) at creation, not one flat number, so each
// airdrop carries the fee it actually paid instead of using prodData.fees.
type DropItem = ProdItem & { fee: number };
let prodData: { locks: ProdItem[]; burns: ProdItem[]; vests: ProdItem[]; drops: DropItem[]; lockTs: Map<string, number>; fees: { lock: number; burn: number; vest: number }; ethUsd: number } | null = null;
let prodRange = 0; // days; 0 = lifetime
function renderProducts() {
  const box = document.getElementById("adProdBox"); if (!box || !prodData) return;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = prodRange > 0 ? now - prodRange * 86400 : 0;
  const inRange = (i: ProdItem) => prodRange === 0 || i.ts >= cutoff;
  const sub = document.getElementById("adProdSub");
  if (sub) sub.textContent = prodRange === 0 ? "REVENUE · USERS · ACTIVITY — LIFETIME" : `REVENUE · USERS · ACTIVITY — LAST ${prodRange} DAY${prodRange === 1 ? "" : "S"}`;

  const L = prodData.locks.filter(inRange), B = prodData.burns.filter(inRange), V = prodData.vests.filter(inRange);
  const D = prodData.drops.filter(inRange);
  const u = (xs: ProdItem[]) => new Set(xs.map((x) => x.wallet)).size;
  const all = new Set([...L, ...B, ...V, ...D].map((x) => x.wallet)).size;
  const revL = L.length * prodData.fees.lock, revB = B.length * prodData.fees.burn, revV = V.length * prodData.fees.vest;
  const revD = D.reduce((n, d) => n + d.fee, 0);
  const usd = prodData.ethUsd;
  const rev = (n: number) => `${n.toFixed(4)} ETH${usd > 0 ? ` <span style="color:var(--ink-3);font-size:11px">≈ ${fmtUsd(n * usd)}</span>` : ""}`;
  // "Active" is a point-in-time count, so it always reflects now regardless of range
  const activeLocks = prodData.locks.filter((x) => x.active).length;
  const activeVest = prodData.vests.filter((x) => x.active).length;
  const openDrops = prodData.drops.filter((x) => x.active).length;
  // The airdrops row only exists on deployments that have the contract at all.
  const dropRow = AIRDROP
    ? `<tr><td><b>Airdrops</b></td><td>${D.length}</td><td>${rev(revD)}</td><td>${u(D)}</td><td>${openDrops} open</td></tr>`
    : "";
  box.innerHTML = `<table style="table-layout:fixed;width:100%"><thead><tr>
      <th style="width:22%">Product</th><th style="width:14%">Count</th><th style="width:26%">Revenue</th><th style="width:20%">Unique users</th><th style="width:18%">Active now</th></tr></thead><tbody>
    <tr><td><b>Token Locks</b></td><td>${L.length}</td><td>${rev(revL)}</td><td>${u(L)}</td><td>${activeLocks} locked</td></tr>
    <tr><td><b>Burns</b></td><td>${B.length}</td><td>${rev(revB)}</td><td>${u(B)}</td><td>—</td></tr>
    <tr><td><b>Vesting</b></td><td>${V.length}</td><td>${rev(revV)}</td><td>${u(V)}</td><td>${activeVest} vesting</td></tr>
    ${dropRow}
    <tr style="border-top:1px solid var(--line-2)"><td><b style="color:var(--neon)">TOTAL</b></td><td><b>${L.length + B.length + V.length + D.length}</b></td><td><b>${rev(revL + revB + revV + revD)}</b></td><td><b>${all}</b></td><td>—</td></tr>
    </tbody></table>`;
}
document.querySelectorAll<HTMLElement>("#adProdRange .chip-dur").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll("#adProdRange .chip-dur").forEach((x) => x.classList.remove("on"));
  c.classList.add("on");
  prodRange = Number(c.dataset.range);
  renderProducts();
}));

/** Airdrops for the product table.
 *
 * Counts and creators come from /api/airdrops. Revenue cannot: the fee is
 * quote(recipients) at creation, so there is no flat number to multiply by.
 * The ETH value of each creation transaction IS the fee that was paid, and a
 * paid fee can never change, so each one is read from the chain once and then
 * kept in localStorage forever. */
async function loadProdDrops() {
  if (!AIRDROP) return;
  try {
    const r = await fetch("/api/airdrops").then((x) => x.json());
    const drops: any[] = r.airdrops || [];
    const nowS = Math.floor(Date.now() / 1000);
    let feeCache: Record<string, string> = {};
    try { feeCache = JSON.parse(localStorage.getItem("hl_adfees") || "{}") || {}; } catch { /* rebuild below */ }
    const items = await Promise.all(drops.map(async (a): Promise<DropItem> => {
      let fee = 0;
      if (feeCache[a.id] !== undefined) fee = Number(feeCache[a.id]) || 0;
      else if (a.tx) {
        try {
          const t = await pub.getTransaction({ hash: a.tx });
          fee = Number(formatUnits(t.value, 18)) || 0;
          feeCache[a.id] = String(fee);
        } catch { /* leave 0 for this render; retried on the next load */ }
      }
      return {
        ts: Number(a.ts || 0),
        wallet: String(a.creator || "").toLowerCase(),
        active: Number(a.endTime) === 0 || nowS < Number(a.endTime),
        fee,
      };
    }));
    try { localStorage.setItem("hl_adfees", JSON.stringify(feeCache)); } catch { /* cache only */ }
    if (!prodData) return;
    prodData.drops = items;
    renderProducts();
  } catch { /* the table keeps its other rows */ }
}

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

/** Airdrop analytics for the admin console.
 *
 * Everything comes from /api/airdrops, which is already built from the same
 * event pass, so this adds no chain read beyond pricing the tokens.
 *
 * Two rules the numbers follow. Funded is what left the creator's wallet;
 * claimed is what recipients have actually taken, and the two are different
 * facts worth seeing side by side. And a token with no WETH pair has no price,
 * which is reported as "N of M priced" rather than folded in as zero: a
 * silently unpriced token would understate the total and look like a real
 * figure.
 */
/* admin: route platform fees through the 50/50 revenue splitter.
 *
 * The server deploys the splitter itself once the drop wallet has gas; this
 * card then offers the owner the four one-click setFeeCollector switches
 * (the connected admin wallet is the contracts' admin, so the txs are its
 * to sign). Once all four read ROUTED, the weekly drop funds itself. */
const FEECOL_ABI = [
  { type: "function", name: "feeCollector", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setFeeCollector", stateMutability: "nonpayable", inputs: [{ name: "c", type: "address" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
/* The locker still answers to its original deploy wallet, so the routing
 * switch must be signed by that wallet. This view is the in-house path: no
 * admin console needed (the console is gated to the main wallet), no
 * explorer. Connect the old wallet, one action does both transactions:
 * route the fees, then hand admin to the main wallet for good. */
const FX_ABI = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeCollector", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setFeeCollector", stateMutability: "nonpayable", inputs: [{ name: "c", type: "address" }], outputs: [] },
  { type: "function", name: "setAdmin", stateMutability: "nonpayable", inputs: [{ name: "a", type: "address" }], outputs: [] },
] as const;
async function loadFixLocker() {
  const box = $("fxBox"), msg = $("fxMsg");
  try {
    const [adminNow, colNow, poolInfo] = await Promise.all([
      pub.readContract({ address: LOCKER, abi: FX_ABI, functionName: "admin" }) as Promise<string>,
      pub.readContract({ address: LOCKER, abi: FX_ABI, functionName: "feeCollector" }) as Promise<string>,
      fetch("/api/revenue/pool").then((r) => r.json()).catch(() => null),
    ]);
    const splitter = poolInfo?.automation?.splitter as string | null;
    const routed = !!splitter && colNow.toLowerCase() === splitter.toLowerCase();
    const handed = adminNow.toLowerCase() === ADMIN_WALLET;
    if (routed && handed) {
      box.innerHTML = `<div class="empty"><div class="big">All done</div><div class="small">Locker fees route through the splitter and admin belongs to the main wallet. Nothing left to do here.</div></div>`;
      return;
    }
    if (!splitter) {
      box.innerHTML = `<div class="empty"><div class="small">The splitter is not deployed yet. Check the admin console first.</div></div>`;
      return;
    }
    const rowsHtml = `
      <div class="rv-sim-row"><span class="rv-sim-label">Locker admin today</span><b class="mono" style="font-size:13px">${short(adminNow)}</b></div>
      <div class="rv-sim-row"><span class="rv-sim-label">Fees currently go to</span><b class="mono" style="font-size:13px">${short(colNow)}${routed ? " (splitter)" : ""}</b></div>
      <div class="rv-sim-row"><span class="rv-sim-label">Fees should go to</span><b class="mono" style="font-size:13px">${short(splitter)} (splitter)</b></div>
      <div class="rv-sim-row" style="margin-bottom:14px"><span class="rv-sim-label">Admin should become</span><b class="mono" style="font-size:13px">${short(ADMIN_WALLET)} (main wallet)</b></div>`;
    if (!account) {
      box.innerHTML = rowsHtml + `<button class="btn btn-neon" id="fxConnect" style="width:100%">Connect the locker admin wallet</button>
        <div class="hintline" style="margin-top:8px">Connect <span class="mono">${escape(adminNow)}</span>, the wallet that deployed the locker.</div>`;
      document.getElementById("fxConnect")?.addEventListener("click", openWalletModal);
      return;
    }
    if (account.toLowerCase() !== adminNow.toLowerCase()) {
      box.innerHTML = rowsHtml + `<div class="hintline">Connected as <span class="mono">${short(account)}</span>, but only the locker admin
        <span class="mono">${escape(adminNow)}</span> can sign this. Switch account in your wallet, or</div>
        <button class="btn btn-line btn-sm" id="fxReconnect" style="margin-top:10px">Connect a different wallet</button>`;
      document.getElementById("fxReconnect")?.addEventListener("click", openWalletModal);
      return;
    }
    box.innerHTML = rowsHtml + `<button class="btn btn-neon" id="fxGo" style="width:100%">${routed ? "Hand over admin" : handed ? "Route fees via splitter" : "Route fees + hand over admin"}</button>
      <div class="hintline" style="margin-top:8px">${routed || handed ? "One transaction." : "Two transactions, confirmed one after the other."}</div>`;
    document.getElementById("fxGo")?.addEventListener("click", async () => {
      const b = document.getElementById("fxGo") as HTMLButtonElement;
      try {
        b.disabled = true;
        msg.style.display = "block"; msg.className = "msg";
        if (!routed) {
          msg.textContent = "1/2 Routing fees, confirm in wallet…";
          const h1 = await send(LOCKER, encodeFunctionData({ abi: FX_ABI, functionName: "setFeeCollector", args: [getAddress(splitter)] }));
          msg.innerHTML = `Routing… <span class="spin"></span>`;
          await waitTx(h1);
        }
        if (!handed) {
          msg.textContent = "2/2 Handing over admin, confirm in wallet…";
          const h2 = await send(LOCKER, encodeFunctionData({ abi: FX_ABI, functionName: "setAdmin", args: [getAddress(ADMIN_WALLET)] }));
          msg.innerHTML = `Handing over… <span class="spin"></span>`;
          await waitTx(h2);
        }
        msg.className = "msg ok"; msg.textContent = "Done. Locker fees route 50/50 and the main wallet is admin.";
        loadFixLocker();
      } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); b.disabled = false; }
    });
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Couldn't read the locker state right now.</div></div>`;
  }
}

async function loadAdminSplit() {
  const card = document.getElementById("adSplitCard"), box = document.getElementById("adSplitBox");
  if (!card || !box) return;
  try {
    /**
     * The splitter is the DEPLOYED one from config, not the one the server's
     * automation reports. Those are two different contracts: the automation
     * splitter pays an EOA on its ops side, the deployed one pays the buyback
     * vault. Routing fees at the wrong one sends half the revenue to a wallet
     * instead of to $LOCK lockers, and RevenueSplitter payees are immutable, so
     * it is not a mistake that can be corrected in place.
     */
    if (!(cfg as any).revenueSplitter) { card.style.display = "none"; return; }
    const splitter = getAddress((cfg as any).revenueSplitter) as `0x${string}`;
    card.style.display = "";
    const targets: [string, `0x${string}` | null][] = [["Locker", LOCKER], ["Burner", BURNER], ["Vesting", VESTING], ["Airdrop", AIRDROP]];
    const states = await Promise.all(targets.map(async ([name, addr]) => {
      if (!addr) return null;
      const [col, adm] = await Promise.all([
        (pub.readContract({ address: addr, abi: FEECOL_ABI, functionName: "feeCollector" }) as Promise<string>).catch(() => null),
        (pub.readContract({ address: addr, abi: FX_ABI, functionName: "admin" }) as Promise<string>).catch(() => null),
      ]);
      return { name, addr, routed: !!col && col.toLowerCase() === splitter.toLowerCase(),
        foreignAdmin: !!adm && adm.toLowerCase() !== ADMIN_WALLET };
    }));
    const live = states.filter((s): s is NonNullable<typeof s> => !!s);
    // Every product this wallet can actually point at the splitter right now.
    const pending = live.filter((s) => !s.routed && !s.foreignAdmin);
    const balSp = await pub.getBalance({ address: splitter }).catch(() => 0n);
    box.innerHTML = live.map((s) => `
      <div class="rv-sim-row" style="margin-bottom:8px"><span class="rv-sim-label">${s.name} fees</span>
        ${s.routed ? `<span class="status locked"><i></i>ROUTED 50/50</span>`
        : s.foreignAdmin ? `<a class="btn btn-neon btn-sm" href="/app/fixlocker">Fix with the old wallet</a>`
        : `<button class="btn btn-neon btn-sm" data-adroute="${s.addr}">Route via splitter</button>`}</div>`).join("")
      + (pending.length > 1 ? `<button class="btn btn-neon" id="adRouteAll" style="width:100%;margin-top:6px">
           Route all ${pending.length} via splitter</button>
         <div class="hintline" style="margin-top:6px">${pending.length} wallet confirmations, one after another.</div>` : "")
      + `<div class="hintline" style="margin-top:10px">Splitter <span class="mono">${short(splitter)}</span> · holding ${Number(formatUnits(balSp, 18)).toFixed(5)} ETH
         ${balSp > 0n ? `<button class="btn btn-line btn-sm" id="adSplitRelease" style="margin-left:10px">Release 50/50 now</button>` : ""}</div>`;
    const msg = $("adSplitMsg");

    const routeOne = async (addr: `0x${string}`) => {
      const h = await send(addr, encodeFunctionData({ abi: FEECOL_ABI, functionName: "setFeeCollector", args: [splitter] }));
      await waitTx(h);
    };

    box.querySelectorAll<HTMLButtonElement>("[data-adroute]").forEach((b) => b.addEventListener("click", async () => {
      try {
        b.disabled = true;
        msg.style.display = "block"; msg.className = "msg"; msg.textContent = "Confirm in wallet…";
        await routeOne(b.dataset.adroute as `0x${string}`);
        msg.className = "msg ok"; msg.textContent = "Routed ✓";
        loadAdminSplit();
      } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); b.disabled = false; }
    }));

    /**
     * One button, but still one signature per contract: each product stores its
     * own collector and there is no batching contract to route through. It stops
     * at the first failure rather than pushing on, so a rejected signature
     * halfway through leaves a state the panel can show honestly on reload.
     */
    document.getElementById("adRouteAll")?.addEventListener("click", async () => {
      const btn = document.getElementById("adRouteAll") as HTMLButtonElement;
      btn.disabled = true;
      msg.style.display = "block";
      let done = 0;
      for (const s of pending) {
        try {
          msg.className = "msg";
          msg.innerHTML = `${s.name}: confirm in wallet (${done + 1} of ${pending.length})… <span class="spin"></span>`;
          await routeOne(s.addr as `0x${string}`);
          done++;
        } catch (e: any) {
          msg.className = "msg bad";
          msg.textContent = `Stopped at ${s.name} after routing ${done} of ${pending.length}. ${friendlyErr(e)}`;
          loadAdminSplit();
          return;
        }
      }
      msg.className = "msg ok"; msg.textContent = `All ${done} routed ✓`;
      loadAdminSplit();
    });
    document.getElementById("adSplitRelease")?.addEventListener("click", async () => {
      try {
        msg.style.display = "block"; msg.className = "msg"; msg.textContent = "Confirm in wallet…";
        const h = await send(splitter, encodeFunctionData({ abi: FEECOL_ABI, functionName: "release" }));
        await waitTx(h);
        msg.className = "msg ok"; msg.textContent = "Released ✓";
        loadAdminSplit();
      } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); }
    });
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Couldn't read the routing state right now.</div></div>`;
  }
}

async function loadAdminAirdrops() {
  const box = $("adDropTokens");
  if (!AIRDROP) {
    $("adDropCount").textContent = "—";
    $("adDropSub").textContent = "AIRDROPS ARE NOT CONFIGURED ON THIS DEPLOYMENT";
    box.innerHTML = "";
    return;
  }
  try {
    const r = await fetch("/api/airdrops").then((x) => x.json());
    const drops: any[] = r.airdrops || [];
    const now = Math.floor(Date.now() / 1000);

    const open = drops.filter((a) => a.endTime === 0 || now < a.endTime).length;
    const wallets = drops.reduce((n, a) => n + Number(a.maxClaims || 0), 0);
    const claims = drops.reduce((n, a) => n + Number(a.claims || 0), 0);

    $("adDropCount").textContent = drops.length.toLocaleString("en-US");
    $("adDropCountSub").textContent = drops.length
      ? `${open.toLocaleString("en-US")} still open`
      : "none yet";
    $("adDropWallets").textContent = wallets.toLocaleString("en-US");
    $("adDropWalletsSub").textContent = wallets
      ? `${claims.toLocaleString("en-US")} claimed · ${Math.round((claims / wallets) * 100)}%`
      : "no recipients yet";

    if (!drops.length) {
      $("adDropUsd").textContent = "$0";
      $("adDropEth").textContent = "nothing funded yet";
      box.innerHTML = "";
      return;
    }

    // Per token, because summing raw amounts across different tokens is a
    // number that means nothing.
    const byToken = new Map<string, { funded: bigint; claimed: bigint; drops: number }>();
    for (const a of drops) {
      const t = String(a.token).toLowerCase();
      const cur = byToken.get(t) || { funded: 0n, claimed: 0n, drops: 0 };
      cur.funded += BigInt(a.total);
      cur.claimed += BigInt(a.claimed);
      cur.drops += 1;
      byToken.set(t, cur);
    }

    let usdFunded = 0, usdClaimed = 0, priced = 0;
    const rows = await Promise.all([...byToken.entries()].map(async ([token, v]) => {
      const m = await tokMeta(token);
      const fUsd = await amountValueUsd(pub as any, token as `0x${string}`, v.funded, m.decimals).catch(() => null);
      const cUsd = await amountValueUsd(pub as any, token as `0x${string}`, v.claimed, m.decimals).catch(() => null);
      if (fUsd !== null) { usdFunded += fUsd; priced += 1; }
      if (cUsd !== null) usdClaimed += cUsd;
      return `<tr>
        <td><div class="tk-cell">${await tokenIcoHTML(token, m.symbol)}
          <div><div class="n">$${escape(m.symbol)}</div><div class="a">${v.drops} airdrop${v.drops === 1 ? "" : "s"}</div></div></div></td>
        <td>${fmtNum(v.funded, m.decimals)} funded</td>
        <td>${fmtNum(v.claimed, m.decimals)} claimed</td>
        <td>${fUsd === null ? '<span style="color:var(--ink-3)">no price</span>' : fmtUsd(fUsd)}</td></tr>`;
    }));

    const ethUsd = Number((typeof localStorage !== "undefined" && localStorage.getItem("hl_ethusd")) || 0);
    $("adDropUsd").textContent = priced ? fmtUsd(usdFunded) : "no price";
    $("adDropEth").textContent = priced
      ? `${ethUsd > 0 ? (usdFunded / ethUsd).toFixed(4) + " ETH · " : ""}${fmtUsd(usdClaimed)} claimed`
        + (priced < byToken.size ? ` · ${priced} of ${byToken.size} tokens priced` : "")
      : `${byToken.size} token${byToken.size === 1 ? "" : "s"}, none with a WETH pair`;

    box.innerHTML = `<table>${rows.join("")}</table>`;
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Couldn't read airdrops right now.</div></div>`;
  }
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
  loadAdminAirdrops();
  loadAdminSplit();
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
    const feeEth = Number(formatUnits(lockFee ?? 0n, 18)) || 0;
    const burnFeeEth = Number(formatUnits(burnFee ?? 0n, 18)) || 0;
    const vestFeeEth = Number(formatUnits(vestingFee ?? 0n, 18)) || 0;
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
      drops: [],
      lockTs: new Map<string, number>(),
      fees: { lock: feeEth, burn: burnFeeEth, vest: vestFeeEth },
      ethUsd,
    };
    loadProdDrops();
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
  try {
    const s: any = await pub.readContract({ address: VESTING!, abi: VESTING_ABI as any, functionName: "getSchedule", args: [BigInt(id)] });
    return { id, creator: getAddress(s.creator), beneficiary: getAddress(s.beneficiary), token: getAddress(s.token),
      total: s.total as bigint, claimed: s.claimed as bigint, start: Number(s.start), cliff: Number(s.cliff), end: Number(s.end) };
  } catch (e) {
    if (e instanceof RecordNotFound) throw e;
    const r = await recordFallback("vesting", id);
    return { id, creator: getAddress(r.creator), beneficiary: getAddress(r.beneficiary), token: getAddress(r.token),
      total: BigInt(r.total), claimed: BigInt(r.claimed), start: Number(r.start), cliff: Number(r.cliff), end: Number(r.end) };
  }
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
      // Logs read from a bare RPC carry no timestamp, so fall back to the block's
      // own time the way locks already do. Without this a schedule could be dated
      // to the epoch — and the result was being cached, so it stayed wrong for the
      // rest of the session.
      const ts = hit.ts || (await blockTs(BigInt(hit.block))) || 0;
      const info = { tx: hit.tx, ts };
      if (ts) vestTxCache.set(id, info);   // don't cache a time we failed to resolve
      return info;
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
  $("vsFee").textContent = vestingFee === null ? "—" : vestingFee > 0n ? `${formatUnits(vestingFee * n, 18)} ETH` : "free";
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
    const vFee = await feeNow(VESTING, VESTING_ABI, "vesting");
    const h = await send(VESTING, data, vFee * n);
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
    const vIdx = await recordIds(account);
    /* The server index lags the chain by its cache TTL plus Blockscout's
     * indexing delay, so a schedule created seconds ago is missing from it
     * and "Created by you" looked like the transaction did nothing. The
     * contract's creator array is safe to read directly: only the wallet
     * itself can append to it (create sets creator = msg.sender), so the
     * junk-spam problem the server index exists for cannot occur there.
     * Union of both, capped, so the row is there the moment the tx lands.
     * The beneficiary array stays server-first — anyone can append to that
     * one for the price of a 1-wei schedule. */
    const chainCre = await (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByCreator", args: [account as `0x${string}`] }) as Promise<bigint[]>).catch(() => [] as bigint[]);
    const benIds = vIdx
      ? asBig(vIdx.vests.beneficiary).reverse()
      : await (pub.readContract({ address: VESTING, abi: VESTING_ABI as any, functionName: "schedulesByBeneficiary", args: [account as `0x${string}`] }) as Promise<bigint[]>).catch(() => [] as bigint[]);
    const creIds = asBig([...new Set([...(vIdx ? vIdx.vests.creator : []), ...chainCre.map((x) => Number(x))])]
      .sort((a, b) => a - b).slice(-250)).reverse();
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

/* lock move modal — same fix as vesting's Move, for locks. The classic
   support case: someone locked from the wrong wallet. transferLockOwnership
   is owner-gated on chain, so the wallet that locked signs the move and the
   tokens never leave the vault. */
let lkMoveId = -1;
async function openLockMoveModal(id: number) {
  lkMoveId = id;
  ($("lkMoveAddr") as HTMLInputElement).value = "";
  const msg = $("lkMoveMsg"); msg.textContent = ""; msg.className = "msg";
  $("lkMoveCurrent").innerHTML = `Lock <b>#${id}</b> — loading…`;
  $("lkMoveModal").classList.add("show");
  try {
    const l = await readLock(id);
    const m = await tokMeta(l.token);
    $("lkMoveCurrent").innerHTML = `Lock <b>#${id}</b> · <b>${fmtNum(l.amount, m.decimals)} $${escape(m.symbol)}</b> locked until <b>${dateLabel(l.unlockTime)}</b>, currently owned by <b>${short(l.owner)}</b>. Pick the wallet that should own it from now on.`;
  } catch { $("lkMoveCurrent").innerHTML = `Lock <b>#${id}</b>`; }
}
function closeLockMoveModal() { $("lkMoveModal").classList.remove("show"); }
if (document.getElementById("lkMoveModal")) {
  $("lkMoveClose").addEventListener("click", closeLockMoveModal);
  $("lkMoveCancel").addEventListener("click", closeLockMoveModal);
  $("lkMoveModal").addEventListener("click", (e) => { if (e.target === $("lkMoveModal")) closeLockMoveModal(); });
  $("lkMoveConfirm").addEventListener("click", async () => {
    const msg = $("lkMoveMsg"); msg.className = "msg";
    const raw = ($("lkMoveAddr") as HTMLInputElement).value.trim();
    if (!isAddress(raw)) { msg.className = "msg bad"; msg.textContent = "Enter a valid wallet address (0x…)."; return; }
    const btn = $("lkMoveConfirm") as HTMLButtonElement;
    try {
      btn.disabled = true;
      msg.textContent = "Confirm in wallet…";
      const h = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "transferLockOwnership", args: [BigInt(lkMoveId), getAddress(raw)] }));
      msg.innerHTML = `Moving… <span class="spin"></span>`;
      await waitTx(h);
      closeLockMoveModal();
      notify("Lock moved ✓");
      renderMine();
    } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); }
    finally { btn.disabled = false; }
  });
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
  } catch (e) { box.innerHTML = e instanceof RecordNotFound
      ? `<div class="empty"><div class="big">Vesting #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`
      : `<div class="empty"><div class="big">Couldn't reach Robinhood Chain</div><div class="small">The network is busy right now. Nothing is wrong with this vesting.</div><button class="btn btn-line btn-sm" style="margin-top:12px" data-proofretry="vesting:${id}">Try again</button></div>`; return; }
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

/* ═══════════════════════════ airdrops ═══════════════════════════
 *
 * Nothing is pushed to a wallet. The creator funds a Merkle root and each
 * recipient comes here and takes their own leaf, which is the point of the
 * product rather than a limitation of it.
 *
 * The tree is built here, in the browser, from the same shared module the
 * server serves proofs from and the contract verifies against. Three
 * implementations of one convention, so they are one file.
 */
import { buildTree } from "@shared/merkle.mjs";
import { buildList, fromBaseUnits, toBaseUnits } from "@shared/airdrop-list.mjs";

const AIRDROP = (cfg as any).airdrop && isAddress((cfg as any).airdrop)
  ? (getAddress((cfg as any).airdrop) as `0x${string}`) : null;

const AIRDROP_ABI = [
  { type: "function", name: "create", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "merkleRoot", type: "bytes32" }, { name: "total", type: "uint256" },
    { name: "maxClaims", type: "uint32" }, { name: "endTime", type: "uint64" }, { name: "uri", type: "string" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [
    { name: "id", type: "uint256" }, { name: "index", type: "uint256" }, { name: "account", type: "address" },
    { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
  { type: "function", name: "sweep", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ name: "n", type: "uint32" }], outputs: [{ type: "uint256" }] },
] as const;

let adTokenMeta: { addr: `0x${string}`; symbol: string; decimals: number; bal: bigint } | null = null;
let adMode: "equal" | "each" = "equal";
let adDeadlineDays = 0;
let adBuilt: { entries: { address: string; amount: bigint }[]; root: string; total: bigint; count: number } | null = null;

function loadAirdropView() {
  adPriceLead();
  renderAdClaims();
  renderAdHistory();
  adRenderList();
}

/** The price, from the contract rather than from this file.
 *
 * quote() is non-decreasing in the recipient count and quote(1) is feeBase plus
 * one per-wallet unit, so a zero here proves both are zero and the product is
 * genuinely free at any list size. Anything else is quoted as a floor, because
 * the real price depends on how many wallets the creator declares.
 */
async function adPriceLead() {
  const el = $("adPriceLead");
  if (!el) return;
  if (!AIRDROP) { el.style.display = "none"; return; }
  try {
    const one = await pub.readContract({
      address: AIRDROP, abi: AIRDROP_ABI as any, functionName: "quote", args: [1],
    }) as bigint;
    el.style.display = "";
    el.innerHTML = one === 0n
      ? `<span class="tag">FREE</span><span><b>No platform fee, at any list size.</b> You pay the network gas and nothing else.</span>`
      : `<span class="tag">FROM ${escape(formatEther(one))} ETH</span><span><b>Priced by how many wallets you send to.</b> The exact amount is shown before you sign.</span>`;
  } catch {
    // A failed read must not invent a price. Say nothing instead.
    el.style.display = "none";
  }
}

/* ---------- the list ---------- */

function adRenderList() {
  const box = $("adListReport");
  const raw = ($("adList") as HTMLTextAreaElement)?.value || "";
  const dec = adTokenMeta?.decimals ?? 18;

  let equal: bigint | null = null;
  if (adMode === "equal") {
    const v = ($("adEqualAmount") as HTMLInputElement)?.value?.trim();
    if (v) { try { equal = toBaseUnits(v, dec); } catch { equal = null; } }
  }

  if (!raw.trim()) { box.innerHTML = ""; adBuilt = null; adSummary(); return; }

  const list = buildList(raw, { decimals: dec, equalAmount: equal });
  const sym = adTokenMeta ? escape(adTokenMeta.symbol) : "tokens";

  if (!list.count) {
    box.innerHTML = `<div class="hintline" style="color:var(--red)">Nothing usable yet. ${
      list.problems.length ? escape(list.problems[0].reason) + ` (line ${list.problems[0].line})` : "Add an amount, or set one for everyone."}</div>`;
    adBuilt = null; adSummary(); return;
  }

  const tree = buildTree(list.entries);
  adBuilt = { entries: list.entries, root: tree.root, total: list.total, count: list.count };

  /* Every pasted row is shown, in the order it was pasted. Reading back "4
     recipients" after pasting five lines looks like the tool ate one, so
     duplicates are flagged and totalled rather than quietly folded away. */
  const rows = list.rows.slice(0, 200).map((r) => `<tr${r.duplicate ? ' style="color:var(--amber)"' : ""}>
    <td class="addr">${short(r.address)}</td>
    <td style="text-align:right">${fromBaseUnits(r.amount, dec)}</td>
    <td class="dim">${r.duplicate ? `also on another line, receives ${fromBaseUnits(r.combined!, dec)} in total` : ""}</td></tr>`).join("");

  box.innerHTML = `
    ${list.merged ? `<div class="hintline" style="color:var(--amber)">${list.merged} duplicate ${list.merged === 1 ? "address" : "addresses"} merged. Every row is still listed below, and the combined amount is shown on each.</div>` : ""}
    ${list.problems.length ? `<div class="hintline" style="color:var(--red)">${list.problems.length} line${list.problems.length === 1 ? "" : "s"} skipped: ${escape(list.problems[0].reason)} (line ${list.problems[0].line})</div>` : ""}
    <div style="max-height:220px;overflow:auto;margin-top:8px"><table class="mini">${rows}</table></div>
    ${list.rows.length > 200 ? `<div class="hintline">Showing the first 200 of ${list.rows.length} rows.</div>` : ""}
    <div class="hintline" style="margin-top:8px"><b>${list.count}</b> wallets receive <b>${fmtNum(list.total, dec)} $${sym}</b> in total.</div>`;
  adSummary();
}

/** The line above the Review button: how many wallets, and how much in total.
 *
 * Nothing else. The fee, the deadline and the balance all have their own place
 * in the review sheet, and repeating them here made the reader check the same
 * facts twice before pressing a button that only opens a preview. Dropping the
 * fee also drops a chain read that ran on every keystroke of the list. */
function adSummary() {
  const el = $("adSummary");
  if (!AIRDROP || !adBuilt) { el.textContent = ""; return; }
  const dec = adTokenMeta?.decimals ?? 18;
  const wallets = adBuilt.count === 1 ? "1 wallet" : `${adBuilt.count.toLocaleString("en-US")} wallets`;
  const symbol = adTokenMeta ? ` $${escape(adTokenMeta.symbol)}` : "";
  el.innerHTML = `<b>${wallets}</b> · <b>${fmtNum(adBuilt.total, dec)}${symbol}</b> in total`;
}

async function adRefreshToken() {
  adTokenMeta = null; $("adTokenInfo").textContent = ""; $("adBalHint").textContent = "";
  const raw = ($("adTokenAddr") as HTMLInputElement).value.trim();
  if (!isAddress(raw)) { adRenderList(); return; }
  const addr = getAddress(raw) as `0x${string}`;
  try {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: addr, abi: ERC20, functionName: "symbol" }) as Promise<string>,
      pub.readContract({ address: addr, abi: ERC20, functionName: "decimals" }) as Promise<number>,
    ]);
    let bal = 0n;
    if (account) bal = await pub.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [account as `0x${string}`] }) as bigint;
    adTokenMeta = { addr, symbol, decimals: Number(decimals), bal };
    $("adTokenInfo").textContent = `$${symbol} · ${decimals} decimals`;
    if (account) $("adBalHint").textContent = `You hold ${fmtNum(bal, Number(decimals))} $${symbol}`;
  } catch {
    $("adTokenInfo").innerHTML = `<span style="color:var(--red)">Not an ERC-20 on this chain</span>`;
  }
  adRenderList();
}

/* ---------- create ---------- */

/** What the review sheet checks before it will open.
 *
 * The same conditions the send path enforces. Reviewing something that cannot
 * be sent wastes the reader's attention on a deal that does not exist. */
function adReadyOrThrow(): { meta: NonNullable<typeof adTokenMeta>; built: NonNullable<typeof adBuilt> } {
  if (!AIRDROP) throw new Error("Airdrops are not configured on this deployment.");
  if (!adTokenMeta) throw new Error("Enter a token contract first.");
  if (!adBuilt || !adBuilt.count) throw new Error("Add at least one recipient.");
  if (adTokenMeta.bal < adBuilt.total) throw new Error(`You hold ${fmtNum(adTokenMeta.bal, adTokenMeta.decimals)} $${adTokenMeta.symbol}, and this list needs ${fmtNum(adBuilt.total, adTokenMeta.decimals)}.`);
  return { meta: adTokenMeta, built: adBuilt };
}

/** Fill the review sheet and show it. Reads the fee and the allowance from the
 *  chain so what is on screen is what will actually happen, not an estimate. */
async function adOpenReview() {
  const formMsg = $("adMsg");
  try {
    if (!account) return openWalletModal();   // same prompt the lock and vesting forms use
    const { meta, built } = adReadyOrThrow();
    formMsg.style.display = "none";

    const revMsg = $("adRevMsg"); revMsg.style.display = "none"; revMsg.className = "msg";
    $("adRevBody").style.display = "";
    $("adRevDone").style.display = "none";
    $("adRevTitle").textContent = "You're sending";
    ($("adRevConfirm") as HTMLButtonElement).disabled = false;
    $("adRevConfirm").textContent = "Fund airdrop";

    $("adRevAmount").innerHTML = `${fmtNum(built.total, meta.decimals)} $${escape(meta.symbol)}`;
    $("adRevAmountSub").textContent = `of your ${fmtNum(meta.bal, meta.decimals)} $${meta.symbol}`;
    $("adRevIcon").innerHTML = await tokenIcoHTML(meta.addr, meta.symbol);
    $("adRevCount").textContent = built.count === 1 ? "1 wallet" : `${built.count.toLocaleString("en-US")} wallets`;

    const fee = await pub.readContract({
      address: AIRDROP!, abi: AIRDROP_ABI as any, functionName: "quote", args: [built.count],
    }) as bigint;
    const each = adMode === "equal" && built.count
      ? `${fmtNum(built.total / BigInt(built.count), meta.decimals)} $${escape(meta.symbol)}`
      : "varies by wallet";

    const rows: [string, string, string?][] = [
      ["Platform fee", fee === 0n ? "Free" : `${formatEther(fee)} ETH`, fee === 0n ? "free" : ""],
      ["Each wallet gets", each],
      ["Deadline", adDeadlineDays
        ? `${dateLabel(Math.floor(Date.now() / 1000) + adDeadlineDays * 86400)}`
        : "None, claimable forever"],
      ["Unclaimed tokens", adDeadlineDays ? "Return to you after the deadline" : "Can never come back"],
    ];
    $("adRevRows").innerHTML = rows.map(([k, v, cls]) =>
      `<div class="rev-row"><span class="k">${k}</span><span class="v ${cls || ""}">${v}</span></div>`).join("");

    $("adReviewModal").classList.add("show");
  } catch (e: any) {
    formMsg.style.display = "block";
    formMsg.className = "msg bad";
    formMsg.textContent = friendlyErr(e);
  }
}

/* AirdropCreated(uint256 indexed id, address indexed token, address indexed creator, ...)
   The id is the first indexed argument, so it is topics[1] of the log this
   contract emitted in this transaction. */
const T_AIRDROP_CREATED = keccak256(toHex(
  "AirdropCreated(uint256,address,address,bytes32,uint256,uint32,uint64,string)"));

function adIdFromReceipt(receipt: any): number | null {
  const want = String(AIRDROP).toLowerCase();
  for (const l of receipt?.logs || []) {
    if (String(l.address).toLowerCase() !== want) continue;
    if (String(l.topics?.[0]).toLowerCase() !== T_AIRDROP_CREATED.toLowerCase()) continue;
    try { return Number(BigInt(l.topics[1])); } catch { return null; }
  }
  return null;
}

/** The same sheet, now a receipt.
 *
 * The one thing worth saying at this moment is that nothing was sent anywhere.
 * People fund an airdrop expecting tokens to land in wallets, and here they do
 * not: the recipients have to come and take them. So the link they need to
 * share is the whole point of this state, not an afterthought at the bottom. */
function adShowFunded(receipt: any, meta: { symbol: string; decimals: number },
                      built: { total: bigint; count: number }, hash: string) {
  const id = adIdFromReceipt(receipt);
  /* Always the app, never the per-airdrop page. A recipient needs to connect a
     wallet and press Claim, and this is the one view that does both, whichever
     airdrops they happen to be on. The id is still read from the receipt,
     because naming the airdrop is worth doing even when the link is fixed. */
  const url = `${location.origin}/app/airdrops`;

  $("adRevTitle").textContent = "Funded";
  $("adRevBody").style.display = "none";
  $("adRevDone").style.display = "";

  $("adRevDoneHead").textContent = id === null ? "Airdrop funded" : `Airdrop #${id} funded`;
  $("adRevDoneSub").innerHTML =
    `<b>${fmtNum(built.total, meta.decimals)} $${escape(meta.symbol)}</b> is now held for `
    + `<b>${built.count === 1 ? "1 wallet" : built.count.toLocaleString("en-US") + " wallets"}</b>. `
    + `Nothing was sent to them. Each recipient has to open this page with their own wallet and take their share, `
    + `so send them the link.`;

  $("adRevLink").textContent = url;
  ($("adRevOpen") as HTMLAnchorElement).href = url;
  ($("adRevTx") as HTMLAnchorElement).href = `${EXP}/tx/${hash}`;

  const copy = $("adRevCopy") as HTMLButtonElement;
  copy.textContent = "Copy link";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); notify("Link copied — send it to the recipients"); copy.textContent = "Copied ✓"; }
    catch { prompt("Copy this link and send it to the recipients:", url); }
  };
}

async function adCreate() {
  const msg = $("adRevMsg"); msg.style.display = "block"; msg.className = "msg";
  const btn = $("adRevConfirm") as HTMLButtonElement;
  try {
    if (!account) return openWalletModal();   // same prompt the lock and vesting forms use
    const { meta: adTokenMeta, built: adBuilt } = adReadyOrThrow();

    btn.disabled = true;

    /* Publish the list before the transaction. The contract stores only a root,
       so a list nobody can read is an airdrop nobody can claim. Uploading first
       means the claim page works the moment the transaction confirms. */
    msg.textContent = "Publishing the recipient list…";
    const up = await fetch("/api/airdrop/list", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: adBuilt.root, entries: adBuilt.entries.map((e) => ({ address: e.address, amount: e.amount.toString() })) }),
    });
    const upJson = await up.json().catch(() => ({}));
    if (!up.ok) throw new Error(upJson?.error || "Couldn't publish the list. Nothing was sent.");

    const fee = await pub.readContract({ address: AIRDROP, abi: AIRDROP_ABI as any, functionName: "quote", args: [adBuilt.count] }) as bigint;

    const allow = await pub.readContract({ address: adTokenMeta.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, AIRDROP] }) as bigint;
    if (allow < adBuilt.total) {
      msg.textContent = "Approving… confirm in wallet";
      const ah = await send(adTokenMeta.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [AIRDROP, adBuilt.total] }));
      msg.innerHTML = `Approving… <span class="spin"></span>`; await waitTx(ah);
    }

    const endTime = adDeadlineDays ? BigInt(Math.floor(Date.now() / 1000) + adDeadlineDays * 86400) : 0n;
    msg.textContent = "Funding the airdrop… confirm in wallet";
    const h = await send(AIRDROP, encodeFunctionData({
      abi: AIRDROP_ABI as any, functionName: "create",
      args: [adTokenMeta.addr, adBuilt.root as `0x${string}`, adBuilt.total, adBuilt.count, endTime, ""],
    }), fee);
    msg.innerHTML = `Funding… <span class="spin"></span>`;
    const receipt = await waitTx(h);
    adShowFunded(receipt, adTokenMeta, adBuilt, h);
    ($("adList") as HTMLTextAreaElement).value = "";
    adBuilt = null; adRenderList();
    invalidateEvents(); renderAdHistory(true);
  } catch (e: any) {
    msg.className = "msg bad"; msg.textContent = friendlyErr(e);
  } finally {
    ($("adRevConfirm") as HTMLButtonElement).disabled = false;
  }
}

/* ---------- claim ---------- */

async function renderAdClaims() {
  const box = $("adClaimBox"), wrap = $("adClaimWrap");
  // Hidden unless this wallet actually has something to take. Almost nobody is
  // on a list, so a heading over a "nothing waiting" panel is noise on nearly
  // every visit, and it pushes the thing people came to do further down.
  wrap.style.display = "none";
  box.innerHTML = "";
  if (!AIRDROP || !account) return;
  try {
    const r = await fetch(`/api/airdrop/eligible?address=${account}`).then((x) => x.json());
    const items: any[] = r.claimable || [];
    if (!items.length) return;   // stays hidden
    const rows = await Promise.all(items.map(async (it) => {
      const m = await tokMeta(it.token);
      // The amount leads. It is the fact the visitor came for, and the button
      // says only what pressing it does.
      return `<tr>
        <td><div class="tk-cell">${await tokenIcoHTML(it.token, m.symbol)}
          <div><div class="n">${fmtNum(BigInt(it.amount), m.decimals)} $${escape(m.symbol)}</div>
          <div class="a">airdrop #${it.id}</div></div></div></td>
        <td>${it.endTime ? `closes ${dateLabel(it.endTime)}` : "no deadline"}</td>
        <td>${it.shortfall ? `<span class="status unlockable"><i></i>UNDERFUNDED</span>` : ""}</td>
        <td><div class="row-actions"><button class="btn btn-neon btn-sm" data-adclaim="${it.id}" data-adidx="${it.index}" data-adamt="${it.amount}">Claim</button></div></td></tr>`;
    }));
    box.innerHTML = `<table>${rows.join("")}</table>`;
    wrap.style.display = "";   // only now is there something worth a heading
    box.querySelectorAll<HTMLButtonElement>("[data-adclaim]").forEach((b) => {
      b.onclick = () => adClaim(Number(b.dataset.adclaim), Number(b.dataset.adidx), BigInt(b.dataset.adamt!), b);
    });
  } catch {
    // The one case that stays visible with nothing to claim. Hiding it would
    // turn "we could not check" into "you have nothing", and a wallet that is
    // on a list would walk away believing it is not.
    box.innerHTML = `<div class="empty"><div class="big">Couldn't check right now</div><div class="small">The network is busy. Nothing was sent; try again in a moment.</div></div>`;
    wrap.style.display = "";
  }
}

async function adClaim(id: number, index: number, amount: bigint, btn: HTMLButtonElement) {
  if (!AIRDROP || !account) return;
  btn.disabled = true; btn.textContent = "Claiming…";
  try {
    /* The proof is fetched fresh rather than trusted from the list render, so a
       stale page cannot send a transaction that is certain to revert. */
    const p = await fetch(`/api/airdrop/${id}/proof?address=${account}`).then((r) => r.json());
    if (!p?.proof) throw new Error("Couldn't build the proof for this wallet. Nothing was sent.");
    const h = await send(AIRDROP, encodeFunctionData({
      abi: AIRDROP_ABI as any, functionName: "claim",
      args: [BigInt(id), BigInt(p.index), getAddress(p.account) as `0x${string}`, BigInt(p.amount), p.proof],
    }));
    await waitTx(h);
    notify("Claimed ✓");
    /* The row stays, with the button spent.
     *
     * Re-rendering here would drop the row, because the airdrop is no longer
     * claimable by this wallet, and the proof that the claim worked would
     * vanish from the exact spot the person was looking at. Dropping btn-neon
     * also takes it out of the call-to-action styling, so nothing on screen
     * still invites a press. The row is gone on the next load, by which time
     * the tokens are in the wallet. */
    btn.classList.remove("btn-neon");
    btn.classList.add("btn-line");
    btn.disabled = true;
    btn.textContent = "Claimed";
    invalidateEvents();
    // The claim belongs in the history below, and it has to be a forced read:
    // the index has not seen the receipt yet at ordinary cache age.
    renderAdHistory(true);
  } catch (e: any) {
    notify(friendlyErr(e));
    btn.disabled = false; btn.textContent = "Claim";
  }
}

/* ---------- what this wallet funded ---------- */

/** Both sides of this wallet's dealings with airdrops: what it sent, what it took.
 *
 * `fresh` bypasses the server's caches. Used right after funding, sweeping or
 * claiming, when the person is watching for their own transaction to show up.
 * The log cache and the index cache each hold a minute and serve stale while
 * refreshing, so without this the screen can insist nothing happened for two
 * minutes after a transaction that plainly worked.
 */
async function renderAdHistory(fresh = false) {
  const box = $("adHistoryBox");
  if (!AIRDROP) { box.innerHTML = ""; return; }
  if (!account) { box.innerHTML = `<div class="empty"><div class="small">Connect your wallet to see what you have sent and claimed.</div></div>`; return; }
  try {
    const h = await fetch(`/api/airdrop/history?address=${account}${fresh ? "&fresh=1" : ""}`).then((r) => r.json());
    const sent: any[] = h.sent || [];
    const claimed: any[] = h.claimed || [];

    if (!sent.length && !claimed.length) {
      box.innerHTML = `<div class="empty"><div class="small">Nothing yet. Fund an airdrop on the left, or claim one you are owed, and it appears here.</div></div>`;
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const parts: string[] = [];

    if (claimed.length) {
      // Claimed first. It is the side with tokens already in the wallet, and
      // the amount leads because that is the fact worth reading.
      const rows = await Promise.all(claimed.map(async (c) => {
        const m = await tokMeta(c.token);
        return `<tr>
          <td><div class="tk-cell">${await tokenIcoHTML(c.token, m.symbol)}
            <div><div class="n">${fmtNum(BigInt(c.amount), m.decimals)} $${escape(m.symbol)}</div>
            <div class="a">airdrop #${c.id}</div></div></div></td>
          <td><span class="status withdrawn"><i></i>CLAIMED</span></td>
          <td>${c.ts ? dateLabel(c.ts) : "&mdash;"}</td>
          <td><div class="row-actions">
            <a class="btn btn-line btn-sm" href="/airdrop/${c.id}">Page</a>
            ${c.tx ? `<a class="btn btn-line btn-sm" href="${EXP}/tx/${escape(c.tx)}" target="_blank" rel="noopener">Tx</a>` : ""}
          </div></td></tr>`;
      }));
      parts.push(`<div class="sub" style="margin:2px 0 8px">CLAIMED BY THIS WALLET</div><table>${rows.join("")}</table>`);
    }

    if (sent.length) {
      const rows = await Promise.all(sent.map(async (a) => {
        const m = await tokMeta(a.token);
        const closed = a.endTime !== 0 && now >= a.endTime;
        const canSweep = closed && BigInt(a.remaining) > 0n;
        return `<tr>
          <td><div class="tk-cell">${await tokenIcoHTML(a.token, m.symbol)}
            <div><div class="n">$${escape(m.symbol)} <span class="tag">AIRDROP #${a.id}</span></div>
            <div class="a">${fmtNum(BigInt(a.total), m.decimals)} total</div></div></div></td>
          <td>${a.claims} of ${a.maxClaims} claimed</td>
          <td>${fmtNum(BigInt(a.remaining), m.decimals)} $${escape(m.symbol)} left</td>
          <td>${a.endTime ? (closed ? "closed" : `closes ${dateLabel(a.endTime)}`) : "no deadline"}</td>
          <td><div class="row-actions">
            <a class="btn btn-line btn-sm" href="/airdrop/${a.id}">Page</a>
            ${canSweep ? `<button class="btn btn-neon btn-sm" data-adsweep="${a.id}">Sweep</button>` : ""}
          </div></td></tr>`;
      }));
      parts.push(`<div class="sub" style="margin:${claimed.length ? "18px" : "2px"} 0 8px">SENT BY THIS WALLET</div><table>${rows.join("")}</table>`);
    }

    box.innerHTML = parts.join("");
    box.querySelectorAll<HTMLButtonElement>("[data-adsweep]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Sweeping…";
        try {
          const tx = await send(AIRDROP!, encodeFunctionData({ abi: AIRDROP_ABI as any, functionName: "sweep", args: [BigInt(b.dataset.adsweep!)] }));
          await waitTx(tx); notify("Swept ✓"); invalidateEvents(); renderAdHistory(true);
        } catch (e: any) { notify(friendlyErr(e)); b.disabled = false; b.textContent = "Sweep"; }
      };
    });
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Couldn't read the chain right now.</div></div>`;
  }
}

/* ---------- wiring ---------- */

$("adTokenAddr")?.addEventListener("input", debounce(adRefreshToken, 400));
// Same picker as the lock and vesting forms. The markup and the placeholder
// already promised it; only the wiring was missing.
if ($("adTokenAddr")) wireTokenDropdown("adTokenAddr", "adTokDd", () => adRefreshToken());
$("adList")?.addEventListener("input", debounce(adRenderList, 250));
$("adEqualAmount")?.addEventListener("input", debounce(adRenderList, 250));
$("adCreateBtn")?.addEventListener("click", adOpenReview);
$("adRevConfirm")?.addEventListener("click", adCreate);
$("adReviewClose")?.addEventListener("click", () => $("adReviewModal").classList.remove("show"));
$("adRevDoneBtn")?.addEventListener("click", () => $("adReviewModal").classList.remove("show"));
$("adReviewModal")?.addEventListener("click", (e) => { if (e.target === $("adReviewModal")) $("adReviewModal").classList.remove("show"); });

$("adModeChips")?.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-admode]");
  if (!chip) return;
  adMode = chip.dataset.admode as "equal" | "each";
  $("adModeChips").querySelectorAll(".chip-dur").forEach((c) => c.classList.toggle("on", c === chip));
  $("adEqualWrap").style.display = adMode === "equal" ? "" : "none";
  $("adListHint").textContent = adMode === "equal" ? "one address per line" : "one line per wallet: address:amount";
  ($("adList") as HTMLTextAreaElement).placeholder = adMode === "equal" ? "0xabc…\n0xdef…" : "0xabc…:1000\n0xdef…:250";
  adRenderList();
});

$("adDeadlineChips")?.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-addead]");
  if (!chip) return;
  adDeadlineDays = Number(chip.dataset.addead);
  $("adDeadlineChips").querySelectorAll(".chip-dur").forEach((c) => c.classList.toggle("on", c === chip));
  adSummary();
});


/* ---------- $LOCK revenue share ----------
 *
 * Everything on this page is either read live (chain, pool endpoint) or
 * clearly labeled as an example. The pool endpoint failing renders
 * "Unavailable", never zeros: a zero here would read as "there is no
 * revenue", which is a claim, not an error state. */
const LOCK_TOKEN = "0xd5bf43f29bf7aa5bb42ae9e217b84b86eb7a4b94";
type RevPool = { since: number; next: number; fees: number; feesByKind: Record<string, { count: number; fees: number }>; affiliateCommission: number; pool: number; ethUsd: number };
let revPool: RevPool | null = null;
let revPoolFailed = false;
let revCirc: { at: number; circulating: bigint; total: bigint } | null = null;
let revLockedTotal: bigint | null = null;   // all qualified locked $LOCK, from the server snapshot
let revShare: number | null = null;   // connected wallet's fraction of circulating
let revTimer: ReturnType<typeof setInterval> | null = null;
let revWired = false;

const rvPad = (n: number) => String(n).padStart(2, "0");
const revEth = (n: number) => `${n >= 0.01 || n === 0 ? n.toFixed(3) : n >= 0.0001 ? n.toFixed(4) : n.toFixed(6)} ETH`;
const revUsdStr = (eth: number) => {
  const p = revPool?.ethUsd || Number(localStorage.getItem("hl_ethusd")) || 0;
  return p > 0 ? fmtUsd(eth * p) : "";
};

/* $LOCK spot price. Payouts are made in $LOCK bought at drop time, so pool
 * figures read most truthfully in the token itself. DEXScreener first (it
 * indexes whatever pair the token actually trades in), the Uniswap-v3 read
 * as fallback, null when neither knows: an unpriced pool falls back to ETH
 * display rather than inventing a conversion. */
let revLockPrice: { at: number; v: number | null } = { at: 0, v: null };
async function revLoadLockPrice(): Promise<number | null> {
  if (Date.now() - revLockPrice.at < 5 * 60_000) return revLockPrice.v;
  let price: number | null = null;
  try {
    const j: any = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${LOCK_TOKEN}`)).json();
    const pairs = (j.pairs || []).filter((p: any) => Number(p?.priceUsd) > 0)
      .sort((a: any, b: any) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0));
    if (pairs.length) price = Number(pairs[0].priceUsd);
  } catch { /* try the chain next */ }
  if (price === null) {
    price = await tokenPriceUsd(pub as any, getAddress(LOCK_TOKEN) as `0x${string}`, 18).catch(() => null);
  }
  revLockPrice = { at: Date.now(), v: price };
  return price;
}
/* eth -> current $LOCK amount, or null when either price is missing. */
function revEthToLock(eth: number): number | null {
  const ethP = revPool?.ethUsd || Number(localStorage.getItem("hl_ethusd")) || 0;
  const lockP = revLockPrice.v;
  return ethP > 0 && lockP && lockP > 0 ? (eth * ethP) / lockP : null;
}
const revLockAmt = (n: number) =>
  `${n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n >= 1 ? 2 : 4)} $LOCK`;
/* Main value in $LOCK when convertible, ETH otherwise; detail line carries
 * the rest either way. */
function revPayoutParts(eth: number): { v: string; extra: string } {
  const lock = revEthToLock(eth);
  const usd = revUsdStr(eth);
  // A spot-price conversion stops meaning anything once the amount rivals the
  // pool's depth (the simulator can dial up sums no buyback could fill), so
  // large figures stay in ETH and dollars instead of impossible token counts.
  if (lock === null || lock > 50_000_000) return { v: revEth(eth), extra: usd };
  return { v: revLockAmt(lock), extra: [revEth(eth), usd].filter(Boolean).join(" · ") };
}

function loadRevenueView() {
  if (revTimer) clearInterval(revTimer);
  // The drop has no calendar anymore: the meter is the heartbeat. Poll the
  // vault every 30s while the view is open; self-clears on navigation.
  revTimer = setInterval(() => {
    if (!$("view-revenue").classList.contains("active")) { if (revTimer) clearInterval(revTimer); return; }
    revLoadPool();
  }, 30_000);
  if (!revWired) {
    revWired = true;
    $("rvSimRange").addEventListener("input", () => revSimRender());
    $("rvSimHoldings").addEventListener("input", debounce(() => revSimRender(), 250));
    $("rvTrigger").addEventListener("click", revTriggerDrop);
  }
  revLoadPool(); revLoadPosition(); revLoadDrops(); revSimRender();
  fetch("/api/revenue/snapshot").then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j?.totalQualified != null) { revLockedTotal = BigInt(j.totalQualified); revSimRender(); }
  }).catch(() => { /* the simulator keeps its last denominator */ });
  revLoadLockPrice().then(() => { revRenderPool(); revRenderCut(); revSimRender(); revLoadPosition(); });
}

/* The permissionless buyback trigger. Every term is fixed by the contract;
 * the button only picks the moment. */
const VAULT_ADDR = (cfg as any).buybackVault && isAddress((cfg as any).buybackVault) ? (getAddress((cfg as any).buybackVault) as `0x${string}`) : null;
const ROUND_MANAGER = (cfg as any).roundManager && isAddress((cfg as any).roundManager) ? String((cfg as any).roundManager).toLowerCase() : null;
const VAULT_EXEC_ABI = [{ type: "function", name: "execute", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] }] as const;
async function revTriggerDrop() {
  const msg = $("rvTriggerMsg"), btn = $("rvTrigger") as HTMLButtonElement;
  if (!VAULT_ADDR) return;
  if (!account) return openWalletModal();
  try {
    btn.disabled = true;
    msg.style.display = "block"; msg.className = "msg"; msg.textContent = "Confirm in wallet…";
    const h = await send(VAULT_ADDR, encodeFunctionData({ abi: VAULT_EXEC_ABI, functionName: "execute" }));
    msg.innerHTML = `Buying back… <span class="spin"></span>`;
    await waitTx(h);
    msg.className = "msg ok"; msg.textContent = "Drop fired. The bought $LOCK opens as a claim round shortly.";
    revLoadPool(); revLoadDrops();
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = friendlyErr(e); }
  finally { btn.disabled = false; }
}

function revRenderPool() {
  const vault = (revPool as any)?.vault as { pendingEth: number; thresholdEth: number; canExecute: boolean; undistributedLock: string; address: string } | null;
  if (!revPool) { $("rvPoolV").textContent = "Unavailable"; return; }
  // The vault balance IS the pool now; the fee math stays as fallback only.
  const poolEth = vault ? vault.pendingEth : revPool.pool;
  const p = revPayoutParts(poolEth);
  $("rvPoolV").textContent = p.v;
  $("rvPoolD").textContent = `${p.extra ? p.extra + " · " : ""}on-chain in the buyback vault`;
  if (vault) {
    const pct = vault.thresholdEth > 0 ? Math.min(100, (vault.pendingEth / vault.thresholdEth) * 100) : 0;
    ($("rvMeterFill") as HTMLElement).style.width = `${vault.canExecute ? 100 : pct}%`;
    $("rvMeterEth").textContent = `${vault.pendingEth.toFixed(4)} / ${vault.thresholdEth} ETH`;
    $("rvMeterSub").textContent = vault.canExecute
      ? "The pool is full. Anyone can fire the buyback; the price is oracle-guarded."
      : "Fires automatically once the pool reaches the threshold. Anyone can trigger it.";
    ($("rvTrigger") as HTMLElement).style.display = vault.canExecute ? "" : "none";
    const bought = BigInt(vault.undistributedLock || "0");
    const boughtEl = $("rvBought");
    if (bought > 0n) { boughtEl.style.display = ""; boughtEl.textContent = `${fmtNum(bought, 18)} $LOCK already bought, opening as a claim round shortly.`; }
    else boughtEl.style.display = "none";
  } else {
    $("rvMeterEth").textContent = "";
  }
  // One click to the vault on the explorer: the pool balance and every
  // buyback are public.
  const verifyAddr = vault?.address || (revPool as any)?.automation?.splitter || null;
  const link = document.getElementById("rvVerify") as HTMLAnchorElement | null;
  if (link && verifyAddr) { link.href = `${EXP}/address/${verifyAddr}`; link.style.display = "inline-flex"; }
}

async function revLoadPool() {
  try {
    const r = await fetch("/api/revenue/pool");
    if (!r.ok) throw new Error(String(r.status));
    revPool = await r.json();
    revPoolFailed = false;
  } catch { revPoolFailed = true; revPool = null; }
  revRenderPool();
  revRenderCut(); revSimRender();
}

/* Circulating supply for the share math: total minus TEAM-locked $LOCK.
 * Tokens the team locked cannot claim a drop, so they must not dilute the
 * holders who can. Read live from the locker so a new team lock, an expiry
 * or a withdrawal changes the math without a code change. */
async function revCirculating(): Promise<{ circulating: bigint; total: bigint } | null> {
  if (revCirc && Date.now() - revCirc.at < 5 * 60_000) return revCirc;
  try {
    const lockAddr = getAddress(LOCK_TOKEN);
    const [total, ids] = await Promise.all([
      pub.readContract({ address: lockAddr, abi: ERC20, functionName: "totalSupply" }) as Promise<bigint>,
      pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByToken", args: [lockAddr] }) as Promise<bigint[]>,
    ]);
    const now = Math.floor(Date.now() / 1000);
    const locks = await Promise.all(ids.map((i) => readLock(Number(i)).catch(() => null)));
    const teamLocked = locks.reduce((s, l) =>
      l && l.owner.toLowerCase() === ADMIN_WALLET && !l.withdrawn && l.unlockTime > now ? s + l.amount : s, 0n);
    const circulating = total - teamLocked;
    revCirc = { at: Date.now(), circulating: circulating > 0n ? circulating : total, total };
    return revCirc;
  } catch { return revCirc; }
}


/* Eligibility is a LOCK, not a balance, so the share has to be read from the
   locker rather than from balanceOf. Both sides are on chain and cheap, so the
   page can show a real number the moment a wallet connects instead of waiting
   for a distribution to reveal it.

   Ids come from the server's event index because locksByToken is appendable by
   anyone for the price of a 1-wei lock. Falling back to the contract array is
   fine for a display estimate: dust adds dust. */
const REV_MIN_DAYS = 7 * 86_400;
type RevWeights = { mine: bigint; total: bigint; myLocks: LockRow[] };

async function revLockWeights(who: string | null): Promise<RevWeights> {
  const idx = await recordIds(LOCK_TOKEN).catch(() => null);
  let ids: number[];
  if (idx) ids = idx.locks.token;
  else ids = ((await pub.readContract({
    address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByToken",
    args: [getAddress(LOCK_TOKEN)],
  })) as bigint[]).map(Number);

  const now = Math.floor(Date.now() / 1000);
  const rows = await Promise.all(ids.map((id) => readLock(id).catch(() => null)));
  const owner = who ? who.toLowerCase() : null;

  let mine = 0n, total = 0n;
  const myLocks: LockRow[] = [];
  await Promise.all(rows.map(async (l) => {
    if (!l || l.withdrawn) return;
    if (l.token.toLowerCase() !== LOCK_TOKEN) return;
    if (l.owner.toLowerCase() === ADMIN_WALLET) return;    // team locks neither dilute nor earn
    if (l.unlockTime <= now) return;                       // the commitment is over
    const t0 = await lockedAtTs(l.id).catch(() => null);
    if (t0 !== null && l.unlockTime - t0 < REV_MIN_DAYS) return;  // under the 7-day floor
    total += l.amount;
    if (owner && l.owner.toLowerCase() === owner) { mine += l.amount; myLocks.push(l); }
  }));
  return { mine, total, myLocks };
}

async function revLoadPosition() {
  const box = $("rvPosBox");
  if (!account) {
    revShare = null;
    box.innerHTML = `<div class="empty"><div class="big">No wallet connected</div><div class="small">Connect to see your locked $LOCK and your share of the weekly pool.</div><button class="btn btn-neon btn-sm" id="rvConnect" style="margin-top:12px">Connect wallet</button></div>`;
    document.getElementById("rvConnect")?.addEventListener("click", openWalletModal);
    $("rvSimHoldWrap").style.display = "";
    revRenderCut(); revSimRender();
    return;
  }
  try {
    const w = await revLockWeights(account);
    revShare = w.total > 0n ? Number((w.mine * 1_000_000_000n) / w.total) / 1e9 : 0;
    const pct = w.total > 0n ? Number((w.mine * 1_000_000n) / w.total) / 10_000 : 0;
    const eligible = w.mine > 0n;
    const lockP = revLockPrice.v;
    const lockedUsd = lockP && lockP > 0 ? fmtUsd(Number(formatUnits(w.mine, 18)) * lockP) : "";
    const soonest = w.myLocks.length
      ? Math.min(...w.myLocks.map((l) => l.unlockTime)) : 0;

    box.innerHTML = `
      <div class="rv-sim-row"><span class="rv-sim-label">$LOCK locked</span><b>${fmtNum(w.mine, 18)}</b></div>
      ${lockedUsd ? `<div class="rv-sim-row"><span class="rv-sim-label">Locked value</span><b>${lockedUsd}</b></div>` : ""}
      <div class="rv-sim-row"><span class="rv-sim-label">Share of all locked $LOCK</span><b>${eligible && pct < 0.0001 ? "<0.0001" : pct.toFixed(4)}%</b></div>
      ${eligible ? `<div class="rv-sim-row"><span class="rv-sim-label">Your locks</span><b>${w.myLocks.length}</b></div>
      <div class="rv-sim-row"><span class="rv-sim-label">Next unlock</span><b>${dateLabel(soonest)}</b></div>` : ""}
      <div class="rv-sim-row" style="margin-bottom:0"><span class="rv-sim-label">Next buyback</span>
        <span class="status ${eligible ? "locked" : "withdrawn"}"><i></i>${eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}</span></div>
      ${eligible ? "" : `<div class="hintline" style="margin-top:10px">Holding $LOCK earns nothing. Lock it for 7 days or more to join the next distribution.</div>
        <a class="btn btn-neon btn-sm" href="/app/locks?token=${LOCK_TOKEN}" style="margin-top:10px">Lock $LOCK</a>`}`;
    $("rvSimHoldWrap").style.display = "none";
  } catch {
    revShare = null;
    box.innerHTML = `<div class="empty"><div class="small">Couldn't read your locks from the chain right now.</div></div>`;
  }
  revRenderCut(); revSimRender();
}

function revRenderCut() {
  const v = $("rvCutV"), d = $("rvCutD");
  if (!account) { v.textContent = "Connect wallet"; d.textContent = "your live share of the pool"; return; }
  if (!revPool || revShare === null) { v.textContent = revPoolFailed ? "Unavailable" : "--"; return; }
  const vaultPool = (revPool as any)?.vault?.pendingEth;
  const p = revPayoutParts((typeof vaultPool === "number" ? vaultPool : revPool.pool) * revShare);
  v.textContent = p.v;
  d.textContent = `${p.extra ? p.extra + " · " : ""}of the pool accrued so far`;
}

const rvTimeLeft = (s: number) => s >= 86_400 ? `${Math.ceil(s / 86_400)}D LEFT` : `${Math.max(1, Math.ceil(s / 3600))}H LEFT`;
async function revLoadDrops() {
  const box = $("rvDropsBox");
  try {
    const r = await (await fetch("/api/airdrops")).json();
    const drops = (r.airdrops || [])
      .filter((a: any) => String(a.token).toLowerCase() === LOCK_TOKEN
        && [ADMIN_WALLET, ROUND_MANAGER].includes(String(a.creator).toLowerCase()))
      .sort((a: any, b: any) => b.id - a.id).slice(0, 5);
    if (!drops.length) {
      box.innerHTML = `<div class="empty"><div class="small">No revenue drops yet. The first one fires as soon as the pool reaches its threshold.</div></div>`;
      return;
    }
    /* The wallet's own claim lives right here in the box: fetching eligibility
       and rendering an inline Claim button beats sending people to another
       page to collect what this page just told them about. */
    let claimable = new Map<number, { index: number; amount: string }>();
    if (account && AIRDROP) {
      try {
        const e = await fetch(`/api/airdrop/eligible?address=${account}`).then((x) => x.json());
        for (const it of e.claimable || []) claimable.set(Number(it.id), { index: Number(it.index), amount: String(it.amount) });
      } catch { /* the list still renders without claim buttons */ }
    }
    const now = Math.floor(Date.now() / 1000);
    box.innerHTML = drops.map((a: any) => {
      const total = BigInt(a.total || "0"), claimed = BigInt(a.claimed || "0"), swept = BigInt(a.swept || "0");
      const pct = total > 0n ? Number(claimed * 1000n / total) / 10 : 0;
      const end = Number(a.endTime || 0);
      const mine = claimable.get(Number(a.id));
      const open = !(swept > 0n) && !(end && now >= end);
      const status = swept > 0n ? `<span class="status withdrawn"><i></i>SWEPT</span>`
        : !open ? `<span class="status withdrawn"><i></i>CLOSED</span>`
        : `<span class="status locked"><i></i>OPEN${end ? " · " + rvTimeLeft(end - now) : ""}</span>`;
      const claimRow = mine && open
        ? `<div class="rv-sim-row" style="margin:2px 0 12px"><span class="rv-sim-label">Yours to claim: <b style="color:var(--neon)">${fmtNum(BigInt(mine.amount), 18)} $LOCK</b></span>
             <button class="btn btn-neon btn-sm" data-rvclaim="${a.id}" data-rvidx="${mine.index}" data-rvamt="${mine.amount}">Claim</button></div>`
        : "";
      return `<div class="rv-sim-row" style="margin-bottom:8px"><span class="rv-sim-label">Drop #${a.id} · ${fmtNum(total, 18)} $LOCK · ${pct.toFixed(1)}% claimed</span>${status}</div>${claimRow}`;
    }).join("");
    box.querySelectorAll<HTMLButtonElement>("[data-rvclaim]").forEach((b) => {
      b.onclick = () => adClaim(Number(b.dataset.rvclaim), Number(b.dataset.rvidx), BigInt(b.dataset.rvamt!), b);
    });
  } catch {
    box.innerHTML = `<div class="empty"><div class="small">Couldn't load drops right now.</div></div>`;
  }
}

function revSimRender() {
  const range = $("rvSimRange") as HTMLInputElement;
  const n = Number(range.value) || 5;
  range.style.setProperty("--fill", `${((n - 5) / 495) * 100}%`);
  $("rvSimLocks").textContent = String(n);
  const feeEth = Number(formatUnits(lockFee ?? 0n, 18)) || 0.005;
  const weeklyRev = n * feeEth * 7;
  const weeklyPool = weeklyRev * 0.5;
  let fraction = revShare;
  if (fraction === null) {
    // An example lock drives the projection. A new lock joins the pool, so
    // the honest share is example / (all qualified locked + the example).
    const totalHuman = revLockedTotal !== null ? Number(formatUnits(revLockedTotal, 18)) : 0;
    const raw = ($("rvSimHoldings") as HTMLInputElement).value || "";
    const ex = Math.max(0, Number(raw.replace(/[,\s_]/g, "")) || 0);
    fraction = ex > 0 ? ex / (totalHuman + ex) : 0;
  }
  const you = weeklyPool * fraction;
  $("rvSimRev").textContent = revEth(weeklyRev);
  $("rvSimRevD").textContent = revUsdStr(weeklyRev) || " ";
  const poolP = revPayoutParts(weeklyPool), youP = revPayoutParts(you);
  $("rvSimPool").textContent = poolP.v;
  $("rvSimPoolD").textContent = poolP.extra || " ";
  $("rvSimYou").textContent = youP.v;
  $("rvSimYouD").textContent = youP.extra || " ";
  $("rvSimNote").textContent = `Assumes ${n} locks per day at the live ${feeEth} ETH lock fee, before affiliate payouts. $LOCK amounts use the current market price. A projection, not a promise.`;
}

/* Retry buttons on the proof error states re-run the same loader. */
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.("[data-proofretry]") as HTMLElement | null;
  if (!b?.dataset.proofretry) return;
  const [kind, id] = b.dataset.proofretry.split(":");
  if (kind === "lock") void showLockProof(Number(id), false);
  else if (kind === "burn") void showBurnProof(Number(id), false);
  else void showVestingProof(Number(id), false);
});

/* ---------- boot ---------- */
/* /app/locks?token=0x... prefills the lock form (the revenue page's CTA). */
try {
  const qTok = new URLSearchParams(location.search).get("token");
  if (qTok && isAddress(qTok)) { ($("tokenAddr") as HTMLInputElement).value = getAddress(qTok); void refreshToken(); }
} catch { /* optional nicety */ }

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

/* Warm Explore in the background from the moment the app opens.
 *
 * It is the slowest view in the app and none of what it needs depends on the
 * wallet, so there is no reason to wait for a click to start. Whichever view the
 * visitor actually landed on paints first: this is queued behind the initial
 * render via requestIdleCallback, never awaited, and cannot reject. */
{
  const warm = () => { void prefetchExplore(); };
  if (typeof (window as any).requestIdleCallback === "function") (window as any).requestIdleCallback(warm, { timeout: 2500 });
  else setTimeout(warm, 800);
}

// Weekly revenue drop widget + countdown dialog (self-contained).
initRevenueDrop();
