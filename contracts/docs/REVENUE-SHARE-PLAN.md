# $LOCK revenue share: buyback and distribute to lockers

Plan only. Nothing here is built. Confirm before implementation.

---

## 1. How it works, in one paragraph

HoodLock charges a flat ETH fee on every lock, burn, vesting schedule and
airdrop. Half of that ETH accumulates in a **BuybackVault**. Once the balance
crosses a threshold, **anyone** can trigger it: the vault swaps its ETH for
$LOCK on the open market and hands the tokens to a **distributor**, which pays
them out to everyone who has $LOCK locked in HoodLock. Holding $LOCK earns
nothing. Locking it does.

Three properties make this worth building rather than copying:

- **The money comes from outside the holder set.** Projects that lock tokens pay
  the fee, and most of them hold no $LOCK. Nobody is paying themselves.
- **Nobody is taxed to enter or leave.** The lock is the commitment. There is no
  staking fee and no exit fee, which would contradict the one thing HoodLock
  says about itself.
- **The token's utility is the product.** "Lock your tokens and prove it" applied
  to its own token.

---

## 2. Eligibility (owner decisions, 2026-08-03)

A lock qualifies at trigger time when **all** of these hold:

| Rule | |
|---|---|
| Token is $LOCK | `0xd5BF43f29BF7Aa5bb42Ae9e217b84B86EB7a4B94` |
| Original duration ≥ 7 days | `unlockTime - lockedAt >= 604800` |
| Still locked | `unlockTime > snapshotTime` and `withdrawn == false` |
| Minimum size | see §6 |

**Time remaining does not matter.** A lock with one day left counts exactly like
one with three hundred, provided it was created for at least seven days.

**Original duration, not remaining.** Locks are extend-only in HoodLock, so a
7-day lock can grow but never shrink. Reading the original duration means
somebody cannot open a 1-day lock and extend it past the line at the last
moment.

**Front-running is accepted.** The accrued balance is public, so somebody can
watch it approach the threshold, lock a large amount, trigger the buyback
themselves and take a full share for almost no time held. Judged acceptable
because the sniper still surrenders liquidity for seven full days against a
payout they cannot predict the size of. Recorded here so nobody rediscovers it
later and calls it a bug.

---

## 3. Threshold and trigger

```
THRESHOLD   0.02 ETH        // adjustable within 0.005–0.5 ETH
MAX_AGE     30 days         // fires regardless of balance
```

`execute()` is **permissionless** and succeeds when
`pending >= THRESHOLD || now >= lastExecuted + MAX_AGE`.

Sized against live numbers:

```
pace          1.35 actions/day
to the split  0.0034 ETH/day  (~$13/day)
pool depth    1.93 WETH in the LOCK/WETH 1% pool
```

| Threshold | Fires every | % of pool per buy |
|---|---|---|
| 0.005 | 1.1 d | 0.3% |
| **0.02** | **4.2 d** | **1.0%** |
| 0.05 | 10.6 d | 2.6% |
| 0.10 | 21.2 d | 5.2% |

Lower than 0.01 and every buy still pays the pool's flat 1% fee, so frequent
dust buys mostly donate to LPs. Higher than 0.05 and each buy moves a 1.93 WETH
pool several percent, and repeated buybacks drain the WETH side so later ones
get worse.

**MAX_AGE exists so money is never stranded.** A quiet month otherwise leaves
the balance below the threshold with no way to release it. StonkBrokers' booster
has a minimum but no escape hatch; this is the one place to improve on it.

**The threshold is adjustable and the fee is not.** Changing it alters *cadence*
only. It cannot change who is entitled or how much. That distinction should be
stated in the docs, or an adjustable number will read as an admin backdoor.

---

## 4. The buyback

`execute()` does, in order:

1. Pull any withdrawable fees from the four product contracts (see §7).
2. Read the LOCK/WETH pool TWAP over a fixed window.
3. Swap the full ETH balance for $LOCK with `amountOutMinimum` derived from that
   TWAP less a bounded tolerance.
4. Transfer the $LOCK to the distributor and record the round.

