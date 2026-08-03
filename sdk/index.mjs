/* @hoodlock/sdk — integrate HoodLock on Robinhood Chain (4663).
 *
 * Airdrop-first: build a recipient list, publish it, fund the airdrop, and
 * let your users claim — all against HoodLock's verified contracts. The
 * Merkle code in this package is byte-for-byte the same module HoodLock's
 * own server runs (merkle.mjs / airdrop-list.mjs), so a root you compute is
 * a root the claim page can prove.
 *
 * Nothing here holds keys. Every write returns { to, data, value } calldata
 * for YOUR signer (viem wallet client, ethers, a relayer — anything), or you
 * pass a viem walletClient and the send methods submit for you.
 *
 * Quickstart:
 *   import { HoodLock } from "@hoodlock/sdk";
 *   const hl = new HoodLock();                       // read-only
 *   const list = hl.buildList("0xabc… 100\n0xdef… 250");
 *   await hl.publishList(list.entries);              // claim page works after funding
 *   const tx = await hl.createAirdropTx({ token, list, deadlineDays: 30 });
 *   // sign tx.approve (if returned), then tx.create, with any wallet
 */
import { buildTree, merkleProof } from "./merkle.mjs";
import { parseList, normaliseList, buildList as buildListRaw, toBaseUnits, fromBaseUnits } from "./airdrop-list.mjs";

export const CHAIN_ID = 4663;
export const ADDRESSES = {
  locker: "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f",
  burner: "0x6bf43ca706faa8ea46803299c191484e82280652",
  vesting: "0x910e19bcC4bce46999994Ed7297E0Fc4431ec72E",
  airdrop: "0x6B1fE7b821001144Ee74EEA258b0AafdE20102E8",
};
export const API = "https://hoodlock.tech";

