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

---

## C1 re-audit (2026-08-03, same day)

**The first implementation of C1 did not close it, and the suite did not catch
that because no test attacked it.** Written down in full because the reasoning
error is more useful than the fix.

The mitigation as first stated bounded the *increase* in total obligations. The
code went further and enforced solvency: a root can never promise more than the
contract holds. Both are true statements about inflation. Neither says anything
about **reallocation**, and reallocation does not change the total.

A probe proved it in one test: with alice and bob each owed 100 and nothing yet
claimed, a stolen keeper key posted a root paying itself 200 and alice 0. Total
obligations unchanged, balance still covering them, check passed, attacker took
the entire pot.

```
attacker took: 200000000000000000000
```

**No accounting rule can close this.** Whoever sets the root decides the
allocation; that is the job. What closes it is time.

*Now binding:* `setRoot` only proposes. `activateRoot()` promotes it after
`ROOT_DELAY`, is permissionless, and cannot be rushed. **The previous
root keeps paying for the whole window**, so every honest holder can claim what
they are owed before any new root pays anyone. A stolen key can at worst take
what nobody claimed in two days, and the proposal is a public event the moment
it is made.

`ROOT_DELAY` is a constant, not a setting. A keeper able to shorten it could
bypass the only thing standing between them and the pot.

This also reverses **A3**, which listed "no timelock in v1" as an accepted risk
on the grounds that C1 was already bounded. It was not. The timelock is not a
nice-to-have here; it is the mitigation.

Regression test: `test_C1_hostileRootCannotStealUnclaimed` asserts the attack
fails, that it cannot be rushed, that honest holders still get paid during the
window, and that the attacker ends with zero. Suite now 31 tests, 107 repo-wide.

---

## Reality check against the live pool (2026-08-03)

Asked what a fork test would add, I queried the real pool instead of speculating.
Three findings, one of them deployment-blocking.

```
pool   0x4562cA679DcCc38f2dd59d28B2eBFEC99f507AF2
token0 WETH   ->  lockIsToken0 = FALSE
token1 LOCK
fee    1%
observationCardinality 1
  observe(60s)   OK
  observe(1800s) REVERTS
```

**B1 — BLOCKING. The oracle cannot answer a 30-minute TWAP.**
`observationCardinality` is 1, so `observe([1800, 0])` reverts. M2 makes the
vault revert rather than fall back to spot, which is correct, and the
consequence is that **every `execute()` would fail from the moment of
deployment**. The contract would be inert.

Not a code fix. Before deploying: call `primeOracle()` (permissionless, already
on the vault) to raise cardinality, then **wait for the pool to actually record
observations**, which only happens when somebody swaps. Cardinality is capacity,
not history. `observe(1800)` must be confirmed working on chain before the vault
is given a single wei.

**B2 — The mock tested the mirror image of production.**
The fixture had LOCK as token0; the real pool has WETH as token0. That inverts
both `zeroForOne` and the branch taken in `_quoteFromTick`, so the path that will
actually run in production had no coverage at all. Added
`test_realTokenOrdering_wethIsToken0`, which builds the fixture in the real
ordering and asserts `lockIsToken0 == false` before exercising it.

**B3 — The 1% pool fee sat outside the slippage bound.**
`_quoteFromTick` returned the raw TWAP quote, but the pool takes 1% before the
output is seen. The bound was therefore unreachable by construction and honest
swaps would have reverted, while `maxSlippageBps = 300` really meant 200 bps of
tolerance for genuine price movement. The fee is now read from the pool at
construction and subtracted before the tolerance, so the setting means what it
says. Covered by `test_poolFeeIsInsideTheSlippageBound`.

Suite now 33 tests, 109 repo-wide.

**Still required before deployment:** a real fork test. B1, B2 and B3 were all
reachable by reading the pool, but concentrated liquidity means the fill for a
given size cannot be predicted from a mock at all, and that is the one thing
only a fork can answer.

---

## Second test pass (2026-08-03)

Two gaps big enough to hide real bugs:

**Every price test ran at tick 0**, where the maths is trivially 1:1 and
`_quoteFromTick` is barely exercised. The live pool sits at **tick 186569**.
`test_quoteAtRealPoolTick` now runs at that tick in the real token ordering and
asserts the quote lands within 2% of **125,606,197 LOCK per WETH**, the price
measured independently off the pool. It passes, which is the first evidence the
tick maths is right at production magnitude rather than merely at the identity.

