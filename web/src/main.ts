/* HoodLock app — the super-app UI wired straight to the RobinhoodLocker
   contract on Robinhood Chain (4663). No backend: every number on screen is a
   contract read or an event log. Wallet layer: EIP-6963 injected providers +
   WalletConnect for Robinhood Wallet mobile. */
import {
  createPublicClient, http, custom, defineChain, getAddress, isAddress,
  parseUnits, formatUnits, encodeFunctionData, numberToHex, type Hex,
} from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";
import BURNER_ABI from "./burner-abi.json";
import { computeTvl, fmtUsd, tokenPriceUsd, tokenDepthCapUsd } from "./tvl";

/* ---------- chain + clients ---------- */
const CHAIN = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pub = createPublicClient({ chain: CHAIN, transport: http(cfg.rpc) });
const LOCKER = getAddress(cfg.locker) as `0x${string}`;
// The burner is optional — without config.burner the whole burn UI stays hidden.
const BURNER = (cfg as any).burner && isAddress((cfg as any).burner) ? (getAddress((cfg as any).burner) as `0x${string}`) : null;
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
($("ctLink") as HTMLAnchorElement).href = `${EXP}/address/${LOCKER}`;

/* ---------- view routing ---------- */
const TITLES: Record<string, string> = { dashboard: "DASHBOARD", locks: "TOKEN LOCKS", explore: "EXPLORE / VERIFY", proof: "LOCK PROOF", vesting: "VESTING", airdrops: "AIRDROPS", streams: "STREAMS" };
function go(view: string, writeHistory = true) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${view}`).classList.add("active");
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $("viewTitle").textContent = TITLES[view] || view.toUpperCase();
  if (view !== "proof" && writeHistory) { history.replaceState(null, "", "/app/" + view); }
  if (view === "explore" && !exploreLoaded) loadExplore();
  if (view === "locks") renderMine();
}
document.querySelectorAll<HTMLElement>(".nav-item").forEach((n) => n.addEventListener("click", () => go(n.dataset.view!)));
document.querySelectorAll<HTMLElement>("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto!)));

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
const CURATED: { name: string; keys: string[]; url: string; icon?: string; wc?: boolean }[] = [
  { name: "MetaMask", keys: ["metamask"], url: "https://metamask.io/download" },
  { name: "Rabby", keys: ["rabby"], url: "https://rabby.io/" },
  { name: "Robinhood Wallet (mobile)", keys: ["robinhood"], url: "https://robinhood.com/us/en/wallet/", icon: RH_ICON, wc: true },
];
function walletChoices(): Choice[] {
  const inj = injectedProviders();
  const find = (keys: string[]) => inj.find((p) => keys.some((k) => p.name.toLowerCase().includes(k)));
  return CURATED.map((cw) => {
    if (cw.wc) return { name: cw.name, icon: cw.icon, installed: true, connect: connectWC };
    const hit = find(cw.keys);
    if (hit) return { name: cw.name, icon: hit.icon || cw.icon, installed: true, connect: () => connectInjected(hit.provider) };
    return { name: cw.name, icon: cw.icon, installed: false, connect: async () => { window.open(cw.url, "_blank", "noopener"); throw new Error(`${cw.name} isn't installed — opening its download page.`); } };
  });
}
async function ensureChain(p: Eip1193) {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN.id) }] }); }
  catch (e: any) { if (e?.code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: numberToHex(CHAIN.id), chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [cfg.rpc] }] }); }
}
async function connectInjected(p: Eip1193) {
  const accs: string[] = await p.request({ method: "eth_requestAccounts" });
  provider = p; account = getAddress(accs[0]); await ensureChain(p); onConnected();
}
async function connectWC() {
  if (!WC_PROJECT_ID) throw new Error("Mobile sign-in isn't enabled yet — a WalletConnect project id is needed.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const wp = await EthereumProvider.init({ projectId: WC_PROJECT_ID, chains: [CHAIN.id], showQrModal: true, rpcMap: { [CHAIN.id]: cfg.rpc } });
  await wp.connect();
  const accs: string[] = await wp.request({ method: "eth_accounts" });
  provider = wp as unknown as Eip1193; wcProvider = wp; account = getAddress(accs[0]); onConnected();
}
function onConnected() {
  closeWalletModal();
  ($("connectBtn") as HTMLButtonElement).innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#03130a;box-shadow:0 0 5px rgba(3,19,10,.6)"></span><span class="wallet">${short(account)}</span>`;
  ($("lockBtn") as HTMLButtonElement).disabled = false;
  walletToks = null; walletToksFor = "";
  refreshToken(); renderMine(); updateSummary(); loadWalletTokens();
  notify(`Wallet connected — ${short(account)}`);
}
function disconnect() {
  try { wcProvider?.disconnect?.(); } catch { /* */ }
  provider = null; wcProvider = null; account = "";
  ($("connectBtn") as HTMLButtonElement).textContent = "Connect Wallet";
  ($("lockBtn") as HTMLButtonElement).disabled = false;
  $("balHint").textContent = "";
  $("yourLocksSub").textContent = "CONNECT WALLET TO MANAGE";
  renderMine(); updateSummary(); closeWalletModal();
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
  choicesBox.innerHTML = choices.map((c, i) => `<div class="wchoice" data-i="${i}">
    ${c.icon ? `<img src="${c.icon}" alt="">` : `<span class="ic">${escape(c.name[0])}</span>`}
    <span>${escape(c.name)}</span><span class="badge2">${c.installed ? "" : "NOT DETECTED"}</span></div>`).join("");
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
async function waitTx(hash: string) { return pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 120000 }); }

