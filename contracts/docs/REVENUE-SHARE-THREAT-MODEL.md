# $LOCK revenue share, pre-implementation threat model

Audit of the design in `REVENUE-SHARE-PLAN.md` before any code is written.
Findings here are **binding on the implementation**.

Same method as `AIRDROP-THREAT-MODEL.md`: assume every actor is hostile, assume
every external contract is hostile, and assume the admin key is eventually
stolen. A finding is only closed when a specific mechanism closes it.

---

## Spec under audit

Two new contracts:

- **`LockBuybackVault`** — accumulates ETH, and on a permissionless `execute()`
  swaps it for $LOCK and forwards the tokens to the distributor.
- **`LockDistributor`** — cumulative Merkle distributor. A keeper posts a root,
  holders claim `cumulative - alreadyClaimed`.

## Existing system this must survive contact with

Read off chain, not assumed:

| | |
|---|---|
| `RevenueSplitter` | `0xf3B5643F6db0c7e728C341C97d3dC8a42FBc21D3`, live, fee collector for all four products |
| its `team` / `ops` | `0x79c1230cAb…` / `0xa270E382f5…`, both EOAs, both **immutable** |
| `RobinhoodLocker.lock()` | `feeCollector.call{value: fee}` inline, and **`require(okFee)`** |
| `$LOCK` | `0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94` |
| LOCK/WETH pool | `0x4562cA679DcCc38f2dd59d28B2eBFEC99f507AF2`, 1% tier, **1.93 WETH** |

**The splitter's payees cannot be changed.** Routing revenue to the vault means
deploying a second splitter with `ops = vault` and calling `setFeeCollector` on
the four products. There is no way to retarget the deployed one.

## Actors and trust

| Actor | Trusted with |
|---|---|
| Anyone | Calling `execute()` and `claim()`. Assumed hostile and profit-seeking. |
| Root keeper | Correctness of the recipient list. **Not** trusted with custody. |
| Admin | The threshold, within bounds. Nothing else. |
| Uniswap pool | Nothing. Assumed manipulable. |

---

## Findings

### CRITICAL

**C1 — A hostile root drains the distributor.**
The keeper posts Merkle roots. A stolen key posts a root paying itself the whole
balance. Publishing the inputs does not prevent it; it only means people find out
afterwards.

*Binding:* the contract tracks `totalObligations`. `setRoot(root, newTotal)`
requires `newTotal >= totalObligations` and `newTotal - totalObligations <=
tokensDepositedSinceLastRoot`. A round can therefore only distribute what that
round actually brought in. A stolen key can misallocate one round's buyback; it
can never touch the accumulated balance of unclaimed earlier rounds.

**C2 — `execute()` is sandwichable by whoever calls it.**
A permissionless swap through a pool holding under 2 WETH. The caller front-runs
their own trigger, sells into the buy, and pockets the difference.

*Binding:* `amountOutMinimum` derived from the pool's TWAP over
`twapWindow >= 30 minutes`, less `maxSlippageBps` (default 300, hard cap 1000).
A swap that cannot meet it reverts. Never accept the spot price.

**C3 — The TWAP itself is manipulable on a 1.93 WETH pool.**
C2's mitigation leans on the TWAP, and a whale can push a pool this thin for a
whole window if the prize is big enough.

*Binding:* cap the ETH spent per round, `maxEthPerRound`, default 0.25 ETH.
The attacker's cost is moving a pool for 30 minutes; the prize is bounded by one
round. Rounds are cheap to repeat, so a cap costs nothing and removes the
incentive entirely. Excess ETH simply waits for the next round.

**C4 — The Uniswap V3 swap callback is a public function.**
`uniswapV3SwapCallback` is called by the pool mid-swap and instructs the vault to
pay. If anyone can call it, anyone can instruct the vault to pay them.

*Binding:* `require(msg.sender == address(pool))` as the first statement, plus a
transient flag proving a swap is genuinely in progress. Both, not either.

### HIGH