**Every Merkle tree was two leaves**, so `_verify`'s loop ran exactly once. A
real round is ~162 lockers, depth 8. `test_deepMerkleTree_eightLeaves` builds
three levels by hand, claims from an interior leaf with a depth-3 proof, and
asserts a sibling's proof fails for a different leaf.

Also added: negative-tick pricing, consecutive rounds, keeper rotation, the
two-step admin handover, and two fuzz properties (claims never exceed the
cumulative; the threshold is always inside its bounds).

### A grief worth recording, not fixing

`test_keeperCanResetPendingDelay_documentedGrief` — a keeper can re-propose a
root before the previous proposal matures, restarting `ROOT_DELAY` each time.
Repeated indefinitely this blocks **all** distributions.

It is a denial of service, not a theft: nothing already claimed is at risk, and
the vault keeps buying $LOCK regardless. Fixing it means either allowing a
proposal to mature despite being superseded (which lets a stolen key queue an
attack the keeper cannot cancel) or restricting re-proposals (which stops an
honest keeper correcting a mistake). Both cures are worse. Recorded so the
behaviour is known rather than discovered.

### All three failures on this pass were in the tests

- The negative-tick test priced the mock at 1e14 when tick -100000 implies
  ~22,026 LOCK per WETH. The contract demanded 4.228e20 and was **right**; the
  failure confirmed the maths rather than contradicting it.
- A fuzz run picked an amount larger than the fixture's balance, testing the
  fixture rather than the invariant. Now bounded.
- `testFuzz_thresholdAlwaysWithinBounds` read `vault.MIN_THRESHOLD()` after
  `vm.prank`, and that view call **consumed the prank**, so `setThreshold`
  arrived from the test contract and reverted `NotAdmin` instead of
  `OutOfBounds`. Constants are now read before pranking.

That last one is worth remembering generally: any call between `vm.prank` and
the call under test silently redirects the sender.

Suite now **42 tests**, 118 repo-wide.

---

## ROOT_DELAY set to 1 hour (owner decision, 2026-08-03)

Was 48 hours. Now 1.

**What the delay buys** is the window in which a hostile root cannot pay anyone
while the honest one still can. At 48 hours that window covered ordinary humans
noticing and claiming. At 1 hour it realistically covers **a monitor, not a
person**: almost nobody claims within an hour of a proposal they never saw.

**Why it is still reasonable today.** The whole pot is a few hundred dollars and
a round pays ~$0.47 per locker. The maximum loss from a stolen keeper key is
whatever is unclaimed after one hour, and one hour of exposure on that sum is a
sensible price for rewards arriving the same day rather than two days later.

**When it stops being reasonable.** If the pot grows by orders of magnitude, an
hour is not long enough for anyone to react and C1's mitigation becomes largely
nominal. `ROOT_DELAY` is a constant, so revisiting it means **redeploying the
distributor** and migrating unclaimed balances. That is the cost of the
protection it provides: a keeper who could shorten the delay could bypass the
only thing between them and the funds.

**Worth pairing with this:** an alert on the `RootProposed` event. It fires the
moment a root is proposed and carries the new total. With a one-hour window, an
alert is what converts the delay from a formality into an actual defence.

---

## C1 third pass: the window had nothing in it (2026-08-03)

Asked to explain in plain terms what the delay protects against, the
explanation exposed the hole.

**The threat, stated simply.** Somebody has to compute who is owed what, because
lock history and duration weighting cannot be derived on chain. A keeper server
does it and publishes a fingerprint. The contract cannot distinguish a correct
list from a fabricated one: both are a 32-byte hash. A stolen keeper key
therefore publishes "everything to me" and the contract has no basis to object.

**What the delay was supposed to buy** was time to respond.

**What you could actually do in that time: nothing.** There was no cancel, and
`setKeeper` does not disarm an already-proposed root, because `activateRoot()`
only checks the clock. Rotating a compromised keeper left its proposal armed and
ticking. The window existed with no action available inside it.

*Now binding:* `cancelPendingRoot()`, admin only, clears a proposal before it
activates.

Safe to hand the admin because it can only **prevent** a change. No path on this
contract moves tokens to an admin, and a veto never creates an obligation, so a
hostile admin can stall distributions and nothing else. A hostile keeper could
already stall by re-proposing, so this grants no new power over funds.

The correct incident response is now: **veto, then rotate.** In that order,
because rotation alone leaves the proposal live.

Tests: `test_adminCanVetoAHostileRoot` (asserts explicitly that rotation alone
leaves it armed, then that the veto disarms it and honest holders still get
paid), `test_onlyAdminCanVeto`, `test_vetoCannotCreateOrMoveFunds`.

Suite 45, repo 121.
