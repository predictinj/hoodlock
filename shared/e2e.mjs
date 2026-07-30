/**
 * End to end against a real chain: build a list, upload it, create the airdrop,
 * fetch a proof from the server, claim with it, and check the tokens landed.
 *
 * Every previous test proved one layer in isolation. This is the only one that
 * proves the layers agree with each other, which is where a Merkle airdrop
 * actually breaks: the browser's root, the server's proof and the contract's
 * verification are three implementations of one convention.
 *
 * Run against an anvil fork of Robinhood Chain, so it exercises the deployed
 * bytecode without spending anything:
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com
 *   node shared/e2e.mjs <serverUrl> <tokenAddress>
 */
import { createWalletClient, createPublicClient, http, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildList } from "./airdrop-list.mjs";
import { buildTree } from "./merkle.mjs";

const SERVER = process.argv[2] || "http://127.0.0.1:4344";
const TOKEN = process.argv[3];
const RPC = process.env.RPC || "http://127.0.0.1:8545";
const AIRDROP = getAddress(process.env.AIRDROP || "0x6B1fE7b821001144Ee74EEA258b0AafdE20102E8");

// anvil's deterministic accounts
const CREATOR = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const RECIPIENTS = [
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

const ABI = parseAbi([
  "function create(address token, bytes32 merkleRoot, uint256 total, uint32 maxClaims, uint64 endTime, string uri) payable returns (uint256)",
  "function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof)",
  "function quote(uint32 n) view returns (uint256)",
  "function totalAirdrops() view returns (uint256)",
  "function isClaimed(uint256 id, uint256 index) view returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
]);

const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account: CREATOR, transport: http(RPC) });

let failed = 0;
const step = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

// 1. The list, exactly as the browser would build it.
const list = buildList(RECIPIENTS.map((w, i) => `${w}:${100 * (i + 1)}`).join("\n"), { decimals: 18 });
const tree = buildTree(list.entries);
step("list built", list.count === 3 && list.problems.length === 0, `${list.count} recipients, total ${list.total}`);

// 2. Upload it. The server recomputes the root and refuses a mismatch.
const up = await fetch(`${SERVER}/api/airdrop/list`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ root: tree.root, entries: list.entries.map((e) => ({ address: e.address, amount: e.amount.toString() })) }),
});
const upJson = await up.json();
step("list accepted by the server", up.status === 200 && upJson.root === tree.root, upJson.root || JSON.stringify(upJson));

// 3. Create it on chain.
const fee = await pub.readContract({ address: AIRDROP, abi: ABI, functionName: "quote", args: [list.count] });
await wallet.writeContract({ address: TOKEN, abi: ABI, functionName: "approve", args: [AIRDROP, list.total], chain: null });
const idBefore = await pub.readContract({ address: AIRDROP, abi: ABI, functionName: "totalAirdrops" });
const hash = await wallet.writeContract({
  address: AIRDROP, abi: ABI, functionName: "create",
  args: [TOKEN, tree.root, list.total, list.count, 0, `${SERVER}/api/airdrop/${idBefore}/list.json`],
  value: fee, chain: null,
});
const rec = await pub.waitForTransactionReceipt({ hash });
const id = Number(idBefore);
step("airdrop created on chain", rec.status === "success", `id ${id}, fee ${fee}`);

// 4. The server has to notice it from the event, with no help.
let seen = null;
for (let i = 0; i < 20 && !seen; i++) {
  const r = await fetch(`${SERVER}/api/airdrops`).then((x) => x.json()).catch(() => null);
  seen = r?.airdrops?.find((a) => a.id === id) || null;
  if (!seen) await new Promise((r2) => setTimeout(r2, 3000));
}
step("server indexed it from the log", !!seen, seen ? `root ${seen.root.slice(0, 12)}…, list published: ${seen.listPublished}` : "never appeared");

// 5. A proof for a real recipient, and nothing for a stranger.
const who = RECIPIENTS[1];
const pr = await fetch(`${SERVER}/api/airdrop/${id}/proof?address=${who}`).then((r) => r.json());
step("proof served for a listed address", Array.isArray(pr.proof) && pr.amount === "200000000000000000000", `index ${pr.index}, ${pr.proof?.length} levels`);
const none = await fetch(`${SERVER}/api/airdrop/${id}/proof?address=0x000000000000000000000000000000000000dEaD`);
step("no proof for an address not on the list", none.status === 404);

// 6. The claim itself, using the server's proof against the deployed contract.
const before = await pub.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [who] });
const ch = await wallet.writeContract({
  address: AIRDROP, abi: ABI, functionName: "claim",
  args: [BigInt(id), BigInt(pr.index), getAddress(pr.account), BigInt(pr.amount), pr.proof], chain: null,
});
const crec = await pub.waitForTransactionReceipt({ hash: ch });
const after = await pub.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [who] });
step("claim succeeded with the server's proof", crec.status === "success" && after - before === BigInt(pr.amount), `+${after - before}`);

// 7. Claimed once means claimed.
step("marked claimed on chain", await pub.readContract({ address: AIRDROP, abi: ABI, functionName: "isClaimed", args: [BigInt(id), BigInt(pr.index)] }));

// 8. Eligibility reflects that: the claimant drops off, the others remain.
const elig = await fetch(`${SERVER}/api/airdrop/eligible?address=${who}`).then((r) => r.json());
step("claimant no longer eligible", !elig.claimable?.some((c) => c.id === id), `${elig.claimable?.length ?? "?"} left`);
const other = await fetch(`${SERVER}/api/airdrop/eligible?address=${RECIPIENTS[2]}`).then((r) => r.json());
step("an unclaimed recipient still is", other.claimable?.some((c) => c.id === id), `amount ${other.claimable?.[0]?.amount}`);

// 9. The published list, which is what makes the claim survive us.
const pubList = await fetch(`${SERVER}/api/airdrop/${id}/list.json`).then((r) => r.json());
step("full list downloadable", pubList.count === 3 && pubList.entries?.length === 3, `root ${pubList.merkleRoot?.slice(0, 12)}…`);

console.log(failed ? `\n  ${failed} FAILED` : "\n  all green");
process.exit(failed ? 1 : 0);
