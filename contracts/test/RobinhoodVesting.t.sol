// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../RobinhoodVesting.sol";
import "./mocks/Tokens.sol";

contract RobinhoodVestingTest is Test {
    RobinhoodVesting v;
    StandardToken tok;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address collector = makeAddr("collector");

    uint256 constant FEE = 0.005 ether;
    uint256 constant AMT = 1_000_000e18;

    uint64 start;
    uint64 cliff;
    uint64 end;

    function setUp() public {
        vm.warp(1_700_000_000);
        v = new RobinhoodVesting(FEE, collector);
        tok = new StandardToken("Token", "TOK", 1e33);
        tok.transfer(creator, 1e33 / 2);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        tok.approve(address(v), type(uint256).max);

        start = uint64(block.timestamp);
        cliff = uint64(block.timestamp + 90 days);
        end = uint64(block.timestamp + 365 days);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(creator);
        id = v.create{value: FEE}(address(tok), alice, AMT, start, cliff, end);
    }

    // ───────────────────────── curve boundaries ─────────────────────────

    function test_zeroBeforeCliff() public {
        uint256 id = _create();
        assertEq(v.claimable(id), 0);
        vm.warp(uint256(cliff) - 1);
        assertEq(v.claimable(id), 0);
    }

    function test_atCliff_linearSinceStart() public {
        uint256 id = _create();
        vm.warp(cliff);
        uint256 expected = (AMT * (cliff - start)) / (end - start);
        assertEq(v.claimable(id), expected);
        assertGt(expected, 0);
    }

    function test_midway() public {
        uint256 id = _create();
        vm.warp(uint256(start) + (uint256(end) - start) / 2);
        assertApproxEqAbs(v.claimable(id), AMT / 2, 1);
    }

    function test_atEnd_exactTotal() public {
        uint256 id = _create();
        vm.warp(end);
        assertEq(v.claimable(id), AMT);
    }

    function test_finalClaimSweepsDust() public {
        // Amount deliberately not divisible by the duration → every interim
        // claim rounds down; the final claim must recover every wei (K2).
        uint256 amt = 1e18 + 7;
        vm.prank(creator);
        uint256 id = v.create{value: FEE}(address(tok), alice, amt, start, cliff, end);

        vm.warp(uint256(cliff) + 11 days);
        vm.prank(alice);
        v.claim(id);
        vm.warp(uint256(cliff) + 100 days);
        vm.prank(alice);
        v.claim(id);
        vm.warp(uint256(end) + 1);
        vm.prank(alice);
        v.claim(id);

        assertEq(tok.balanceOf(alice), amt); // nothing stuck
        assertEq(v.claimable(id), 0);
    }

    function test_claimableMonotonic() public {
        uint256 id = _create();
        uint256 prev = 0;
        for (uint256 t = start; t <= uint256(end) + 1 days; t += 13 days) {
            vm.warp(t);
            uint256 c = v.claimable(id);
            assertGe(c, prev);
            prev = c;
        }
    }

    function test_backdatedStart_immediatelyClaimable() public {
        // TGE backdating: start & cliff in the past → linear portion claimable now.
        uint64 pastStart = uint64(block.timestamp - 180 days);
        uint64 pastCliff = uint64(block.timestamp - 90 days);
        uint64 futureEnd = uint64(block.timestamp + 180 days);
        vm.prank(creator);
        uint256 id = v.create{value: FEE}(address(tok), alice, AMT, pastStart, pastCliff, futureEnd);
        uint256 expected = (AMT * (block.timestamp - pastStart)) / (futureEnd - pastStart);
        assertEq(v.claimable(id), expected);
        vm.prank(alice);
        v.claim(id);
        assertEq(tok.balanceOf(alice), expected);
    }

    // ───────────────────────── access control ─────────────────────────

    function test_onlyBeneficiaryClaims() public {
        uint256 id = _create();
        vm.warp(end);
        vm.prank(bob);
        vm.expectRevert("not beneficiary");
        v.claim(id);
        vm.prank(creator);
        vm.expectRevert("not beneficiary");
        v.claim(id);
    }

    function test_doubleClaimReverts() public {
        uint256 id = _create();
        vm.warp(end);
        vm.startPrank(alice);
        v.claim(id);
        vm.expectRevert("nothing to claim");
        v.claim(id);
        vm.stopPrank();
    }

    function test_claimNonexistentId() public {
        vm.expectRevert("not beneficiary");
        v.claim(999);
    }

    function test_transferBeneficiary() public {
        uint256 id = _create();
        vm.warp(end);

        vm.prank(bob);
        vm.expectRevert("not beneficiary");
        v.transferBeneficiary(id, bob);

        vm.prank(alice);
        vm.expectRevert("zero beneficiary");
        v.transferBeneficiary(id, address(0));

        vm.prank(alice);
        v.transferBeneficiary(id, bob);

        vm.prank(alice);
        vm.expectRevert("not beneficiary");
        v.claim(id);

        vm.prank(bob);
        v.claim(id);
        assertEq(tok.balanceOf(bob), AMT);

        // new beneficiary is indexed; old array may keep the stale id (F-5)
        uint256[] memory bobIds = v.schedulesByBeneficiary(bob);
        assertEq(bobIds.length, 1);
        assertEq(bobIds[0], id);
    }

    // ───────────────────────── creation guards ─────────────────────────

    function test_createValidation() public {
        vm.startPrank(creator);

        vm.expectRevert("bad fee");
        v.create{value: FEE - 1}(address(tok), alice, AMT, start, cliff, end);
        vm.expectRevert("bad fee");
        v.create{value: FEE + 1}(address(tok), alice, AMT, start, cliff, end);

        vm.expectRevert("zero beneficiary");
        v.create{value: FEE}(address(tok), address(0), AMT, start, cliff, end);

        vm.expectRevert("token has no code");
        v.create{value: FEE}(makeAddr("noCode"), alice, AMT, start, cliff, end);

        vm.expectRevert("zero amount");
        v.create{value: FEE}(address(tok), alice, 0, start, cliff, end);

        vm.expectRevert("bad dates");
        v.create{value: FEE}(address(tok), alice, AMT, cliff, start, end); // start > cliff
        vm.expectRevert("bad dates");
        v.create{value: FEE}(address(tok), alice, AMT, start, end + 1, end); // cliff > end

        vm.expectRevert("vesting too short");
        v.create{value: FEE}(
            address(tok), alice, AMT, start, start, uint64(block.timestamp + 23 hours)
        );

        vm.stopPrank();

        // over the uint128 cap: needs a token whose balance can actually cover it
        StandardToken mega = new StandardToken("MEGA", "MEGA", uint256(type(uint128).max) * 2);
        mega.transfer(creator, uint256(type(uint128).max) + 10);
        vm.startPrank(creator);
        mega.approve(address(v), type(uint256).max);
        vm.expectRevert("amount too large");
        v.create{value: FEE}(address(mega), alice, uint256(type(uint128).max) + 1, start, cliff, end);
        vm.stopPrank();
    }

    function test_cliffEqualsEnd_isPureLock() public {
        // F-4: degenerates to a cliff-lock — everything at end, nothing before.
        vm.prank(creator);
        uint256 id = v.create{value: FEE}(address(tok), alice, AMT, start, end, end);
        vm.warp(uint256(end) - 1);
        assertEq(v.claimable(id), 0);
        vm.warp(end);
        assertEq(v.claimable(id), AMT);
    }

    function test_amountNearUint128Max_noOverflow() public {
        uint256 big = type(uint128).max;
        StandardToken huge = new StandardToken("HUGE", "HUGE", big);
        huge.transfer(creator, big);
        vm.startPrank(creator);
        huge.approve(address(v), big);
        uint256 id = v.create{value: FEE}(address(huge), alice, big, start, cliff, end);
        vm.stopPrank();
        vm.warp(uint256(end) - 1); // max elapsed under the curve branch
        uint256 c = v.claimable(id); // must not revert (K1)
        assertLe(c, big);
        vm.warp(end);
        assertEq(v.claimable(id), big);
    }

    function test_createMany() public {
        address[] memory bens = new address[](3);
        uint256[] memory amts = new uint256[](3);
        (bens[0], bens[1], bens[2]) = (alice, bob, makeAddr("carol"));
        (amts[0], amts[1], amts[2]) = (1e18, 2e18, 3e18);

        vm.startPrank(creator);
        vm.expectRevert("bad fee");
        v.createMany{value: FEE * 2}(address(tok), bens, amts, start, cliff, end);

        uint256[] memory shortAmts = new uint256[](2);
        vm.expectRevert("length mismatch");
        v.createMany{value: FEE * 3}(address(tok), bens, shortAmts, start, cliff, end);

        address[] memory none = new address[](0);
        uint256[] memory noneA = new uint256[](0);
        vm.expectRevert("bad batch size");
        v.createMany{value: 0}(address(tok), none, noneA, start, cliff, end);

        uint256 first = v.createMany{value: FEE * 3}(address(tok), bens, amts, start, cliff, end);
        vm.stopPrank();

        assertEq(v.totalSchedules(), 3);
        for (uint256 i = 0; i < 3; i++) {
            RobinhoodVesting.Schedule memory s = v.getSchedule(first + i);
            assertEq(s.beneficiary, bens[i]);
            assertEq(uint256(s.total), amts[i]);
        }
        assertEq(v.accruedFees(), FEE * 3);
    }

    // ───────────────────────── fees & admin ─────────────────────────

    function test_feeAccrualAndWithdraw() public {
        _create();
        assertEq(v.accruedFees(), FEE);
        assertEq(address(v).balance, FEE);

        vm.prank(alice);
        vm.expectRevert("not collector");
        v.withdrawFees();

        vm.prank(collector);
        v.withdrawFees();
        assertEq(collector.balance, FEE);
        assertEq(v.accruedFees(), 0);
        assertEq(address(v).balance, 0);

        vm.prank(collector);
        vm.expectRevert("nothing accrued");
        v.withdrawFees();
    }

    function test_revertingCollectorCannotBrickCreate() public {
        // H2: fees are pull-only, so a hostile collector never blocks create().
        RevertingCollector bad = new RevertingCollector();
        vm.prank(v.admin());
        v.setFeeCollector(address(bad));

        uint256 id = _create(); // must succeed
        assertEq(v.getSchedule(id).total, AMT);

        vm.prank(address(bad));
        vm.expectRevert("eth send failed");
        v.withdrawFees(); // only their own withdrawal fails, fees stay accrued
        assertEq(v.accruedFees(), FEE);
    }

    function test_strayEthReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, ) = address(v).call{value: 1 wei}("");
        assertFalse(ok); // no receive/fallback → ETH balance always == accruedFees
    }

    function test_setFeeCapped() public {
        uint256 cap = v.MAX_FEE(); // cached: expectRevert must target setFee, not this view call
        vm.startPrank(v.admin());
        v.setFee(cap);
        vm.expectRevert("fee over cap");
        v.setFee(cap + 1);
        v.setFee(0.01 ether);
        vm.stopPrank();
        assertEq(v.fee(), 0.01 ether);

        vm.prank(alice);
        vm.expectRevert("not admin");
        v.setFee(0);
    }

    function test_feeChangeNeverTouchesExistingSchedules() public {
        uint256 id = _create();
        RobinhoodVesting.Schedule memory before = v.getSchedule(id);
        vm.prank(v.admin());
        v.setFee(v.MAX_FEE());
        RobinhoodVesting.Schedule memory afterS = v.getSchedule(id);
        assertEq(before.total, afterS.total);
        assertEq(before.start, afterS.start);
        assertEq(before.end, afterS.end);
        // and creating now costs the new fee
        vm.prank(creator);
        vm.expectRevert("bad fee");
        v.create{value: FEE}(address(tok), alice, AMT, start, cliff, end);
    }

    function test_twoStepAdmin() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(alice);
        vm.expectRevert("not admin");
        v.transferAdmin(newAdmin);

        vm.prank(v.admin());
        v.transferAdmin(newAdmin);
        assertEq(v.admin(), address(this)); // unchanged until accepted

        vm.prank(alice);
        vm.expectRevert("not pending admin");
        v.acceptAdmin();

        vm.prank(newAdmin);
        v.acceptAdmin();
        assertEq(v.admin(), newAdmin);
        assertEq(v.pendingAdmin(), address(0));
    }

    // ───────────────────────── hostile tokens ─────────────────────────

    function test_feeOnTransferToken_recordsReceived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1e30);
        fot.transfer(creator, 1e24);
        uint256 amt = 1e21;
        vm.startPrank(creator);
        fot.approve(address(v), type(uint256).max);
        uint256 id = v.create{value: FEE}(address(fot), alice, amt, start, cliff, end);
        vm.stopPrank();

        uint256 received = amt - amt / 100;
        assertEq(uint256(v.getSchedule(id).total), received);

        vm.warp(end);
        assertEq(v.claimable(id), received);
        vm.prank(alice);
        v.claim(id); // outbound also takes 1% — contract stays solvent
        assertEq(fot.balanceOf(address(v)), 0);
    }

    function test_noReturnToken_worksBothDirections() public {
        // The v1 locker's raw require(transfer(...)) would brick this (K3).
        NoReturnToken usdt = new NoReturnToken(1e30);
        usdt.transfer(creator, 1e24);
        vm.startPrank(creator);
        usdt.approve(address(v), 1e24);
        uint256 id = v.create{value: FEE}(address(usdt), alice, 1e21, start, cliff, end);
        vm.stopPrank();

        vm.warp(end);
        vm.prank(alice);
        v.claim(id);
        assertEq(usdt.balanceOf(alice), 1e21);
    }

    function test_falseReturnToken_rejected() public {
        FalseReturnToken f = new FalseReturnToken(1e30);
        vm.prank(creator);
        vm.expectRevert("transferFrom failed");
        v.create{value: FEE}(address(f), alice, 1e18, start, cliff, end);
    }

    function test_reentrantToken_cannotDoubleClaim() public {
        ReentrantToken evil = new ReentrantToken(1e30);
        evil.transfer(creator, 1e24);
        vm.startPrank(creator);
        evil.approve(address(v), type(uint256).max);
        uint256 id = v.create{value: FEE}(address(evil), alice, 1e21, start, cliff, end);
        vm.stopPrank();

        evil.arm(address(v), id);
        vm.warp(end);
        vm.prank(alice);
        v.claim(id); // inner re-entrant claim is swallowed by the token; guard blocked it

        assertEq(evil.balanceOf(alice), 1e21); // paid exactly once
        assertEq(v.claimable(id), 0);
        assertEq(uint256(v.getSchedule(id).claimed), 1e21);
    }
}
