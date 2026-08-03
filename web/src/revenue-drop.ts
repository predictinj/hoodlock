/* The revenue drop — floating widget + dialog.
 *
 * Threshold model (owner decision 2026-08-03): there is no calendar. Fees
 * fill the on-chain buyback vault; when it reaches its threshold (0.02 ETH,
 * or 30 days since the last drop, whichever comes first) anyone may fire the
 * permissionless, oracle-guarded buyback, and the bought $LOCK opens as a
 * claim round for qualified lockers. So the widget shows a fill meter, not a
 * countdown, fed by /api/revenue/pool (server-cached vault reads).
 *
 * Self-contained: injects its own styles and markup, styled from the same
 * design tokens as the rest of the site (with local fallbacks so it renders
 * correctly on any page that imports it).
 *
 * Layering: the dock sits at z 90, below the app's transient toasts (200) and
 * every existing modal (110/150), so nothing important is ever covered. The
 * dialog veil sits at 140, above page chrome but below wallet flows.
 */

const MIN_KEY = "hl_rvd_min_ts";
const MIN_FOR_MS = 24 * 3600_000;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* A faint mono-noise tile so the glass reads as material rather than flat
   fill. Kept tiny and inline: no request, no dependency. */
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E\")";

const CSS = `
.rvd-dock,.rvd-veil{--rvd-neon:var(--neon,#00e05a);--rvd-ink:var(--ink,#eef4ef);--rvd-ink2:var(--ink-2,#8fa396);
  --rvd-ink3:var(--ink-3,#59695e);--rvd-mono:var(--mono,'JetBrains Mono',ui-monospace,monospace);
  --rvd-sans:var(--sans,'Inter',system-ui,sans-serif);--rvd-serif:var(--serif,'Instrument Serif',Georgia,serif);
  font-family:var(--rvd-sans);color:var(--rvd-ink)}

/* ---------- dock (bottom-right) ---------- */
.rvd-dock{position:fixed;right:22px;bottom:calc(22px + env(safe-area-inset-bottom,0px));z-index:90;
  display:flex;align-items:flex-end;opacity:0;transform:translateY(26px) scale(.92);pointer-events:none}
.rvd-dock.in{opacity:1;transform:none;pointer-events:auto;
  transition:opacity .5s ease,transform .65s cubic-bezier(.34,1.56,.64,1)}
.rvd-fab{position:relative;display:flex;align-items:center;gap:13px;text-align:left;cursor:pointer;
  border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:12px 18px 12px 13px;
  background:linear-gradient(160deg,rgba(16,24,19,.92),rgba(7,11,9,.94));
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 18px 44px -14px rgba(0,0,0,.75),0 8px 30px -14px rgba(0,224,90,.28);
  overflow:hidden;color:var(--rvd-ink);font-family:var(--rvd-sans);
  transition:transform .25s ease,border-color .25s ease,box-shadow .25s ease}
.rvd-fab:hover{transform:translateY(-2px);border-color:rgba(0,224,90,.35);
  box-shadow:0 1px 0 rgba(255,255,255,.08) inset,0 22px 50px -14px rgba(0,0,0,.8),0 10px 34px -12px rgba(0,224,90,.4)}
.rvd-fab:focus-visible{outline:2px solid var(--rvd-neon);outline-offset:3px}
.rvd-fab::before{content:"";position:absolute;inset:0;background-image:${NOISE};opacity:.05;pointer-events:none}
/* one controlled light: a sheen that crosses the glass, then rests */
.rvd-fab::after{content:"";position:absolute;top:-40%;bottom:-40%;left:-30%;width:34%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.07) 45%,rgba(0,224,90,.05) 55%,transparent);
  transform:translateX(-140%) rotate(8deg);animation:rvdSheen 16s ease-in-out infinite;pointer-events:none}
@keyframes rvdSheen{0%,72%{transform:translateX(-160%) rotate(8deg)}86%,100%{transform:translateX(1200%) rotate(8deg)}}
/* calm idle: a small lift twice a minute, still the rest of the time */
.rvd-dock.in .rvd-fab{animation:rvdIdle 26s ease-in-out 6s infinite}
@keyframes rvdIdle{0%,90%,100%{transform:translateY(0)}93%{transform:translateY(-4px)}96%{transform:translateY(-1px)}}
.rvd-fab:hover{animation-play-state:paused}

.rvd-ico{position:relative;flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;
  background:linear-gradient(160deg,rgba(0,224,90,.14),rgba(0,224,90,.03));
  border:1px solid rgba(0,224,90,.28);box-shadow:0 1px 0 rgba(255,255,255,.08) inset}
.rvd-ico svg{display:block}
.rvd-dot{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;
  background:var(--rvd-neon);box-shadow:0 0 10px rgba(0,224,90,.9);animation:rvdPulse 2.6s ease-in-out infinite}
@keyframes rvdPulse{0%,100%{opacity:1}50%{opacity:.45}}

.rvd-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.rvd-label{font-family:var(--rvd-mono);font-size:9.5px;letter-spacing:2.4px;color:var(--rvd-ink2);white-space:nowrap}
.rvd-count{font-family:var(--rvd-mono);font-size:16px;font-weight:600;letter-spacing:.5px;color:var(--rvd-ink);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.rvd-count .u{color:var(--rvd-ink3);font-size:11px;margin-left:4px}
.rvd-count.ready{color:var(--rvd-neon)}
.rvd-fabbar{width:130px;height:3px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:5px}
.rvd-fabbar i{display:block;height:100%;width:0%;border-radius:2px;background:var(--rvd-neon);transition:width .6s ease}
.rvd-peek{font-size:11.5px;color:var(--rvd-ink2);white-space:nowrap;max-height:0;opacity:0;overflow:hidden;
  transition:max-height .45s cubic-bezier(.16,1,.3,1),opacity .4s ease .05s,margin-top .45s cubic-bezier(.16,1,.3,1)}
.rvd-peek b{color:var(--rvd-neon);font-weight:600}
.rvd-dock.peek .rvd-peek{max-height:20px;opacity:1;margin-top:3px}

/* minimize control + minimized shape */
.rvd-hide{position:absolute;top:-7px;left:-7px;width:20px;height:20px;border-radius:50%;border:1px solid rgba(255,255,255,.14);
  background:#0c120e;color:var(--rvd-ink3);font-size:11px;line-height:1;cursor:pointer;display:grid;place-items:center;
  opacity:0;transition:opacity .2s ease,color .2s ease;z-index:2}
.rvd-dock:hover .rvd-hide,.rvd-hide:focus-visible{opacity:1}
.rvd-hide:hover{color:var(--rvd-ink)}
.rvd-hide:focus-visible{outline:2px solid var(--rvd-neon);outline-offset:2px}
.rvd-dock.min .rvd-fab{padding:10px;border-radius:14px;gap:0}
.rvd-dock.min .rvd-txt{display:none}
.rvd-dock.min .rvd-hide{display:none}

/* ---------- dialog ---------- */
.rvd-veil{position:fixed;inset:0;z-index:140;display:none;align-items:center;justify-content:center;
  padding:24px;background:rgba(2,5,3,.72);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.rvd-veil.show{display:flex;animation:rvdFade .25s ease}
@keyframes rvdFade{from{opacity:0}}
.rvd-modal{position:relative;width:min(660px,100%);max-height:min(92dvh,860px);overflow-y:auto;overscroll-behavior:contain;
  border-radius:22px;padding:44px 48px 40px;
  background:linear-gradient(168deg,rgba(15,23,18,.94),rgba(6,10,8,.96) 55%,rgba(8,14,11,.94));
  border:1px solid rgba(255,255,255,.09);
  box-shadow:0 1px 0 rgba(255,255,255,.07) inset,0 -18px 60px -32px rgba(0,224,90,.35) inset,
    0 40px 120px -30px rgba(0,0,0,.9),0 0 90px -30px rgba(0,224,90,.25);
  animation:rvdRise .5s cubic-bezier(.16,1,.3,1)}
@keyframes rvdRise{from{opacity:0;transform:translateY(22px) scale(.965)}}
.rvd-modal::before{content:"";position:absolute;inset:0;border-radius:22px;background-image:${NOISE};opacity:.045;pointer-events:none}
/* top light edge, the "machined bevel" */
.rvd-modal::after{content:"";position:absolute;top:0;left:8%;right:8%;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),rgba(0,224,90,.35),rgba(255,255,255,.28),transparent)}
.rvd-x{position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.03);color:var(--rvd-ink2);font-size:15px;cursor:pointer;display:grid;place-items:center;
  transition:color .2s,border-color .2s}
.rvd-x:hover{color:var(--rvd-ink);border-color:rgba(255,255,255,.25)}
.rvd-x:focus-visible{outline:2px solid var(--rvd-neon);outline-offset:2px}

.rvd-eyebrow{font-family:var(--rvd-mono);font-size:10.5px;letter-spacing:3.2px;color:var(--rvd-neon);margin-bottom:14px;padding-right:48px}
.rvd-h{font-size:clamp(28px,4.6vw,40px);font-weight:800;letter-spacing:-1px;line-height:1.04;margin:0 0 12px}
.rvd-h .s{font-family:var(--rvd-serif);font-style:italic;font-weight:400;letter-spacing:0;color:var(--rvd-neon)}
.rvd-sub{font-size:15px;line-height:1.55;color:var(--rvd-ink2);margin:0 0 28px;max-width:46ch}
.rvd-sub b{color:var(--rvd-neon);font-weight:700;font-size:17px}

.rvd-stage{border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:26px 22px 24px;margin-bottom:24px;text-align:center;
  background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0) 40%),rgba(3,6,4,.5);
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset}
.rvd-nextlabel{font-family:var(--rvd-mono);font-size:10.5px;letter-spacing:3px;color:var(--rvd-ink2);margin-bottom:16px}
.rvd-nextlabel i{font-style:normal;color:var(--rvd-neon);margin-right:8px}
.rvd-meterpct{font-family:var(--rvd-mono);font-weight:600;font-size:clamp(34px,6vw,52px);letter-spacing:1px;font-variant-numeric:tabular-nums}
.rvd-meterpct.ready{color:var(--rvd-neon)}
.rvd-meterbar{height:6px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;margin:16px 12% 0}
.rvd-meterbar i{display:block;height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,rgba(10,168,79,1),var(--rvd-neon));
  box-shadow:0 0 12px rgba(0,224,90,.5);transition:width .6s cubic-bezier(.16,1,.3,1)}
.rvd-when{margin-top:16px;font-family:var(--rvd-mono);font-size:11.5px;letter-spacing:1.4px;color:var(--rvd-ink2)}
.rvd-when b{color:var(--rvd-ink);font-weight:600}
.rvd-when span{display:block;margin-top:6px;font-size:10px;letter-spacing:1.6px;color:var(--rvd-ink3)}

.rvd-facts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:26px}
.rvd-fact{border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 15px;background:rgba(255,255,255,.018)}
.rvd-fact .v{font-family:var(--rvd-mono);font-weight:600;font-size:19px;color:var(--rvd-neon);margin-bottom:8px}
.rvd-fact h4{font-size:12.5px;font-weight:600;margin:0 0 6px;letter-spacing:.1px}
.rvd-fact p{font-size:11.5px;line-height:1.5;color:var(--rvd-ink2);margin:0}

.rvd-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.rvd-cta{display:inline-flex;align-items:center;gap:8px;border-radius:11px;padding:12px 22px;font-size:13.5px;font-weight:600;
  text-decoration:none;background:var(--rvd-neon);color:#03130a;border:none;cursor:pointer;
  box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 8px 28px -8px rgba(0,224,90,.55);
  transition:transform .2s ease,box-shadow .2s ease}
.rvd-cta:hover{transform:translateY(-1px);box-shadow:0 1px 0 rgba(255,255,255,.3) inset,0 12px 32px -8px rgba(0,224,90,.65)}
.rvd-cta:focus-visible{outline:2px solid var(--rvd-ink);outline-offset:2px}
.rvd-more{background:none;border:none;padding:12px 4px;font-size:13px;font-weight:500;color:var(--rvd-ink2);cursor:pointer;
  border-bottom:1px solid transparent;transition:color .2s}
.rvd-more:hover{color:var(--rvd-ink)}
.rvd-more:focus-visible{outline:2px solid var(--rvd-neon);outline-offset:2px}
.rvd-how{margin-top:18px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px;font-size:13px;line-height:1.65;color:var(--rvd-ink2)}
.rvd-how b{color:var(--rvd-ink)}
.rvd-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

@media (max-width:640px){
  .rvd-dock{right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}
  .rvd-hide{opacity:.55}
  .rvd-modal{padding:32px 20px 26px;border-radius:18px}
  .rvd-veil{padding:12px;align-items:flex-end}
  .rvd-facts{grid-template-columns:1fr}
  .rvd-actions .rvd-cta{width:100%;justify-content:center}
}
@media (prefers-reduced-motion:reduce){
  .rvd-fab::after,.rvd-dock.in .rvd-fab,.rvd-dot{animation:none}
  .rvd-modal,.rvd-veil.show{animation:none}
  .rvd-dock{transition:none}
}`;