**H1 — An admin redirects the buyback output.**
If `distributor` is settable, the admin points it at themselves and every
subsequent round pays them.

*Binding:* `distributor` and `pool` are `immutable`. Changing either means
deploying a new vault, which is visible and requires re-pointing the splitter.

**H2 — A lower cumulative locks a claimant out permanently.**
`payout = cumulative - claimed[addr]`. If a later root gives an address a
*smaller* cumulative than it has already claimed, the subtraction underflows and
reverts. That address can never claim again, even from correct future roots.

*Binding:* `if (cumulative <= claimed[addr]) revert NothingToClaim();` so it is a
clean no-op rather than a permanent lockout. The off-chain builder must also
never decrease a cumulative, and the test suite proves the contract survives it
if it does.

**H3 — The vault's `receive()` can brick fee release.**
`RevenueSplitter.release()` does `ops.call{value:}` and **requires success**. If
the vault's `receive()` reverts or runs out of gas, `release()` reverts and all
revenue stalls.

*Binding:* `receive() external payable {}` — empty, no logic, no events, no
accounting. Balance is read from `address(this).balance` when needed.

Note the blast radius is limited: locking pushes to the *splitter*, whose
`receive()` is already empty, so a broken vault cannot break locking itself.

**H4 — A dead pool strands the ETH forever.**
If liquidity is pulled, every `execute()` reverts and `MAX_AGE` cannot help,
because the failure is the swap, not the timing.

*Accepted, deliberately.* The alternative is an admin drain function, which is a
custody hole permanently open to protect against a scenario that has never
happened. ETH waits in the vault until the pool works. Documented, not fixed.

### MEDIUM

**M1 — An admin sets the threshold absurdly high to delay payouts.**
*Binding:* bounded to `[0.005, 0.5] ETH`, and `MAX_AGE` (30 days) fires
regardless of balance, so delay is capped at 30 days whatever the admin does.

**M2 — No TWAP history on the first call.**
A young pool, or one whose oracle cardinality was never increased, cannot answer
a 30-minute observation.

*Binding:* call `increaseObservationCardinalityNext` at deploy, and revert with a
clear `TwapUnavailable()` rather than silently falling back to spot. **A fallback
to spot would re-open C2 in the exact moment the protection is needed most.**

**M3 — Reentrancy on `claim` via the token.**
$LOCK is a standard ERC-20 today, but the distributor should not depend on that.
*Binding:* `nonReentrant`, checks-effects-interactions, `claimed[addr]` written
before the transfer.

**M4 — Rounding dust accumulates unclaimably.**
Integer division across ~160 recipients leaves wei behind each round.
*Binding:* dust simply stays and is included in the next round's distributable
amount. No sweep function, because a sweep is an admin withdrawal by another
name.

**M5 — `execute()` griefing by triggering at a bad moment.**
Someone triggers when the price is unfavourable. *Mitigated by C2:* the TWAP
bound means a bad fill reverts rather than executing. The worst a griefer
achieves is a failed transaction at their own expense.

### ACCEPTED RISKS (deliberate, owner-approved)

**A1 — Snapshot front-running.** The pending balance is public; somebody can lock
just before the threshold, trigger, and take a full share. Owner decision
2026-08-03. The sniper still gives up liquidity for seven days against an
unpredictable payout.

**A2 — The keeper decides who is owed what.** Constrained by C1 to one round's
worth, and by publishing the full input list and snapshot block so anyone can
recompute the root and prove it wrong. Not eliminated.

**A3 — No timelock on roots in v1.** Adds delay for a risk already bounded by C1.
Revisit if round sizes grow by orders of magnitude.

---

## Invariants the Foundry suite must prove

1. `execute()` reverts below the threshold and before `MAX_AGE`.
2. `execute()` succeeds at exactly the threshold, and after `MAX_AGE` with any
   non-zero balance.
