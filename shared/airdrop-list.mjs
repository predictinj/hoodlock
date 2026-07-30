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

const ADDRESS = /0x[0-9a-fA-F]{40}/;

/** Human amount to base units, without floating point. "12.5" at 18 decimals. */
export function toBaseUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`not a number: ${value}`);
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places: ${value}`);
  return BigInt((whole || "0") + frac.padEnd(decimals, "0"));
}

export function fromBaseUnits(value, decimals) {
  const s = BigInt(value).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
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
    } else if (equalAmount != null) {
      amount = BigInt(equalAmount);
    } else {
      problems.push({ line: i + 1, text: line, reason: "no amount, and no amount-for-everyone set" });
      return;
    }

    rows.push({ address, amount });
  });

  return { rows, problems };
}

/**
 * Normalise a parsed list into the exact form the tree is built from.
 *
 * Two decisions worth stating, because both change the root:
 *
 * Duplicates are merged by summing. Dropping the second entry would silently
 * lose tokens somebody was meant to get, and rejecting the list outright would
 * block the legitimate case of one wallet qualifying twice. Merging is the only
 * option that loses nothing, and the count of merges is returned so the UI can
 * say so out loud.
 *
 * The result is sorted by address. That makes the root a function of the set
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
  const entries = [...byAddress.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([address, amount]) => ({ address, amount }));

  return {
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
