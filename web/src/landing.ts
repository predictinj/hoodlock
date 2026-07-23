/* HoodLock landing — page motion + live on-chain stats (read-only, no wallet).
   Everything degrades gracefully if the RPC is unreachable: static copy stays,
   live numbers keep their "—" placeholders and the ticker shows a fallback. */
import { createPublicClient, http, defineChain, formatUnits, getAddress } from "viem";
import cfg from "./config.json";
import LOCKER_ABI from "./locker-abi.json";
import { computeTvl, fmtUsd } from "./tvl";

const CHAIN = defineChain({
  id: cfg.chainId, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
});
const pub = createPublicClient({ chain: CHAIN, transport: http(cfg.rpc) });
const LOCKER = getAddress(cfg.locker) as `0x${string}`;

const $ = (id: string) => document.getElementById(id);
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

/* ---------- page motion (nav glass, reveals, spotlights) ---------- */
const nav = $("nav")!;
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 24), { passive: true });

const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add("reveal-in"); io.unobserve(e.target); }
}), { threshold: 0.06, rootMargin: "0px 0px -40px 0px" });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

document.querySelectorAll<HTMLElement>(".cell,.stepc").forEach((c) => c.addEventListener("pointermove", (e) => {
  const r = c.getBoundingClientRect();
  c.style.setProperty("--mx", `${e.clientX - r.left}px`);
  c.style.setProperty("--my", `${e.clientY - r.top}px`);
}));

/* ---------- contract links ---------- */
const contractUrl = `${cfg.explorer}/address/${LOCKER}?tab=contract`;
($("ctaContract") as HTMLAnchorElement | null)?.setAttribute("href", contractUrl);
($("footContract") as HTMLAnchorElement | null)?.setAttribute("href", contractUrl);