/* ---------- fee (live from contract) ---------- */
let lockFee = 0n, burnFee = 0n;
function renderFee() {
  const fee = burnMode ? burnFee : lockFee;
  $("sFee").textContent = fee > 0n ? `${formatUnits(fee, 18)} ETH` : "free";
}
async function loadFee() {
  try { lockFee = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ }
  if (BURNER) { try { burnFee = await pub.readContract({ address: BURNER, abi: BURNER_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ } }
  renderFee();
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
  $("lockNoteText").innerHTML = on
    ? `<b style="color:#ff8a8a">Irreversible.</b> Burned tokens go straight to the dead address and can never be recovered — by anyone. The burn gets a public proof page you can share.`
    : `<b>Extend-only.</b> Unlock dates can be pushed later, but never shortened. Locked tokens can only be withdrawn by the lock owner after the unlock time.`;
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
      $("balHint").innerHTML = `You hold <b>${fmt(bal, Number(decimals))}</b> $${sym}${pctPart} · <a href="#" id="maxBtn">Max</a>`;
      const mb = document.getElementById("maxBtn");
      if (mb) mb.addEventListener("click", (e) => { e.preventDefault(); ($("amount") as HTMLInputElement).value = fmt(bal, Number(decimals)); updateSummary(); });
    }
    updateSummary();
  } catch { $("tokenInfo").innerHTML = `<span class="badv">Couldn't read this token on Robinhood Chain.</span>`; }
}
$("tokenAddr").addEventListener("input", debounce(refreshToken, 400));

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
async function renderTokDd() {
  const dd = $("tokDd");
  if (!account) { dd.classList.remove("show"); return; }
  const q = ($("tokenAddr") as HTMLInputElement).value.trim().toLowerCase();
  dd.innerHTML = `<div class="td-note">Loading your tokens… <span class="spin"></span></div>`;
  dd.classList.add("show");
  const toks = await loadWalletTokens();
  const hits = toks.filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.addr.toLowerCase().startsWith(q));
  if (!hits.length) {
    if (q) { dd.classList.remove("show"); return; }   // fri inmatning — stör inte
    dd.innerHTML = `<div class="td-note">No tokens found in this wallet on Robinhood Chain — paste a contract address instead.</div>`;
    return;
  }
  dd.innerHTML = hits.slice(0, 30).map((t, i) => `
    <div class="td-item" data-i="${i}">
      <span class="token-ico" style="background:${tokenColor(t.addr)}">${escape(t.symbol.slice(0, 2).toUpperCase())}</span>
      <div><div class="n">$${escape(t.symbol)}</div><div class="a">${short(t.addr)}</div></div>
      <span class="bal">${fmtNum(t.balance, t.decimals)}</span>
    </div>`).join("");
  dd.querySelectorAll<HTMLElement>(".td-item").forEach((el) => el.addEventListener("mousedown", (e) => {
    e.preventDefault();   // hinner före inputens blur
    const t = hits[Number(el.dataset.i)];
    ($("tokenAddr") as HTMLInputElement).value = t.addr;
    dd.classList.remove("show");
    refreshToken();
  }));
}
$("tokenAddr").addEventListener("focus", renderTokDd);
$("tokenAddr").addEventListener("input", debounce(renderTokDd, 250));
$("tokenAddr").addEventListener("blur", () => setTimeout(() => $("tokDd").classList.remove("show"), 150));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("tokDd").classList.remove("show"); });

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
    if (ids.length) proof = ` · <a href="?burn=${Number(ids[ids.length - 1])}">Open the burn proof</a>`;
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
    await waitTx(lh);
    msg.className = "msg ok";
    msg.innerHTML = `🔒 Locked! <a href="${EXP}/tx/${lh}" target="_blank" rel="noopener">view tx</a> — see it under <b>My locks</b> and share the proof.`;
    btn.disabled = false;
    ($("amount") as HTMLInputElement).value = "";
    invalidateEvents();      // refresh events so the new lock's tx + stats resolve
    renderMine(); loadDashboard(); exploreLoaded = false;
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = e?.shortMessage || e?.message || "Failed."; ($("lockBtn") as HTMLButtonElement).disabled = false; }
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
const BURNED_EVENT = { type: "event", name: "Burned", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "burner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
  { name: "timestamp", type: "uint256", indexed: false } ] } as const;

