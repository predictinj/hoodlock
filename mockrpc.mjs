// Mock Robinhood Chain JSON-RPC — simulates the RobinhoodLocker contract + a few
// ERC-20s so the UI wiring can be verified end-to-end without network access.
// Test-only; not part of the shipped site.
import http from "node:http";
import { encodeAbiParameters, keccak256, toHex, pad, toBytes } from "viem";

const CHAIN_ID = 4663;
const LOCKER = "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const TOKENS = {
  "0x1111111111111111111111111111111111111111": { symbol: "HOOD-ETH LP", decimals: 18, supply: 10_000_000n * 10n ** 18n },
  "0x2222222222222222222222222222222222222222": { symbol: "RBHD", decimals: 18, supply: 1_000_000_000n * 10n ** 18n },
  "0x3333333333333333333333333333333333333333": { symbol: "FTHR", decimals: 18, supply: 100_000_000n * 10n ** 18n },
  "0x4444444444444444444444444444444444444444": { symbol: "NOVA", decimals: 6, supply: 50_000_000n * 10n ** 6n },
  "0x5555555555555555555555555555555555555555": { symbol: "ZENN", decimals: 18, supply: 9_000_000n * 10n ** 18n },
};
const W1 = "0x7f3a00000000000000000000000000000000 9c21".replace(/ /g, "");
const W2 = "0x3d11000000000000000000000000000000008802";
const W3 = "0xb42000000000000000000000000000000000 1f6e".replace(/ /g, "");
const E18 = 10n ** 18n;

// [owner, token, amount, unlockTime, withdrawn, lockedDaysAgo]
const LOCKS = [
  [W1, "0x1111111111111111111111111111111111111111", 1_250_000n * E18, NOW + 365 * DAY, false, 80],
  [W2, "0x2222222222222222222222222222222222222222", 48_000_000n * E18, NOW + 180 * DAY, false, 62],
  [W3, "0x3333333333333333333333333333333333333333", 12_500_000n * E18, NOW + 358 * DAY, false, 30],
  [W1, "0x4444444444444444444444444444444444444444", 5_000_000n * 10n ** 6n, NOW + 274 * DAY, false, 21],
  [W2, "0x5555555555555555555555555555555555555555", 900_000n * E18, NOW - 20 * DAY, true, 90],
  [W3, "0x1111111111111111111111111111111111111111", 88_200n * E18, NOW - 2 * DAY, false, 33],
];
const GENESIS_TS = NOW - 120 * DAY;
const blockForDaysAgo = (d) => 1000 + Math.floor(((120 - d) * DAY) / 2); // 2s blocks
const LATEST_BLOCK = 1000 + Math.floor((120 * DAY) / 2);
const tsForBlock = (bn) => GENESIS_TS + (bn - 1000) * 2;

const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const topic = (sig) => keccak256(toBytes(sig));
const SEL = {
  fee: sel("fee()"), totalLocks: sel("totalLocks()"), getLock: sel("getLock(uint256)"),
  locksByOwner: sel("locksByOwner(address)"), locksByToken: sel("locksByToken(address)"),
  symbol: sel("symbol()"), decimals: sel("decimals()"), totalSupply: sel("totalSupply()"),
  balanceOf: sel("balanceOf(address)"), allowance: sel("allowance(address,address)"),
};
const TOPIC = {
  locked: topic("Locked(uint256,address,address,uint256,uint256)"),
  extended: topic("Extended(uint256,uint256)"),
  withdrawn: topic("Withdrawn(uint256,address,uint256)"),
};
const u256 = (v) => encodeAbiParameters([{ type: "uint256" }], [BigInt(v)]);

