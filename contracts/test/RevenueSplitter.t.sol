// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {RevenueSplitter} from "../RevenueSplitter.sol";

/// Pull-style fee source, faithful to vesting/airdrop semantics: pays its
/// collector on withdrawFees, reverts when nothing accrued.
contract MockFeeSource {
    address public feeCollector;
    uint256 public accruedFees;
    constructor(address c) { feeCollector = c; }
    receive() external payable { accruedFees += msg.value; }
    function withdrawFees() external {
        require(msg.sender == feeCollector, "not collector");
        uint256 amount = accruedFees;
        require(amount > 0, "nothing accrued");
        accruedFees = 0;
        (bool ok, ) = feeCollector.call{value: amount}("");
        require(ok, "eth send failed");
    }
}

/// A hostile pull target that tries to reenter release() mid-withdraw.
contract ReentrantSource {
    RevenueSplitter s;
    constructor(RevenueSplitter _s) { s = _s; }
    receive() external payable {}
    function withdrawFees() external {
        s.release(); // attempt to reenter while pull() is mid-flight
    }
}

/// A hostile payee that reenters release() while being paid.
contract ReentrantPayee {
    RevenueSplitter s;
    function setTarget(RevenueSplitter _s) external { s = _s; }
    receive() external payable {
        s.release(); // reverts "reentrant", making our payment fail
    }
}

contract RevenueSplitterTest is Test {
    RevenueSplitter s;
    address team = makeAddr("team");
    address ops = makeAddr("ops");

    function setUp() public {
        s = new RevenueSplitter(team, ops);
    }

    function test_constructor_guards() public {
        vm.expectRevert(bytes("zero payee"));
        new RevenueSplitter(address(0), ops);
        vm.expectRevert(bytes("zero payee"));
        new RevenueSplitter(team, address(0));
        vm.expectRevert(bytes("same payee"));
        new RevenueSplitter(team, team);
    }

    /// The locker/burner push path: plain transfer in, then a split.
    function test_push_then_release_splits_evenly() public {
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(s).call{value: 1 ether}("");
        assertTrue(ok, "receive must accept");
        s.release();
        assertEq(ops.balance, 0.5 ether);
        assertEq(team.balance, 0.5 ether);
        assertEq(address(s).balance, 0);
    }

    /// Odd wei must land on the team side, never ops (K4).
    function test_odd_wei_goes_to_team() public {
        vm.deal(address(s), 3 wei);
        s.release();
        assertEq(ops.balance, 1 wei);
        assertEq(team.balance, 2 wei);
    }

    function test_release_with_zero_balance_is_noop() public {
        s.release();
        assertEq(ops.balance, 0);
        assertEq(team.balance, 0);
    }

    /// Anyone may trigger the split; the destination never changes (K2).
    function test_release_is_permissionless_but_fixed() public {
        vm.deal(address(s), 2 ether);
        vm.prank(makeAddr("stranger"));
        s.release();
        assertEq(ops.balance, 1 ether);
        assertEq(team.balance, 1 ether);
    }

    /// The vesting/airdrop pull path end to end.
    function test_pull_drains_source_and_splits() public {
        MockFeeSource src = new MockFeeSource(address(s));
        vm.deal(address(this), 4 ether);
        (bool ok, ) = address(src).call{value: 4 ether}("");
        assertTrue(ok);
        s.pull(address(src));
        assertEq(ops.balance, 2 ether);
        assertEq(team.balance, 2 ether);
        assertEq(src.accruedFees(), 0);
    }

    /// A hostile source reentering release() mid-pull achieves nothing: the
    /// early call IS just a legitimate split, and the outer one finds an
    /// empty balance. Nothing is lost, nothing double-pays (K3).
    function test_pull_reentrancy_is_harmless() public {
        ReentrantSource evil = new ReentrantSource(s);
        vm.deal(address(s), 1 ether);
        s.pull(address(evil));
        assertEq(ops.balance, 0.5 ether);
        assertEq(team.balance, 0.5 ether);
        assertEq(address(s).balance, 0);
    }

    /// The actual nested-release guard: a payee that tries to reenter during
    /// its own payment makes the whole release revert atomically, so the
    /// balance can never be counted twice mid-split.
    function test_nested_release_reverts_atomically() public {
        ReentrantPayee evilOps = new ReentrantPayee();
        RevenueSplitter s2 = new RevenueSplitter(team, address(evilOps));
        evilOps.setTarget(s2);
        vm.deal(address(s2), 1 ether);
        vm.expectRevert(bytes("ops send failed"));
        s2.release();
        assertEq(address(s2).balance, 1 ether); // untouched, waits for honesty
    }

    /// Conservation: whatever goes in comes out 50/50, exactly, at any size.
    function testFuzz_split_conserves_and_balances(uint96 amount) public {
        vm.deal(address(s), amount);
        s.release();
        assertEq(ops.balance + team.balance, amount);
        // team gets the odd wei, and the sides differ by at most that 1 wei
        assertGe(team.balance, ops.balance);
        assertLe(team.balance - ops.balance, 1);
    }
}
