// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../RobinhoodVesting.sol";
import "./mocks/Tokens.sol";

/// Random-walk handler: actors create schedules, claim, transfer beneficiaries,
/// warp time and withdraw fees, while ghost variables track ground truth.
contract Handler is Test {
    RobinhoodVesting public v;
    StandardToken[] public tokens;
    address[] public actors;

    // ghost accounting (invariant 1)
    mapping(address => uint256) public ghostReceived;
    mapping(address => uint256) public ghostClaimed;

    // creation snapshots (invariant 5)
    struct Snap { address creator; address token; uint128 total; uint64 start; uint64 cliff; uint64 end; }
    mapping(uint256 => Snap) public snaps;
    uint256 public snapCount;

    receive() external payable {} // handler acts as feeCollector

    constructor(RobinhoodVesting _v) {
        v = _v;
        for (uint256 i = 0; i < 3; i++) {
            StandardToken t = new StandardToken("T", "T", 1e33);
            tokens.push(t);
        }
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(a);
            vm.deal(a, 1_000 ether);
            for (uint256 j = 0; j < tokens.length; j++) {
                tokens[j].transfer(a, 1e30);
                vm.prank(a);
                tokens[j].approve(address(v), type(uint256).max);
            }
        }
    }

    function createSchedule(uint256 actorSeed, uint256 tokenSeed, uint256 benSeed, uint96 amount, uint32 cliffDelta, uint32 endDelta) external {
        address actor = actors[actorSeed % actors.length];
        StandardToken t = tokens[tokenSeed % tokens.length];
        address ben = actors[benSeed % actors.length];
        uint256 amt = uint256(amount) % 1e24 + 1;
        uint64 start = uint64(block.timestamp);
        uint64 cliff = start + uint64(cliffDelta % 200 days);
        uint64 end = cliff + uint64(endDelta % 900 days) + 25 hours;

        uint256 feeNow = v.fee();
        vm.prank(actor);
        try v.create{value: feeNow}(address(t), ben, amt, start, cliff, end) returns (uint256 id) {
            ghostReceived[address(t)] += amt; // StandardToken: received == amt
            snaps[id] = Snap(actor, address(t), uint128(amt), start, cliff, end);
            snapCount++;
        } catch {}
    }

    function claimSchedule(uint256 idSeed) external {
        uint256 total = v.totalSchedules();
        if (total == 0) return;
        uint256 id = idSeed % total;
        RobinhoodVesting.Schedule memory s = v.getSchedule(id);
        uint256 amount = v.claimable(id);
        vm.prank(s.beneficiary);
        try v.claim(id) {
            ghostClaimed[s.token] += amount;
        } catch {}
    }

    function transferBen(uint256 idSeed, uint256 newBenSeed) external {
        uint256 total = v.totalSchedules();
        if (total == 0) return;
        uint256 id = idSeed % total;
        RobinhoodVesting.Schedule memory s = v.getSchedule(id);
        address newBen = actors[newBenSeed % actors.length];
        vm.prank(s.beneficiary);
        try v.transferBeneficiary(id, newBen) {} catch {}
    }

    function warp(uint32 delta) external {
        vm.warp(block.timestamp + (delta % 400 days));
    }

    function withdrawFees() external {
        try v.withdrawFees() {} catch {} // handler IS the collector
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
    function tokenAt(uint256 i) external view returns (address) { return address(tokens[i]); }
}

contract RobinhoodVestingInvariantTest is Test {
    RobinhoodVesting v;
    Handler h;

    function setUp() public {
        vm.warp(1_700_000_000);
        v = new RobinhoodVesting(0.005 ether, address(this));
        h = new Handler(v);
        v.setFeeCollector(address(h)); // handler pulls fees during the walk

        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = Handler.createSchedule.selector;
        sels[1] = Handler.claimSchedule.selector;
        sels[2] = Handler.transferBen.selector;
        sels[3] = Handler.warp.selector;
        sels[4] = Handler.withdrawFees.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// Invariant 1: per token, claims never exceed deposits, and (with honest
    /// tokens) the contract holds exactly the difference.
    function invariant_solvencyPerToken() public view {
        for (uint256 i = 0; i < h.tokenCount(); i++) {
            address t = h.tokenAt(i);
            uint256 rec = h.ghostReceived(t);
            uint256 cl = h.ghostClaimed(t);
            assertLe(cl, rec, "claimed > received");
            assertEq(IERC20(t).balanceOf(address(v)), rec - cl, "balance drift");
        }
    }

    /// Invariant 4: the contract's ETH is exactly the accrued fees — no stray
    /// ETH can enter, fees only leave via withdrawFees.
    function invariant_ethEqualsAccruedFees() public view {
        assertEq(address(v).balance, v.accruedFees());
    }

    /// Invariant 5: no operation sequence mutates a schedule's immutable
    /// fields, and claimed never exceeds total.
    function invariant_scheduleFieldsImmutable() public view {
        for (uint256 id = 0; id < v.totalSchedules(); id++) {
            (address creator, address token, uint128 total, uint64 start, uint64 cliff, uint64 end) = h.snaps(id);
            if (total == 0) continue; // schedule created outside handler ghost (shouldn't happen)
            RobinhoodVesting.Schedule memory s = v.getSchedule(id);
            assertEq(s.creator, creator);
            assertEq(s.token, token);
            assertEq(uint256(s.total), uint256(total));
            assertEq(uint256(s.start), uint256(start));
            assertEq(uint256(s.cliff), uint256(cliff));
            assertEq(uint256(s.end), uint256(end));
            assertLe(uint256(s.claimed), uint256(s.total));
        }
    }
}
