// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StandardToken} from "./Tokens.sol";

/// Minimal WETH: deposit() plus the ERC-20 surface the vault uses.
contract MockWETH is StandardToken {
    constructor() StandardToken("Wrapped Ether", "WETH", 0) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }
}

interface ISwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/**
 * A Uniswap v3 pool stand-in with exactly the surface LockBuybackVault touches.
 *
 * The oracle is settable so a test can pin a TWAP, and the execution price is
 * settable independently. Being able to move them apart is the whole point:
 * that gap is what a sandwich attack looks like, and invariant 3 depends on
 * reproducing it.
 */
contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee = 10000; // 1%, matching the real LOCK/WETH pool

    int24 public twapTick;        // what observe() reports
    uint256 public lockPerEthWad; // execution price, LOCK per 1 WETH, 1e18 scale
    bool public oracleReverts;    // simulate a pool with no observations (M2)
    bool public reenterOnSwap;    // try to re-enter execute() mid-swap

    address public vault;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setVault(address v) external { vault = v; }
    function setFee(uint24 f) external { fee = f; }
    function setTwapTick(int24 t) external { twapTick = t; }
    function setExecutionPrice(uint256 wad) external { lockPerEthWad = wad; }
    function setOracleReverts(bool b) external { oracleReverts = b; }
    function setReenterOnSwap(bool b) external { reenterOnSwap = b; }

    function increaseObservationCardinalityNext(uint16) external {}

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        if (oracleReverts) revert("OLD");
        tickCumulatives = new int56[](2);
        secondsPerLiquidity = new uint160[](2);
        // A constant tick over the window: cumulative grows by tick * elapsed.
        uint32 window = secondsAgos[0];
        tickCumulatives[0] = 0;
        tickCumulatives[1] = int56(twapTick) * int56(uint56(window));
    }

    /**
     * Take `amountSpecified` of the input token via the callback, pay out LOCK
     * at the configured execution price.
     */
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        address lockToken = _lockToken();
        uint256 out = (amountIn * lockPerEthWad) / 1e18;

        // Pay the recipient first, as the real pool does, then pull payment.
        StandardToken(lockToken).transfer(recipient, out);

        if (zeroForOne) { amount0 = int256(amountIn); amount1 = -int256(out); }
        else            { amount1 = int256(amountIn); amount0 = -int256(out); }

        if (reenterOnSwap) {
            (bool ok, ) = vault.call(abi.encodeWithSignature("execute()"));
            require(!ok, "reentrancy should have been blocked");
        }

        ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }

    /// Whichever side is not WETH is the LOCK side; the vault sets it up so.
    address private _lock;
    function setLockToken(address l) external { _lock = l; }
    function _lockToken() internal view returns (address) { return _lock; }
}