**The slippage bound is not optional.** A permissionless swap of real money
through a pool holding under 2 WETH is sandwichable by anyone, including the
person who triggered it. Without a TWAP-derived minimum, `execute()` is a
standing invitation to extract value on every round. This is the single most
important security property of the contract.

Emits `BuybackExecuted(caller, ethIn, lockOut, twapMin, roundId)` so every round
is auditable and the caller is named.

---

## 5. Distribution

**Cumulative Merkle distributor.** Each round publishes a root where every
address's leaf is *everything it has ever been owed*, not that round's amount.
`claim` pays `cumulative - alreadyClaimed[addr]`.

This matters at your scale. A round of 0.02 ETH across 162 lockers is about
**$0.47 each**. Per-round claiming would cost more gas than the reward. With a
cumulative root, people claim whenever they like and receive every round since
their last claim in one transaction.

The existing `RobinhoodAirdrop` cannot do this: it tracks a claimed bitmap per
drop, so it would need a fresh airdrop and a fresh claim per round. **This is the
one genuinely new contract.**

**Trust model.** The root is set by a keeper, which is a real power, so it is
constrained by making it checkable rather than by making it trustless:

- Inputs are entirely public on-chain state (locks of $LOCK at a known block).
- The full recipient list and the block used are published per round, exactly as
  airdrop lists already are.
- Anyone can recompute the root and prove it wrong.
- Optional and worth it: a timelock between posting a root and it becoming
  claimable, so a bad root can be challenged before it pays.

---

## 6. Weighting: the one open decision

**As specified, every eligible lock earns pro-rata by amount only.** Simple, and
it means the rational behaviour is to relock for exactly seven days forever and
never commit further.

**Recommendation: weight by remaining duration as well.**

| Remaining at snapshot | Multiplier |
|---|---|
| 7 days | 1.0× |
| 30 days | 1.5× |
| 90 days | 2.0× |
| 365 days | 3.0× |

`weight = amount × multiplier`. It costs nothing, since the tree is built off
chain either way, and it converts "am I eligible" into "how committed am I",
which is the difference between a rolling 7-day farm and a locked supply.

**Minimum lock size.** `locksByToken` is appendable by anyone for the price of a
1-wei lock, and the app already notes this. Harmless on a page, an attack on a
payout. Two mitigations, both worth having:

- Build the eligible set from the **server's event index**, not the contract
  array.
- Require a minimum locked amount, so dust locks cost more gas than they can
  ever earn.

---

## 7. Where the ETH comes from

Each product contract holds its fees until `withdrawFees` is called, and each has
`setFeeCollector`. Two options:

- **Point every collector at the BuybackVault**, so withdrawals land there
  directly. Cleanest, and needs the withdraw call to be permissionless or
  performed inside `execute()`.
- **Top the vault up manually.** Simpler, but reintroduces a person in the loop,
  which is the thing this design is trying to remove.

**Verify before building:** whether fees transfer on each action or accumulate
pending a withdrawal, for all four contracts. The whole flow depends on it.

**The split is 50%** to the buyback, matching what /app/revenue already publishes. It is a constant, set once. If
it is adjustable, it is an admin power over holder entitlement, which is exactly
the thing criticised in StonkBrokers' vault.

---

## 8. Rebuilding /app/revenue

The page shipped for a different model and now contradicts this one in three
places. It is not a cosmetic pass.

**What is live today and is wrong:**

| Live copy | Problem |
|---|---|
| "dropped to holders **every Saturday**" | There is no schedule. It fires on a threshold. |
| "Eligibility: hold $LOCK at the Saturday 21:30 CET snapshot. **No locking, no staking.**" | The exact opposite of the new rule. |
| A countdown to the next drop (`rvCountdown`, `rvNextDate`) | Counting down to a moment that no longer exists. |
| The floating widget in `revenue-drop.ts`: "every single week", plus its own countdown | Same problem, on every page. |

**What replaces the countdown.** The heartbeat of the page becomes a progress
bar toward the threshold, not a clock:

```
        NEXT BUYBACK
   0.0134 / 0.02 ETH          67%
   [==============·······]
   Anyone can trigger it at 0.02 ETH
   [ Trigger buyback ]   ← disabled until the threshold, then live for everyone
```

