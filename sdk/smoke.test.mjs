/* End-to-end smoke against the LIVE API: build a list, publish it, and check
   the server derives the exact same root. Unbound lists are pruned by the
   server after 24h, so this leaves no residue. Run: node sdk/smoke.test.mjs */
import { HoodLock } from "./index.mjs";

const hl = new HoodLock();
const list = hl.buildList(`
  0x1111111111111111111111111111111111111111 100
  0x2222222222222222222222222222222222222222 250.5
  0x1111111111111111111111111111111111111111 25
`, { decimals: 18 });

console.log("local  root:", list.root, "count:", list.count, "total:", list.total.toString());
if (list.count !== 2) throw new Error("dedupe failed");
if (list.total !== 375_500000000000000000n / 1000n * 1000n) { /* 375.5e18 */ }

const server = await hl.publishList(list.entries);
console.log("server root:", server.root, "count:", server.count, "total:", server.total);
if (server.root !== list.root) throw new Error("ROOT MISMATCH — sdk and server disagree");
if (Number(server.count) !== list.count) throw new Error("count mismatch");
if (String(server.total) !== list.total.toString()) throw new Error("total mismatch");
console.log("SMOKE PASS — sdk root === server root");
