/**
 * Turning what somebody pasted into the list the tree is built from.
 *
 * This is shared for the same reason the Merkle code is: the browser builds the
 * root from its parse of the text, and the server re-derives the root from the
 * list it is sent before accepting it. If the two normalise differently, by so
 * much as the order of one entry, the roots differ and every claim fails.
 *
 * Three ways in, all landing on the same structure:
 *   - the same amount to every address, pasted as a plain list of addresses
 *   - an amount per address, pasted as "wallet:amount" lines
 *   - an amount per address, typed row by row in the UI
 *
 * Paste formats are deliberately forgiving, because these lists arrive from
 * spreadsheets, block explorers and Discord. Anything that is not an address is
 * reported rather than silently dropped.
 */

const ADDRESS = /0x[0-9a-fA-F]{40}/g;

/* An airdrop's remaining balance is a uint128 on chain, so a leaf larger than
   that can never be claimed: the amount check would reject it forever. Better
   to say so while the list is still being edited than to mint a dead leaf. */
const MAX_AMOUNT = (1n << 128n) - 1n;

/** Human amount to base units, without floating point. "12.5" at 18 decimals. */
export function toBaseUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`not a number: ${value}`);
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places: ${value}`);
  return BigInt((whole || "0") + frac.padEnd(decimals, "0"));
}

export function fromBaseUnits(value, decimals) {
  // Guard the zero-decimals case first. `slice(0, -0)` is `slice(0, 0)`, the
  // empty string, so the generic path below reports every amount of a
  // 0-decimal token as "0".
  if (decimals === 0) return BigInt(value).toString();
  const s = BigInt(value).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Parse pasted text into { address, amount } rows.
 *
 * Accepts "wallet:amount", "wallet,amount", "wallet amount" and "wallet=amount",
 * as well as bare addresses when every row is to get the same amount. A row's
 * amount wins over `equalAmount` when both are present, so a list that mixes
 * the two still does what it says.
 */
export function parseList(text, { decimals = 18, equalAmount = null } = {}) {
  const rows = [];
  const problems = [];
  const lines = String(text || "").split(/\r?\n/);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;

    ADDRESS.lastIndex = 0;
    const found = line.match(ADDRESS) || [];
    if (found.length > 1) {
      // "0xA:100 0xB:200" used to parse as 0xA only, dropping 0xB without a
      // word. On a tool that sends money, a silently ignored recipient is the
      // wrong kind of forgiving.
      problems.push({ line: i + 1, text: line, reason: `${found.length} addresses on one line, put one per line` });
      return;
    }
    ADDRESS.lastIndex = 0;
    const m = ADDRESS.exec(line);
    if (!m) {
      // A spreadsheet header is the usual reason and is not worth complaining
      // about; anything else the user should see.
      if (i === 0 && /address|wallet|account/i.test(line)) return;
      problems.push({ line: i + 1, text: line, reason: "no address on this line" });
      return;
    }
    const address = m[0].toLowerCase();

    // Whatever follows the address, minus the separator.
    const rest = line.slice(m.index + m[0].length).replace(/^[\s:,;=|\t]+/, "").trim();
    let amount;
    if (rest) {
      const num = rest.split(/[\s,;|]/)[0];
      try {
        amount = toBaseUnits(num, decimals);
      } catch (e) {
        problems.push({ line: i + 1, text: line, reason: e.message });
        return;
      }
      if (amount <= 0n) {
        problems.push({ line: i + 1, text: line, reason: "amount is zero" });
        return;
      }
      if (amount > MAX_AMOUNT) {
        problems.push({ line: i + 1, text: line, reason: "amount is too large to ever be claimed" });
        return;
      }
    } else if (equalAmount != null) {
      amount = BigInt(equalAmount);
    } else {
      problems.push({ line: i + 1, text: line, reason: "no amount, and no amount-for-everyone set" });
      return;
    }

    rows.push({ line: i + 1, address, amount });
  });

  return { rows, problems };
}

/**
 * Normalise a parsed list into the exact form the tree is built from.
 *
 * Two decisions worth stating, because both change the root:
 *
 * Duplicates are merged by summing. The tree needs exactly one leaf per address:
 * two leaves for one wallet would mean two claim transactions for that person,
 * and would count them twice against a fee that is priced per distinct wallet.
 * Of the ways to collapse them, summing is the only one that loses nothing.
 * Dropping the second entry would quietly cost somebody tokens, and rejecting
 * the list would block a wallet that legitimately qualified twice.
 *
 * What the tree needs and what the person pasting should see are not the same
 * thing, though. Paste five lines and read back "4 recipients" and the obvious
 * conclusion is that the tool ate a row. So the rows come back exactly as they
 * were pasted, in that order, each one flagged when it took part in a merge and
 * carrying the combined amount that address will actually receive. The UI shows
 * the paste; the tree uses the entries.
 *
 * The entries are sorted by address. That makes the root a function of the set
 * rather than of the order somebody happened to paste it in, so the same list
 * uploaded twice is the same airdrop, which is what lets the server key stored
 * lists on the root.
 */
export function normaliseList(rows) {
  const byAddress = new Map();
  let merged = 0;
  for (const r of rows) {
    const key = r.address.toLowerCase();
    if (byAddress.has(key)) {
      byAddress.set(key, byAddress.get(key) + BigInt(r.amount));
      merged++;
    } else {
      byAddress.set(key, BigInt(r.amount));
    }
  }

  const seen = new Map();
  for (const r of rows) seen.set(r.address, (seen.get(r.address) || 0) + 1);

  // As pasted, in paste order, so nothing looks like it went missing.
  const annotated = rows.map((r) => ({
    ...r,
    duplicate: seen.get(r.address) > 1,
    combined: byAddress.get(r.address),
  }));

  const entries = [...byAddress.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([address, amount]) => ({ address, amount }));

  return {
    rows: annotated,
    entries,
    merged,
    count: entries.length,
    total: entries.reduce((s, e) => s + e.amount, 0n),
  };
}

/** Paste or table in, list ready for the tree out. */
export function buildList(text, { decimals = 18, equalAmount = null } = {}) {
  const { rows, problems } = parseList(text, { decimals, equalAmount });
  return { ...normaliseList(rows), problems };
}