function ethCall(to, data) {
  const s = data.slice(0, 10).toLowerCase();
  const arg = (i) => "0x" + data.slice(10 + i * 64, 10 + (i + 1) * 64);
  const argAddr = (i) => "0x" + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64);
  if (to.toLowerCase() === LOCKER) {
    if (s === SEL.fee) return u256(5n * 10n ** 15n); // 0.005 ETH
    if (s === SEL.totalLocks) return u256(LOCKS.length);
    if (s === SEL.getLock) {
      const id = Number(BigInt(arg(0)));
      const l = LOCKS[id];
      if (!l) return encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }] }],
        [["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n, 0n, false]]);
      return encodeAbiParameters([{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }] }],
        [[l[0], l[1], l[2], BigInt(l[3]), l[4]]]);
    }
    if (s === SEL.locksByOwner) {
      const o = argAddr(0).toLowerCase();
      const ids = LOCKS.map((l, i) => [l, i]).filter(([l]) => l[0].toLowerCase() === o).map(([, i]) => BigInt(i));
      return encodeAbiParameters([{ type: "uint256[]" }], [ids]);
    }
    if (s === SEL.locksByToken) {
      const t = argAddr(0).toLowerCase();
      const ids = LOCKS.map((l, i) => [l, i]).filter(([l]) => l[1].toLowerCase() === t).map(([, i]) => BigInt(i));
      return encodeAbiParameters([{ type: "uint256[]" }], [ids]);
    }
  }
  const tok = TOKENS[to.toLowerCase()];
  if (tok) {
    if (s === SEL.symbol) return encodeAbiParameters([{ type: "string" }], [tok.symbol]);
    if (s === SEL.decimals) return u256(tok.decimals);
    if (s === SEL.totalSupply) return u256(tok.supply);
    if (s === SEL.balanceOf) return u256(tok.supply / 100n);
    if (s === SEL.allowance) return u256(0);
  }
  return "0x";
}

function getLogs(filter) {
  const topics = filter.topics || [];
  const t0 = (topics[0] || "").toLowerCase();
  const out = [];
  const mk = (i, tops, data, bn) => ({
    address: LOCKER, topics: tops, data, blockNumber: toHex(bn),
    transactionHash: pad(toHex(0xabc000 + i), { size: 32 }), transactionIndex: "0x0",
    blockHash: pad(toHex(0xb10c000 + bn), { size: 32 }), logIndex: toHex(i), removed: false,
  });
  if (!t0 || t0 === TOPIC.locked.toLowerCase()) {
    LOCKS.forEach((l, i) => out.push(mk(i, [
      TOPIC.locked, pad(toHex(BigInt(i)), { size: 32 }), pad(l[0], { size: 32 }), pad(l[1], { size: 32 }),
    ], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [l[2], BigInt(l[3])]), blockForDaysAgo(l[5]))));
  }
  if (t0 === TOPIC.extended.toLowerCase()) {
    out.push(mk(100, [TOPIC.extended, pad(toHex(1n), { size: 32 })],
      encodeAbiParameters([{ type: "uint256" }], [BigInt(NOW + 180 * DAY)]), blockForDaysAgo(10)));
  }
  if (t0 === TOPIC.withdrawn.toLowerCase()) {
    out.push(mk(200, [TOPIC.withdrawn, pad(toHex(4n), { size: 32 }), pad(W2, { size: 32 })],
      encodeAbiParameters([{ type: "uint256" }], [900_000n * E18]), blockForDaysAgo(5)));
  }
  return out;
}

function getBlock(bnHex) {
  const bn = bnHex === "latest" ? LATEST_BLOCK : Number(BigInt(bnHex));
  const z32 = pad("0x0", { size: 32 }), z20 = pad("0x0", { size: 20 }), z256 = pad("0x0", { size: 256 });
  return {
    number: toHex(bn), hash: pad(toHex(0xb10c000 + bn), { size: 32 }), parentHash: z32,
    timestamp: toHex(tsForBlock(bn)), nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0",
    gasLimit: "0x1c9c380", gasUsed: "0x0", miner: z20, extraData: "0x", baseFeePerGas: "0x0",
    logsBloom: z256, mixHash: z32, receiptsRoot: z32, sha3Uncles: z32, size: "0x0",
    stateRoot: z32, transactionsRoot: z32, transactions: [], uncles: [],
  };
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let out;
    try {
      const reqs = JSON.parse(body);
      const handle = (r) => {
        const { method, params = [], id } = r;
        let result;
        switch (method) {
          case "eth_chainId": result = toHex(CHAIN_ID); break;
          case "net_version": result = String(CHAIN_ID); break;
          case "eth_blockNumber": result = toHex(LATEST_BLOCK); break;
          case "eth_call": result = ethCall(params[0].to, params[0].data); break;
          case "eth_getLogs": result = getLogs(params[0] || {}); break;
          case "eth_getBlockByNumber": result = getBlock(params[0]); break;
          case "eth_gasPrice": result = "0x3b9aca00"; break;
          default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `method ${method} not mocked` } };
        }
        return { jsonrpc: "2.0", id, result };
      };
      out = Array.isArray(reqs) ? reqs.map(handle) : handle(reqs);
    } catch (e) {
      out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e) } };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  });
});
server.listen(8545, () => console.log("mock RPC on :8545"));
