/* HoodLock embed — the lock feature served in an iframe on partner sites.
   Attribution rides ?key=pk_… . On success it postMessage()s the parent so the
   partner can react. Self-contained (mirrors main.ts patterns) to keep the widget
   lean and decoupled from the full app. */
import {
  createPublicClient, http, fallback, defineChain, getAddress, isAddress,
  parseUnits, formatUnits, encodeFunctionData, numberToHex, type Hex,
} from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";

type Eip1193 = { request: (a: { method: string; params?: any[] }) => Promise<any>; on?: (e: string, cb: (...a: any[]) => void) => void };

const $ = (id: string) => document.getElementById(id)!;
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
const qs = new URLSearchParams(location.search);
const KEY = qs.get("key") || "";
const PRESET_TOKEN = (qs.get("token") || "").trim();
const PRESET_UNLOCK = (qs.get("unlockTime") || "").trim(); // unix seconds (optional)

/* ---------- chain + clients (same resilient transport as the app) ---------- */
const RPC_URLS: string[] = [(import.meta as any).env?.VITE_RPC_URL, cfg.rpc].filter((u, i, a) => typeof u === "string" && u && a.indexOf(u) === i);
const transport = fallback(RPC_URLS.map((u) => http(u, { timeout: 15_000, retryCount: 2, retryDelay: 400 })), { retryCount: 0 });
const CHAIN = defineChain({ id: cfg.chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: RPC_URLS } } });
const pub = createPublicClient({ chain: CHAIN, transport });
const LOCKER = getAddress(cfg.locker) as `0x${string}`;
const EXP = cfg.explorer;
const WC_PROJECT_ID = (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID || "";
const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const FEE_ABI = [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];

let provider: Eip1193 | null = null;
let account = "";
let feeWei = 5000000000000000n;
let tokenMeta: { addr: `0x${string}`; symbol: string; decimals: number; bal: bigint } | null = null;

/* ---------- parent messaging ---------- */
function post(type: string, data: Record<string, any> = {}) { try { parent.postMessage({ source: "hoodlock-embed", type, ...data }, "*"); } catch { /* */ } }
function resizePost() { post("resize", { height: Math.ceil(document.body.scrollHeight) }); }
const ro = new ResizeObserver(() => resizePost());
ro.observe(document.body);

/* ---------- wallet discovery (EIP-6963 + injected + WalletConnect) ---------- */
const announced = new Map<string, { info: { name: string; rdns?: string; icon?: string }; provider: Eip1193 }>();
window.addEventListener("eip6963:announceProvider", (e: any) => { const d = e.detail; if (d?.info?.rdns) announced.set(d.info.rdns, d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));

async function ensureChain(p: Eip1193) {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN.id) }] }); }
  catch (e: any) {
    if (e?.code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: numberToHex(CHAIN.id), chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [cfg.rpc], blockExplorerUrls: [EXP] }] });
  }
}
async function connectInjected(p: Eip1193) {
  const accs: string[] = await p.request({ method: "eth_requestAccounts" });
  if (!accs?.length) throw new Error("No account");
  provider = p; account = getAddress(accs[0]); await ensureChain(p);
  onConnected();
}
async function connectWC() {
  if (!WC_PROJECT_ID) throw new Error("WalletConnect isn't configured.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const wp: any = await EthereumProvider.init({ projectId: WC_PROJECT_ID, optionalChains: [CHAIN.id, 1], showQrModal: true, rpcMap: { [CHAIN.id]: cfg.rpc } } as any);
  await wp.connect();
  const accs: string[] = await wp.request({ method: "eth_accounts" });
  if (!accs?.length) throw new Error("No account");
  provider = wp as Eip1193; account = getAddress(accs[0]);
  try { await ensureChain(provider); } catch { /* wallet may handle chain in-app */ }
  onConnected();
}
function friendlyErr(e: any): string {
  const m = String(e?.shortMessage || e?.details || e?.message || "");
  if (e?.code === 4001 || /user rejected|user denied|rejected the request/i.test(m)) return "Rejected in wallet.";
  if (/HTTP request failed|fetch failed|Failed to fetch|timed out|timeout|network error|load failed/i.test(m)) return "Couldn't reach Robinhood Chain — try again in a moment.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH for the fee + gas.";
  return m || "Something went wrong.";
}

/* ---------- flow ---------- */
async function onConnected() {
  // attribute this wallet to the developer (fresh-wallet first-touch, server-guarded)
  fetch("/api/dev/attribute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY, wallet: account }) }).catch(() => { /* best-effort */ });
  post("connected", { account });
  if (PRESET_TOKEN && isAddress(PRESET_TOKEN)) await loadToken(PRESET_TOKEN);
  renderForm();
}
async function loadToken(addr: string): Promise<boolean> {
  if (!isAddress(addr)) { tokenMeta = null; return false; }
  try {
    const a = getAddress(addr);
    const [symbol, decimals, bal] = await Promise.all([
      pub.readContract({ address: a, abi: ERC20, functionName: "symbol" }).catch(() => "TOKEN"),
      pub.readContract({ address: a, abi: ERC20, functionName: "decimals" }).catch(() => 18),
      pub.readContract({ address: a, abi: ERC20, functionName: "balanceOf", args: [account as `0x${string}`] }).catch(() => 0n),
    ]);
    tokenMeta = { addr: a, symbol: String(symbol), decimals: Number(decimals), bal: bal as bigint };
    return true;
  } catch { tokenMeta = null; return false; }
}
async function send(to: `0x${string}`, data: Hex, value = 0n): Promise<string> {
  return await provider!.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: numberToHex(value) as any }] });
}
async function waitTx(hash: string) { return pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 120_000, retryCount: 12, retryDelay: 2000 }); }

