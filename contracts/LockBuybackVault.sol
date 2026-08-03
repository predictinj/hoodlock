// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * LockBuybackVault — turns HoodLock's ETH revenue into $LOCK for lockers.
 *
 * ETH arrives from the RevenueSplitter. Once the balance reaches a threshold,
 * ANYONE may call execute(): the vault swaps ETH for $LOCK through the Uniswap
 * v3 pool and sends the tokens to the distributor. Nobody schedules it, nobody
 * can withhold it, and the caller chooses only WHEN, never how much or to whom.
 *
 * Threat model: contracts/docs/REVENUE-SHARE-THREAT-MODEL.md
 *
 *  - C2  The swap is bounded by the pool's TWAP, never the spot price. A
 *        permissionless swap priced at spot through a pool this thin is an
 *        invitation for the caller to sandwich their own trigger.
 *  - C3  maxEthPerRound caps a single round. The TWAP itself is movable on a
 *        ~2 WETH pool, so the prize for moving it is bounded to one round while
 *        the cost is holding a pool off-market for the whole window.
 *  - C4  The Uniswap callback checks BOTH that the caller is the pool and that
 *        a swap is genuinely in flight. Either alone is insufficient.
 *  - H1  distributor and pool are immutable. Redirecting the output means
 *        deploying a new vault, which is visible on chain.
 *  - H3  receive() is empty. RevenueSplitter.release() requires its send to
 *        succeed, so any logic here could stall all revenue.
 *  - H4  If the pool dies, ETH waits. There is deliberately no admin drain: a
 *        permanent custody hole is worse than an unlikely stall.
 *  - M2  No TWAP history reverts. It never falls back to spot, because that
 *        would remove C2's protection at exactly the moment it is needed.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract LockBuybackVault {
    /* ---------------- immutable wiring (H1) ---------------- */

    IUniswapV3Pool public immutable pool;
    IWETH9 public immutable weth;
    IERC20 public immutable lock;
    address public immutable distributor;
    bool public immutable lockIsToken0;

    /* ---------------- bounded configuration ---------------- */

    uint256 public constant MIN_THRESHOLD = 0.005 ether;
    uint256 public constant MAX_THRESHOLD = 0.5 ether;
    uint256 public constant MAX_AGE = 30 days;
    uint32  public constant MIN_TWAP_WINDOW = 30 minutes;
    uint16  public constant MAX_SLIPPAGE_BPS = 1000; // 10%, hard ceiling

    uint256 public threshold = 0.02 ether;
    uint256 public maxEthPerRound = 0.25 ether;
    uint16  public maxSlippageBps = 300;
    uint32  public twapWindow = 30 minutes;

    address public admin;
    address public pendingAdmin;

    uint64  public lastExecuted;
    uint256 public roundId;
    uint256 public totalEthSpent;
    uint256 public totalLockBought;

    /* ---------------- swap state ---------------- */

    uint256 private _swapping; // 1 = idle, 2 = a swap this contract started
    uint256 private _entered = 1;

    error NotAdmin();
    error ZeroAddress();
    error Reentrant();
    error NotReady(uint256 balance, uint256 need, uint64 readyAt);
    error NothingToSpend();
    error TwapUnavailable();
    error SlippageTooHigh(uint256 got, uint256 min);
    error NotPool();
    error NoSwapInFlight();
    error OutOfBounds();
    error TransferFailed();

    event BuybackExecuted(
        address indexed caller,
        uint256 indexed roundId,
        uint256 ethIn,
        uint256 lockOut,
        uint256 minOut
    );
    event ThresholdChanged(uint256 threshold);
    event MaxEthPerRoundChanged(uint256 maxEth);
    event SlippageChanged(uint16 bps);
    event TwapWindowChanged(uint32 window);
    event AdminTransferStarted(address indexed to);
    event AdminChanged(address indexed admin);

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address pool_, address weth_, address lock_, address distributor_, address admin_) {
        if (pool_ == address(0) || weth_ == address(0) || lock_ == address(0)
            || distributor_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        pool = IUniswapV3Pool(pool_);
        weth = IWETH9(weth_);
        lock = IERC20(lock_);
        distributor = distributor_;
        admin = admin_;
        lockIsToken0 = IUniswapV3Pool(pool_).token0() == lock_;
        lastExecuted = uint64(block.timestamp);
    }

    /// H3: empty on purpose. The splitter requires its send to succeed.
    receive() external payable {}

    /* ---------------- the only thing that moves money ---------------- */

    function pending() public view returns (uint256) {
        return address(this).balance;
    }

    function readyAt() public view returns (uint64) {
        return lastExecuted + uint64(MAX_AGE);
    }

    function canExecute() public view returns (bool) {
        uint256 bal = address(this).balance;
        if (bal == 0) return false;
        return bal >= threshold || block.timestamp >= readyAt();
    }

    /**
     * Swap up to maxEthPerRound of the balance for $LOCK and send it onward.
     *
     * Permissionless. The caller picks the moment; every other term is fixed by
     * the contract. Anything above maxEthPerRound stays for the next round (C3).
     */
    function execute() external nonReentrant returns (uint256 lockOut) {
        uint256 bal = address(this).balance;
        bool ready = bal >= threshold || block.timestamp >= readyAt();
        if (!ready || bal == 0) revert NotReady(bal, threshold, readyAt());

        uint256 spend = bal > maxEthPerRound ? maxEthPerRound : bal;
        if (spend == 0) revert NothingToSpend();

        uint256 minOut = _minOutForEth(spend);

        weth.deposit{value: spend}();

        // WETH -> LOCK. zeroForOne is true when we are selling token0.
        bool zeroForOne = !lockIsToken0;
        uint160 limit = zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341;

        _swapping = 2;
        (int256 amount0, int256 amount1) =
            pool.swap(address(this), zeroForOne, int256(spend), limit, bytes(""));
        _swapping = 1;

        // The LOCK side comes back negative: the pool paid it out.
        int256 lockDelta = lockIsToken0 ? amount0 : amount1;
        lockOut = uint256(-lockDelta);
        if (lockOut < minOut) revert SlippageTooHigh(lockOut, minOut);

        lastExecuted = uint64(block.timestamp);
        unchecked { roundId += 1; }
        totalEthSpent += spend;
        totalLockBought += lockOut;

        if (!lock.transfer(distributor, lockOut)) revert TransferFailed();
        emit BuybackExecuted(msg.sender, roundId, spend, lockOut, minOut);
    }

    /**
     * C4: the pool is the only permitted caller, AND a swap must be in flight.
     * The pool check alone is not enough, because a pool can be made to call
     * arbitrary data; the flag alone is not enough, because it is only set
     * during our own call.
     */
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != address(pool)) revert NotPool();
        if (_swapping != 2) revert NoSwapInFlight();

        // Pay whichever side we owe. Positive delta = the pool wants it.
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (!weth.transfer(msg.sender, owed)) revert TransferFailed();
    }

    /* ---------------- pricing ---------------- */

    /// Minimum $LOCK for `ethAmount`, from the TWAP less maxSlippageBps (C2).
    function _minOutForEth(uint256 ethAmount) internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;

        try pool.observe(ago) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int24 avgTick = int24(delta / int56(uint56(twapWindow)));
            // Round toward negative infinity, as Uniswap's own oracle library does.
            if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) avgTick--;

            uint256 quoted = _quoteFromTick(avgTick, ethAmount);
            return (quoted * (10_000 - maxSlippageBps)) / 10_000;
        } catch {
            // M2: never fall back to spot. That would remove the protection.
            revert TwapUnavailable();
        }
    }

    /// How much $LOCK `ethAmount` of WETH buys at `tick`, ignoring fees.
    function _quoteFromTick(int24 tick, uint256 ethAmount) internal view returns (uint256) {
        uint160 sqrtP = _sqrtRatioAtTick(tick);
        // priceX192 = (sqrtP)^2 = token1 per token0, Q192.
        uint256 priceX192 = uint256(sqrtP) * uint256(sqrtP);
        if (lockIsToken0) {
            // LOCK is token0, WETH is token1: LOCK = weth * 2^192 / priceX192
            return _mulDiv(ethAmount, 1 << 192, priceX192);
        } else {
            // LOCK is token1: LOCK = weth * priceX192 / 2^192
            return _mulDiv(ethAmount, priceX192, 1 << 192);
        }
    }

    /* ---------------- admin: cadence and tolerance only ---------------- */

    function setThreshold(uint256 t) external {
        if (msg.sender != admin) revert NotAdmin();
        if (t < MIN_THRESHOLD || t > MAX_THRESHOLD) revert OutOfBounds();
        threshold = t;
        emit ThresholdChanged(t);
    }

    function setMaxEthPerRound(uint256 m) external {
        if (msg.sender != admin) revert NotAdmin();
        if (m < MIN_THRESHOLD || m > MAX_THRESHOLD) revert OutOfBounds();
        maxEthPerRound = m;
        emit MaxEthPerRoundChanged(m);
    }

    function setMaxSlippageBps(uint16 bps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bps > MAX_SLIPPAGE_BPS) revert OutOfBounds();
        maxSlippageBps = bps;
        emit SlippageChanged(bps);
    }

    function setTwapWindow(uint32 w) external {
        if (msg.sender != admin) revert NotAdmin();
        if (w < MIN_TWAP_WINDOW) revert OutOfBounds();
        twapWindow = w;
        emit TwapWindowChanged(w);
    }

    /// Anyone may deepen the oracle. It only ever helps (M2).
    function primeOracle(uint16 cardinality) external {
        pool.increaseObservationCardinalityNext(cardinality);
    }

    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminChanged(msg.sender);
    }

    /* ---------------- math (ported from Uniswap, unchanged semantics) ------ */

    function _mulDiv(uint256 a, uint256 b, uint256 denom) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denom > 0, "denom");
                return prod0 / denom;
            }
            require(denom > prod1, "overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denom)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denom & (~denom + 1);
            assembly {
                denom := div(denom, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denom) ^ 2;
            inv *= 2 - denom * inv;
            inv *= 2 - denom * inv;
            inv *= 2 - denom * inv;
            inv *= 2 - denom * inv;
            inv *= 2 - denom * inv;
            inv *= 2 - denom * inv;
            result = prod0 * inv;
        }
    }

    function _sqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= 887272, "T");
            uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
