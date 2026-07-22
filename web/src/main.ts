import {
  createPublicClient, http, custom, defineChain, getAddress, isAddress,
  parseUnits, formatUnits, encodeFunctionData, numberToHex, type Hex,
} from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";

/* ---------- chain + clients ---------- */
const CHAIN = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pub = createPublicClient({ chain: CHAIN, transport: http(cfg.rpc) });
const LOCKER = getAddress(cfg.locker) as `0x${string}`;
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
// Time-left label: days when >= 1d, otherwise hours + minutes (and just minutes under 1h).
function remainingLabel(secLeft: number): string {
  if (secLeft <= 0) return "0m";
  const d = secLeft / 86400;
  if (d >= 1) return `${d.toFixed(d < 2 ? 1 : 0)}d`;
  const h = Math.floor(secLeft / 3600), m = Math.floor((secLeft % 3600) / 60);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}
($("ctLink") as HTMLAnchorElement).href = `${EXP}/address/${LOCKER}`;

/* ---------- wallet ---------- */
type Eip1193 = { request(a: { method: string; params?: any[] }): Promise<any>; };
const announced = new Map<string, { info: { name: string; rdns?: string }; provider: Eip1193 }>();
window.addEventListener("eip6963:announceProvider", (e: any) => { const d = e.detail; if (d?.info?.rdns) announced.set(d.info.rdns, d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));

let provider: Eip1193 | null = null;
let wcProvider: any = null;   // WalletConnect provider instance (kept so we can disconnect it)
let account = "";

// Robinhood-green feather icon for the Robinhood Wallet option (same as the Hoodlands game).
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
// Curated set — same as the Hoodlands game (Phantom/Keplr etc. never shown).
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
  ($("connectBtn") as HTMLButtonElement).innerHTML = `<span class="wallet">${short(account)}</span>`;
  ($("lockBtn") as HTMLButtonElement).disabled = false;
  ($("lockBtn") as HTMLButtonElement).textContent = "Lock tokens";
  refreshToken(); renderMine();
}
function disconnect() {
  try { wcProvider?.disconnect?.(); } catch { /* */ }
  provider = null; wcProvider = null; account = "";
  ($("connectBtn") as HTMLButtonElement).textContent = "Connect Wallet";
  ($("lockBtn") as HTMLButtonElement).disabled = false;   // stays clickable → click opens the wallet popup
  ($("lockBtn") as HTMLButtonElement).textContent = "Connect wallet to lock";
  $("balHint").textContent = ""; renderMine(); closeWalletModal();
}
function openWalletModal() {
  $("walletModal").style.display = "flex";
  const choicesBox = $("walletChoices"), connBox = $("walletConnected"), title = $("walletModalTitle");
  if (account) {
    title.textContent = "Wallet"; choicesBox.style.display = "none"; connBox.style.display = "";
    connBox.innerHTML = `<div class="wconn-addr">${account}</div><div class="wconn-acts">
      <a class="btn ghost" href="${EXP}/address/${account}" target="_blank">View on explorer</a>
      <button id="disconnectBtn" class="btn danger">Disconnect</button></div>`;
    document.getElementById("disconnectBtn")!.addEventListener("click", disconnect);
    return;
  }
  title.textContent = "Connect a wallet"; connBox.style.display = "none"; choicesBox.style.display = "";
  const choices = walletChoices();
  choicesBox.innerHTML = choices.map((c, i) => `<div class="wchoice" data-i="${i}">
    ${c.icon ? `<img src="${c.icon}" alt="">` : `<span class="ic">${escape(c.name[0])}</span>`}
    <span>${escape(c.name)}</span><span class="badge2">${c.installed ? "" : "Not detected"}</span></div>`).join("");
  choicesBox.querySelectorAll<HTMLElement>(".wchoice").forEach((el) => el.addEventListener("click", async () => {
    const c = choices[Number(el.dataset.i)];
    const b = el.querySelector(".badge2")!; b.textContent = "connecting…";
    try { await c.connect(); } catch (e: any) { alert(e?.shortMessage || e?.message || "Connect failed"); openWalletModal(); }
  }));
}
function closeWalletModal() { $("walletModal").style.display = "none"; }
$("connectBtn").addEventListener("click", openWalletModal);
$("walletModalClose").addEventListener("click", closeWalletModal);
$("walletModal").addEventListener("click", (e) => { if (e.target === $("walletModal")) closeWalletModal(); });