const AIRDROP_ABI = [
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ name: "maxClaims", type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "create", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "merkleRoot", type: "bytes32" }, { name: "total", type: "uint256" },
    { name: "maxClaims", type: "uint32" }, { name: "endTime", type: "uint64" }, { name: "uri", type: "string" } ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [
    { name: "id", type: "uint256" }, { name: "index", type: "uint256" }, { name: "account", type: "address" },
    { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" } ], outputs: [] },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

/** Thrown when the HoodLock API answers with an error. */
export class HoodLockApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class HoodLock {
  /**
   * @param {object} [opts]
   * @param {string} [opts.api]        API origin, default https://hoodlock.tech
   * @param {string} [opts.apiKey]     developer program key (pk_…) — attributes
   *                                   actions to you and earns commission
   * @param {import("viem").PublicClient} [opts.publicClient]  for on-chain reads
   * @param {import("viem").WalletClient} [opts.walletClient]  to auto-send txs
   */
  constructor(opts = {}) {
    this.api = (opts.api || API).replace(/\/$/, "");
    this.apiKey = opts.apiKey || null;
    this.pub = opts.publicClient || null;
    this.wallet = opts.walletClient || null;
  }

  async #json(path, init) {
    const r = await fetch(this.api + path, init);
    if (!r.ok) throw new HoodLockApiError(`${path} -> ${r.status}`, r.status);
    return r.json();
  }

  /* ---------------- airdrops ---------------- */

  /** Parse "address amount" lines (CSV/whitespace) into normalized entries.
   *  Same rules as the HoodLock UI: dedupe by address (amounts summed),
   *  validates every row. Returns { entries, count, total, root }. */
  buildList(text, { decimals = 18, equalAmount = null } = {}) {
    const { entries, count, total } = buildListRaw(text, { decimals, equalAmount });
    const { root } = buildTree(entries);
    return { entries, count, total, root };
  }

  /** Normalize pre-parsed [{ address, amount }] (amount in base units, bigint
   *  or string). Returns { entries, count, total, root }. */
  normalize(rows) {
    const { entries, count, total } = normaliseList(rows.map((r) => ({ address: r.address, amount: BigInt(r.amount) })));
    const { root } = buildTree(entries);
    return { entries, count, total, root };
  }

  /** Publish the recipient list to HoodLock so the claim page can serve
   *  proofs. Must happen BEFORE funding: the contract stores only the root,
   *  and a list nobody can read is an airdrop nobody can claim. The server
   *  recomputes the root itself and never trusts yours. */
  async publishList(entries) {
    return this.#json("/api/airdrop/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: entries.map((e) => ({ address: e.address, amount: e.amount.toString() })) }),
    });
  }

  /** The protocol fee for an airdrop with `maxClaims` recipients, in wei.
   *  Read from the contract — construct with a publicClient to use this. */
  async quote(maxClaims) {
    if (!this.pub) throw new Error("constructor needs a publicClient for quote()");
    return this.pub.readContract({ address: ADDRESSES.airdrop, abi: AIRDROP_ABI, functionName: "quote", args: [maxClaims] });
  }

  /**
   * Everything needed to fund an airdrop, as calldata for your signer.
   * Publishes the list first. Returns:
   *   { approve: {to,data} | null, create: {to,data,value}, root, total, count, endTime }
   * Pass a walletClient in the constructor and call sendAirdrop() instead to
   * have the SDK submit both transactions.
   */
  async createAirdropTx({ token, list, deadlineDays = 30, uri = "", owner = null }) {
    const { encodeFunctionData } = await import("viem");
    const { entries, count, total, root } = list.root ? list : this.normalize(list);
    await this.publishList(entries);
    const endTime = deadlineDays > 0 ? BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86_400) : 0n;
    const fee = this.pub
      ? await this.pub.readContract({ address: ADDRESSES.airdrop, abi: AIRDROP_ABI, functionName: "quote", args: [count] })
      : 0n;
    let approve = { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ADDRESSES.airdrop, total] }) };
    if (this.pub && owner) {
      const allowance = await this.pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, ADDRESSES.airdrop] });
      if (allowance >= total) approve = null;
    }
    const create = {
      to: ADDRESSES.airdrop,
      data: encodeFunctionData({ abi: AIRDROP_ABI, functionName: "create", args: [token, root, total, count, endTime, uri] }),
      value: fee,
    };
    return { approve, create, root, total, count, endTime };
  }

  /** Convenience: build, publish, approve and create with the configured
   *  walletClient. Returns { airdropCreateHash, root, count, total }. */
  async sendAirdrop(args) {
    if (!this.wallet) throw new Error("constructor needs a walletClient for sendAirdrop()");
    const [account] = await this.wallet.getAddresses();
    const tx = await this.createAirdropTx({ ...args, owner: account });
    if (tx.approve) {
      const h1 = await this.wallet.sendTransaction({ account, to: tx.approve.to, data: tx.approve.data, chain: this.wallet.chain });
      if (this.pub) await this.pub.waitForTransactionReceipt({ hash: h1 });
    }
    const h2 = await this.wallet.sendTransaction({ account, to: tx.create.to, data: tx.create.data, value: tx.create.value, chain: this.wallet.chain });
    return { airdropCreateHash: h2, root: tx.root, count: tx.count, total: tx.total };
  }

  /** Everything `address` can claim right now across all HoodLock airdrops:
   *  [{ id, token, amount, index, endTime, shortfall }]. */
  async claimable(address) {
    const j = await this.#json(`/api/airdrop/eligible?address=${address}`);
    return j.claimable || [];
  }

  /** Claim calldata for one airdrop. The proof is fetched fresh from the
   *  list server so a stale UI can never produce a reverting transaction. */
  async claimTx({ id, address }) {
    const { encodeFunctionData } = await import("viem");
    const p = await this.#json(`/api/airdrop/${id}/proof?address=${address}`);
    if (!p?.proof) throw new HoodLockApiError("no proof for this wallet", 404);
    return {
      to: ADDRESSES.airdrop,
      data: encodeFunctionData({ abi: AIRDROP_ABI, functionName: "claim",
        args: [BigInt(id), BigInt(p.index), p.account, BigInt(p.amount), p.proof] }),
    };
  }

  /* ---------------- developer program ---------------- */

  /** First-touch attribution: call when a wallet connects on your site and
   *  every action it later takes on HoodLock earns you commission. Requires
   *  an apiKey from hoodlock.tech/app/developers. Fire-and-forget safe. */
  async attribute(wallet) {
    if (!this.apiKey) throw new Error("constructor needs apiKey for attribute()");
    return this.#json("/api/dev/attribute", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.apiKey, wallet }),
    });
  }

  /** Prepared lock calldata from the developer API: { to, data, value }. */
  async lockIntentTx(params) {
    if (!this.apiKey) throw new Error("constructor needs apiKey for lockIntentTx()");
    return this.#json("/api/dev/lock-intent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.apiKey, ...params }),
    });
  }
}

export { buildTree, merkleProof, parseList, normaliseList, toBaseUnits, fromBaseUnits };
