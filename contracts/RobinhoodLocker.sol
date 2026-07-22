// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
   RobinhoodLocker — a trustless liquidity & token locker for Robinhood Chain.

   One vault holds many locks. Anyone can lock any ERC-20 (an LP token or a plain
   token) until a chosen unlock time. Core safety guarantees:
     • Locked tokens can ONLY be withdrawn by the lock's owner, and ONLY at/after
       its unlockTime. There is NO admin function that can move locked tokens.
     • unlockTime can only ever be EXTENDED, never shortened.
     • Fee-on-transfer tokens are handled by recording the amount actually received.
     • Reentrancy-guarded.
   The admin can change ONLY the flat fee, the fee collector, and the admin key.
*/

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RobinhoodLocker {
    struct Lock {
        address owner;
        address token;
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
    }

    uint256 public nextLockId;
    mapping(uint256 => Lock) public locks;
    mapping(address => uint256[]) private _byOwner;
    mapping(address => uint256[]) private _byToken;

    uint256 public fee;           // flat ETH fee charged per lock
    address public feeCollector;  // receives the fees
    address public admin;         // may change fee / feeCollector / admin ONLY

    event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint256 unlockTime);
    event Withdrawn(uint256 indexed id, address indexed owner, uint256 amount);
    event Extended(uint256 indexed id, uint256 newUnlockTime);
    event LockOwnershipTransferred(uint256 indexed id, address indexed from, address indexed to);
    event FeeChanged(uint256 fee);

    modifier onlyAdmin() { require(msg.sender == admin, "not admin"); _; }
    modifier onlyLockOwner(uint256 id) { require(locks[id].owner == msg.sender, "not lock owner"); _; }

    uint256 private _guard = 1;
    modifier nonReentrant() { require(_guard == 1, "reentrant"); _guard = 2; _; _guard = 1; }

    constructor(uint256 _fee, address _feeCollector) {
        admin = msg.sender;
        fee = _fee;
        feeCollector = _feeCollector == address(0) ? msg.sender : _feeCollector;
    }

    /// Lock `amount` of `token` until `unlockTime`. Requires prior approve() and msg.value >= fee.
    function lock(address token, uint256 amount, uint256 unlockTime) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= fee, "fee too low");
        require(amount > 0, "amount = 0");
        require(token != address(0), "token = 0");
        require(unlockTime > block.timestamp, "unlock in the past");

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        require(received > 0, "nothing received");

        id = nextLockId++;
        locks[id] = Lock({ owner: msg.sender, token: token, amount: received, unlockTime: unlockTime, withdrawn: false });
        _byOwner[msg.sender].push(id);
        _byToken[token].push(id);

        if (fee > 0) { (bool okFee, ) = feeCollector.call{value: fee}(""); require(okFee, "fee transfer failed"); }
        if (msg.value > fee) { (bool okRef, ) = msg.sender.call{value: msg.value - fee}(""); require(okRef, "refund failed"); }

        emit Locked(id, msg.sender, token, received, unlockTime);
    }

    /// Withdraw a fully-unlocked lock back to its owner.
    function withdraw(uint256 id) external nonReentrant onlyLockOwner(id) {
        Lock storage l = locks[id];
        require(!l.withdrawn, "already withdrawn");
        require(block.timestamp >= l.unlockTime, "still locked");
        l.withdrawn = true;
        require(IERC20(l.token).transfer(l.owner, l.amount), "transfer failed");
        emit Withdrawn(id, l.owner, l.amount);
    }

    /// Extend a lock to a LATER unlock time (can never shorten it).
    function extend(uint256 id, uint256 newUnlockTime) external onlyLockOwner(id) {
        Lock storage l = locks[id];
        require(!l.withdrawn, "already withdrawn");
        require(newUnlockTime > l.unlockTime, "must be later");
        l.unlockTime = newUnlockTime;
        emit Extended(id, newUnlockTime);
    }

    /// Hand a lock to a new owner (e.g. a multisig). The new owner controls withdrawal.
    function transferLockOwnership(uint256 id, address newOwner) external onlyLockOwner(id) {
        require(newOwner != address(0), "zero owner");
        address prev = locks[id].owner;
        locks[id].owner = newOwner;
        _byOwner[newOwner].push(id);
        emit LockOwnershipTransferred(id, prev, newOwner);
    }

    // ---- views ----
    function getLock(uint256 id) external view returns (Lock memory) { return locks[id]; }
    function lockedAmount(uint256 id) external view returns (uint256) { return locks[id].withdrawn ? 0 : locks[id].amount; }
    function isUnlocked(uint256 id) external view returns (bool) { return block.timestamp >= locks[id].unlockTime; }
    function timeRemaining(uint256 id) external view returns (uint256) {
        uint256 u = locks[id].unlockTime;
        return block.timestamp >= u ? 0 : u - block.timestamp;
    }
    function locksByOwner(address o) external view returns (uint256[] memory) { return _byOwner[o]; }
    function locksByToken(address t) external view returns (uint256[] memory) { return _byToken[t]; }
    function totalLocks() external view returns (uint256) { return nextLockId; }

    // ---- admin: fee config ONLY (never touches locked tokens) ----
    function setFee(uint256 _fee) external onlyAdmin { fee = _fee; emit FeeChanged(_fee); }
    function setFeeCollector(address c) external onlyAdmin { require(c != address(0), "zero"); feeCollector = c; }
    function setAdmin(address a) external onlyAdmin { require(a != address(0), "zero"); admin = a; }
}