const wallet = () => ({ account: account as `0x${string}`, chain: CHAIN, transport: custom(provider!) } as any);
async function send(to: `0x${string}`, data: Hex, value = 0n): Promise<string> {
  return await provider!.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: numberToHex(value) as any }] });
}
async function waitTx(hash: string) { return pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 120000 }); }

/* ---------- tabs ---------- */
const tabs = ["lock", "mine", "explore"];
document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.addEventListener("click", () => {
  const id = t.dataset.tab!;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
  tabs.forEach((n) => ($(`tab-${n}`).style.display = n === id ? "" : "none"));
  if (id === "explore") loadExplore();
  if (id === "mine") renderMine();
}));

/* ---------- LOCK ---------- */
let tokenMeta: { addr: `0x${string}`; symbol: string; decimals: number; bal: bigint } | null = null;
async function refreshToken() {
  tokenMeta = null; $("tokenInfo").textContent = ""; $("balHint").textContent = "";
  const raw = ($("tokenAddr") as HTMLInputElement).value.trim();
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
    $("tokenInfo").innerHTML = `✓ <b>${escape(String(symbol))}</b> · ${decimals} decimals`;
    if (account) {
      const sym = escape(String(symbol));
      const pctStr = supply > 0n
        ? (Number((bal * 10n ** 10n) / supply) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 })
        : null;
      const pctPart = bal > 0n && pctStr !== null ? ` · <b>${pctStr}%</b> of supply` : "";
      $("balHint").innerHTML = `You hold <b>${fmt(bal, Number(decimals))}</b> ${sym}${pctPart} · <a href="#" id="maxBtn">Max</a>`;
      const mb = document.getElementById("maxBtn"); if (mb) mb.addEventListener("click", (e) => { e.preventDefault(); ($("amount") as HTMLInputElement).value = fmt(bal, Number(decimals)); });
    }
  } catch { $("tokenInfo").innerHTML = `<span style="color:var(--bad)">Couldn't read this token.</span>`; }
}
$("tokenAddr").addEventListener("input", debounce(refreshToken, 400));

// Platform lock fee (native ETH) — read live from the contract so the UI always matches on-chain.
let lockFee = 0n;
async function loadFee() {
  try { lockFee = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "fee" }) as bigint; } catch { /* leave 0 */ }
  const el = document.getElementById("feeHint");
  if (el) el.textContent = lockFee > 0n ? `Platform fee: ${formatUnits(lockFee, 18)} ETH per lock.` : "";
}
loadFee();

$("lockBtn").addEventListener("click", async () => {
  const msg = $("lockMsg"); msg.className = "msg";
  try {
    if (!account) return openWalletModal();
    if (!tokenMeta) throw new Error("Enter a valid token address.");
    const amtStr = ($("amount") as HTMLInputElement).value.trim();
    const amount = parseUnits(amtStr || "0", tokenMeta.decimals);
    if (amount <= 0n) throw new Error("Enter an amount.");
    if (amount > tokenMeta.bal) throw new Error("Amount exceeds your balance.");
    const dt = ($("unlockDate") as HTMLInputElement).value;
    if (!dt) throw new Error("Pick an unlock date.");
    const unlockTime = BigInt(Math.floor(new Date(dt).getTime() / 1000));
    if (unlockTime <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Unlock date must be in the future.");

    const btn = $("lockBtn") as HTMLButtonElement; btn.disabled = true;
    // 1) approve if needed
    const allow = await pub.readContract({ address: tokenMeta.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, LOCKER] }) as bigint;
    if (allow < amount) {
      msg.textContent = "Approving… confirm in wallet"; msg.className = "msg";
      const ah = await send(tokenMeta.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [LOCKER, amount] }));
      msg.innerHTML = `Approving… <span class="spin"></span>`; await waitTx(ah);
    }
    // 2) lock
    msg.textContent = "Locking… confirm in wallet";
    const lh = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "lock", args: [tokenMeta.addr, amount, unlockTime] }), lockFee);
    msg.innerHTML = `Locking… <span class="spin"></span>`;
    await waitTx(lh);
    msg.className = "msg ok";
    msg.innerHTML = `🔒 Locked! <a href="${EXP}/tx/${lh}" target="_blank">view tx</a> — see it under <b>My locks</b> / <b>Explore</b>.`;
    btn.disabled = false;
    ($("amount") as HTMLInputElement).value = "";
    lockTxMapPromise = null;   // refresh so the new lock's tx link resolves
    renderMine();
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = e?.shortMessage || e?.message || "Failed."; ($("lockBtn") as HTMLButtonElement).disabled = false; }
});