/* burns: id → tx via Burned-eventet (samma atomiska promise-mönster) */
type BurnedLog = { id: number; tx: string };
let burnedLogsPromise: Promise<BurnedLog[]> | null = null;
function loadBurnedLogs(): Promise<BurnedLog[]> {
  if (!burnedLogsPromise) {
    burnedLogsPromise = (async () => {
      if (!BURNER) return [];
      try {
        const logs = await pub.getLogs({ address: BURNER, event: BURNED_EVENT as any, fromBlock: 0n, toBlock: "latest" });
        return logs.map((lg: any) => ({ id: Number(lg.args.id), tx: lg.transactionHash as string }));
      } catch { burnedLogsPromise = null; return []; }
    })();
  }
  return burnedLogsPromise;
}
async function txForBurn(id: number): Promise<string | null> {
  const logs = await loadBurnedLogs();
  return logs.find((l) => l.id === id)?.tx || null;
}

type BurnRow = { id: number; burner: string; token: string; amount: bigint; timestamp: number };
async function readBurn(id: number): Promise<BurnRow> {
  const b: any = await pub.readContract({ address: BURNER!, abi: BURNER_ABI as any, functionName: "getBurn", args: [BigInt(id)] });
  return { id, burner: getAddress(b.burner), token: getAddress(b.token), amount: b.amount as bigint, timestamp: Number(b.timestamp) };
}