async function doLock(msg: HTMLElement, btn: HTMLButtonElement) {
  try {
    const tokAddr = (($("emToken") as HTMLInputElement)?.value || PRESET_TOKEN).trim();
    if (!tokenMeta || tokenMeta.addr.toLowerCase() !== tokAddr.toLowerCase()) { if (!(await loadToken(tokAddr))) throw new Error("Enter a valid token address."); }
    const amtStr = ($("emAmount") as HTMLInputElement).value.trim();
    const amount = parseUnits(amtStr || "0", tokenMeta!.decimals);
    if (amount <= 0n) throw new Error("Enter an amount.");
    if (amount > tokenMeta!.bal) throw new Error("Amount exceeds your balance.");
    const dt = ($("emDate") as HTMLInputElement).value;
    if (!dt) throw new Error("Pick an unlock date.");
    const unlockTime = BigInt(Math.floor(new Date(dt).getTime() / 1000));
    if (unlockTime <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Unlock date must be in the future.");

    btn.disabled = true;
    const allow = await pub.readContract({ address: tokenMeta!.addr, abi: ERC20, functionName: "allowance", args: [account as `0x${string}`, LOCKER] }) as bigint;
    if (allow < amount) {
      msg.textContent = "Approving… confirm in wallet"; msg.className = "em-msg";
      const ah = await send(tokenMeta!.addr, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [LOCKER, amount] }));
      msg.innerHTML = `Approving… <span class="em-spin"></span>`; await waitTx(ah);
    }
    msg.textContent = "Locking… confirm in wallet";
    const lh = await send(LOCKER, encodeFunctionData({ abi: LOCKER_ABI as any, functionName: "lock", args: [tokenMeta!.addr, amount, unlockTime] }), feeWei);
    msg.innerHTML = `Locking… <span class="em-spin"></span>`;
    let lockId: number | null = null;
    try {
      await waitTx(lh);
      try { const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" })); lockId = total > 0 ? total - 1 : null; } catch { /* */ }
      renderDone(lh, lockId);
      post("locked", { txHash: lh, lockId, token: tokenMeta!.addr, amount: amount.toString() });
    } catch {
      // submitted but receipt lost — treat as success-ish, report tx
      renderDone(lh, null);
      post("locked", { txHash: lh, lockId: null, token: tokenMeta!.addr, amount: amount.toString(), unconfirmed: true });
    }
  } catch (e: any) {
    msg.className = "em-msg bad"; msg.textContent = friendlyErr(e); btn.disabled = false;
    post("error", { message: friendlyErr(e) });
  }
}