The Trigger button is the most valuable thing on the page. It is the proof that
nobody controls the payout, and it should be visibly available to the visitor
rather than described in prose.

**Section by section:**

- **Hero** — "Lock $LOCK, earn the fees." Locking is now the whole point and the
  headline should say so.
- **Threshold card** — replaces the countdown. Pending ETH, progress, the trigger
  button, and the fallback line "or automatically after 30 days".
- **Eligibility card** — new, and needed, because the rule is no longer obvious:
  lock $LOCK for 7 days or more; any time remaining counts; unlocked balances
  earn nothing.
- **Your position** — keep, but read from locks rather than balance. Show each
  lock, its unlock date, whether it qualifies, and the wallet's share of total
  weight.
- **Round history** — replaces "Revenue drops". Per round: ETH in, $LOCK bought,
  who triggered it, the tx. This is the audit trail and it is worth more than the
  simulator.
- **Growth simulator** — already labelled "EXAMPLE PROJECTION, NOT REAL DATA".
  Once real rounds exist, replace it with them. Real small numbers beat
  impressive fake ones on a page whose entire job is trust.
- **Floating widget** — either retire it or convert it to threshold progress. A
  countdown to nothing is worse than no widget.

**Sequencing.** The page cannot ship before the contracts, because a Trigger
button with nothing behind it is a broken promise. But the copy that is wrong
today is wrong today: "no locking, no staking" is live on a page describing a
model that requires locking. Correcting that line is worth doing immediately,
independently of everything else here.

---

## 9. What to build

| | |
|---|---|
| Reused unchanged | `RobinhoodLocker` as the eligibility source; the LOCK/WETH v3 pool |
| **New** | `LockBuybackVault` — accrues ETH, permissionless `execute()`, TWAP-bounded swap |
| **New** | `CumulativeDistributor` — Merkle roots, claim-on-demand |
| Server | Snapshot job, Merkle build, published round lists, `/api/revenue` |
| Web | Rebuild `/app/revenue` per §8, and retire or convert the countdown widget in `revenue-drop.ts` |

**Order:**

1. Threat model for both contracts, as the airdrop contract got.
2. `CumulativeDistributor` plus Foundry suite. Testable in isolation.
3. `LockBuybackVault` plus suite, including a sandwich attempt against the TWAP
   bound and a `MAX_AGE` release with the balance under threshold.
4. Deploy, verify, point one fee collector at it and watch a single real round.
5. Point the remaining collectors at it.
6. Rebuild `/app/revenue` (§8).

**Do first, independently of all of the above:** `/app/revenue` currently states
"No locking, no staking" and promises a Saturday drop. Both are wrong under the
agreed model and both are live now.

---

## 10. Honest economics

```
lifetime revenue      0.175 ETH   (~$665)
50% to the split      0.0875 ETH  (~$333)
$LOCK holders         162
locked in HoodLock    47,165,311 LOCK
pool depth            1.93 WETH
implied mcap          ~$30,000
```

**A 0.02 ETH round pays roughly $0.47 per locker.** That is real and it is
honest, and it is not income. The reason to lock is a claim on a growing revenue
stream and a permanent bid under the token, not this week's payout.

Say that plainly wherever this is announced. Somebody will divide the round size
by the locker count in public within a day, and it is far better if you said it
first.

**What actually moves this number is more locks**, not a better fee mechanism.
At 100 actions a day rather than 1.35, a round is ~$35 per locker per week and
the design works exactly as written with no changes.

---

## 11. Open questions

1. **Flat or duration-weighted?** Recommendation §6: weighted.
2. **Minimum lock size to qualify?** Suggest an amount worth clearly more than
   the gas to claim.
3. ~~Split between buyback and treasury?~~ **Settled: 50%**, matching /app/revenue.
4. **Timelock on new Merkle roots, yes or no?** Costs a delay, buys the ability
   to challenge a bad root before it pays.
5. **Snapshot at the trigger block, or at a fixed time before it?** Trigger block
   is simplest and the front-run is already accepted.