// Duration presets (lock form + extend modal) via event delegation — robust regardless of
// render timing. Clicking a chip fills the matching datetime picker and highlights the chip.
document.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest(".chip-dur") as HTMLElement | null;
  if (!chip || !chip.dataset.days) return;
  const days = Number(chip.dataset.days);
  const group = chip.parentElement as HTMLElement | null;
  group?.querySelectorAll(".chip-dur").forEach((x) => x.classList.remove("on"));
  chip.classList.add("on");
  if (group?.id === "lockPresets") {
    ($("unlockDate") as HTMLInputElement).value = toLocalInput(new Date(Date.now() + days * 86400000));
  } else if (group?.id === "extendPresets") {
    ($("extendDate") as HTMLInputElement).value = toLocalInput(new Date((extendBase + days * 86400) * 1000));
  }
});

/* ---------- lock rendering ---------- */
type LockRow = { id: number; owner: string; token: string; amount: bigint; unlockTime: number; withdrawn: boolean };
async function readLock(id: number): Promise<LockRow> {
  const l: any = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "getLock", args: [BigInt(id)] });
  return { id, owner: getAddress(l.owner), token: getAddress(l.token), amount: l.amount as bigint, unlockTime: Number(l.unlockTime), withdrawn: l.withdrawn };
}

