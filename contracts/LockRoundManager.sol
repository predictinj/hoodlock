// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * LockRoundManager — opens one RobinhoodAirdrop per revenue-share round and
 * routes what nobody claims.
 *
 * The buyback vault sends $LOCK here. A keeper computes who is owed what from
 * the locks and opens a round; the airdrop contract does the claiming, the
 * deadline and the accounting, because it already does all three and has been
 * live since July.
 *
 * Why this contract exists at all: `RobinhoodAirdrop.sweep()` pays the drop's
 * CREATOR, and a creator is fixed forever at creation. A sweep destination the
 * admin can change therefore needs a contract to be the creator and forward on.
 * That is the whole job.
 *
 * Threat model: contracts/docs/REVENUE-SHARE-THREAT-MODEL.md
 *
 *  - C1  Dissolved rather than mitigated. Every round is a separately funded
 *        airdrop with its own `remaining`, so a hostile root for round 7 can
 *        misallocate round 7 and nothing else. Earlier rounds are unreachable,
 *        which is why there is no timelock, no veto and no keeper alert here.
 *  - S1  `sweepReceiver` is settable, and that IS an admin path to funds. It is
 *        bounded to money that is already expired: RobinhoodAirdrop.sweep()
 *        enforces `block.timestamp >= endTime` itself, so no admin can reach a
 *        round that is still claimable, whatever they set this to.
 *  - S2  Sweeping is permissionless. The caller chooses only WHEN; the
 *        destination is whatever the admin last set, never the caller.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IRobinhoodAirdrop {
    function create(
        address token,
        bytes32 merkleRoot,
        uint256 total,
        uint32 maxClaims,
        uint64 endTime,
        string calldata uri
    ) external payable returns (uint256 id);
    function sweep(uint256 id) external;
    function quote(uint32 maxClaims) external view returns (uint256);
}

contract LockRoundManager {
    IERC20 public immutable lock;
    IRobinhoodAirdrop public immutable airdrop;

    /// Each round is claimable for this long. Independent per round: one opened
    /// today expires in 180 days, one opened on day 10 expires on day 190.
    uint64 public constant CLAIM_WINDOW = 180 days;

    address public keeper;         // opens rounds, can never move tokens out
    address public admin;
    address public pendingAdmin;
    address public sweepReceiver;  // where expired rounds go (S1)

    uint256[] public rounds;       // airdrop ids, in order
    mapping(uint256 => bool) public swept;

    error NotKeeper();
    error NotAdmin();
    error ZeroAddress();
    error NothingToDistribute();
    error AlreadySwept();
    error Reentrant();
    error TransferFailed();

    event RoundOpened(uint256 indexed airdropId, uint256 total, uint32 maxClaims, uint64 endTime, string uri);
    event RoundSwept(uint256 indexed airdropId, uint256 amount, address to);
    event SweepReceiverChanged(address indexed to);
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

    constructor(address lock_, address airdrop_, address keeper_, address admin_, address sweepReceiver_) {
        if (lock_ == address(0) || airdrop_ == address(0) || keeper_ == address(0)
            || admin_ == address(0) || sweepReceiver_ == address(0)) revert ZeroAddress();
        lock = IERC20(lock_);
        airdrop = IRobinhoodAirdrop(airdrop_);
        keeper = keeper_;
        admin = admin_;
        sweepReceiver = sweepReceiver_;
    }

    /// Buyback output lands here between rounds.
    function undistributed() external view returns (uint256) {
        return lock.balanceOf(address(this));
    }

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    /**
     * Open a round for `total` $LOCK against `merkleRoot`.
     *
     * The manager is the creator, which is what makes the sweep routable. The
     * airdrop's own fee is paid from the ETH sent with this call, so the
     * manager never needs an ETH balance of its own.
     */
    function openRound(bytes32 merkleRoot, uint256 total, uint32 maxClaims, string calldata uri)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (total == 0 || total > lock.balanceOf(address(this))) revert NothingToDistribute();

        uint64 endTime = uint64(block.timestamp) + CLAIM_WINDOW;

        // forceApprove pattern: reset first, since some tokens reject a change
        // from a non-zero allowance.
        lock.approve(address(airdrop), 0);
        lock.approve(address(airdrop), total);

        id = airdrop.create{value: msg.value}(address(lock), merkleRoot, total, maxClaims, endTime, uri);
        rounds.push(id);
        emit RoundOpened(id, total, maxClaims, endTime, uri);
    }

    /**
     * Reclaim a round nobody finished claiming and forward it on.
     *
     * Permissionless (S2). The airdrop contract refuses to sweep before its own
     * `endTime`, so this cannot touch a round that is still live no matter who
     * calls it or where `sweepReceiver` points.
     */
    function sweepRound(uint256 id) external nonReentrant returns (uint256 amount) {
        if (swept[id]) revert AlreadySwept();
        swept[id] = true;

        uint256 before = lock.balanceOf(address(this));
        airdrop.sweep(id);                       // reverts unless expired
        amount = lock.balanceOf(address(this)) - before;

        if (amount > 0) {
            address to = sweepReceiver;
            if (!lock.transfer(to, amount)) revert TransferFailed();
            emit RoundSwept(id, amount, to);
        }
    }

    /* ---------------- admin ---------------- */

    /// S1: reaches expired rounds only. The airdrop enforces the deadline.
    function setSweepReceiver(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();
        sweepReceiver = to;
        emit SweepReceiverChanged(to);
    }

    function setKeeper(address k) external {
        if (msg.sender != admin) revert NotAdmin();
        if (k == address(0)) revert ZeroAddress();
        keeper = k;
        emit KeeperChanged(k);
    }

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
}