// One atomic promise per event type — concurrent renders await the SAME fetch.
type LockedLog = { id: number; owner: string; token: string; amount: bigint; unlockTime: number; tx: string; block: bigint };
let lockedLogsPromise: Promise<LockedLog[]> | null = null;
function loadLockedLogs(): Promise<LockedLog[]> {
  if (!lockedLogsPromise) {
    lockedLogsPromise = (async () => {
      try {
        const logs = await pub.getLogs({ address: LOCKER, event: LOCKED_EVENT as any, fromBlock: 0n, toBlock: "latest" });
        return logs.map((lg: any) => ({
          id: Number(lg.args.id), owner: String(lg.args.owner), token: String(lg.args.token),
          amount: lg.args.amount as bigint, unlockTime: Number(lg.args.unlockTime),
          tx: lg.transactionHash as string, block: lg.blockNumber as bigint,
        })).sort((a, b) => (a.block < b.block ? -1 : 1));
      } catch { lockedLogsPromise = null; return []; }
    })();
  }
  return lockedLogsPromise;
}
function invalidateEvents() { lockedLogsPromise = null; blockTsCache.clear(); }
async function txForLock(id: number): Promise<string | null> {
  const logs = await loadLockedLogs();
  return logs.find((l) => l.id === id)?.tx || null;
}
async function lockedAtBlock(id: number): Promise<bigint | null> {
  const logs = await loadLockedLogs();
  const hit = logs.find((l) => l.id === id);
  return hit ? hit.block : null;
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
async function tokMeta(addr: string) {
  if (metaCache.has(addr)) return metaCache.get(addr)!;
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "symbol" }).catch(() => "TOKEN"),
    pub.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "decimals" }).catch(() => 18),
  ]);
  const m = { symbol: String(symbol), decimals: Number(decimals) }; metaCache.set(addr, m); return m;
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
  const lb = await lockedAtBlock(l.id);
  if (lb !== null && !unlocked) {
    const t0 = await blockTs(lb);
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
    const price = await priceUsdFor(l.token, m.decimals);
    const tvl = price !== null && price > 0 ? fmtUsd((Number(l.amount) / 10 ** m.decimals) * price) : "—";
    return `<tr data-proof="${l.id}">
    <td><div class="tk-cell"><span class="token-ico" style="background:${tokenColor(l.token)}">${sym.slice(0, 2).toUpperCase()}</span>
      <div><div class="n">$${sym} <span class="tag">#${l.id}</span></div><div class="a">${short(l.token)}</div></div></div></td>
    <td>${fmtNum(l.amount, m.decimals)}</td>
    <td>${dateLabel(l.unlockTime)}</td>
    <td>${tvl}</td>
    <td>${status}</td>
    <td><div class="row-actions">${acts.join("")}</div></td></tr>`;
  }
  return `<tr data-proof="${l.id}">
    <td><div class="tk-cell"><span class="token-ico" style="background:${tokenColor(l.token)}">${sym.slice(0, 2).toUpperCase()}</span>
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
    const url = `${location.origin}/app?lock=${b.dataset.share}`;
    try { await navigator.clipboard.writeText(url); notify("Proof link copied — share it anywhere"); }
    catch { prompt("Copy this proof link:", url); }
  }));
  container.querySelectorAll<HTMLElement>("[data-proofburn]").forEach((tr) => tr.addEventListener("click", () => showBurnProof(Number(tr.dataset.proofburn))));
  container.querySelectorAll<HTMLButtonElement>("[data-shareburn]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const url = `${location.origin}/app?burn=${b.dataset.shareburn}`;
    try { await navigator.clipboard.writeText(url); notify("Burn proof link copied — share it anywhere"); }
    catch { prompt("Copy this proof link:", url); }
  }));
}

/* ---------- burn rows ---------- */
async function burnRowHTML(b: BurnRow, variant: "mine" | "explore" = "mine"): Promise<string> {
  const m2 = await tokMeta(b.token);
  const sym = escape(m2.symbol);
  if (variant === "explore") {
    const price = await priceUsdFor(b.token, m2.decimals);
    const tvl = price !== null && price > 0 ? fmtUsd((Number(b.amount) / 10 ** m2.decimals) * price) : "—";
    return `<tr data-proofburn="${b.id}">
    <td><div class="tk-cell"><span class="token-ico" style="background:${tokenColor(b.token)}">${sym.slice(0, 2).toUpperCase()}</span>
      <div><div class="n">$${sym} <span class="tag" style="color:#ff8a8a;background:rgba(255,107,107,.08);border-color:rgba(255,107,107,.25)">BURN #${b.id}</span></div><div class="a">${short(b.token)}</div></div></div></td>
    <td>${fmtNum(b.amount, m2.decimals)}</td>
    <td>${dateLabel(b.timestamp)}</td>
    <td>${tvl}</td>
    <td><span class="status burned"><i></i>BURNED FOREVER</span></td>
    <td><div class="row-actions"><button class="btn btn-line btn-sm" data-shareburn="${b.id}">Share</button></div></td></tr>`;
  }
  return `<tr data-proofburn="${b.id}">
    <td><div class="tk-cell"><span class="token-ico" style="background:${tokenColor(b.token)}">${sym.slice(0, 2).toUpperCase()}</span>
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
  const boxes = [$("yourLocksBox"), $("myLocksBox")];
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
    $("yourLocksSub").textContent = `${ids.length} LOCK${ids.length === 1 ? "" : "S"}${burnIds.length ? ` · ${burnIds.length} BURN${burnIds.length === 1 ? "" : "S"}` : ""} · ${short(account).toUpperCase()}`;
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
    notify("Withdrawn ✓"); renderMine(); loadDashboard(); exploreLoaded = false;
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
async function loadExplore() {
  const box = $("exploreBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading latest locks… <span class="spin"></span></div></div>`;
  try {
    const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
    if (!total) { box.innerHTML = `<div class="empty"><div class="big">No locks yet</div><div class="small">Be the first to lock on Robinhood Chain.</div></div>`; exploreLoaded = true; return; }
    const ids: number[] = []; for (let i = total - 1; i >= 0 && ids.length < 25; i--) ids.push(i);
    const rows = await Promise.all(ids.map(readLock));
    await renderTable(box, rows, false, "No locks yet", "Be the first to lock on Robinhood Chain.", "explore");
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
    const ids = [...new Set([...byToken, ...byOwner].map(Number))];
    const burnIds = [...new Set([...burnsTok, ...burnsBy].map(Number))];
    if (!ids.length && !burnIds.length) { box.innerHTML = `<div class="empty"><div class="big">No locks found</div><div class="small">Nothing locked or burned for this token or wallet yet.</div></div>`; return; }
    const rows = (await Promise.all(ids.map(readLock))).sort((a, b) => b.id - a.id);
    const burns = (await Promise.all(burnIds.map(readBurn))).sort((a, b) => b.id - a.id);
    const lockHTML = rows.length ? `<table>${TABLE_HEAD_EXPLORE}<tbody>${(await Promise.all(rows.map((r) => lockRowHTML(r, false, "explore")))).join("")}</tbody></table>` : "";
    box.innerHTML = lockHTML + (await burnsTableHTML(burns, "Burns — destroyed forever", "explore"));
    if (!lockHTML && !burns.length) box.innerHTML = `<div class="empty"><div class="big">No locks found</div><div class="small"></div></div>`;
    wireActions(box);
  } catch {
    box.innerHTML = `<div class="empty"><div class="big">Search failed</div><div class="small">Couldn't reach Robinhood Chain — try again.</div></div>`;
  }
}
$("searchBtn").addEventListener("click", runSearch);
$("searchAddr").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runSearch(); });