3. `execute()` reverts when the pool price is worse than the TWAP bound.
4. `execute()` never spends more than `maxEthPerRound` in one call.
5. `uniswapV3SwapCallback` reverts for every caller except the pool.
6. `uniswapV3SwapCallback` reverts when no swap is in progress, even from the pool.
7. `setRoot` reverts when the increase in obligations exceeds tokens deposited
   since the previous root.
8. `setRoot` reverts when total obligations decrease.
9. A claimant receives exactly `cumulative - previouslyClaimed`, never more.
10. Claiming twice against the same root pays nothing the second time.
11. A forged proof reverts.
12. A decreased cumulative is a clean no-op, not a permanent lockout (H2).
13. A reentrant token cannot claim twice.
14. No function on either contract can send ETH or $LOCK to an admin.
15. `receive()` accepts ETH from an account supplying minimal gas and never
    reverts (H3).
16. Threshold cannot be set outside `[0.005, 0.5] ETH`.
17. Invariant run: distributor $LOCK balance always covers
    `totalObligations - totalClaimed`.

---

## Post-implementation audit (2026-08-03)

Contracts written to the findings above. `forge test`: **105 passed, 0 failed**
across the whole repo, 29 of them this suite. No regressions in the locker,
burner, vesting, airdrop or splitter suites.

**One finding came out of writing the tests, and it was in the tests.**

`test_execute_revertsWhenPriceWorseThanTwapBound` passed the swap when it should
have reverted. The contract was correct; the harness was not. The mock's oracle
tick was 0 (a 1:1 raw ratio) while its execution price paid 100:1, so the
TWAP-derived `minOut` was always ~100x below anything the pool would return and
**the bound could never bind**. Invariant 3, the one closing C2, was silently
asserting nothing.

Fixed by tying the mock's execution price to the same tick the oracle reports,
so "worse than TWAP" is now expressible. The test then failed for the right
reason and passes for the right reason.

Worth recording because it is the characteristic failure of a mock-based suite:
a green test that exercises nothing. Any future mock added here should be checked
for the same class of error before its result is trusted.

### Coverage of the seventeen invariants

| # | Test |
|---|---|
| 1 | `test_execute_revertsBelowThreshold` |
| 2 | `test_execute_succeedsAtExactThreshold`, `test_execute_succeedsAfterMaxAgeWithDust` |
| 3 | `test_execute_revertsWhenPriceWorseThanTwapBound`, `test_execute_acceptsFillWithinSlippageTolerance` |
| 4 | `test_execute_capsSpendPerRound` |
| 5 | `test_callback_revertsForNonPool` |
| 6 | `test_callback_revertsWhenNoSwapInFlight` |
| 7 | `test_setRoot_revertsWhenUnfunded` |
| 8 | `test_setRoot_revertsOnDecrease` |
| 9 | `test_claim_paysExactly`, `test_claim_cumulativeAcrossRounds` |
| 10 | `test_claim_secondTimeSameRootPaysNothing` |
| 11 | `test_claim_forgedProofReverts` |
| 12 | `test_claim_loweredCumulativeIsCleanNoop` |
| 13 | `test_execute_blocksReentrancy` |
| 14 | `test_noAdminPathToFunds`, `test_noAdminPathToTokens` |
| 15 | `test_receive_neverRevertsOnMinimalGas` |
| 16 | `test_thresholdBounded`, `test_slippageBounded`, `test_twapWindowCannotGoBelowMinimum` |
| 17 | `test_solvency_balanceAlwaysCoversOutstanding` |

### Not yet done

- **Not deployed.** No addresses, nothing live.
- **Fork test against the real pool.** The mock cannot reproduce concentrated
  liquidity or real tick spacing. Before deploying, `execute()` should be run
  against a fork of chain 4663 with the actual 1.93 WETH pool.
- **The keeper's off-chain root builder** is unwritten. C1 bounds the damage a
  bad root can do, but the builder still has to compute eligibility correctly
  from the locker's event index.
- **A second splitter** must be deployed with `ops = vault`, since the live one's
  payees are immutable, followed by `setFeeCollector` on all four products.
