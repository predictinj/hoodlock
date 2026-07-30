// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
    RobinhoodAirdrop, pull-based Merkle airdrops on Robinhood Chain.

    Companion to RobinhoodLocker / RobinhoodBurner / RobinhoodVesting.
    Non-upgradeable, no proxy.

    Nothing is ever pushed to a wallet. The creator funds the airdrop and
    publishes a Merkle root; each recipient comes and claims their own leaf.

    Guarantees (see contracts/docs/AIRDROP-THREAT-MODEL.md):
      - Per-airdrop `remaining` means no airdrop can spend another's deposit,
        however much its tree promises (K1).
      - No admin function can move a funded airdrop's tokens or alter it. Admin
        may only adjust the two fee parameters within a hard cap, change the
        collector, and hand over admin in two steps.
      - Once funded, the creator cannot take the tokens back before `endTime`,
        and `endTime` may be 0, meaning claimable forever and never sweepable.
      - The fee is charged at create only; claiming is always free of protocol
        fee.

    Fee: min(feeBase + feePerWallet * maxClaims, MAX_FEE), paid at create.
    `maxClaims` is both what the creator pays for and the ceiling on how many
    claims succeed, so under-declaring the recipient count breaks your own
    airdrop rather than saving money (M5). That is what makes the fee
    enforceable without trusting anything off chain.