/* ---------- shareable proof (?lock=<id>) — works without a wallet ---------- */
async function showLockProof(id: number, push = true) {
  go("proof");
  if (push) history.pushState(null, "", `/app?lock=${id}`);
  else history.replaceState(null, "", `/app?lock=${id}`);
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
  box.innerHTML = `
    <div class="proof-card">
      <span class="stamp">✓ ON-CHAIN PROOF</span>
      <div class="proof-amt">${fmtNum(l.amount, m.decimals)} $${escape(m.symbol)}</div>
      <div class="proof-sub">HOODLOCK · LOCK #${id} · ROBINHOOD CHAIN 4663</div>
      <div class="p-row"><span class="k">Status</span><span class="v">${statusHTML}</span></div>
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
    <a class="p-back" href="/app">← Open HoodLock</a>`;
  $("proofCopy").addEventListener("click", async () => {
    const url = `${location.origin}/app?lock=${id}`;
    try { await navigator.clipboard.writeText(url); notify("Proof link copied"); } catch { prompt("Copy this proof link:", url); }
  });
}

/* ---------- shareable burn proof (?burn=<id>) — works without a wallet ---------- */
async function showBurnProof(id: number, push = true) {
  go("proof");
  $("viewTitle").textContent = "BURN PROOF";
  if (push) history.pushState(null, "", `/app?burn=${id}`);
  else history.replaceState(null, "", `/app?burn=${id}`);
  const box = $("proofBox");
  box.innerHTML = `<div class="empty"><div class="small">Loading burn #${id}… <span class="spin"></span></div></div>`;
  let b: BurnRow;
  try {
    b = await readBurn(id);
    if (!b.timestamp) throw new Error("empty");   // getBurn returns zeros for unknown ids
  } catch { box.innerHTML = `<div class="empty"><div class="big">Burn #${id} not found</div><div class="small">Nothing at this id on Robinhood Chain.</div></div>`; return; }
  const m2 = await tokMeta(b.token);
  const tx = await txForBurn(id);
  let pct = "";
  try {
    const supply = await pub.readContract({ address: b.token as `0x${string}`, abi: ERC20, functionName: "totalSupply" }) as bigint;
    if (supply > 0n) pct = (Number((b.amount * 10n ** 10n) / supply) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 }) + "% of total supply";
  } catch { /* supply row is optional */ }
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
      <div class="p-row"><span class="k">Sent to</span><span class="v">the dead address — irrecoverable</span></div>
      <div class="p-acts">
        ${tx ? `<a class="btn btn-neon" href="${EXP}/tx/${tx}" target="_blank" rel="noopener">✔ Confirm the burn transaction on Blockscout</a>` : ""}
        <a class="btn btn-line" href="${EXP}/address/${BURNER}?tab=contract" target="_blank" rel="noopener">Read the verified burner contract</a>
        <button class="btn btn-line" id="proofCopy">Copy proof link</button>
      </div>
    </div>
    <a class="p-back" href="/app">← Open HoodLock</a>`;
  $("proofCopy").addEventListener("click", async () => {
    const url = `${location.origin}/app?burn=${id}`;
    try { await navigator.clipboard.writeText(url); notify("Burn proof link copied"); } catch { prompt("Copy this proof link:", url); }
  });
}

/* ---------- dashboard: stats, chart, activity ---------- */
async function loadDashboard() {
  try {
    const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
    $("statLocks").textContent = total.toLocaleString("en-US");
    const logs = await loadLockedLogs();
    if (logs.length) {
      $("statWallets").textContent = new Set(logs.map((l) => l.owner.toLowerCase())).size.toLocaleString("en-US");
    } else if (!total) { $("statWallets").textContent = "0"; }
    // active = sample the latest 25 locks (exact when total <= 25)
    const ids: number[] = []; for (let i = total - 1; i >= 0 && ids.length < 25; i--) ids.push(i);
    const rows = await Promise.all(ids.map(readLock));
    const now = Math.floor(Date.now() / 1000);
    const active = rows.filter((r) => !r.withdrawn && r.unlockTime > now).length;
    $("statActive").textContent = active.toLocaleString("en-US") + (total > ids.length ? "+" : "");
    drawChartFromLogs(logs);
    renderActivity(logs, rows);
  } catch {
    $("chartEmpty").style.display = "";
    $("chartEmpty").textContent = "Couldn't reach Robinhood Chain — live chart unavailable.";
    ($("locksChart").querySelector("svg") as SVGElement).style.display = "none";
    $("activityFeed").innerHTML = `<div class="empty"><div class="small">Couldn't reach Robinhood Chain.</div></div>`;
  }
}