/* Minimal vault mark: a machined dial, no cartoon. */
const ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00e05a" stroke-width="1.7" aria-hidden="true">
  <rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/>
  <circle cx="12" cy="12" r="4.6"/>
  <path d="M12 7.4V5.2M12 18.8v-2.2M16.6 12h2.2M5.2 12h2.2"/>
  <circle cx="12" cy="12" r="1.1" fill="#00e05a" stroke="none"/>
</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

type VaultState = { pendingEth: number; thresholdEth: number; canExecute: boolean } | null;

export function initRevenueDrop() {
  if (document.getElementById("rvdDock")) return; // idempotent

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ---------- dock ---------- */
  const dock = el("div", "rvd-dock");
  dock.id = "rvdDock";
  dock.innerHTML = `
    <button class="rvd-fab" type="button" aria-haspopup="dialog" aria-controls="rvdModal">
      <span class="rvd-ico">${ICON}<i class="rvd-dot"></i></span>
      <span class="rvd-txt">
        <span class="rvd-label">REVENUE DROP</span>
        <span class="rvd-count" id="rvdFabCount">&nbsp;</span>
        <span class="rvd-fabbar"><i id="rvdFabFill"></i></span>
        <span class="rvd-peek">$LOCK lockers receive <b>50%</b> of HoodLock revenue.</span>
      </span>
    </button>
    <button class="rvd-hide" type="button" aria-label="Minimize the revenue drop widget">×</button>`;
  document.body.appendChild(dock);

  const fab = dock.querySelector<HTMLButtonElement>(".rvd-fab")!;
  const fabCount = dock.querySelector<HTMLElement>("#rvdFabCount")!;
  const fabFill = dock.querySelector<HTMLElement>("#rvdFabFill")!;
  const hideBtn = dock.querySelector<HTMLButtonElement>(".rvd-hide")!;

  const minimizedAt = Number(localStorage.getItem(MIN_KEY) || 0);
  if (minimizedAt && Date.now() - minimizedAt < MIN_FOR_MS) dock.classList.add("min");
  else if (minimizedAt) localStorage.removeItem(MIN_KEY);

  hideBtn.addEventListener("click", () => {
    dock.classList.add("min");
    try { localStorage.setItem(MIN_KEY, String(Date.now())); } catch { /* still minimized this session */ }
  });

  // Spring in once the page has settled; instantly when motion is reduced.
  setTimeout(() => dock.classList.add("in"), reduced() ? 0 : 1300);

  // The occasional reveal: calm by default, one line of context now and then.
  if (!reduced()) {
    setInterval(() => {
      if (dock.classList.contains("min") || veil.classList.contains("show")) return;
      dock.classList.add("peek");
      setTimeout(() => dock.classList.remove("peek"), 5500);
    }, 48_000);
  }

  /* ---------- dialog ---------- */
  const veil = el("div", "rvd-veil");
  veil.innerHTML = `
  <div class="rvd-modal" role="dialog" aria-modal="true" aria-labelledby="rvdTitle" id="rvdModal">
    <button class="rvd-x" type="button" aria-label="Close">×</button>
    <div class="rvd-eyebrow">HOODLOCK · REVENUE DISTRIBUTION</div>
    <h2 class="rvd-h" id="rvdTitle">Lock $LOCK. <span class="s">Get paid.</span></h2>
    <p class="rvd-sub">HoodLock distributes <b>50%</b> of its platform revenue to wallets that lock $LOCK for 7 days or more, every time the pool fills.</p>

    <section class="rvd-stage">
      <div class="rvd-nextlabel"><i>●</i>NEXT REVENUE DROP</div>
      <div class="rvd-meterpct" id="rvdMeterPct">--</div>
      <div class="rvd-meterbar"><i id="rvdMeterFill"></i></div>
      <div class="rvd-when"><b id="rvdMeterEth">--</b>
        <span id="rvdMeterSub">Fires automatically once the pool reaches the threshold. Anyone can trigger it.</span>
      </div>
      <p class="rvd-sr" id="rvdSr" aria-live="polite"></p>
    </section>

    <div class="rvd-facts">
      <div class="rvd-fact"><div class="v">50%</div><h4>Revenue Share</h4>
        <p>Half of HoodLock's platform revenue is allocated to wallets locking $LOCK.</p></div>
      <div class="rvd-fact"><div class="v">AUTO</div><h4>No Schedule</h4>
        <p>Drops fire whenever the pool reaches its threshold, and at most 30 days apart. Busy weeks drop faster.</p></div>
      <div class="rvd-fact"><div class="v">7D+</div><h4>Based on Your Locked Share</h4>
        <p>Your payout follows your share of all qualified locked $LOCK. Locks need a duration of 7 days or more.</p></div>
    </div>

    <div class="rvd-actions">
      <a class="rvd-cta" href="/app/revenue">Open HoodLock</a>
      <button class="rvd-more" type="button" aria-expanded="false" aria-controls="rvdHow">How revenue sharing works</button>
    </div>
    <div class="rvd-how" id="rvdHow" hidden>
      HoodLock earns fees every time someone locks, burns, vests or airdrops on the platform.
      <b>Half of that revenue flows on-chain into a buyback vault.</b> Once the vault reaches its
      threshold, anyone can fire the oracle-guarded buyback; the bought $LOCK opens as a claim
      round, split across all qualified locks by how much $LOCK each wallet has locked. A lock
      qualifies with a chosen duration of 7 days or more; holding unlocked tokens earns nothing.
      Claims stay open for 180 days.
    </div>
  </div>`;
  document.body.appendChild(veil);

  const modal = veil.querySelector<HTMLElement>(".rvd-modal")!;
  const closeBtn = veil.querySelector<HTMLButtonElement>(".rvd-x")!;
  const moreBtn = veil.querySelector<HTMLButtonElement>(".rvd-more")!;
  const howBox = veil.querySelector<HTMLElement>("#rvdHow")!;
  const srLine = veil.querySelector<HTMLElement>("#rvdSr")!;

  moreBtn.addEventListener("click", () => {
    const open = howBox.hidden;
    howBox.hidden = !open;
    moreBtn.setAttribute("aria-expanded", String(open));
  });

  /* focus handling: trap inside the dialog, give focus back on close */
  let lastFocus: HTMLElement | null = null;
  const focusables = () =>
    [...modal.querySelectorAll<HTMLElement>("a[href],button:not([disabled])")].filter((n) => n.offsetParent !== null);
  const open = () => {
    lastFocus = document.activeElement as HTMLElement;
    veil.classList.add("show");
    void refresh(true);
    closeBtn.focus();
  };
  const close = () => {
    veil.classList.remove("show");
    lastFocus?.focus?.();
  };
  fab.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  veil.addEventListener("mousedown", (e) => { if (e.target === veil) close(); });
  document.addEventListener("keydown", (e) => {
    if (!veil.classList.contains("show")) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- the meter ---------- */
  let vault: VaultState = null;
  let fetchedAt = 0;
  async function refresh(force = false) {
    if (!force && Date.now() - fetchedAt < 55_000) { render(); return; }
    fetchedAt = Date.now();
    try {
      const r = await fetch("/api/revenue/pool");
      if (r.ok) {
        const j: any = await r.json();
        vault = j?.vault && typeof j.vault.pendingEth === "number"
          ? { pendingEth: j.vault.pendingEth, thresholdEth: j.vault.thresholdEth, canExecute: !!j.vault.canExecute }
          : null;
      }
    } catch { /* keep the last state */ }
    render();
  }
  function render() {
    if (!vault) {
      fabCount.textContent = "· · ·";
      fabFill.style.width = "0%";
      return;
    }
    const pct = vault.thresholdEth > 0 ? Math.min(100, (vault.pendingEth / vault.thresholdEth) * 100) : 0;
    const shown = vault.canExecute ? 100 : pct;
    if (vault.canExecute) {
      fabCount.innerHTML = `READY<span class="u">DROP ARMED</span>`;
      fabCount.classList.add("ready");
    } else {
      fabCount.innerHTML = `${pct < 1 && vault.pendingEth > 0 ? "<1" : Math.floor(pct)}%<span class="u">TO NEXT DROP</span>`;
      fabCount.classList.remove("ready");
    }
    fabFill.style.width = `${shown}%`;
    const pctEl = veil.querySelector<HTMLElement>("#rvdMeterPct")!;
    pctEl.textContent = vault.canExecute ? "READY" : `${pct < 1 && vault.pendingEth > 0 ? "<1" : Math.floor(pct)}%`;
    pctEl.classList.toggle("ready", vault.canExecute);
    veil.querySelector<HTMLElement>("#rvdMeterFill")!.style.width = `${shown}%`;
    veil.querySelector<HTMLElement>("#rvdMeterEth")!.textContent = `${vault.pendingEth.toFixed(4)} / ${vault.thresholdEth} ETH`;
    veil.querySelector<HTMLElement>("#rvdMeterSub")!.textContent = vault.canExecute
      ? "The pool is full. Anyone can fire the buyback; the price is oracle-guarded."
      : "Fires automatically once the pool reaches the threshold. Anyone can trigger it. At most 30 days between drops.";
    srLine.textContent = vault.canExecute
      ? "The pool is full and the next revenue drop can be fired."
      : `The pool is ${Math.floor(pct)} percent of the way to the next revenue drop.`;
  }

  void refresh(true);
  setInterval(() => void refresh(), 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(true); });

  // Deep link: /...#revenue opens the drop dialog directly, so the widget can
  // be pointed at from posts and announcements.
  if (location.hash === "#revenue") open();
  window.addEventListener("hashchange", () => { if (location.hash === "#revenue") open(); });
}
