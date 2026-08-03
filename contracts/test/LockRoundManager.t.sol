// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {LockRoundManager} from "../LockRoundManager.sol";
import {StandardToken} from "./mocks/Tokens.sol";
import {AirdropStub} from "./mocks/AirdropStub.sol";

contract LockRoundManagerTest is Test {
    StandardToken lock;
    AirdropStub drop;
    LockRoundManager mgr;

    address admin  = address(0xA11CE);
    address keeper = address(0xC0FFEE);
    address feeWallet = 0x79c1230cAb12d53D040f5FE1F5279e1A481CCeA2;
    address alice  = address(0xA1);
    address rando  = address(0xBEEF);

    function setUp() public {
        lock = new StandardToken("HoodLock", "LOCK", 1_000_000e18);
        drop = new AirdropStub();
        mgr = new LockRoundManager(address(lock), address(drop), keeper, admin, feeWallet);
        lock.transfer(address(mgr), 10_000e18); // buyback output
    }

    function _open(uint256 total) internal returns (uint256 id) {
        vm.prank(keeper);
        id = mgr.openRound(bytes32(uint256(1)), total, 100, "ipfs://list");
    }

    /* ---------------- opening ---------------- */

    function test_openRound_setsA180DayWindow() public {
        uint256 id = _open(1_000e18);
        (,,, uint64 endTime,) = drop.drops(id);
        assertEq(endTime, uint64(block.timestamp) + 180 days);
        assertEq(mgr.roundCount(), 1);
    }

    /// Each round has its OWN clock: day 0 expires at 180, day 10 at 190.
    function test_eachRoundExpiresIndependently() public {
        uint256 first = _open(1_000e18);
        vm.warp(block.timestamp + 10 days);
        uint256 second = _open(1_000e18);

        (,,, uint64 e1,) = drop.drops(first);
        (,,, uint64 e2,) = drop.drops(second);
        assertEq(e2 - e1, 10 days, "clocks are independent, not shared");
    }

    function test_openRound_keeperOnly() public {
        vm.prank(rando);
        vm.expectRevert(LockRoundManager.NotKeeper.selector);
        mgr.openRound(bytes32(uint256(1)), 1_000e18, 100, "");
    }

    function test_openRound_cannotOverdraw() public {
        vm.prank(keeper);
        vm.expectRevert(LockRoundManager.NothingToDistribute.selector);
        mgr.openRound(bytes32(uint256(1)), 10_001e18, 100, "");
    }

    function test_openRound_forwardsTheAirdropFee() public {
        drop.setFee(0.005 ether);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        mgr.openRound{value: 0.005 ether}(bytes32(uint256(1)), 1_000e18, 100, "");
        assertEq(address(mgr).balance, 0, "manager holds no ETH of its own");
    }

    /* ---------------- sweeping ---------------- */

    function test_sweep_revertsBeforeTheDeadline() public {
        uint256 id = _open(1_000e18);
        vm.warp(block.timestamp + 179 days);
        vm.expectRevert();
        mgr.sweepRound(id);
    }

    function test_sweep_sendsTheRemainderToTheReceiver() public {
        uint256 id = _open(1_000e18);
        drop.claimTo(id, alice, 400e18);          // some of it was claimed

        vm.warp(block.timestamp + 180 days);
        uint256 amount = mgr.sweepRound(id);      // permissionless

        assertEq(amount, 600e18, "only the unclaimed remainder");
        assertEq(lock.balanceOf(feeWallet), 600e18);
        assertEq(lock.balanceOf(alice), 400e18, "claimed tokens are untouched");
    }

    function test_sweep_isPermissionlessButDestinationIsNot() public {
        uint256 id = _open(1_000e18);
        vm.warp(block.timestamp + 180 days);

        vm.prank(rando);                          // a stranger triggers it
        mgr.sweepRound(id);

        assertEq(lock.balanceOf(rando), 0, "caller gets nothing");
        assertEq(lock.balanceOf(feeWallet), 1_000e18, "it goes where admin set");
    }

    function test_sweep_cannotBeRepeated() public {
        uint256 id = _open(1_000e18);
        vm.warp(block.timestamp + 180 days);
        mgr.sweepRound(id);
        vm.expectRevert(LockRoundManager.AlreadySwept.selector);
        mgr.sweepRound(id);
    }

    /* ---------------- the admin power, and its limit ---------------- */

    function test_adminCanChangeTheReceiver() public {
        vm.prank(admin);
        mgr.setSweepReceiver(alice);
        assertEq(mgr.sweepReceiver(), alice);

        uint256 id = _open(1_000e18);
        vm.warp(block.timestamp + 180 days);
        mgr.sweepRound(id);
        assertEq(lock.balanceOf(alice), 1_000e18);
    }

    /// S1: the settable destination reaches EXPIRED rounds only. Changing it
    /// gives no access whatever to a round that is still claimable.
    function test_receiverChangeCannotReachALiveRound() public {
        uint256 id = _open(1_000e18);
        vm.prank(admin);
        mgr.setSweepReceiver(admin);

        vm.warp(block.timestamp + 179 days);
        vm.expectRevert();
        mgr.sweepRound(id);
        assertEq(lock.balanceOf(admin), 0, "a live round is unreachable");
    }

    function test_nonAdminCannotChangeTheReceiver() public {
        vm.prank(rando);
        vm.expectRevert(LockRoundManager.NotAdmin.selector);
        mgr.setSweepReceiver(rando);
        vm.prank(keeper);
        vm.expectRevert(LockRoundManager.NotAdmin.selector);
        mgr.setSweepReceiver(keeper);
    }

    /// The receiver can point back at the manager, recycling expired rounds
    /// into the next distribution instead of paying them out.
    function test_receiverCanRecycleBackIntoTheNextRound() public {
        vm.prank(admin);
        mgr.setSweepReceiver(address(mgr));

        uint256 id = _open(1_000e18);
        uint256 heldBefore = mgr.undistributed();
        vm.warp(block.timestamp + 180 days);
        mgr.sweepRound(id);
        assertEq(mgr.undistributed(), heldBefore + 1_000e18, "recycled, not paid out");
    }

    function test_keeperCannotMoveTokensOut() public {
        vm.prank(keeper);
        (bool ok, ) = address(mgr).call(
            abi.encodeWithSignature("transfer(address,uint256)", keeper, 1e18));
        assertFalse(ok);
        assertEq(lock.balanceOf(keeper), 0);
    }

    function test_adminTwoStep() public {
        vm.prank(admin);
        mgr.transferAdmin(alice);
        assertEq(mgr.admin(), admin);
        vm.prank(alice);
        mgr.acceptAdmin();
        assertEq(mgr.admin(), alice);
    }
}