/* cumulative locks chart from Locked events (sampled block timestamps) */
let chartPoints: { t: number; n: number }[] = [];
let chartPointsTvl: { t: number; n: number }[] = [];
let chartRange = 30;
let chartMode: "locks" | "tvl" = "locks";
async function drawChartFromLogs(logs: LockedLog[]) {
  const svg = $("locksChart").querySelector("svg") as SVGElement;
  if (!logs.length) {
    svg.style.display = "none"; $("chartEmpty").style.display = "";
    $("chartEmpty").textContent = "No locks yet — the chart starts with the first lock.";
    return;
  }
  // sample ≤ 16 event blocks (always first + last) for timestamps
  const idxs = new Set<number>([0, logs.length - 1]);
  for (let k = 1; k < 15; k++) idxs.add(Math.round((k * (logs.length - 1)) / 15));
  const sorted = [...idxs].sort((a, b) => a - b);
  const tsByIdx = new Map<number, number>();
  await Promise.all(sorted.map(async (i) => {
    const ts = await blockTs(logs[i].block);
    if (ts !== null) tsByIdx.set(i, ts);
  }));
  const pts: { t: number; n: number }[] = [];
  for (const i of sorted) { const ts = tsByIdx.get(i); if (ts !== undefined) pts.push({ t: ts, n: i + 1 }); }
  pts.sort((a, b) => a.t - b.t);
  pts.push({ t: Math.floor(Date.now() / 1000), n: logs.length });
  chartPoints = pts;

  // TVL-serien: kumulativt USD-värde av skapade lås, till DAGENS priser —
  // djup-kapad PER TOKEN med samma politik som tilen (proportionell skalning).
  try {
    const uniq = [...new Set(logs.map((l) => l.token.toLowerCase()))];
    const priceMap = new Map<string, number>();
    const factorMap = new Map<string, number>();
    await Promise.all(uniq.map(async (tok) => {
      const meta = await tokMeta(tok);
      const p = await tokenPriceUsd(pub as any, tok as `0x${string}`, meta.decimals);
      priceMap.set(tok, p ?? 0);
      if (p && p > 0) {
        const totalAmt = logs.filter((l) => l.token.toLowerCase() === tok)
          .reduce((a, l) => a + Number(l.amount) / 10 ** meta.decimals, 0);
        const uncapped = totalAmt * p;
        const cap = await tokenDepthCapUsd(pub as any, tok as `0x${string}`);
        factorMap.set(tok, cap !== null && uncapped > 0 ? Math.min(1, cap / uncapped) : 0);
      } else factorMap.set(tok, 0);
    }));
    const vals = logs.map((l) => {
      const meta = metaCacheGet(l.token.toLowerCase());
      const dec = meta ? meta.decimals : 18;
      const tok = l.token.toLowerCase();
      return (Number(l.amount) / 10 ** dec) * (priceMap.get(tok) ?? 0) * (factorMap.get(tok) ?? 0);
    });
    const cum: number[] = []; let acc = 0;
    for (const v of vals) { acc += v; cum.push(acc); }
    const tpts: { t: number; n: number }[] = [];
    for (const i of sorted) { const ts = tsByIdx.get(i); if (ts !== undefined) tpts.push({ t: ts, n: cum[i] }); }
    tpts.sort((a, b) => a.t - b.t);
    tpts.push({ t: Math.floor(Date.now() / 1000), n: acc });
    chartPointsTvl = tpts;
  } catch { chartPointsTvl = []; }

  renderChart();
}
function metaCacheGet(addr: string) { return metaCache.get(addr) ?? metaCache.get(getAddress(addr)) ?? null; }
function activeSeries(): { t: number; n: number }[] { return chartMode === "tvl" ? chartPointsTvl : chartPoints; }
function countAt(t: number): number {
  const pts = activeSeries();
  if (!pts.length) return 0;
  if (t <= pts[0].t) return 0;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= t) return pts[i].n;
  return pts[pts.length - 1].n;
}
function renderChart() {
  const svg = $("locksChart").querySelector("svg") as SVGElement;
  const tip = $("chartTip");
  const series0 = activeSeries();
  if (!series0.length) return;
  svg.style.display = ""; $("chartEmpty").style.display = "none";
  const now = Math.floor(Date.now() / 1000);
  const from = now - chartRange * 86400;
  // series inside the window (with a boundary point at the left edge)
  const inWin = series0.filter((p) => p.t >= from);
  const series: { t: number; n: number }[] = [{ t: from, n: countAt(from) }, ...inWin];
  if (series[series.length - 1].t < now) series.push({ t: now, n: countAt(now) });

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag: string, attrs: Record<string, any>) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, String(attrs[k])); return e; };
  svg.innerHTML = "";
  const W = 640, H = 230, P = { t: 18, r: 14, b: 24, l: 42 };
  const minN = 0, maxN = chartMode === "tvl" ? Math.max(1, series[series.length - 1].n * 1.15) : Math.max(2, Math.ceil(series[series.length - 1].n * 1.15));
  const x = (t: number) => P.l + ((t - from) / (now - from)) * (W - P.l - P.r);
  const y = (n: number) => P.t + (1 - (n - minN) / (maxN - minN)) * (H - P.t - P.b);
  for (let g = 0; g < 4; g++) {
    const v = chartMode === "tvl" ? minN + ((maxN - minN) * g) / 3 : Math.round(minN + ((maxN - minN) * g) / 3), gy = y(v);
    svg.appendChild(el("line", { x1: P.l, x2: W - P.r, y1: gy, y2: gy, stroke: "rgba(255,255,255,.05)", "stroke-width": 1 }));
    const tEl = el("text", { x: P.l - 9, y: gy + 3.5, "text-anchor": "end", fill: "#59695e", "font-size": 9.5, "font-family": "JetBrains Mono,monospace" });
    tEl.textContent = chartMode === "tvl" ? fmtUsd(v) : String(v); svg.appendChild(tEl);
  }
  const defs = el("defs", {});
  defs.innerHTML = `<linearGradient id="tf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0aa84f" stop-opacity=".26"/><stop offset="1" stop-color="#0aa84f" stop-opacity="0"/></linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  svg.appendChild(defs);
  // step-after path (counts jump at each lock)
  let dLine = `M ${x(series[0].t)} ${y(series[0].n)}`;
  for (let i = 1; i < series.length; i++) dLine += ` L ${x(series[i].t)} ${y(series[i - 1].n)} L ${x(series[i].t)} ${y(series[i].n)}`;
  const dArea = dLine + ` L ${x(now)} ${H - P.b} L ${x(from)} ${H - P.b} Z`;
  svg.appendChild(el("path", { d: dArea, fill: "url(#tf)" }));
  svg.appendChild(el("path", { d: dLine, fill: "none", stroke: "#0aa84f", "stroke-width": 2, "stroke-linejoin": "round", filter: "url(#glow)" }));
  svg.appendChild(el("circle", { cx: x(now), cy: y(series[series.length - 1].n), r: 3.5, fill: "#00e05a" }));
  const cross = el("line", { y1: P.t, y2: H - P.b, stroke: "rgba(255,255,255,.2)", "stroke-width": 1, "stroke-dasharray": "3 3" }) as SVGLineElement;
  cross.style.display = "none"; svg.appendChild(cross);
  const hdot = el("circle", { r: 4, fill: "#00e05a", stroke: "#0a0f0c", "stroke-width": 2 }) as SVGCircleElement;
  hdot.style.display = "none"; svg.appendChild(hdot);
  (svg as any).onmousemove = (e: MouseEvent) => {
    const r = (svg as any).getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / r.width) * (now - from);
    const n = countAt(t);
    cross.setAttribute("x1", String(x(t))); cross.setAttribute("x2", String(x(t))); cross.style.display = "block";
    hdot.setAttribute("cx", String(x(t))); hdot.setAttribute("cy", String(y(n))); hdot.style.display = "block";
    tip.querySelector(".tv")!.textContent = chartMode === "tvl" ? fmtUsd(n) : `${n} lock${n === 1 ? "" : "s"}`;
    tip.querySelector(".tk")!.textContent = new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
    tip.style.display = "block";
    const tipX = (x(t) / W) * r.width, flip = tipX > r.width * 0.72;
    tip.style.left = tipX + (flip ? -12 : 12) + "px";
    tip.style.transform = flip ? "translateX(-100%)" : "none";
    tip.style.top = (y(n) / H) * r.height - 12 + "px";
  };
  (svg as any).onmouseleave = () => { cross.style.display = "none"; hdot.style.display = "none"; tip.style.display = "none"; };
}
document.querySelectorAll<HTMLElement>("#chartModeRow .mode-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#chartModeRow .mode-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  chartMode = (b.dataset.mode as "locks" | "tvl") ?? "locks";
  $("chartTitle").textContent = chartMode === "tvl" ? "Value locked" : "Locks created";
  $("chartSub").textContent = chartMode === "tvl" ? "CUMULATIVE · AT CURRENT PRICES" : "CUMULATIVE · FROM LOCKED EVENTS";
  renderChart();
}));
document.querySelectorAll<HTMLElement>(".range-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); chartRange = Number(b.dataset.range); renderChart();
}));

/* activity feed: latest Locked/Extended/Withdrawn events */
async function renderActivity(lockedLogs: LockedLog[], sampledRows: LockRow[]) {
  const feed = $("activityFeed");
  try {
    const [extLogs, wdLogs] = await Promise.all([
      pub.getLogs({ address: LOCKER, event: EXTENDED_EVENT as any, fromBlock: 0n, toBlock: "latest" }).catch(() => []),
      pub.getLogs({ address: LOCKER, event: WITHDRAWN_EVENT as any, fromBlock: 0n, toBlock: "latest" }).catch(() => []),
    ]);
    type Ev = { kind: "lock" | "ext" | "wd"; id: number; block: bigint; token?: string; amount?: bigint; unlockTime?: number };
    const evs: Ev[] = [
      ...lockedLogs.map((l) => ({ kind: "lock" as const, id: l.id, block: l.block, token: l.token, amount: l.amount, unlockTime: l.unlockTime })),
      ...(extLogs as any[]).map((lg) => ({ kind: "ext" as const, id: Number(lg.args.id), block: lg.blockNumber as bigint, unlockTime: Number(lg.args.newUnlockTime) })),
      ...(wdLogs as any[]).map((lg) => ({ kind: "wd" as const, id: Number(lg.args.id), block: lg.blockNumber as bigint, amount: lg.args.amount as bigint })),
    ].sort((a, b) => (a.block > b.block ? -1 : 1)).slice(0, 7);
    if (!evs.length) { feed.innerHTML = `<div class="empty"><div class="small">No activity yet — the feed starts with the first lock.</div></div>`; return; }
    const tokenOf = (id: number) => lockedLogs.find((l) => l.id === id)?.token || sampledRows.find((r) => r.id === id)?.token;
    const items = await Promise.all(evs.map(async (ev) => {
      const ts = await blockTs(ev.block);
      const tok = tokenOf(ev.id);
      const m = tok ? await tokMeta(tok) : { symbol: `#${ev.id}`, decimals: 18 };
      const sym = escape(m.symbol);
      let ico = "lock", txt = "";
      if (ev.kind === "lock") txt = `<b>${fmtNum(ev.amount!, m.decimals)} $${sym}</b> locked until ${dateLabel(ev.unlockTime!)}`;
      else if (ev.kind === "ext") { ico = "ext"; txt = `Lock <b>#${ev.id}</b> extended to ${dateLabel(ev.unlockTime!)}`; }
      else { ico = "wd"; txt = `<b>${fmtNum(ev.amount!, m.decimals)} $${sym}</b> withdrawn`; }
      return { ico, txt, sub: `LOCK #${ev.id}${tok ? " · " + short(tok).toUpperCase() : ""}`, t: ts ? relTime(ts) : "", id: ev.id };
    }));
    feed.innerHTML = items.map((a) => `
      <div class="feed-item" style="cursor:pointer" data-proof-feed="${a.id}">
        <span class="feed-ico ${a.ico === "ext" ? "ext" : a.ico === "wd" ? "wd" : ""}">${
          a.ico === "ext" ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f5b731" stroke-width="2"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="8.5"/></svg>'
          : a.ico === "wd" ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8fa396" stroke-width="2"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/></svg>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00e05a" stroke-width="2.2"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 118 0v3"/></svg>'}</span>
        <div class="fm">${a.txt}<div class="sub">${a.sub}</div></div><span class="t">${a.t}${a.t ? " AGO" : ""}</span>
      </div>`).join("");
    feed.querySelectorAll<HTMLElement>("[data-proof-feed]").forEach((el) => el.addEventListener("click", () => showLockProof(Number(el.dataset.proofFeed))));
  } catch {
    feed.innerHTML = `<div class="empty"><div class="small">Couldn't load activity.</div></div>`;
  }
}

