/* Revenue drop schedule for the web app.
 *
 * The actual schedule math lives in shared/revenue-schedule.mjs so the server
 * can compute the same weekly windows (the pool endpoint must agree with the
 * countdown to the second). This file re-exports it and keeps the web-only
 * parts: the TypeScript shapes and the payout-status fetch.
 */
export {
  PAYOUT, instantAt, firstPayout, nextPayout, previousPayout,
  dropPhase, countdownParts, payoutDateLabel, localTimeLabel,
} from "@shared/revenue-schedule.mjs";

export type DropPhase =
  | { phase: "countdown"; target: number }
  | { phase: "processing"; since: number; target: number }
  | { phase: "complete"; since: number; target: number };

/* ---------- payout status (backend hook) ----------
 * There is no payout-status endpoint yet. This is the seam it plugs into:
 * once the server exposes GET /api/revenue/status the UI starts honouring it
 * with no other change. Anything short of a well-formed answer is "unknown",
 * and unknown never claims a payout happened. */
export type PayoutStatus =
  | { state: "unknown" }
  | { state: "processing" }
  | { state: "complete"; at?: number };

export async function fetchPayoutStatus(): Promise<PayoutStatus> {
  try {
    const r = await fetch("/api/revenue/status", { headers: { Accept: "application/json" } });
    if (!r.ok) return { state: "unknown" };
    const j: any = await r.json();
    if (j && j.state === "complete") return { state: "complete", at: Number(j.at) || undefined };
    if (j && j.state === "processing") return { state: "processing" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}
