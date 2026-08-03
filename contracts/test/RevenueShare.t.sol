// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {LockBuybackVault} from "../LockBuybackVault.sol";
import {LockDistributor} from "../LockDistributor.sol";
import {StandardToken} from "./mocks/Tokens.sol";
import {MockWETH, MockPool} from "./mocks/Uniswap.sol";

/**
 * Proves the seventeen invariants in docs/REVENUE-SHARE-THREAT-MODEL.md.
 * Each test names the finding it closes.
 */
contract RevenueShareTest is Test {
    StandardToken lock;
    MockWETH weth;
    MockPool pool;
    LockBuybackVault vault;
    LockDistributor dist;

    address admin  = address(0xA11CE);
    address keeper = address(0xC0FFEE);
    address alice  = address(0xA1);
    address bob    = address(0xB0B);
    address rando  = address(0xBEEF);

    // The execution price MUST correspond to the oracle tick, or the slippage
    // bound is never binding and invariant 3 silently tests nothing. Tick 0 is
    // a 1:1 raw ratio, so the honest execution price is 1e18.
    uint256 constant PRICE_WAD = 1e18;

    function setUp() public {
        lock = new StandardToken("HoodLock", "LOCK", 1_000_000e18);
        weth = new MockWETH();

        // token0/token1 ordering is irrelevant to the mock; LOCK is token0 here.
        pool = new MockPool(address(lock), address(weth));
        pool.setLockToken(address(lock));
        pool.setTwapTick(0);              // tick 0 => price 1:1 in raw units
        pool.setExecutionPrice(PRICE_WAD);

        dist  = new LockDistributor(address(lock), keeper, admin);
        vault = new LockBuybackVault(address(pool), address(weth), address(lock), address(dist), admin);
        pool.setVault(address(vault));

        // The pool needs LOCK to pay out with.
        lock.transfer(address(pool), 500_000e18);
    }

    /* ============ vault: readiness (invariants 1, 2) ============ */

    function test_execute_revertsBelowThreshold() public {
        vm.deal(address(vault), 0.019 ether);
        vm.expectRevert();
        vault.execute();
    }

    function test_execute_succeedsAtExactThreshold() public {
        vm.deal(address(vault), 0.02 ether);
        assertTrue(vault.canExecute());
        vm.prank(rando);
        vault.execute();
        assertEq(vault.roundId(), 1);
    }

    function test_execute_succeedsAfterMaxAgeWithDust() public {
        vm.deal(address(vault), 0.0001 ether);
        assertFalse(vault.canExecute());
        vm.warp(block.timestamp + 30 days + 1);
        assertTrue(vault.canExecute());
        vm.prank(rando);
        vault.execute();
        assertEq(vault.roundId(), 1);
    }

    function test_execute_revertsOnZeroBalanceEvenAfterMaxAge() public {
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert();
        vault.execute();
    }

    /* ============ vault: C2/C3 pricing (invariants 3, 4) ============ */

    /// C2: a fill worse than the TWAP bound must revert, not execute.
    function test_execute_revertsWhenPriceWorseThanTwapBound() public {
        vm.deal(address(vault), 0.02 ether);
        // Execution price collapses to 50% of the oracle: a sandwich in progress.
        pool.setExecutionPrice(PRICE_WAD / 2);
        vm.prank(rando);
        vm.expectRevert();
        vault.execute();
    }

    /// A fill inside the tolerance is accepted.
    function test_execute_acceptsFillWithinSlippageTolerance() public {
        vm.deal(address(vault), 0.02 ether);
        pool.setExecutionPrice((PRICE_WAD * 9800) / 10_000); // 2% worse, tolerance 3%
        vm.prank(rando);
        vault.execute();
        assertEq(vault.roundId(), 1);
    }

    /// C3: one round can never spend more than maxEthPerRound.
    function test_execute_capsSpendPerRound() public {
        vm.deal(address(vault), 5 ether);
        vm.prank(rando);
        vault.execute();
        assertEq(vault.totalEthSpent(), vault.maxEthPerRound());
        assertEq(address(vault).balance, 5 ether - vault.maxEthPerRound());
    }

    /// M2: no oracle history reverts rather than silently pricing at spot.
    function test_execute_revertsWhenTwapUnavailable() public {
        vm.deal(address(vault), 0.02 ether);
        pool.setOracleReverts(true);
        vm.expectRevert(LockBuybackVault.TwapUnavailable.selector);
        vault.execute();
    }

    /* ============ vault: C4 callback (invariants 5, 6) ============ */

    function test_callback_revertsForNonPool() public {
        vm.prank(rando);
        vm.expectRevert(LockBuybackVault.NotPool.selector);
        vault.uniswapV3SwapCallback(1, -1, bytes(""));
    }

    function test_callback_revertsWhenNoSwapInFlight() public {
        vm.prank(address(pool));
        vm.expectRevert(LockBuybackVault.NoSwapInFlight.selector);
        vault.uniswapV3SwapCallback(1, -1, bytes(""));
    }

    /// The mock asserts internally that a re-entrant execute() fails.
    function test_execute_blocksReentrancy() public {
        vm.deal(address(vault), 0.02 ether);
        pool.setReenterOnSwap(true);
        vm.prank(rando);
        vault.execute();
        assertEq(vault.roundId(), 1);
    }

    /* ============ vault: H1/H3/M1 (invariants 14, 15, 16) ============ */

    function test_noAdminPathToFunds() public {
        vm.deal(address(vault), 1 ether);
        uint256 before = admin.balance;
        // There is no withdraw/rescue/sweep on the vault at all.
        vm.prank(admin);
        (bool ok, ) = address(vault).call(abi.encodeWithSignature("rescueEth(address,uint256)", admin, 1 ether));
        assertFalse(ok, "vault must expose no rescue path");
        assertEq(admin.balance, before);
    }

    function test_receive_neverRevertsOnMinimalGas() public {
        // H3: RevenueSplitter.release() requires this send to succeed.
        (bool ok, ) = address(vault).call{value: 1 ether, gas: 2300}("");
        assertTrue(ok, "receive() must accept a 2300-gas stipend send");
    }

    function test_thresholdBounded() public {
        vm.startPrank(admin);
        vm.expectRevert(LockBuybackVault.OutOfBounds.selector);
        vault.setThreshold(0.004 ether);
        vm.expectRevert(LockBuybackVault.OutOfBounds.selector);
        vault.setThreshold(0.51 ether);
        vault.setThreshold(0.1 ether);
        assertEq(vault.threshold(), 0.1 ether);
        vm.stopPrank();
    }

    function test_slippageBounded() public {
        vm.startPrank(admin);
        vm.expectRevert(LockBuybackVault.OutOfBounds.selector);
        vault.setMaxSlippageBps(1001);
        vault.setMaxSlippageBps(1000);
        vm.stopPrank();
    }

    function test_twapWindowCannotGoBelowMinimum() public {
        vm.prank(admin);
        vm.expectRevert(LockBuybackVault.OutOfBounds.selector);
        vault.setTwapWindow(29 minutes);
    }

    function test_nonAdminCannotConfigure() public {
        vm.prank(rando);
        vm.expectRevert(LockBuybackVault.NotAdmin.selector);
        vault.setThreshold(0.1 ether);
    }

    /* ============ distributor: C1 funding cap (invariants 7, 8) ============ */

    function _leaf(address a, uint256 c) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, c))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x <= y ? keccak256(abi.encode(x, y)) : keccak256(abi.encode(y, x));
    }

    /// C1: a root may not promise more than the tokens actually delivered.
    function test_setRoot_revertsWhenUnfunded() public {
        bytes32 root = _pair(_leaf(alice, 100e18), _leaf(bob, 100e18));
        vm.prank(keeper);
        vm.expectRevert();
        dist.setRoot(root, 200e18); // nothing deposited yet
    }

    function test_setRoot_succeedsWhenFunded() public {
        lock.transfer(address(dist), 200e18);
        bytes32 root = _pair(_leaf(alice, 100e18), _leaf(bob, 100e18));
        vm.prank(keeper);
        dist.setRoot(root, 200e18);
        assertEq(dist.totalObligations(), 0, "not live until activated");
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();
        assertEq(dist.totalObligations(), 200e18);
        assertEq(dist.roundId(), 1);
    }

    /// C1 again: obligations may never shrink.
    function test_setRoot_revertsOnDecrease() public {
        lock.transfer(address(dist), 200e18);
        bytes32 root = _pair(_leaf(alice, 100e18), _leaf(bob, 100e18));
        vm.prank(keeper);
        dist.setRoot(root, 200e18);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();
        vm.prank(keeper);
        vm.expectRevert(LockDistributor.ObligationsDecreased.selector);
        dist.setRoot(root, 199e18);
    }

    function test_setRoot_onlyKeeper() public {
        vm.prank(rando);
        vm.expectRevert(LockDistributor.NotKeeper.selector);
        dist.setRoot(bytes32(uint256(1)), 0);
    }

    /* ============ distributor: claiming (invariants 9-13) ============ */

    function _seedTwo(uint256 aAmt, uint256 bAmt) internal returns (bytes32[] memory pa, bytes32[] memory pb) {
        lock.transfer(address(dist), aAmt + bAmt);
        bytes32 la = _leaf(alice, aAmt);
        bytes32 lb = _leaf(bob, bAmt);
        vm.prank(keeper);
        dist.setRoot(_pair(la, lb), aAmt + bAmt);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();
        pa = new bytes32[](1); pa[0] = lb;
        pb = new bytes32[](1); pb[0] = la;
    }

    function test_claim_paysExactly() public {
        (bytes32[] memory pa, ) = _seedTwo(100e18, 50e18);
        dist.claim(alice, 100e18, pa);
        assertEq(lock.balanceOf(alice), 100e18);
        assertEq(dist.claimed(alice), 100e18);
    }

    function test_claim_secondTimeSameRootPaysNothing() public {
        (bytes32[] memory pa, ) = _seedTwo(100e18, 50e18);
        dist.claim(alice, 100e18, pa);
        vm.expectRevert(LockDistributor.NothingToClaim.selector);
        dist.claim(alice, 100e18, pa);
        assertEq(lock.balanceOf(alice), 100e18);
    }

    function test_claim_forgedProofReverts() public {
        (, bytes32[] memory pb) = _seedTwo(100e18, 50e18);
        // bob's proof, alice's (inflated) amount
        vm.expectRevert(LockDistributor.BadProof.selector);
        dist.claim(alice, 999e18, pb);
    }

    /// Cumulative: a second round pays only the increment.
    function test_claim_cumulativeAcrossRounds() public {
        (bytes32[] memory pa, ) = _seedTwo(100e18, 50e18);
        dist.claim(alice, 100e18, pa);

        lock.transfer(address(dist), 100e18);
        bytes32 la2 = _leaf(alice, 160e18);
        bytes32 lb2 = _leaf(bob, 90e18);
        vm.prank(keeper);
        dist.setRoot(_pair(la2, lb2), 250e18);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        bytes32[] memory pa2 = new bytes32[](1); pa2[0] = lb2;
        dist.claim(alice, 160e18, pa2);
        assertEq(lock.balanceOf(alice), 160e18, "paid only the increment");
    }

    /// H2: a lowered cumulative is a no-op, never a permanent lockout.
    function test_claim_loweredCumulativeIsCleanNoop() public {
        (bytes32[] memory pa, ) = _seedTwo(100e18, 50e18);
        dist.claim(alice, 100e18, pa);

        // A bad round gives alice LESS than she already took.
        lock.transfer(address(dist), 100e18);
        bytes32 la2 = _leaf(alice, 40e18);
        bytes32 lb2 = _leaf(bob, 210e18);
        vm.prank(keeper);
        dist.setRoot(_pair(la2, lb2), 250e18);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        bytes32[] memory pa2 = new bytes32[](1); pa2[0] = lb2;
        vm.expectRevert(LockDistributor.NothingToClaim.selector);
        dist.claim(alice, 40e18, pa2);

        // And a later CORRECT root still works: not locked out.
        lock.transfer(address(dist), 100e18);
        bytes32 la3 = _leaf(alice, 300e18);
        bytes32 lb3 = _leaf(bob, 50e18);
        vm.prank(keeper);
        dist.setRoot(_pair(la3, lb3), 350e18);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();
        bytes32[] memory pa3 = new bytes32[](1); pa3[0] = lb3;
        dist.claim(alice, 300e18, pa3);
        assertEq(lock.balanceOf(alice), 300e18);
    }

    function test_noAdminPathToTokens() public {
        lock.transfer(address(dist), 500e18);
        vm.prank(admin);
        (bool ok, ) = address(dist).call(abi.encodeWithSignature("rescueToken(address,uint256)", admin, 500e18));
        assertFalse(ok, "distributor must expose no rescue path");
        assertEq(lock.balanceOf(address(dist)), 500e18);
    }

    /* ============ invariant 17: solvency ============ */

    function test_solvency_balanceAlwaysCoversOutstanding() public {
        (bytes32[] memory pa, bytes32[] memory pb) = _seedTwo(100e18, 50e18);
        assertGe(lock.balanceOf(address(dist)), dist.totalObligations() - dist.totalClaimed());
        dist.claim(alice, 100e18, pa);
        assertGe(lock.balanceOf(address(dist)), dist.totalObligations() - dist.totalClaimed());
        dist.claim(bob, 50e18, pb);
        assertGe(lock.balanceOf(address(dist)), dist.totalObligations() - dist.totalClaimed());
    }

    /* ============ end to end ============ */

    function test_endToEnd_feeToClaim() public {
        vm.deal(address(vault), 0.02 ether);
        vm.prank(rando);
        uint256 bought = vault.execute();
        assertGt(bought, 0);
        assertEq(lock.balanceOf(address(dist)), bought, "buyback lands in the distributor");

        // Keeper splits it between two lockers.
        uint256 half = bought / 2;
        bytes32 la = _leaf(alice, half);
        bytes32 lb = _leaf(bob, bought - half);
        vm.prank(keeper);
        dist.setRoot(_pair(la, lb), bought);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        bytes32[] memory pa = new bytes32[](1); pa[0] = lb;
        dist.claim(alice, half, pa);
        assertEq(lock.balanceOf(alice), half);
    }

    /**
     * C1 regression. A stolen keeper key tries to reassign every unclaimed
     * token to itself. Total obligations are unchanged and the balance still
     * covers them, so the solvency check alone passed this — it is what the
     * timelock exists for.
     */
    function test_C1_hostileRootCannotStealUnclaimed() public {
        lock.transfer(address(dist), 200e18);
        bytes32 la = _leaf(alice, 100e18);
        bytes32 lb = _leaf(bob, 100e18);
        vm.prank(keeper);
        dist.setRoot(_pair(la, lb), 200e18);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        // Key stolen. Same total, all of it reassigned to the attacker.
        bytes32 evil = _leaf(rando, 200e18);
        bytes32 zero = _leaf(alice, 0);
        vm.prank(keeper);
        dist.setRoot(_pair(evil, zero), 200e18);

        // Immediately unusable: the honest root is still the live one.
        bytes32[] memory pe = new bytes32[](1); pe[0] = zero;
        vm.expectRevert(LockDistributor.BadProof.selector);
        dist.claim(rando, 200e18, pe);

        // And it cannot be rushed.
        vm.expectRevert();
        dist.activateRoot();

        // Meanwhile the honest holders can still take what they are owed.
        bytes32[] memory pa = new bytes32[](1); pa[0] = lb;
        bytes32[] memory pb = new bytes32[](1); pb[0] = la;
        dist.claim(alice, 100e18, pa);
        dist.claim(bob, 100e18, pb);
        assertEq(lock.balanceOf(alice), 100e18);
        assertEq(lock.balanceOf(bob), 100e18);

        // When the bad root finally matures there is nothing left to take.
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();
        vm.expectRevert();
        dist.claim(rando, 200e18, pe);
        assertEq(lock.balanceOf(rando), 0, "attacker gets nothing");
    }

    function test_activateRoot_cannotBeRushed() public {
        lock.transfer(address(dist), 100e18);
        bytes32 r = _pair(_leaf(alice, 100e18), _leaf(bob, 0));
        vm.prank(keeper);
        dist.setRoot(r, 100e18);
        vm.warp(block.timestamp + 47 hours);
        vm.expectRevert();
        dist.activateRoot();
        vm.warp(block.timestamp + 1 hours + 1);
        dist.activateRoot();
        assertEq(dist.totalObligations(), 100e18);
    }

    /**
     * The real LOCK/WETH pool on chain 4663 has WETH as token0 and LOCK as
     * token1, the opposite of the fixture above. That flips zeroForOne AND the
     * branch taken in _quoteFromTick, so the configuration production will
     * actually run was untested until this existed.
     */
    function test_realTokenOrdering_wethIsToken0() public {
        StandardToken lock2 = new StandardToken("HoodLock", "LOCK", 1_000_000e18);
        MockWETH weth2 = new MockWETH();
        MockPool pool2 = new MockPool(address(weth2), address(lock2)); // WETH first
        pool2.setLockToken(address(lock2));
        pool2.setTwapTick(0);
        pool2.setExecutionPrice(PRICE_WAD);
        lock2.transfer(address(pool2), 500_000e18);

        LockDistributor d2 = new LockDistributor(address(lock2), keeper, admin);
        LockBuybackVault v2 =
            new LockBuybackVault(address(pool2), address(weth2), address(lock2), address(d2), admin);
        pool2.setVault(address(v2));

        assertFalse(v2.lockIsToken0(), "fixture must mirror production");
        assertEq(v2.poolFee(), 10000, "1% tier");

        vm.deal(address(v2), 0.02 ether);
        vm.prank(rando);
        uint256 out = v2.execute();
        assertGt(out, 0);
        assertEq(lock2.balanceOf(address(d2)), out);
    }

    /// The 1% pool fee must be inside the bound, or an honest fill reverts.
    function test_poolFeeIsInsideTheSlippageBound() public {
        // An honest 1% pool takes 1% before we see the output. With the fee
        // ignored, this exact fill would fail the bound.
        vm.deal(address(vault), 0.02 ether);
        pool.setExecutionPrice((PRICE_WAD * 99) / 100); // exactly the 1% fee
        vm.prank(rando);
        vault.execute();
        assertEq(vault.roundId(), 1, "an honest 1% fee must not trip slippage");
    }

    /* ============ price maths at the REAL tick ============ */

    /**
     * Every other price test runs at tick 0, where the maths is trivially 1:1
     * and exercises almost nothing. The live pool sits at tick 186569 with WETH
     * as token0, which independently measures ~125,606,197 LOCK per WETH. If
     * _quoteFromTick is wrong at that magnitude, every bound in production is
     * wrong, and tick 0 would never reveal it.
     */
    function test_quoteAtRealPoolTick() public {
        StandardToken l2 = new StandardToken("HoodLock", "LOCK", 1e30);
        MockWETH w2 = new MockWETH();
        MockPool p2 = new MockPool(address(w2), address(l2)); // real ordering
        p2.setLockToken(address(l2));
        p2.setTwapTick(186569);
        l2.transfer(address(p2), 1e30);

        LockDistributor d2 = new LockDistributor(address(l2), keeper, admin);
        LockBuybackVault v2 =
            new LockBuybackVault(address(p2), address(w2), address(l2), address(d2), admin);
        p2.setVault(address(v2));

        // Price the pool honestly at the same tick: ~1.256e8 LOCK per WETH.
        uint256 measured = 125_606_197e18;
        p2.setExecutionPrice(measured);

        vm.deal(address(v2), 0.02 ether);
        vm.prank(rando);
        uint256 out = v2.execute();

        // 0.02 ETH at ~1.256e8 LOCK/WETH is ~2.512e6 LOCK.
        assertApproxEqRel(out, (measured * 2) / 100, 0.02e18, "quote must track the real tick");
    }

    /// The negative-tick rounding branch is never touched by tick 0.
    function test_quoteAtNegativeTick() public {
        StandardToken l2 = new StandardToken("LOCK", "LOCK", 1e30);
        MockWETH w2 = new MockWETH();
        MockPool p2 = new MockPool(address(l2), address(w2)); // LOCK is token0 here
        p2.setLockToken(address(l2));
        p2.setTwapTick(-100000);
        l2.transfer(address(p2), 1e30);

        LockDistributor d2 = new LockDistributor(address(l2), keeper, admin);
        LockBuybackVault v2 =
            new LockBuybackVault(address(p2), address(w2), address(l2), address(d2), admin);
        p2.setVault(address(v2));

        // tick -100000 with LOCK as token0 means 1.0001^-100000 WETH per LOCK,
        // i.e. ~22,026 LOCK per WETH. Pricing the mock anywhere else tests the
        // mock, not the contract.
        p2.setExecutionPrice(22026e18);
        vm.deal(address(v2), 0.02 ether);
        vm.prank(rando);
        uint256 out = v2.execute();
        assertGt(out, 0, "negative ticks must price without reverting");
    }

    /* ============ a Merkle tree of realistic depth ============ */

    /**
     * Every other claim test uses two leaves, so the proof is one hash deep and
     * the loop in _verify runs once. A real round has ~162 lockers, depth 8.
     */
    function test_deepMerkleTree_eightLeaves() public {
        address[8] memory who;
        uint256[8] memory amt;
        bytes32[8] memory leaves;
        uint256 total;
        for (uint256 i = 0; i < 8; i++) {
            who[i] = address(uint160(0x1000 + i));
            amt[i] = (i + 1) * 10e18;
            total += amt[i];
            leaves[i] = _leaf(who[i], amt[i]);
        }
        lock.transfer(address(dist), total);

        // Build three levels by hand so the proof is genuinely depth 3.
        bytes32[4] memory l1;
        for (uint256 i = 0; i < 4; i++) l1[i] = _pair(leaves[2 * i], leaves[2 * i + 1]);
        bytes32[2] memory l2;
        for (uint256 i = 0; i < 2; i++) l2[i] = _pair(l1[2 * i], l1[2 * i + 1]);
        bytes32 rootHash = _pair(l2[0], l2[1]);

        vm.prank(keeper);
        dist.setRoot(rootHash, total);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        // Claim for leaf index 5: siblings are leaf 4, l1[3], l2[0].
        bytes32[] memory proof = new bytes32[](3);
        proof[0] = leaves[4];
        proof[1] = l1[3];
        proof[2] = l2[0];
        dist.claim(who[5], amt[5], proof);
        assertEq(lock.balanceOf(who[5]), amt[5], "depth-3 proof must verify");

        // And a sibling's proof must not work for a different leaf.
        vm.expectRevert(LockDistributor.BadProof.selector);
        dist.claim(who[6], amt[6], proof);
    }

    /* ============ paths not previously exercised ============ */

    /// A keeper can overwrite a pending root, which resets the 48h clock. That
    /// is a denial of service on distributions, not a theft. Recorded, not fixed.
    function test_keeperCanResetPendingDelay_documentedGrief() public {
        lock.transfer(address(dist), 100e18);
        bytes32 r = _pair(_leaf(alice, 100e18), _leaf(bob, 0));
        vm.prank(keeper);
        dist.setRoot(r, 100e18);
        uint64 firstActiveAt = dist.pendingActiveAt();

        vm.warp(block.timestamp + 47 hours);
        vm.prank(keeper);
        dist.setRoot(r, 100e18);           // re-propose, clock restarts
        assertGt(dist.pendingActiveAt(), firstActiveAt, "delay restarts");

        vm.expectRevert();
        dist.activateRoot();               // cannot activate on the old timer
    }

    function test_adminTwoStepTransfer() public {
        vm.prank(admin);
        dist.transferAdmin(bob);
        assertEq(dist.admin(), admin, "not until accepted");
        vm.prank(rando);
        vm.expectRevert(LockDistributor.NotAdmin.selector);
        dist.acceptAdmin();
        vm.prank(bob);
        dist.acceptAdmin();
        assertEq(dist.admin(), bob);
    }

    function test_keeperRotation() public {
        vm.prank(admin);
        dist.setKeeper(bob);
        vm.prank(keeper);
        vm.expectRevert(LockDistributor.NotKeeper.selector);
        dist.setRoot(bytes32(uint256(1)), 0);
        lock.transfer(address(dist), 10e18);
        vm.prank(bob);
        dist.setRoot(_pair(_leaf(alice, 10e18), _leaf(bob, 0)), 10e18);
    }

    function test_consecutiveRoundsAccumulate() public {
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rando);
        vault.execute();
        uint256 afterOne = vault.totalLockBought();
        vault.execute();
        vm.stopPrank();
        assertEq(vault.roundId(), 2);
        assertGt(vault.totalLockBought(), afterOne, "second round adds more");
        assertEq(vault.totalEthSpent(), 2 * vault.maxEthPerRound());
    }

    /* ============ fuzz ============ */

    function testFuzz_claimNeverExceedsCumulative(uint96 a, uint96 b) public {
        // Bounded by what this contract still holds after seeding the pool;
        // an unfundable amount tests the fixture's balance, not the invariant.
        uint256 aa = bound(uint256(a), 1, 100_000e18);
        uint256 bb = bound(uint256(b), 1, 100_000e18);
        lock.transfer(address(dist), aa + bb);
        bytes32 la = _leaf(alice, aa);
        bytes32 lb = _leaf(bob, bb);
        vm.prank(keeper);
        dist.setRoot(_pair(la, lb), aa + bb);
        vm.warp(block.timestamp + 48 hours);
        dist.activateRoot();

        bytes32[] memory pa = new bytes32[](1); pa[0] = lb;
        dist.claim(alice, aa, pa);
        assertEq(lock.balanceOf(alice), aa);
        assertLe(dist.totalClaimed(), dist.totalObligations(), "never over-pay");
    }

    function testFuzz_thresholdAlwaysWithinBounds(uint256 t) public {
        // Read the bounds BEFORE pranking: a view call consumes vm.prank, so
        // setThreshold would arrive from the test contract and revert NotAdmin.
        uint256 lo = vault.MIN_THRESHOLD();
        uint256 hi = vault.MAX_THRESHOLD();
        bool valid = t >= lo && t <= hi;
        vm.prank(admin);
        if (!valid) {
            vm.expectRevert(LockBuybackVault.OutOfBounds.selector);
            vault.setThreshold(t);
        } else {
            vault.setThreshold(t);
            assertEq(vault.threshold(), t);
        }
    }
}
