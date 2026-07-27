# RobinhoodVesting — pre-implementation threat model

Date: 2026-07-27. Status: design audit completed BEFORE implementation. Every
requirement below is binding on the implementation; the Foundry test suite must
prove the invariants at the bottom.

## Spec under audit

- Standalone, non-upgradeable contract next to RobinhoodLocker v1 / RobinhoodBurner.
- `Schedule { creator, beneficiary, token, total, claimed, start, cliff, end }`
- `create(token, beneficiary, amount, start, cliff, end)` payable (flat ETH fee),
  `createMany` batch, `claim(id)`, `claimable(id)` view,
  `transferBeneficiary(id, newAddr)`.
- Linear vesting: `vested(t) = total · (t − start) / (end − start)`, gated at
  `cliff`, `claimable = vested(now) − claimed`.
- Non-revocable. No admin path to tokens. Admin: `setFee` (≤ hard cap),
  `setFeeCollector`, admin transfer. Fee charged at create only.
- `start ≤ now` allowed (TGE backdating). Indexes byToken/byBeneficiary/byCreator.

## Actors & trust

| Actor | May | Must never |
|---|---|---|
| Creator | create + fund | touch anything after create |
| Beneficiary | claim vested, change own address | claim early, touch others |
| Admin | fee (≤ cap), collector, admin | reach locked tokens, alter existing schedules |
| Token contract | — | (uncontrollable — largest risk surface) |

## Findings

### CRITICAL

- **K1 Curve overflow bricks claims.** `total · elapsed` reverts under 0.8
  checked math for supplies ≈1e70+ → funds stuck forever.
  **Req:** `require(amount ≤ type(uint128).max)` at create.
- **K2 Final claim must bypass the curve.** Integer division leaves wei dust
  each claim; with no sweep (by design) dust is stuck forever.
  **Req:** `if (block.timestamp ≥ end) claimable = total − claimed`.
- **K3 Do NOT reuse locker v1's raw `require(transfer(...))`.** Reverts on
  no-return-value tokens (USDT pattern). **Req:** safe-transfer via low-level
  call accepting empty returndata, for both transferFrom (create) and
  transfer (claim).
- **K4 CEI + shared reentrancy guard.** `claimed += x` BEFORE transfer; one
  `nonReentrant` across create/createMany/claim/transferBeneficiary. Vector:
  hooked tokens re-entering during create's balance-delta measurement.

### HIGH

- **H1 Pooled per-token balances bound the guarantee.** All schedules of one
  token share the contract's balance; a token that rebases down / owner-burns /
  blacklists the contract makes THOSE schedules unpayable. Isolation holds per
  token. **Req:** document openly; UI proof page surfaces GoPlus token risk
  flags; rebasing tokens unsupported.
- **H2 Fees accrue-and-pull, never push.** (HoodMarket L-2 lesson: reverting
  collector must not brick create.) **Req:** fees accumulate in contract,
  `withdrawFees()` by collector; no `receive()`; `msg.value == fee × n` exact
  (SweepBuyer L-1 lesson: stray ETH reverts).
- **H3 Optics attack — fake vesting for the trust badge.** 1-hour schedule or
  fully backdated start shows "vested ✓" while effectively liquid.
  **Req contract:** `require(end > block.timestamp + 24 hours)`.
  **Req UI/proof:** always show remaining duration AND "% already vested at
  creation".

### MEDIUM

- **M1** Two-step admin transfer (Ownable2Step pattern) — v1's single-step
  `setAdmin` can brick administration on a typo.
- **M2** `transferBeneficiary`: only current beneficiary, non-zero target,
  event with old+new. Old address claiming already-vested before transfer
  lands is correct behavior, not a bug.
- **M3** Guards: `end > start`, `start ≤ cliff ≤ end`, `amount > 0`.
- **M4** Events designed for indexers/GoPlus `locked_detail`:
  `VestingCreated(id, creator, beneficiary, token, total, start, cliff, end)`,
  `Claimed(id, beneficiary, amount)`, `BeneficiaryTransferred(id, old, new)`.
- **M5** Fee cap: `MAX_FEE` immutable constant (0.05 ETH); `setFee` bounded by
  it so a compromised admin key cannot set absurd fees.

### ACCEPTED RISKS (documented, deliberate)

- Fee-on-transfer on claim: beneficiary receives less than deducted; contract
  accounts the deducted amount (cannot control token behavior).
- Beneficiary-transfer enables OTC sale of positions — owner decision.
- No upgrade path: bugs are unfixable; mitigated by this pre-audit + invariant
  tests as a deploy gate.

## Final-pass addendum (2026-07-27, pre-build)

- **F-1 HIGH — codeless token address defeats safe-transfer.** A low-level call
  to an address with no code succeeds with empty returndata, so the K3 pattern
  alone would treat it as success. **Req:** `require(token.code.length > 0)` at
  create. (The balance-delta measurement would also revert via `balanceOf`, but
  the guarantee must be explicit, not incidental.)
- **F-2 MED — createMany bounds:** equal array lengths, `1 ≤ n ≤ 200`,
  `msg.value == n × fee` exact.
- **F-3 LOW — `claim` with zero claimable reverts** ("nothing to claim").
- **F-4 INFO — `cliff == end` degenerates to a pure cliff-lock.** Allowed by
  design: vesting becomes a superset of locking.
- **F-5 INFO — beneficiary index staleness:** `byBeneficiary` arrays are
  append-only; after `transferBeneficiary` the old array keeps the id. Readers
  must filter on the schedule's current beneficiary. Documented, not fixed
  on-chain (gas).
- **F-6 INFO — backdating vs the 24h guard:** a schedule with `start` far in
  the past and `end = now + 25h` is ~fully liquid at creation despite H3's
  guard. Legitimate (TGE backdating) — which is why the proof page's
  "% already vested at creation" is MANDATORY, not advisory.
- **F-7 LOW — sequencer timestamp drift is immaterial** at vesting timescales.

## Invariants (Foundry must prove)

1. Per token: `Σ claimed ≤ Σ received` — always, incl. hostile tokens.
2. `claimable(id)` monotonically non-decreasing in time; 0 before cliff;
   exactly `total − claimed` at/after end.
3. No function except `claim` moves tokens out (fuzz whole ABI).
4. Contract ETH balance == accrued fees after any operation sequence.
5. Admin functions can never mutate any field of an existing schedule.

## Deploy protocol

One-time deployer wallet (seed never in chat, shredded after — RobinhoodBurner
pattern), set admin → collector wallet immediately, verify source on
Blockscout, then follow-up email to GoPlus adding the vesting contract to the
recognition request.