/* ---------- rendering ---------- */
const root = () => $("emRoot");
function frame(inner: string) {
  root().innerHTML = `
    <div class="em-head">
      <div class="em-brand"><span class="em-dot"></span> Lock with <b>HoodLock</b></div>
      <button class="em-x" id="emClose" aria-label="Close">×</button>
    </div>
    ${inner}
    <div class="em-foot">Secured on Robinhood Chain · <a href="${EXP}/address/${LOCKER}?tab=contract" target="_blank" rel="noopener">verified contract</a></div>`;
  $("emClose").addEventListener("click", () => post("close"));
  resizePost();
}
function renderConnect() {
  const wallets = [...announced.values()];
  const eth = (window as any).ethereum;
  const rows: string[] = [];
  if (wallets.length) {
    for (const w of wallets) rows.push(`<button class="em-wallet" data-rdns="${esc(w.info.rdns || "")}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : `<span class="em-wi"></span>`}${esc(w.info.name)}</button>`);
  } else if (eth) {
    rows.push(`<button class="em-wallet" data-injected="1"><span class="em-wi"></span>Browser wallet</button>`);
  }
  if (WC_PROJECT_ID) rows.push(`<button class="em-wallet" data-wc="1"><span class="em-wi wc"></span>WalletConnect</button>`);
  if (!rows.length) rows.push(`<div class="em-note">No wallet found in this browser. <a href="/app/locks?dev=${encodeURIComponent(KEY)}${PRESET_TOKEN ? "&token=" + encodeURIComponent(PRESET_TOKEN) : ""}" target="_blank" rel="noopener">Open HoodLock in a new tab →</a></div>`);
  frame(`<div class="em-body"><div class="em-title">Connect a wallet to lock tokens</div><div class="em-wallets">${rows.join("")}</div><div class="em-msg" id="emMsg"></div></div>`);
  root().querySelectorAll<HTMLElement>(".em-wallet").forEach((b) => b.addEventListener("click", async () => {
    const msg = $("emMsg"); msg.className = "em-msg"; msg.textContent = "Connecting…";
    try {
      if (b.dataset.wc) await connectWC();
      else if (b.dataset.injected) await connectInjected(eth);
      else { const w = announced.get(b.dataset.rdns!); if (w) await connectInjected(w.provider); }
    } catch (e: any) { msg.className = "em-msg bad"; msg.textContent = friendlyErr(e); }
  }));
}
function renderForm() {
  const tokenRO = PRESET_TOKEN && isAddress(PRESET_TOKEN);
  const dateVal = PRESET_UNLOCK && /^\d+$/.test(PRESET_UNLOCK) ? new Date(Number(PRESET_UNLOCK) * 1000).toISOString().slice(0, 10) : "";
  frame(`<div class="em-body">
    <div class="em-acct">Connected · ${short(account)}</div>
    <label class="em-l">Token address</label>
    <input class="em-in" id="emToken" placeholder="0x…" value="${esc(PRESET_TOKEN)}" ${tokenRO ? "readonly" : ""} spellcheck="false" autocomplete="off">
    <div class="em-row"><label class="em-l">Amount${tokenMeta ? ` · <span class="em-bal" id="emMax">max ${formatUnits(tokenMeta.bal, tokenMeta.decimals)}</span>` : ""}</label></div>
    <input class="em-in" id="emAmount" inputmode="decimal" placeholder="0.0" autocomplete="off">
    <label class="em-l">Unlock date</label>
    <input class="em-in" id="emDate" type="date" value="${dateVal}">
    <button class="em-btn" id="emLock">Lock ${tokenMeta ? "$" + esc(tokenMeta.symbol) : "tokens"}</button>
    <div class="em-fee" id="emFee">Flat fee ${formatUnits(feeWei, 18)} ETH · no percentage cuts</div>
    <div class="em-msg" id="emMsg"></div>
  </div>`);
  const tokenInput = $("emToken") as HTMLInputElement;
  if (!tokenRO) tokenInput.addEventListener("blur", async () => { if (isAddress(tokenInput.value.trim())) { await loadToken(tokenInput.value.trim()); renderForm(); } });
  $("emMax")?.addEventListener("click", () => { if (tokenMeta) ($("emAmount") as HTMLInputElement).value = formatUnits(tokenMeta.bal, tokenMeta.decimals); });
  $("emLock").addEventListener("click", () => doLock($("emMsg"), $("emLock") as HTMLButtonElement));
}
function renderDone(tx: string, lockId: number | null) {
  frame(`<div class="em-body em-center">
    <div class="em-ok">🔒</div>
    <div class="em-title">Locked${lockId != null ? ` · #${lockId}` : ""}</div>
    <div class="em-note">Your tokens are locked on-chain with a shareable proof.</div>
    <div class="em-acts">
      <a class="em-btn" href="${EXP}/tx/${tx}" target="_blank" rel="noopener">View transaction</a>
      ${lockId != null ? `<a class="em-btn em-line" href="https://hoodlock.tech/proof/lock/${lockId}" target="_blank" rel="noopener">Open proof page</a>` : ""}
    </div>
    <button class="em-link" id="emDone">Done</button>
  </div>`);
  $("emDone").addEventListener("click", () => post("close"));
}

/* ---------- boot ---------- */
async function boot() {
  if (!KEY) { frame(`<div class="em-body"><div class="em-msg bad">Missing embed key.</div></div>`); return; }
  // validate the key + pull fee/commission
  try {
    const r = await fetch(`/api/dev/config?key=${encodeURIComponent(KEY)}`);
    if (!r.ok) { frame(`<div class="em-body"><div class="em-msg bad">Invalid embed key.</div></div>`); return; }
    const c = await r.json(); if (c.feeWei) feeWei = BigInt(c.feeWei);
  } catch { /* keep default fee; still allow connect */ }
  pub.readContract({ address: LOCKER, abi: FEE_ABI, functionName: "fee" }).then((f: any) => { feeWei = BigInt(f); }).catch(() => { /* */ });
  post("ready");
  renderConnect();
  // re-render connect as wallets announce
  window.addEventListener("eip6963:announceProvider", () => { if (!account) renderConnect(); });
}
boot();
