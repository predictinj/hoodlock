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

/** Sibling path for one leaf, bottom up. Empty for a one-leaf tree. */
export function merkleProof(leaves, idx) {
  if (idx < 0 || idx >= leaves.length) throw new Error("index out of range");
  const proof = [];
  let level = leaves;
  let pos = idx;
  while (level.length > 1) {
    const sib = pos ^ 1;
    if (sib < level.length) proof.push(level[sib]);
    level = nextLevel(level);
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
  return {
    root: merkleRoot(leaves),
    leaves,
    proofFor: (index) => merkleProof(leaves, index),
  };
}

/** The same check the contract performs, for validating before sending a tx. */
export function verifyProof(proof, root, leaf) {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
