/* Per-proof Open Graph images.
 *
 * Every proof page shared a single static og:image, so a lock, a burn and a
 * vesting schedule all previewed identically on X — the card said "HoodLock"
 * and nothing about what was actually proven. These render the numbers into
 * the card itself, which is the part people read before deciding to click.
 *
 * SVG is composed here and rasterised with resvg; X and Facebook reject SVG
 * as og:image, so PNG is not optional. Fonts come from the container (Debian's
 * fonts-inter), with fallbacks so local dev renders too.
 */
import { Resvg } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200, H = 630;                 // the size every platform crops from
const FONTS = "Inter, sans-serif";

/* Ship the font rather than looking one up. Installing fonts-inter into the
 * image was not enough — resvg found nothing and rendered every card as an
 * empty gradient, so the files are passed by path and system lookup is off.
 * Inter is SIL OFL 1.1; see fonts/LICENSE. */
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fonts");
const FONT_FILES = ["Inter-Regular.otf", "Inter-SemiBold.otf", "Inter-Bold.otf"]
  .map((f) => join(FONT_DIR, f))
  .filter((f) => existsSync(f));

const BG = "#050807", NEON = "#00e05a", INK = "#eef4ef", INK2 = "#8fa396", INK3 = "#59695e";
const KIND = {
  lock:    { eyebrow: "TOKEN LOCK",       accent: NEON,      verb: "LOCKED" },
  burn:    { eyebrow: "PROOF OF BURN",    accent: "#ff6b6b", verb: "BURNED FOREVER" },
  vesting: { eyebrow: "VESTING SCHEDULE", accent: "#f5b731", verb: "VESTING" },
  // A token page answers "is this locked?", so its card leads with the answer
  // rather than an amount — and stays neutral when the answer is no, because
  // the card is about a project we may have no relationship with.
  token:   { eyebrow: "TOKEN ON ROBINHOOD CHAIN", accent: NEON, verb: "" },
};

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shrink the headline until a rough advance-width estimate fits the canvas. */
function fitSize(text, max, startPx, minPx = 46) {
  let px = startPx;
  while (px > minPx && text.length * px * 0.58 > max) px -= 4;
  return px;
}

export function ogSvg(card) {
  const k = KIND[card.kind] || KIND.lock;
  const symbol = esc(String(card.symbol || "TOKEN").slice(0, 14));
  const amount = esc(card.amount || "");
  // Amount and symbol share one line, so size them against the combined width.
  const headline = `${amount} $${symbol}`;
  const size = fitSize(headline, W - 160, 92);

  const supply = card.pct ? `${esc(card.pct)}% OF SUPPLY` : null;
  const meta = [supply, esc(card.status || "")].filter(Boolean).join("   ·   ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${k.accent}" stop-opacity=".16"/>
      <stop offset="100%" stop-color="${k.accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${k.accent}" stop-opacity=".9"/>
      <stop offset="100%" stop-color="${k.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- wordmark -->
  <text x="80" y="98" font-family="${FONTS}" font-size="30" font-weight="700"
        letter-spacing="-1" fill="${INK}">Hood<tspan fill="${NEON}">Lock</tspan></text>

  <!-- chain chip -->
  <rect x="${W - 80 - 268}" y="70" width="268" height="40" rx="20"
        fill="none" stroke="rgba(255,255,255,.14)"/>
  <circle cx="${W - 80 - 244}" cy="90" r="4" fill="${NEON}"/>
  <text x="${W - 80 - 228}" y="96" font-family="${FONTS}" font-size="15"
        letter-spacing="1.6" fill="${INK2}">ROBINHOOD CHAIN</text>

  <!-- eyebrow -->
  <rect x="80" y="228" width="46" height="2" fill="url(#rule)"/>
  <text x="142" y="236" font-family="${FONTS}" font-size="17" font-weight="600"
        letter-spacing="4" fill="${k.accent}">${k.eyebrow}</text>

  <!-- headline -->
  <text x="80" y="${330 + (92 - size) * 0.4}" font-family="${FONTS}" font-size="${size}"
        font-weight="700" letter-spacing="-2.5" fill="${INK}">${amount} <tspan fill="${k.accent}">$${symbol}</tspan></text>

  <!-- what happened, and until when -->
  <text x="80" y="404" font-family="${FONTS}" font-size="34" font-weight="600"
        letter-spacing="-.6" fill="${INK2}">${esc(card.line2 || k.verb)}</text>

  ${meta ? `<text x="80" y="462" font-family="${FONTS}" font-size="18" letter-spacing="2.4"
        fill="${INK3}">${meta}</text>` : ""}

  ${card.kind === "token" && card.stats ? `<text x="80" y="500" font-family="${FONTS}" font-size="18"
        letter-spacing="1.6" fill="${INK3}">${esc(card.stats)}</text>` : ""}

  <!-- footer -->
  <rect x="80" y="524" width="${W - 160}" height="1" fill="rgba(255,255,255,.09)"/>
  <text x="80" y="572" font-family="${FONTS}" font-size="20" font-weight="600"
        letter-spacing="-.2" fill="${INK2}">Verify it yourself on-chain</text>
  <text x="${W - 80}" y="572" text-anchor="end" font-family="${FONTS}" font-size="20"
        font-weight="600" letter-spacing="-.2" fill="${NEON}">hoodlock.tech</text>
</svg>`;
}

/** SVG string → PNG buffer. */
export function renderPng(svg) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: {
      fontFiles: FONT_FILES,
      // Only fall back to system fonts if the bundled files went missing —
      // a card with the wrong font still beats a card with no text.
      loadSystemFonts: FONT_FILES.length === 0,
      defaultFontFamily: "Inter",
    },
  }).render().asPng();
}

/** True when text can actually be drawn — checked at boot so a missing font
 *  shows up in the logs instead of silently shipping blank cards. */
export const fontsReady = () => FONT_FILES.length > 0;

/** Cached PNG per proof. Records are immutable enough that an hour is safe. */
export function makeOgRenderer({ ttlMs = 60 * 60_000, log = () => {} } = {}) {
  const cache = new Map();
  return function ogPng(key, card) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.png;
    let png;
    try {
      png = renderPng(ogSvg(card));
    } catch (e) {
      log(`og render failed for ${key}: ${e?.message || e}`);
      return hit ? hit.png : null;   // stale card beats no card
    }
    cache.set(key, { at: Date.now(), png });
    return png;
  };
}
