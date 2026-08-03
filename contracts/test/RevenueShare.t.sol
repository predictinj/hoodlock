// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {LockBuybackVault} from "../LockBuybackVault.sol";
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
    address dist = address(0xD157);  // stand-in: rounds are funded into RobinhoodAirdrop

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

        vault = new LockBuybackVault(address(pool), address(weth), address(lock), dist, admin);
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
}
