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
        assertEq(dist.totalObligations(), 200e18);
        assertEq(dist.roundId(), 1);
    }

    /// C1 again: obligations may never shrink.
    function test_setRoot_revertsOnDecrease() public {
        lock.transfer(address(dist), 200e18);
        bytes32 root = _pair(_leaf(alice, 100e18), _leaf(bob, 100e18));
        vm.startPrank(keeper);
        dist.setRoot(root, 200e18);
        vm.expectRevert(LockDistributor.ObligationsDecreased.selector);
        dist.setRoot(root, 199e18);
        vm.stopPrank();
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

        bytes32[] memory pa2 = new bytes32[](1); pa2[0] = lb2;
        vm.expectRevert(LockDistributor.NothingToClaim.selector);
        dist.claim(alice, 40e18, pa2);

        // And a later CORRECT root still works: not locked out.
        lock.transfer(address(dist), 100e18);
        bytes32 la3 = _leaf(alice, 300e18);
        bytes32 lb3 = _leaf(bob, 50e18);
        vm.prank(keeper);
        dist.setRoot(_pair(la3, lb3), 350e18);
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

        bytes32[] memory pa = new bytes32[](1); pa[0] = lb;
        dist.claim(alice, half, pa);
        assertEq(lock.balanceOf(alice), half);
    }
}
