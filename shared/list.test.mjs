/**
 * The three ways a list gets in, and the two properties that must hold however
 * it got in: duplicates lose nothing, and the root depends on the set rather
 * than the order it was pasted.
 *
 * Run: node shared/list.test.mjs
 */
import { buildList, parseList, toBaseUnits, fromBaseUnits } from "./airdrop-list.mjs";
import { buildTree } from "./merkle.mjs";

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const eq = (a, b, what) => {
  if (String(a) !== String(b)) throw new Error(`${what}: got ${a}, wanted ${b}`);
};

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

t("the same amount to every address, pasted as bare addresses", () => {
  const l = buildList([A, B, C].join("\n"), { decimals: 18, equalAmount: 5n * 10n ** 18n });
  eq(l.count, 3, "count");
  eq(l.total, 15n * 10n ** 18n, "total");
  eq(l.problems.length, 0, "problems");
});

t("an amount per address, pasted as wallet:amount", () => {
  const l = buildList(`${A}:100\n${B}:250.5\n${C}:1`, { decimals: 18 });
  eq(l.count, 3, "count");
  eq(l.total, toBaseUnits("351.5", 18), "total");
});

t("the other separators people actually paste", () => {
  const l = buildList([
    `${A}, 100`,      // csv from a spreadsheet
    `${B}\t250`,      // tab
    `${C} = 1`,       // key/value
  ].join("\n"), { decimals: 18 });
  eq(l.count, 3, "count");
  eq(l.total, toBaseUnits("351", 18), "total");
});

t("a row's own amount wins over the amount-for-everyone", () => {
  const l = buildList(`${A}:7\n${B}`, { decimals: 18, equalAmount: toBaseUnits("2", 18) });
  const byAddr = Object.fromEntries(l.entries.map((e) => [e.address, e.amount]));
  eq(byAddr[A], toBaseUnits("7", 18), "explicit amount");
  eq(byAddr[B], toBaseUnits("2", 18), "fallback amount");
});

t("headers, comments and blank lines are ignored", () => {
  const l = buildList(`address,amount\n# team\n\n${A}:1\n// note\n${B}:2`, { decimals: 18 });
  eq(l.count, 2, "count");
  eq(l.problems.length, 0, "problems");
});

t("duplicates are merged by summing, and the merge is reported", () => {
  const l = buildList(`${A}:10\n${B}:5\n${A}:15`, { decimals: 18 });
  eq(l.count, 2, "count");
  eq(l.merged, 1, "merged");
  const byAddr = Object.fromEntries(l.entries.map((e) => [e.address, e.amount]));
  eq(byAddr[A], toBaseUnits("25", 18), "summed amount");
});

t("mixed case addresses are the same address", () => {
  const l = buildList(`${A.toUpperCase().replace("0X", "0x")}:10\n${A}:5`, { decimals: 18 });
  eq(l.count, 1, "count");
  eq(l.entries[0].amount, toBaseUnits("15", 18), "summed amount");
});

/**
 * The server keys stored lists on the Merkle root, so uploading the same list
 * twice has to be the same airdrop. That only holds if the root is a function
 * of the set and not of the paste order.
 */
t("paste order does not change the root", () => {
  const one = buildList(`${A}:1\n${B}:2\n${C}:3`, { decimals: 18 });
  const two = buildList(`${C}:3\n${A}:1\n${B}:2`, { decimals: 18 });
  eq(buildTree(one.entries).root, buildTree(two.entries).root, "root");
});

t("a different set gives a different root", () => {
  const one = buildList(`${A}:1\n${B}:2`, { decimals: 18 });
  const two = buildList(`${A}:1\n${B}:3`, { decimals: 18 });
  if (buildTree(one.entries).root === buildTree(two.entries).root) throw new Error("roots collided");
});

t("bad lines are reported rather than dropped", () => {
  const l = buildList(`${A}:10\nnot an address\n${B}:abc\n${C}:0`, { decimals: 18 });
  eq(l.count, 1, "count");
  eq(l.problems.length, 3, "problems");
  if (!l.problems.some((p) => /zero/.test(p.reason))) throw new Error("zero amount not reported");
});

t("more decimal places than the token has is refused, not rounded", () => {
  const l = buildList(`${A}:1.1234567`, { decimals: 6 });
  eq(l.count, 0, "count");
  if (!/decimal places/.test(l.problems[0].reason)) throw new Error("wrong reason");
});

t("amounts round-trip through base units", () => {
  for (const [v, d] of [["1", 18], ["0.5", 18], ["1234.56789", 18], ["7", 6], ["0.000001", 6]]) {
    eq(fromBaseUnits(toBaseUnits(v, d), d), v, `round trip ${v}@${d}`);
  }
});

t("a wallet address on its own line with no amount and no default is a problem", () => {
  const { problems } = parseList(`${A}`, { decimals: 18 });
  eq(problems.length, 1, "problems");
});

console.log(failed ? `\n  ${failed} FAILED` : "\n  all green");
process.exit(failed ? 1 : 0);