*/

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract RobinhoodAirdrop {
    struct Airdrop {
        address creator;    // slot 0
        uint64 endTime;     // 0 = claimable forever, never sweepable
        uint32 maxClaims;
        address token;      // slot 1
        uint32 claims;
        bool swept;
        bytes32 merkleRoot; // slot 2
        uint128 total;      // slot 3, what was deposited
        uint128 remaining;  // what is still owed; K1's isolation lives here
    }

    uint256 public constant MAX_FEE = 0.25 ether;      // hard cap; no admin call can raise it (M2)
    uint256 public constant MIN_WINDOW = 7 days;       // a shorter deadline is the optics attack (M3)
    uint32 public constant MAX_RECIPIENTS = 250_000;   // bounds the fee quote and the tree (M3)
    uint256 public constant MAX_URI = 256;             // listURI storage bound (H3)

    uint256 public nextAirdropId;
    mapping(uint256 => Airdrop) public airdrops;
    mapping(uint256 => string) public listURI;          // where the full list is published
    /// Per airdrop, so one airdrop's index can never block another's (K3).
    mapping(uint256 => mapping(uint256 => uint256)) private _claimedBitMap;

    /* There are deliberately no byToken / byCreator index arrays.
     *
     * The locker already paid for that lesson: an append-only array that anyone
     * can push to for the price of a 1-wei record, read back through one getter,
     * is a griefing vector. Measured here before removal, an attacker holding
     * 200 wei of someone else's token could append 200 junk airdrops to that
     * token's index for gas alone, and the fee is zero at launch.
     *
     * AirdropCreated already indexes both token and creator, so every query the
     * arrays would have answered is reconstructible from logs, which is how the
     * server reads them anyway. Dropping them removes the vector and saves the
     * honest creator roughly 40k gas.
     */

    uint256 public feeBase;       // flat part, per airdrop
    uint256 public feePerWallet;  // scaling part, per declared recipient
    uint256 public accruedFees;   // fees accumulate here; collector pulls (H2)
    address public feeCollector;
    address public admin;
    address public pendingAdmin;  // two-step admin transfer (M1)

    event AirdropCreated(
        uint256 indexed id,
        address indexed token,
        address indexed creator,
        bytes32 merkleRoot,
        uint256 total,
        uint32 maxClaims,
        uint64 endTime,
        string listURI
    );
    event Claimed(uint256 indexed id, uint256 index, address indexed account, uint256 amount);
    event Swept(uint256 indexed id, address indexed creator, uint256 amount);
    event FeeChanged(uint256 feeBase, uint256 feePerWallet);
    event FeeCollectorChanged(address collector);
    event FeesWithdrawn(address indexed collector, uint256 amount);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed current);

    modifier onlyAdmin() { require(msg.sender == admin, "not admin"); _; }

    uint256 private _guard = 1; // shared guard across all state-changing entry points (K5)
    modifier nonReentrant() { require(_guard == 1, "reentrant"); _guard = 2; _; _guard = 1; }

    /**
     * `_admin` is set at construction rather than handed over afterwards. A
     * deploy-then-transfer flow leaves a window where the deploying key is
     * admin, and needs the real owner to send an acceptAdmin transaction before
     * it closes. Naming the owner here removes both.
     *
     * Zero falls back to the deployer, which is what the tests use.
     */
    constructor(uint256 _feeBase, uint256 _feePerWallet, address _feeCollector, address _admin) {
        require(_feeBase <= MAX_FEE && _feePerWallet <= MAX_FEE, "fee param over cap");
        admin = _admin == address(0) ? msg.sender : _admin;
        feeBase = _feeBase;
        feePerWallet = _feePerWallet;
        feeCollector = _feeCollector == address(0) ? msg.sender : _feeCollector;
    }

    // ─────────────────────────────── fee ──────────────────────────────────

    /**
     * The cap is a clamp, not a rejection: however the admin sets the two
     * parameters, no single airdrop can ever be charged more than MAX_FEE.
     *
     * The parameters are separately bounded at MAX_FEE by setFee. That bound is
     * not about pricing, it is about arithmetic: an unbounded perWallet would
     * make this multiplication overflow at large recipient counts, and a
     * reverting quote() would take create() down with it (invariant 9 requires
     * quote to never revert).
     */
    function _quote(uint256 base, uint256 perWallet, uint32 n) private pure returns (uint256) {
        uint256 q = base + perWallet * uint256(n);
        return q > MAX_FEE ? MAX_FEE : q;
    }

    /// What `create` will charge for this many declared recipients.
    function quote(uint32 maxClaims) public view returns (uint256) {
        return _quote(feeBase, feePerWallet, maxClaims);
    }

    // ─────────────────────────────── create ───────────────────────────────

    /// Fund an airdrop. Requires prior approve() and msg.value == quote(maxClaims).
    function create(
        address token,
        bytes32 merkleRoot,
        uint256 total,
        uint32 maxClaims,
        uint64 endTime,
        string calldata uri
    ) external payable nonReentrant returns (uint256 id) {
        require(msg.value == quote(maxClaims), "bad fee");
        require(merkleRoot != bytes32(0), "zero root");
        require(total > 0, "zero total");
        require(maxClaims > 0 && maxClaims <= MAX_RECIPIENTS, "bad recipient count");
        require(token.code.length > 0, "token has no code");
        require(bytes(uri).length <= MAX_URI, "uri too long");
        // 0 means claimable forever. Anything else must leave a real window, or
        // the airdrop is advertising a promise it can withdraw the same day (M3).
        require(endTime == 0 || uint256(endTime) >= block.timestamp + MIN_WINDOW, "window too short");

        accruedFees += msg.value;

        // Measure what actually arrived. Requiring the full amount rejects
        // fee-on-transfer tokens outright, rather than letting the last
        // claimants discover the shortfall.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), total);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        require(received >= total, "fee-on-transfer token");
        require(total <= type(uint128).max, "total too large");

        id = nextAirdropId++;
        airdrops[id] = Airdrop({
            creator: msg.sender,
            endTime: endTime,
            maxClaims: maxClaims,
            token: token,
            claims: 0,
            swept: false,
            merkleRoot: merkleRoot,
            total: uint128(total),
            remaining: uint128(total)
        });
        if (bytes(uri).length > 0) listURI[id] = uri;

        emit AirdropCreated(id, token, msg.sender, merkleRoot, total, maxClaims, endTime, uri);
    }

    // ─────────────────────────────── claim ────────────────────────────────

    function isClaimed(uint256 id, uint256 index) public view returns (bool) {
        uint256 word = _claimedBitMap[id][index / 256];
        return word & (uint256(1) << (index % 256)) != 0;
    }

    /**
     * Claim one leaf. Anyone may submit it; the tokens always go to `account`,
     * so a third party paying the gas can only help (M6).
     */
    function claim(
        uint256 id,
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        Airdrop storage a = airdrops[id];
        require(a.total > 0, "no such airdrop");
        require(a.endTime == 0 || block.timestamp < a.endTime, "airdrop closed");
        require(!isClaimed(id, index), "already claimed");
        require(a.claims < a.maxClaims, "claim ceiling reached");
        require(amount > 0, "zero amount");
        // The tree may promise more than was deposited. This is what stops one
        // airdrop from spending another's tokens (K1).
        require(amount <= a.remaining, "airdrop exhausted");

        // Double-hashed leaf, so an internal node can never be presented as a
        // leaf whatever the tuple's encoded length happens to be (K2).
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(_verify(proof, a.merkleRoot, leaf), "bad proof");

        // Effects before interaction (K5).
        _claimedBitMap[id][index / 256] |= (uint256(1) << (index % 256));
        a.claims += 1;
        a.remaining -= uint128(amount);

        _safeTransfer(a.token, account, amount);
        emit Claimed(id, index, account, amount);
    }

    /**
     * Return what nobody claimed. Creator only, and only once the deadline has
     * passed, so the claim window and the sweep window can never overlap (H5).
     * An airdrop created with endTime == 0 can never be swept, by the creator's
     * own irreversible choice.
     */
    function sweep(uint256 id) external nonReentrant {
        Airdrop storage a = airdrops[id];
        require(msg.sender == a.creator, "not creator");
        require(a.endTime != 0, "no deadline set");
        require(block.timestamp >= a.endTime, "not closed yet");
        require(!a.swept, "already swept");
        uint256 amount = a.remaining;
        require(amount > 0, "nothing left");

        a.swept = true;
        a.remaining = 0;

        _safeTransfer(a.token, a.creator, amount);
        emit Swept(id, a.creator, amount);
    }

    // ─────────────────────────────── views ────────────────────────────────

    function getAirdrop(uint256 id) external view returns (Airdrop memory) { return airdrops[id]; }
    function totalAirdrops() external view returns (uint256) { return nextAirdropId; }

    // ─────────────────────────────── admin ────────────────────────────────
    // None of these can touch a funded airdrop.

    /// Both parameters move together. Each is bounded at MAX_FEE so the quote
    /// arithmetic cannot overflow; what any one airdrop actually pays is then
    /// clamped to MAX_FEE by _quote (M2).
    function setFee(uint256 _feeBase, uint256 _feePerWallet) external onlyAdmin {
        require(_feeBase <= MAX_FEE && _feePerWallet <= MAX_FEE, "fee param over cap");
        feeBase = _feeBase;
        feePerWallet = _feePerWallet;
        emit FeeChanged(_feeBase, _feePerWallet);
    }

    function setFeeCollector(address c) external onlyAdmin {
        require(c != address(0), "zero collector");
        feeCollector = c;
        emit FeeCollectorChanged(c);
    }

    /// Fees are pulled by the collector, never pushed (H2): a reverting
    /// collector can only block its own withdrawal, never create().
    function withdrawFees() external nonReentrant {
        require(msg.sender == feeCollector, "not collector");
        uint256 amount = accruedFees;
        require(amount > 0, "nothing accrued");
        accruedFees = 0;
        (bool ok, ) = feeCollector.call{value: amount}("");
        require(ok, "eth send failed");
        emit FeesWithdrawn(feeCollector, amount);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "zero admin");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "not pending admin");
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ──────────────────────────── internals ───────────────────────────────

    /// Sorted-pair Merkle verification, the OpenZeppelin convention, so proofs
    /// built by any standard library verify here.
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == root;
    }

    // Safe-transfer pattern (K4): accept both a true return and an empty return
    // (USDT-style tokens); revert on false or a failed call. Token code
    // existence is guaranteed at create.

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }

    // No receive() and no fallback: stray ETH reverts, so the contract's ETH
    // balance always equals accruedFees exactly (SweepBuyer L-1 lesson).
}
