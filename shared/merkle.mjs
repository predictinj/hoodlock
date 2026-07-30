/**
 * The Merkle tree behind RobinhoodAirdrop, written once for both sides.
 *
 * The browser builds the root, the server serves the proofs, and the contract
 * verifies them. If any two of those three disagree by a single byte, every
 * claim fails. So this file is the only place the rules live, and
 * shared/merkle.test.mjs proves its output against the contract itself rather
 * than against a second copy of the same logic.
 *
 * The rules, matching RobinhoodAirdrop._verify and the Solidity test helpers:
 *
 *   leaf   = keccak256(keccak256(abi.encode(uint256 index, address account, uint256 amount)))
 *   parent = keccak256(min(a,b) ++ max(a,b))
 *   an odd node is promoted unchanged to the next level
 *
 * Leaves are hashed twice on purpose. It makes a leaf preimage 32 bytes and an
 * internal one 64, so no internal node can ever be presented as a leaf however
 * the leaf tuple changes later (threat model K2).
 */
import { keccak256, encodeAbiParameters, concat } from "viem";

/** keccak256(keccak256(abi.encode(index, account, amount))) */
export function leafHash({ index, address, amount }) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [BigInt(index), address, BigInt(amount)],
    ),
  );
  return keccak256(inner);
}

/** Sorted-pair parent hash. Sorting is what lets a proof omit its own side. */
const pair = (a, b) => (a.toLowerCase() <= b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

function nextLevel(level) {
  const out = [];
  for (let i = 0; i < level.length; i += 2) {
    out.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
  }
  return out;
}

/** Root of a list of leaf hashes. A single leaf is its own root. */
export function merkleRoot(leaves) {
  if (!leaves.length) throw new Error("empty tree");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

/** Every level of the tree, leaves first, root last. */
function levels(leaves) {
  if (!leaves.length) throw new Error("empty tree");
  const out = [leaves];
  while (out[out.length - 1].length > 1) out.push(nextLevel(out[out.length - 1]));
  return out;
}

/**
 * Sibling path for one leaf, bottom up. Empty for a one-leaf tree.
 *
 * Takes the precomputed levels rather than the leaves. Rebuilding the tree for
 * each proof is O(n) per call, which measured at 593ms for a 50,000-entry list:
 * fine once, ruinous for a server answering one proof per visitor. With the
 * levels in hand a proof is O(log n).
 */
export function merkleProof(tree, idx) {
  const ls = Array.isArray(tree[0]) ? tree : levels(tree);
  if (idx < 0 || idx >= ls[0].length) throw new Error("index out of range");
  const proof = [];
  let pos = idx;
  for (let d = 0; d < ls.length - 1; d++) {
    const sib = pos ^ 1;
    if (sib < ls[d].length) proof.push(ls[d][sib]);
    pos = pos >> 1;
  }
  return proof;
}

/**
 * Everything the contract and the claim API need, from a normalised list.
 * `entries` must already be normalised by shared/airdrop-list.mjs, which is
 * what fixes the index of each address and therefore the root.
 */
export function buildTree(entries) {
  const leaves = entries.map((e, index) => leafHash({ index, address: e.address, amount: e.amount }));
  const ls = levels(leaves);
  return {
    root: ls[ls.length - 1][0],
    leaves,
    levels: ls,
    proofFor: (index) => merkleProof(ls, index),
  };
}

/** The same check the contract performs, for validating before sending a tx. */
export function verifyProof(proof, root, leaf) {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