// The Locked event lets us link each lock to the exact transaction that moved the tokens in.
const LOCKED_EVENT = { type: "event", name: "Locked", inputs: [
  { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
  { name: "unlockTime", type: "uint256", indexed: false } ] } as const;
// Populate once, atomically: concurrent lockCard() renders must await the SAME promise, or an
// early caller would see the half-built (empty) map and wrongly conclude a lock has no tx.
let lockTxMapPromise: Promise<Map<number, string>> | null = null;
function loadLockTxMap(): Promise<Map<number, string>> {
  if (!lockTxMapPromise) {
    lockTxMapPromise = (async () => {
      const map = new Map<number, string>();
      try {
        const logs = await pub.getLogs({ address: LOCKER, event: LOCKED_EVENT as any, fromBlock: 0n, toBlock: "latest" });
        for (const lg of logs) { const lid = Number((lg as any).args.id); if (lg.transactionHash) map.set(lid, lg.transactionHash); }
      } catch { lockTxMapPromise = null; /* let a later render retry */ }
      return map;
    })();
  }
  return lockTxMapPromise;
}
async function txForLock(id: number): Promise<string | null> {
  return (await loadLockTxMap()).get(id) || null;
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
async function lockCard(l: LockRow, mine: boolean): Promise<string> {
  const m = await tokMeta(l.token);
  const now = Math.floor(Date.now() / 1000);
  const open = l.withdrawn || now >= l.unlockTime;
  const when = new Date(l.unlockTime * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const pill = l.withdrawn ? `<span class="pill open">withdrawn</span>` : open ? `<span class="pill open">unlocked</span>` : `<span class="pill locked">🔒 ${remainingLabel(l.unlockTime - now)} left</span>`;
  const tx = await txForLock(l.id);
  const acts: string[] = [];
  if (tx) acts.push(`<a class="btn ghost" style="padding:7px 12px" href="${EXP}/tx/${tx}" target="_blank">View lock tx</a>`);
  acts.push(`<a class="btn ghost" style="padding:7px 12px" href="${EXP}/address/${LOCKER}?tab=contract" target="_blank">Contract</a>`);
  acts.push(`<button class="btn primary" style="padding:7px 12px" data-share="${l.id}">Share proof</button>`);
  if (mine && !l.withdrawn && now >= l.unlockTime) acts.push(`<button class="btn primary" style="padding:7px 12px" data-withdraw="${l.id}">Withdraw</button>`);
  // Extend stays available whenever the lock isn't withdrawn — including after unlock, so the
  // owner can re-lock instead of withdrawing if they change their mind.
  if (mine && !l.withdrawn) acts.push(`<button class="btn ghost" style="padding:7px 12px" data-extend="${l.id}">Extend</button>`);
  return `<div class="lock"><div class="top"><span class="amt">Locked: ${fmt(l.amount, m.decimals)} $${escape(m.symbol)}</span>${pill}</div>
    <div class="meta">Lock #${l.id} · token ${l.token}<br/>owner ${l.owner} · unlock ${when}</div>
    <div class="acts">${acts.join("")}</div></div>`;
}
function wireActions(container: HTMLElement) {
  container.querySelectorAll<HTMLButtonElement>("[data-withdraw]").forEach((b) => b.addEventListener("click", () => withdraw(Number(b.dataset.withdraw))));
  container.querySelectorAll<HTMLButtonElement>("[data-extend]").forEach((b) => b.addEventListener("click", () => extend(Number(b.dataset.extend))));
  container.querySelectorAll<HTMLButtonElement>("[data-share]").forEach((b) => b.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?lock=${b.dataset.share}`;
    try { await navigator.clipboard.writeText(url); const t = b.innerHTML; b.textContent = "Copied ✓"; setTimeout(() => (b.innerHTML = t), 1600); }
    catch { prompt("Copy this proof link:", url); }
  }));
}

/* ---------- shareable public proof page (?lock=<id>) — works without a wallet ---------- */
async function showLockProof(id: number) {
  (document.querySelector(".tabs") as HTMLElement).style.display = "none";
  (document.querySelector(".hero") as HTMLElement).style.display = "none";
  tabs.forEach((n) => ($(`tab-${n}`).style.display = "none"));
  const box = $("lockProof"); box.style.display = "";
  box.innerHTML = `<div class="empty">Loading lock #${id}…</div>`;
  let l: LockRow;
  try { l = await readLock(id); } catch { box.innerHTML = `<div class="empty">Lock #${id} not found on this chain.</div>`; return; }
  const m = await tokMeta(l.token);
  const tx = await txForLock(id);
  const now = Math.floor(Date.now() / 1000);
  const open = l.withdrawn || now >= l.unlockTime;
  const when = new Date(l.unlockTime * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const pill = l.withdrawn ? `<span class="pill open">withdrawn</span>` : open ? `<span class="pill open">unlocked</span>` : `<span class="pill locked">🔒 locked · ${remainingLabel(l.unlockTime - now)} left</span>`;
  box.innerHTML = `
    <div style="text-align:center;margin-bottom:8px">${pill}</div>
    <h2 style="text-align:center;font-size:24px">${fmt(l.amount, m.decimals)} ${escape(m.symbol)} locked</h2>
    <div class="sub" style="text-align:center">HoodLock · Lock #${id} · Robinhood Chain — verify every field on-chain below.</div>
    <div class="proof-rows">
      <div><span>Amount locked</span><b>${fmt(l.amount, m.decimals)} ${escape(m.symbol)}</b></div>
      <div><span>Token</span><code>${l.token}</code></div>
      <div><span>Owner</span><code>${l.owner}</code></div>
      <div><span>Unlocks</span><b>${when}</b></div>
      <div><span>Status</span>${pill}</div>
    </div>
    <div class="proof-links">
      ${tx ? `<a class="btn primary" href="${EXP}/tx/${tx}" target="_blank">✔ Confirm the lock transaction on Blockscout →</a>` : ""}
      <a class="btn ghost" href="${EXP}/address/${LOCKER}?tab=contract" target="_blank">Read the verified locker contract</a>
    </div>
    <div style="text-align:center;margin-top:18px"><a href="${location.pathname}">← Open HoodLock</a></div>`;
}
async function withdraw(id: number) {
  try { const h = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "withdraw", args: [BigInt(id)] })); await waitTx(h); renderMine(); }
  catch (e: any) { alert(e?.shortMessage || e?.message || "Withdraw failed"); }
}
/* ---------- extend modal (matches the site UI) ---------- */
function toLocalInput(d: Date) { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
let extendId = -1, extendBase = 0;
async function extend(id: number) {
  const l = await readLock(id);
  const nowSec = Math.floor(Date.now() / 1000);
  // For an already-unlocked lock the stored unlockTime is in the past, so require a real FUTURE time.
  extendId = id; extendBase = Math.max(l.unlockTime, nowSec);
  const when = new Date(l.unlockTime * 1000).toISOString().replace("T", " ").slice(0, 16);
  $("extendCurrent").innerHTML = nowSec >= l.unlockTime
    ? `Lock #${id} unlocked on <b>${when} UTC</b>. Pick a future date to re-lock it instead of withdrawing.`
    : `Lock #${id} currently unlocks <b>${when} UTC</b>. Pick a later date — a lock can only be extended, never shortened.`;
  ($("extendDate") as HTMLInputElement).value = toLocalInput(new Date((extendBase + 30 * 86400) * 1000));
  ($("extendDate") as HTMLInputElement).min = toLocalInput(new Date((extendBase + 60) * 1000));   // can't pick a date at/before now / the current unlock
  const msg = $("extendMsg"); msg.textContent = ""; msg.className = "msg";
  document.querySelectorAll("#extendPresets .chip-dur").forEach((c) => c.classList.remove("on"));
  $("extendModal").style.display = "flex";
}
$("extendClose").addEventListener("click", () => ($("extendModal").style.display = "none"));
$("extendCancel").addEventListener("click", () => ($("extendModal").style.display = "none"));
$("extendModal").addEventListener("click", (e) => { if (e.target === $("extendModal")) $("extendModal").style.display = "none"; });
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
    $("extendModal").style.display = "none"; renderMine();
  } catch (e: any) { msg.className = "msg bad"; msg.textContent = e?.shortMessage || e?.message || "Extend failed"; }
  finally { btn.disabled = false; }
});