/* ---------- count-up ---------- */
function countUp(el: HTMLElement, end: number) {
  const t0 = performance.now();
  const tick = (t: number) => {
    const p = Math.min(1, (t - t0) / 1400), ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(end * ease).toLocaleString("en-US");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- live chain data ---------- */
const ERC20_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const metaCache = new Map<string, { symbol: string; decimals: number }>();
async function tokMeta(addr: string) {
  if (metaCache.has(addr)) return metaCache.get(addr)!;
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: addr as `0x${string}`, abi: ERC20_META, functionName: "symbol" }).catch(() => "TOKEN"),
    pub.readContract({ address: addr as `0x${string}`, abi: ERC20_META, functionName: "decimals" }).catch(() => 18),
  ]);
  const m = { symbol: String(symbol), decimals: Number(decimals) };
  metaCache.set(addr, m); return m;
}
const fmtAmt = (v: bigint, d: number) => {
  const n = Number(formatUnits(v, d));
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const dt = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase();

/* hero-mockup mini chart ← cumulative locks vs block number (real events) */
function drawMockChart(logs: any[]) {
  if (!logs.length) return; // keep the decorative sample until there's data
  const line = $("mockLine"), area = $("mockArea"), dot = $("mockDot");
  if (!line || !area || !dot) return;
  const sorted = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
  const b0 = Number(sorted[0].blockNumber), b1 = Math.max(Number(sorted[sorted.length - 1].blockNumber), b0 + 1);
  const W = 560, H = 110, n = sorted.length;
  const x = (b: number) => ((b - b0) / (b1 - b0)) * (W - 20) + 4;
  const y = (c: number) => H - 12 - (c / n) * (H - 26);
  let pts = `0,${y(0).toFixed(1)}`;
  sorted.forEach((lg, i) => { const px = x(Number(lg.blockNumber)).toFixed(1); pts += ` ${px},${y(i).toFixed(1)} ${px},${y(i + 1).toFixed(1)}`; });
  pts += ` ${W},${y(n).toFixed(1)}`;
  line.setAttribute("points", pts);
  area.setAttribute("points", `0,${H} ${pts} ${W},${H}`);
  dot.setAttribute("cx", String(W)); dot.setAttribute("cy", y(n).toFixed(1));
}

async function loadLive() {
  // fee (hero + mock tile)
  try {
    const fee = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "fee" }) as bigint;
    const feeStr = `${formatUnits(fee, 18)} ETH`;
    $("heroFee")!.textContent = feeStr;
  } catch { /* keep placeholders */ }

  try {
    const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
    countUp($("statLocks")!, total);
    $("mockLocks")!.textContent = total.toLocaleString("en-US");

    // latest locks → ticker + mock rows; owners/active from the same reads
    const ids: number[] = [];
    for (let i = total - 1; i >= 0 && ids.length < 12; i--) ids.push(i);
    const locks = await Promise.all(ids.map(async (id) => {
      const l: any = await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "getLock", args: [BigInt(id)] });
      return { id, owner: String(l.owner), token: String(l.token), amount: l.amount as bigint, unlockTime: Number(l.unlockTime), withdrawn: Boolean(l.withdrawn) };
    }));

    // unique wallets + active count across ALL locks: from Locked logs (cheap, one call)
    let lockedLogs: any[] = [];
    try {
      lockedLogs = await pub.getLogs({
        address: LOCKER, fromBlock: 0n, toBlock: "latest",
        event: { type: "event", name: "Locked", inputs: [
          { name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true },
          { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
          { name: "unlockTime", type: "uint256", indexed: false } ] } as any,
      });
      const owners = new Set(lockedLogs.map((lg: any) => String(lg.args.owner).toLowerCase()));
      countUp($("statWallets")!, owners.size);
      $("mockWallets")!.textContent = owners.size.toLocaleString("en-US");
      drawMockChart(lockedLogs);
    } catch { /* wallets stay — */ }

    const now = Math.floor(Date.now() / 1000);
    const activeSampled = locks.filter((l) => !l.withdrawn && l.unlockTime > now).length;
    // exact when total is small (we sampled everything), lower bound otherwise
    countUp($("statActive")!, activeSampled);
    if (total > ids.length) $("statActive")!.textContent += "+";

    const live = locks.filter((l) => !l.withdrawn);
    if (live.length) {
      const items = await Promise.all(live.map(async (l) => {
        const m = await tokMeta(l.token);
        return { ...l, sym: m.symbol, amt: fmtAmt(l.amount, m.decimals) };
      }));
      const tapeHTML = items.map((t) =>
        `<a class="tape-item" href="/app.html?lock=${t.id}"><span class="lk">🔒</span><span class="sym">$${esc(t.sym)}</span><span>${t.amt} locked</span><span class="dt">until ${dt(t.unlockTime)}</span></a>`).join("");
      $("tape")!.innerHTML = tapeHTML + tapeHTML; // duplicated for the seamless -50% loop
      $("mockRows")!.innerHTML = items.slice(0, 2).map((t) => `
        <div class="wm-row"><span class="ico" style="background:#00e05a">${esc(t.sym.slice(0, 2).toUpperCase())}</span>
        <b>$${esc(t.sym)}</b><span class="mono">${t.amt}</span><span class="pill">🔒 ${dt(t.unlockTime)}</span></div>`).join("");

      // bento proof card ← latest still-locked lock (falls back to latest active)
      const nowPick = Math.floor(Date.now() / 1000);
      const latest = items.find((i) => i.unlockTime > nowPick) || items[0];
      $("pmToken")!.textContent = `$${latest.sym}`;
      $("pmAmount")!.textContent = Number(formatUnits(latest.amount, metaCache.get(latest.token)!.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
      $("pmOwner")!.textContent = latest.owner.slice(0, 6) + "…" + latest.owner.slice(-4);
      const nowSec = Math.floor(Date.now() / 1000);
      $("pmStatus")!.textContent = nowSec >= latest.unlockTime ? "● Unlocked" : "● Locked";
      $("pmEnd")!.textContent = "UNLOCKS " + dt(latest.unlockTime);
      try {
        const lg = lockedLogs.find((g: any) => Number(g.args.id) === latest.id);
        const blk = await pub.getBlock({ blockNumber: lg.blockNumber });
        const t0 = Number(blk.timestamp);
        const pct = nowSec >= latest.unlockTime ? 100 : Math.min(99, Math.max(1, Math.round(((nowSec - t0) / (latest.unlockTime - t0)) * 100)));
        ($("pmFill") as HTMLElement).style.width = pct + "%";
        $("pmStart")!.textContent = "LOCKED " + dt(t0);
      } catch { ($("pmFill")!.closest(".lock-track") as HTMLElement).style.display = "none"; }
    } else {
      $("tape")!.innerHTML = `<span class="tape-item"><span class="lk">🔒</span><span class="sym">HOODLOCK IS LIVE</span><span>be the first to lock on Robinhood Chain</span></span>`.repeat(6);
    }
  } catch {
    // RPC unreachable — leave placeholders, show a neutral tape
    $("tape")!.innerHTML = `<span class="tape-item"><span class="lk">🔒</span><span class="sym">HOODLOCK</span><span>live locks on Robinhood Chain</span><span class="dt">open the app to explore</span></span>`.repeat(6);
  }
}
loadLive();

/* ---------- TVL i mock-dashboarden (klientside, djup-kapad) ---------- */
(async function loadMockTvl() {
  try {
    const total = Number(await pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "totalLocks" }));
    if (!total) { const el = $("mockTvl"); if (el) el.textContent = "$0"; return; }
    const locks = await Promise.all(Array.from({ length: total }, (_, i) =>
      (pub.readContract({ address: LOCKER, abi: LOCKER_ABI as any, functionName: "getLock", args: [BigInt(i)] }) as Promise<any>)
        .then((l) => ({ token: String(l.token), amount: l.amount as bigint, withdrawn: Boolean(l.withdrawn) }))
        .catch(() => null)));
    const t = await computeTvl(pub as any, locks.filter((x): x is { token: string; amount: bigint; withdrawn: boolean } => !!x));
    const el = $("mockTvl");
    if (el) el.textContent = t.ethUsd > 0 ? fmtUsd(t.usd) : `${t.eth.toFixed(3)} ETH`;
  } catch { /* behåll — */ }
})();