/* ---------- TVL (klientside, djup-kapad — se tvl.ts) ---------- */
async function loadTvl() {
  try {
    const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
    if (!total) { $("statTvl").textContent = "$0"; return; }
    const ids = Array.from({ length: total }, (_, i) => i);
    const rows = await Promise.all(ids.map((i) => readLock(i).catch(() => null)));
    const locks = rows.filter((r): r is LockRow => !!r);
    const t = await computeTvl(pub as any, locks);
    $("statTvl").textContent = t.ethUsd > 0 ? fmtUsd(t.usd) : `${t.eth.toFixed(3)} ETH`;
    $("statTvlSub").textContent = t.unpricedTokens > 0
      ? `depth-capped · ${t.unpricedTokens} token${t.unpricedTokens === 1 ? "" : "s"} unpriced`
      : "priced from DEX pools · depth-capped";
  } catch { $("statTvl").textContent = "—"; }
}
loadTvl();
setInterval(loadTvl, 60_000);

/* ---------- bakåt/framåt i historiken ---------- */
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  const lock = q.get("lock"), burn = q.get("burn");
  if (lock && /^\d+$/.test(lock)) { showLockProof(Number(lock), false); return; }
  if (burn && /^\d+$/.test(burn) && BURNER) { showBurnProof(Number(burn), false); return; }
  const v = location.pathname.match(/^\/app\/([a-z]+)/)?.[1];
  go(v && TITLES[v] ? v : "dashboard", false);
});

/* ---------- boot ---------- */
loadDashboard();
const _lockParam = new URLSearchParams(location.search).get("lock");
const _burnParam = new URLSearchParams(location.search).get("burn");
const _pathView = location.pathname.match(/^\/app\/([a-z]+)/)?.[1];
if (_lockParam && /^\d+$/.test(_lockParam)) showLockProof(Number(_lockParam), false);
else if (_burnParam && /^\d+$/.test(_burnParam) && BURNER) showBurnProof(Number(_burnParam), false);
else if (_pathView && TITLES[_pathView]) go(_pathView);
else if (location.hash && TITLES[location.hash.slice(1)]) go(location.hash.slice(1));   // gamla #-länkar