async function renderMine() {
  const box = $("mineList");
  if (!account) { box.innerHTML = `<div class="empty">Connect your wallet to see your locks.</div>`; return; }
  box.innerHTML = `<div class="empty">Loading…</div>`;
  const ids: bigint[] = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByOwner", args: [account as `0x${string}`] }) as bigint[];
  if (!ids.length) { box.innerHTML = `<div class="empty">You have no locks yet.</div>`; return; }
  const rows = await Promise.all(ids.map((i) => readLock(Number(i))));
  box.innerHTML = (await Promise.all(rows.reverse().map((r) => lockCard(r, true)))).join("");
  wireActions(box);
}

async function loadExplore() {
  const box = $("exploreList"); box.innerHTML = `<div class="empty">Loading latest locks…</div>`;
  const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
  if (!total) { box.innerHTML = `<div class="empty">No locks yet — be the first.</div>`; return; }
  const ids: number[] = []; for (let i = total - 1; i >= 0 && ids.length < 25; i--) ids.push(i);
  const rows = await Promise.all(ids.map(readLock));
  box.innerHTML = (await Promise.all(rows.map((r) => lockCard(r, r.owner === account)))).join("");
  wireActions(box);
}
$("searchBtn").addEventListener("click", async () => {
  const box = $("exploreList");
  const raw = ($("searchAddr") as HTMLInputElement).value.trim();
  if (!raw) return loadExplore();
  if (!isAddress(raw)) { box.innerHTML = `<div class="empty">Enter a valid address.</div>`; return; }
  box.innerHTML = `<div class="empty">Searching…</div>`;
  const ids: bigint[] = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "locksByToken", args: [getAddress(raw)] }) as bigint[];
  if (!ids.length) { box.innerHTML = `<div class="empty">No locks found for this token.</div>`; return; }
  const rows = await Promise.all(ids.map((i) => readLock(Number(i))));
  box.innerHTML = (await Promise.all(rows.reverse().map((r) => lockCard(r, r.owner === account)))).join("");
  wireActions(box);
});

/* ---------- utils ---------- */
function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) { let t: any; return (...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function escape(s: string) { return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!)); }

// A ?lock=<id> deep link opens the public proof page for anyone — no wallet required.
const _lockParam = new URLSearchParams(location.search).get("lock");
if (_lockParam && /^\d+$/.test(_lockParam)) showLockProof(Number(_lockParam));
