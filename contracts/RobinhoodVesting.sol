// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
    RobinhoodVesting — irrevocable linear token vesting on Robinhood Chain.

    Companion to RobinhoodLocker / RobinhoodBurner. Non-upgradeable, no proxy.

    Guarantees (see contracts/docs/VESTING-THREAT-MODEL.md):
      - No function moves vested tokens out except claim(), callable only by the
        schedule's current beneficiary. There is NO revoke, NO sweep, NO rescue.
      - Admin can only adjust the flat creation fee (hard-capped at MAX_FEE),
        change the fee collector, and hand over admin via a two-step transfer.
        Admin can never mutate an existing schedule.
      - The creation fee is charged once at create; claims are always free.

    Vesting curve: linear from `start` to `end`, gated by `cliff`.
      claimable(t) = 0                                   for t <  cliff
      claimable(t) = total·(t−start)/(end−start) − claimed  for cliff ≤ t < end
      claimable(t) = total − claimed                     for t ≥ end  (exact sweep)
*/

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract RobinhoodVesting {
    struct Schedule {
        address creator;     // slot 0
        uint64 start;
        address beneficiary; // slot 1
        uint64 cliff;
        address token;       // slot 2
        uint64 end;
        uint128 total;       // slot 3 — uint128 keeps curve math overflow-free (K1)
        uint128 claimed;
    }

    uint256 public constant MAX_FEE = 0.05 ether; // hard cap; admin can never exceed (M5)
    uint256 public constant MIN_DURATION = 24 hours; // end must be this far in the future (H3)
    uint256 public constant MAX_BATCH = 200; // createMany bound (F-2)

    uint256 public nextScheduleId;
    mapping(uint256 => Schedule) public schedules;
    mapping(address => uint256[]) private _byToken;
    mapping(address => uint256[]) private _byBeneficiary; // append-only; may hold stale ids after transferBeneficiary (F-5)
    mapping(address => uint256[]) private _byCreator;

    uint256 public fee;          // flat ETH fee per schedule, charged at create only
    uint256 public accruedFees;  // fees accumulate here; collector pulls (H2)
    address public feeCollector;
    address public admin;
    address public pendingAdmin; // two-step admin transfer (M1)

    event VestingCreated(
        uint256 indexed id,
        address indexed token,
        address indexed beneficiary,
        address creator,
        uint256 total,
        uint64 start,
        uint64 cliff,
        uint64 end
    );
    event Claimed(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event BeneficiaryTransferred(uint256 indexed id, address indexed from, address indexed to);
    event FeeChanged(uint256 fee);
    event FeeCollectorChanged(address collector);
    event FeesWithdrawn(address indexed collector, uint256 amount);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed current);

    modifier onlyAdmin() { require(msg.sender == admin, "not admin"); _; }

    uint256 private _guard = 1; // shared guard across all state-changing entry points (K4)
    modifier nonReentrant() { require(_guard == 1, "reentrant"); _guard = 2; _; _guard = 1; }

    constructor(uint256 _fee, address _feeCollector) {
        require(_fee <= MAX_FEE, "fee over cap");
        admin = msg.sender;
        fee = _fee;
        feeCollector = _feeCollector == address(0) ? msg.sender : _feeCollector;
    }

    // ─────────────────────────────── create ───────────────────────────────

    /// Create one schedule. Requires prior approve() and msg.value == fee.
    function create(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliff,
        uint64 end
    ) external payable nonReentrant returns (uint256 id) {
        require(msg.value == fee, "bad fee");
        accruedFees += msg.value;
        id = _create(token, beneficiary, amount, start, cliff, end);
    }

    /// Create one schedule per (beneficiary, amount) pair, sharing token and dates.
    /// Requires msg.value == fee * pairs.
    function createMany(
        address token,
        address[] calldata beneficiaries,
        uint256[] calldata amounts,
        uint64 start,
        uint64 cliff,
        uint64 end
    ) external payable nonReentrant returns (uint256 firstId) {
        uint256 n = beneficiaries.length;
        require(n > 0 && n <= MAX_BATCH, "bad batch size");
        require(amounts.length == n, "length mismatch");
        require(msg.value == fee * n, "bad fee");
        accruedFees += msg.value;
        firstId = nextScheduleId;
        for (uint256 i = 0; i < n; i++) {
            _create(token, beneficiaries[i], amounts[i], start, cliff, end);
        }
    }

    function _create(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliff,
        uint64 end
    ) private returns (uint256 id) {
        require(beneficiary != address(0), "zero beneficiary");
        require(token.code.length > 0, "token has no code"); // F-1
        require(amount > 0, "zero amount");
        require(start <= cliff && cliff <= end && end > start, "bad dates"); // M3
        require(uint256(end) > block.timestamp + MIN_DURATION, "vesting too short"); // H3

        // Record what was actually received — fee-on-transfer safe (A1/H1).
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        require(received > 0, "nothing received");
        require(received <= type(uint128).max, "amount too large"); // K1

        id = nextScheduleId++;
        schedules[id] = Schedule({
            creator: msg.sender,
            start: start,
            beneficiary: beneficiary,
            cliff: cliff,
            token: token,
            end: end,
            total: uint128(received),
            claimed: 0
        });
        _byToken[token].push(id);
        _byBeneficiary[beneficiary].push(id);
        _byCreator[msg.sender].push(id);

        emit VestingCreated(id, token, beneficiary, msg.sender, received, start, cliff, end);
    }

    // ─────────────────────────────── claim ────────────────────────────────

    /// Amount the beneficiary could claim right now.
    function claimable(uint256 id) public view returns (uint256) {
        Schedule storage s = schedules[id];
        if (s.total == 0) return 0; // nonexistent id
        uint256 t = block.timestamp;
        if (t < s.cliff) return 0;
        if (t >= s.end) return uint256(s.total) - s.claimed; // exact sweep, no dust (K2)
        // total ≤ 2^128 and elapsed ≤ 2^64 → product ≤ 2^192: cannot overflow (K1)
        uint256 vested = (uint256(s.total) * (t - s.start)) / (s.end - s.start);
        return vested - s.claimed; // vested is monotonic and claims never exceed it
    }

    function claim(uint256 id) external nonReentrant {
        Schedule storage s = schedules[id];
        require(msg.sender == s.beneficiary, "not beneficiary");
        uint256 amount = claimable(id);
        require(amount > 0, "nothing to claim");
        s.claimed += uint128(amount); // effects before interaction (K4); fits: claimed+amount ≤ total
        _safeTransfer(s.token, s.beneficiary, amount);
        emit Claimed(id, s.beneficiary, amount);
    }

    /// Current beneficiary may move the schedule to a new wallet (wallet
    /// rotation / compromised key). Emits an event so proof pages can show it.
    function transferBeneficiary(uint256 id, address newBeneficiary) external nonReentrant {
        Schedule storage s = schedules[id];
        require(msg.sender == s.beneficiary, "not beneficiary");
        require(newBeneficiary != address(0), "zero beneficiary");
        address old = s.beneficiary;
        s.beneficiary = newBeneficiary;
        _byBeneficiary[newBeneficiary].push(id);
        emit BeneficiaryTransferred(id, old, newBeneficiary);
    }

    // ─────────────────────────────── views ────────────────────────────────

    function getSchedule(uint256 id) external view returns (Schedule memory) { return schedules[id]; }
    function totalSchedules() external view returns (uint256) { return nextScheduleId; }
    function schedulesByToken(address token) external view returns (uint256[] memory) { return _byToken[token]; }
    /// May include stale ids after transferBeneficiary — filter on schedules[id].beneficiary (F-5).
    function schedulesByBeneficiary(address b) external view returns (uint256[] memory) { return _byBeneficiary[b]; }
    function schedulesByCreator(address c) external view returns (uint256[] memory) { return _byCreator[c]; }

    // ─────────────────────────────── admin ────────────────────────────────
    // None of these can touch schedules or locked tokens.

    function setFee(uint256 _fee) external onlyAdmin {
        require(_fee <= MAX_FEE, "fee over cap"); // M5
        fee = _fee;
        emit FeeChanged(_fee);
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
    // Safe-transfer pattern (K3): accept both a true return and an empty
    // return (USDT-style tokens); revert on false or a failed call. Token code
    // existence is guaranteed at create (F-1).

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
