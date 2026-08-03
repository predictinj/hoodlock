// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * LockDistributor — cumulative Merkle distribution of $LOCK to lockers.
 *
 * Each round publishes a root whose leaves are CUMULATIVE totals: everything an
 * address has ever been owed, not that round's slice. A claimant is paid
 * `cumulative - alreadyClaimed`, so they may claim once a month and receive
 * every round since. That matters here because a round is worth cents per
 * recipient, and per-round claiming would cost more gas than the reward.
 *
 * Threat model: contracts/docs/REVENUE-SHARE-THREAT-MODEL.md
 *
 *  - C1  The keeper is NOT trusted with custody. `setRoot` may only increase
 *        total obligations by tokens that have actually arrived since the last
 *        root. A stolen key can misallocate one round; it can never reach the
 *        unclaimed balance of every earlier round, which is the entire pot.
 *  - H2  A root that lowers somebody's cumulative below what they already
 *        claimed is a clean no-op, never an underflow that locks them out of
 *        all future rounds.
 *  - M3  nonReentrant, and `claimed` is written before the transfer.
 *  - M4  Rounding dust stays and is simply distributable next round. There is
 *        no sweep, because a sweep is an admin withdrawal wearing a hat.
 *
 * There is deliberately no function that can move $LOCK to an admin.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract LockDistributor {
    IERC20 public immutable token;

    address public keeper;   // may post roots, may never withdraw
    address public admin;    // may rotate the keeper, may never withdraw
    address public pendingAdmin;

    bytes32 public root;
    uint256 public totalObligations; // sum of all cumulative leaves in `root`
    uint256 public totalClaimed;
    uint256 public roundId;

    mapping(address => uint256) public claimed;

    error NotKeeper();
    error NotAdmin();
    error ZeroAddress();
    error NothingToClaim();
    error BadProof();
    error ObligationsDecreased();
    error Unfunded(uint256 requested, uint256 available);
    error Reentrant();

    event RootUpdated(uint256 indexed roundId, bytes32 root, uint256 totalObligations, uint256 added);
    event Claimed(address indexed account, uint256 amount, uint256 cumulative);
    event KeeperChanged(address indexed keeper);
    event AdminTransferStarted(address indexed to);
    event AdminChanged(address indexed admin);

    uint256 private _entered = 1;

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address token_, address keeper_, address admin_) {
        if (token_ == address(0) || keeper_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        keeper = keeper_;
        admin = admin_;
    }

    /**
     * Publish a new cumulative root.
     *
     * `newTotal` is the sum of every leaf in the tree. The increase over the
     * previous total is what this round distributes, and C1 requires that the
     * contract already holds enough tokens to cover every outstanding
     * obligation including it. Tokens arrive from the buyback vault before this
     * is called; if they have not, the call reverts rather than promising money
     * that is not there.
     */
    function setRoot(bytes32 newRoot, uint256 newTotal) external {
        if (msg.sender != keeper) revert NotKeeper();
        uint256 prev = totalObligations;
        if (newTotal < prev) revert ObligationsDecreased();

        // Every unclaimed obligation, old and new, must be backed right now.
        uint256 outstanding = newTotal - totalClaimed;
        uint256 held = token.balanceOf(address(this));
        if (held < outstanding) revert Unfunded(outstanding, held);

        root = newRoot;
        totalObligations = newTotal;
        unchecked { roundId += 1; }
        emit RootUpdated(roundId, newRoot, newTotal, newTotal - prev);
    }

    /// Everything owed to `account` that it has not already taken.
    function claimable(address account, uint256 cumulative) external view returns (uint256) {
        uint256 taken = claimed[account];
        return cumulative > taken ? cumulative - taken : 0;
    }

    /**
     * Claim against the current root.
     *
     * `cumulative` is the lifetime total for `account`, and the proof is over
     * `keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))))`.
     * Double hashing matches the airdrop contract and keeps a leaf from ever
     * being reinterpreted as an internal node.
     */
    function claim(address account, uint256 cumulative, bytes32[] calldata proof) external nonReentrant {
        uint256 taken = claimed[account];
        // H2: a root that lowered this account's cumulative must not underflow.
        if (cumulative <= taken) revert NothingToClaim();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
        if (!_verify(proof, root, leaf)) revert BadProof();

        uint256 amount = cumulative - taken;
        claimed[account] = cumulative;          // effects before interaction
        totalClaimed += amount;

        if (!token.transfer(account, amount)) revert Unfunded(amount, token.balanceOf(address(this)));
        emit Claimed(account, amount, cumulative);
    }

    /* ---------------- admin: rotation only, never custody ---------------- */

    function setKeeper(address k) external {
        if (msg.sender != admin) revert NotAdmin();
        if (k == address(0)) revert ZeroAddress();
        keeper = k;
        emit KeeperChanged(k);
    }

    /// Two-step, so a typo cannot orphan the contract.
    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminChanged(msg.sender);
    }

    /* ---------------- merkle ---------------- */

    function _verify(bytes32[] calldata proof, bytes32 r, bytes32 leaf) private pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == r;
    }
}
